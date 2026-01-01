/**
 * Real Transaction Validator
 *
 * Validates transactions using real blockchain state and gas estimation.
 * Replaces simulation with actual profitability validation and gas optimization.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { ArbitrageOpportunity } from '../types/opportunity';
import { ArbitrageRoute } from '../types/execution';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ContractManager } from '../contracts/contract-manager';
import { createComponentLogger } from '../utils/logger';

export interface FoundrySimulatorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly contractManager?: ContractManager | undefined;
  readonly forkUrl?: string;
  readonly anvilPort?: number;
  readonly simulationTimeoutMs?: number;
  readonly maxConcurrentSimulations?: number;
}

export interface SimulationTimeoutConfig {
  readonly maxValidationTimeMs: number;
  readonly maxGasLimit: bigint;
  readonly maxSlippagePercent: number;
  readonly minProfitMarginPercent: number;
  readonly enableLiquidityCheck: boolean;
}

export interface SimulationValidationResult {
  readonly isValid: boolean;
  readonly rejectionReason?: string;
  readonly validationDetails: {
    readonly profitValidation: boolean;
    readonly gasValidation: boolean;
    readonly routeValidation: boolean;
    readonly liquidityValidation: boolean;
    readonly slippageValidation: boolean;
  };
  readonly actualProfit: bigint;
  readonly estimatedGas: bigint;
  readonly validatedAt: number;
  readonly gasPrice: bigint;
  readonly totalCost: bigint;
}

export interface ValidationResult {
  readonly isValid: boolean;
  readonly rejectionReason?: string;
  readonly validationDetails: {
    readonly profitValidation: boolean;
    readonly gasValidation: boolean;
    readonly routeValidation: boolean;
    readonly liquidityValidation: boolean;
    readonly slippageValidation: boolean;
  };
  readonly actualProfit: bigint;
  readonly estimatedGas: bigint;
  readonly validatedAt: number;
  readonly gasPrice: bigint;
  readonly totalCost: bigint;
}

export interface ValidationConfig {
  readonly maxValidationTimeMs: number;
  readonly maxGasLimit: bigint;
  readonly maxSlippagePercent: number;
  readonly minProfitMarginPercent: number;
  readonly enableLiquidityCheck: boolean;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly actualProfit: bigint;
  readonly executionTime: number;
  readonly error?: string | undefined;
  readonly revertReason?: string | undefined;
  readonly logs?: string[] | undefined;
  readonly validationResult?: SimulationValidationResult;
}

export interface ForkState {
  readonly forkId: string;
  readonly blockNumber: number;
  readonly provider: ethers.JsonRpcProvider;
  readonly createdAt: number;
  readonly isActive: boolean;
}

export class FoundrySimulator extends EventEmitter {
  // Logger for debugging and monitoring (used for simulation tracking)
  private readonly componentLogger = createComponentLogger('foundry-simulator');
  private readonly connectionManager: RpcConnectionManager;
  private readonly contractManager?: ContractManager | undefined;
  private readonly forkUrl: string;
  private readonly anvilPort: number;
  private readonly simulationTimeoutMs: number;
  private readonly maxConcurrentSimulations: number;
  private readonly timeoutConfig: SimulationTimeoutConfig;

  // Anvil process management
  private anvilProcess: ChildProcess | undefined;
  private forkProvider: ethers.JsonRpcProvider | undefined;
  private isInitialized = false;

  // Fork state management
  private activeForks: Map<string, ForkState> = new Map();
  private forkCounter = 0;

  // Simulation queue
  private simulationQueue: Array<{
    opportunity: ArbitrageOpportunity;
    resolve: (result: SimulationResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private activeSimulations = 0;

  constructor(options: FoundrySimulatorOptions) {
    super();

    this.componentLogger.info('Initializing Foundry simulator', {
      anvilPort: options.anvilPort || 8545,
      simulationTimeoutMs: options.simulationTimeoutMs || 50,
    });

    this.connectionManager = options.connectionManager;
    this.contractManager = options.contractManager;
    this.forkUrl = options.forkUrl || this.connectionManager.getPrimaryRpcUrl();
    this.anvilPort = options.anvilPort || 8545;
    this.simulationTimeoutMs = options.simulationTimeoutMs || 50; // 50ms for latency requirement
    this.maxConcurrentSimulations = options.maxConcurrentSimulations || 5;

    // Default timeout configuration
    this.timeoutConfig = {
      maxValidationTimeMs: this.simulationTimeoutMs,
      maxGasLimit: 500000n,
      maxSlippagePercent: 10,
      minProfitMarginPercent: 5,
      enableLiquidityCheck: true,
    };
  }

  /**
   * Initialize the Foundry simulator
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.startAnvil();
      await this.setupForkProvider();
      this.isInitialized = true;
      this.emit('initialized');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Shutdown the simulator
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    // Clear simulation queue
    this.simulationQueue.forEach(({ reject }) => {
      reject(new Error('Simulator shutting down'));
    });
    this.simulationQueue = [];

    // Clean up forks
    this.activeForks.clear();

    // Stop Anvil process
    if (this.anvilProcess) {
      this.anvilProcess.kill('SIGTERM');
      this.anvilProcess = undefined;
    }

    this.forkProvider = undefined;
    this.isInitialized = false;
    this.emit('shutdown');
  }

  /**
   * Simulate an arbitrage opportunity
   */
  async simulate(opportunity: ArbitrageOpportunity): Promise<SimulationResult> {
    if (!this.isInitialized) {
      throw new Error('Simulator not initialized');
    }

    return new Promise((resolve, reject) => {
      // Add to queue if at max concurrent simulations
      if (this.activeSimulations >= this.maxConcurrentSimulations) {
        this.simulationQueue.push({ opportunity, resolve, reject });
        return;
      }

      this.executeSimulation(opportunity, resolve, reject);
    });
  }

  /**
   * Simulate an arbitrage route (enhanced method for Flash Executor integration)
   */
  async simulateArbitrageRoute(route: ArbitrageRoute): Promise<SimulationResult> {
    if (!this.isInitialized) {
      throw new Error('Simulator not initialized');
    }

    const startTime = Date.now();

    try {
      // Basic validation
      if (route.path.length === 0) {
        return {
          success: false,
          gasUsed: 0n,
          actualProfit: 0n,
          executionTime: Date.now() - startTime,
          error: 'Route has no steps',
        };
      }

      if (route.amountIn <= 0n) {
        return {
          success: false,
          gasUsed: 0n,
          actualProfit: 0n,
          executionTime: Date.now() - startTime,
          error: 'Amount in must be positive',
        };
      }

      // Enhanced validation if contract manager is available
      if (this.contractManager) {
        // Could add additional validation here using contract manager
        // For now, just log that we have access to contract configuration
        const config = this.contractManager.getFlashExecutorConfig();
        if (!config.address) {
          return {
            success: false,
            gasUsed: 0n,
            actualProfit: 0n,
            executionTime: Date.now() - startTime,
            error: 'Flash Executor contract not deployed',
          };
        }
      }

      // Estimate gas based on route complexity
      const baseGas = 200000n;
      const gasPerStep = 150000n;
      const estimatedGas = baseGas + BigInt(route.path.length) * gasPerStep;

      // Simulate gas cost impact on profit
      const gasPrice = 2000000000n; // 2 gwei
      const gasCost = estimatedGas * gasPrice;
      const actualProfit = route.expectedProfit > gasCost ? route.expectedProfit - gasCost : 0n;

      // Check if profitable after gas costs
      const success = actualProfit > 0n;

      return {
        success,
        gasUsed: estimatedGas,
        actualProfit,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a new fork from current Base state
   */
  async createFork(): Promise<ForkState> {
    if (!this.forkProvider) {
      throw new Error('Fork provider not available');
    }

    try {
      const currentBlock = await this.connectionManager.getProvider().getBlockNumber();
      const forkId = `fork_${++this.forkCounter}_${Date.now()}`;

      // Create fork using anvil_fork RPC call
      await this.forkProvider.send('anvil_fork', [this.forkUrl, currentBlock]);

      const forkState: ForkState = {
        forkId,
        blockNumber: currentBlock,
        provider: this.forkProvider,
        createdAt: Date.now(),
        isActive: true,
      };

      this.activeForks.set(forkId, forkState);
      return forkState;
    } catch (error) {
      throw new Error(`Failed to create fork: ${error}`);
    }
  }

  /**
   * Execute simulation on fork
   */
  private async executeSimulation(
    opportunity: ArbitrageOpportunity,
    resolve: (result: SimulationResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    this.activeSimulations++;

    try {
      // Create timeout promise using timeout configuration
      const timeoutPromise = new Promise<never>((_, timeoutReject) => {
        setTimeout(() => {
          timeoutReject(new Error('Simulation timeout'));
        }, this.timeoutConfig.maxValidationTimeMs);
      });

      // Execute simulation with timeout
      const result = await Promise.race([this.performSimulation(opportunity), timeoutPromise]);

      resolve(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('simulationError', { opportunityId: opportunity.id, error: errorMessage });
      reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      this.activeSimulations--;
      this.processQueue();
    }
  }

  /**
   * Perform the actual simulation
   */
  private async performSimulation(opportunity: ArbitrageOpportunity): Promise<SimulationResult> {
    const startTime = Date.now();

    try {
      // Create fork for this simulation
      const fork = await this.createFork();

      // Deploy Flash Executor contract to fork
      const contractAddress = await this.deployFlashExecutorToFork(fork);

      // Simulate the arbitrage transaction
      const simulationResult = await this.simulateArbitrageTransaction(
        opportunity,
        fork,
        contractAddress
      );

      // Clean up fork
      this.activeForks.delete(fork.forkId);

      const finalResult = {
        ...simulationResult,
        executionTime: Date.now() - startTime,
      };

      this.emit('simulationCompleted', {
        opportunityId: opportunity.id,
        success: finalResult.success,
        profit: finalResult.actualProfit.toString(),
        gasUsed: finalResult.gasUsed.toString(),
        contractAddress,
      });

      return finalResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('simulationFailed', { opportunityId: opportunity.id, error: errorMessage });

      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        executionTime: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Deploy Flash Executor contract to fork
   */
  private async deployFlashExecutorToFork(fork: ForkState): Promise<string> {
    try {
      // Load contract artifacts
      const FlashExecutorArtifact = require('../../artifacts/contracts/FlashExecutor.sol/FlashExecutor.json');

      // Create a test wallet for deployment
      const deployerWallet = ethers.Wallet.createRandom().connect(fork.provider);

      // Fund the deployer wallet with ETH
      await fork.provider.send('anvil_setBalance', [
        deployerWallet.address,
        ethers.toBeHex(ethers.parseEther('100')), // 100 ETH for deployment and gas
      ]);

      // Create contract factory
      const contractFactory = new ethers.ContractFactory(
        FlashExecutorArtifact.abi,
        FlashExecutorArtifact.bytecode,
        deployerWallet
      );

      // Deploy with minimum profit of 1 wei (will be overridden by route data)
      const contract = await contractFactory.deploy(1n);
      await contract.waitForDeployment();

      const contractAddress = await contract.getAddress();

      // Authorize test pools if contract manager is available
      if (this.contractManager) {
        const authorizedPools = this.contractManager.getAllAuthorizedPoolAddresses();
        for (const poolAddress of authorizedPools) {
          try {
            const tx = await (contract as any).addAuthorizedPool(poolAddress);
            await tx.wait();
          } catch (error) {
            // Log but don't fail deployment if pool authorization fails
            this.emit('poolAuthorizationFailed', {
              poolAddress,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      this.emit('contractDeployed', {
        forkId: fork.forkId,
        contractAddress,
        deployerAddress: deployerWallet.address,
      });

      return contractAddress;
    } catch (error) {
      throw new Error(`Failed to deploy Flash Executor to fork: ${error}`);
    }
  }
  /**
   * Simulate arbitrage transaction execution
   */
  private async simulateArbitrageTransaction(
    opportunity: ArbitrageOpportunity,
    fork: ForkState,
    contractAddress: string
  ): Promise<Omit<SimulationResult, 'executionTime'>> {
    try {
      // Create a test wallet for simulation
      const testWallet = ethers.Wallet.createRandom().connect(fork.provider);

      // Fund the test wallet with ETH for gas
      await fork.provider.send('anvil_setBalance', [
        testWallet.address,
        ethers.toBeHex(ethers.parseEther('10')), // 10 ETH for gas
      ]);

      // Build transaction using transaction builder
      const transactionBuilder = await this.createTransactionBuilder(fork.provider);
      const route = this.convertOpportunityToRoute(opportunity);

      // Build the actual transaction that would be submitted
      const tx = await transactionBuilder.buildArbitrageTx(route, testWallet.address);

      // Override the contract address to use our deployed fork contract
      tx.to = contractAddress;

      // Execute the transaction on the fork
      const executionResult = await this.executeTransactionOnFork(tx, testWallet, fork);

      return executionResult;
    } catch (error) {
      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create transaction builder for simulation
   */
  private async createTransactionBuilder(provider: ethers.Provider): Promise<any> {
    if (!this.contractManager) {
      throw new Error('Contract manager required for transaction building');
    }

    // Import TransactionBuilder dynamically to avoid circular dependencies
    const { TransactionBuilder } = await import('../executor/transaction-builder');

    return new TransactionBuilder({
      contractManager: this.contractManager,
      provider,
      defaultGasLimit: this.timeoutConfig.maxGasLimit,
      defaultSlippage: 0.01, // 1% default slippage
    });
  }

  /**
   * Convert ArbitrageOpportunity to ArbitrageRoute for transaction builder
   */
  private convertOpportunityToRoute(opportunity: ArbitrageOpportunity): any {
    return {
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      amountIn: BigInt(opportunity.amountIn.toString()),
      expectedProfit: BigInt(opportunity.expectedProfit.toString()),
      path: opportunity.route.pools.map((poolAddress, index) => ({
        poolAddress,
        tokenIn: index === 0 ? opportunity.tokenIn : opportunity.route.pools[index - 1], // Simplified
        tokenOut:
          index === opportunity.route.pools.length - 1
            ? opportunity.tokenOut
            : opportunity.route.pools[index + 1], // Simplified
      })),
    };
  }

  /**
   * Execute transaction on fork and capture results
   */
  private async executeTransactionOnFork(
    tx: any,
    wallet: ethers.HDNodeWallet,
    fork: ForkState
  ): Promise<Omit<SimulationResult, 'executionTime'>> {
    try {
      // Get initial balance for profit calculation
      const initialBalance = (await wallet.provider?.getBalance(wallet.address)) || 0n;

      // Execute the transaction
      const txResponse = await wallet.sendTransaction(tx);
      const receipt = await txResponse.wait();

      if (!receipt) {
        return {
          success: false,
          gasUsed: 0n,
          actualProfit: 0n,
          error: 'Transaction receipt not available',
        };
      }

      // Get final balance
      const finalBalance = (await wallet.provider?.getBalance(wallet.address)) || 0n;

      // Calculate actual profit (excluding gas costs for now, as this is a simulation)
      const gasUsed = BigInt(receipt.gasUsed.toString());
      const gasCost = gasUsed * BigInt(receipt.gasPrice?.toString() || '0');
      const balanceChange = finalBalance - initialBalance + gasCost; // Add back gas cost to see profit

      // Check if transaction was successful
      const success = receipt.status === 1 && balanceChange > 0n;

      // Extract revert reason from logs if transaction failed
      let revertReason: string | undefined;
      if (!success && receipt.logs) {
        // Look for ArbitrageFailed event or other error events
        for (const log of receipt.logs) {
          try {
            // Try to decode as ArbitrageFailed event
            const iface = new ethers.Interface([
              'event ArbitrageFailed(address indexed caller, string reason, uint256 gasUsed)',
            ]);
            const decoded = iface.parseLog(log);
            if (decoded && decoded.name === 'ArbitrageFailed') {
              revertReason = decoded.args['reason'];
              break;
            }
          } catch {
            // Ignore decode errors
          }
        }
      }

      this.emit('transactionExecuted', {
        forkId: fork.forkId,
        txHash: receipt.hash,
        success,
        gasUsed: gasUsed.toString(),
        balanceChange: balanceChange.toString(),
      });

      return {
        success,
        gasUsed,
        actualProfit: success ? balanceChange : 0n,
        revertReason,
        logs: receipt.logs?.map(log => log.data) || [],
      };
    } catch (error) {
      // Handle transaction revert
      let revertReason: string | undefined;

      if (error instanceof Error) {
        // Extract revert reason from error message
        const revertMatch = error.message.match(/revert (.+)/i);
        if (revertMatch) {
          revertReason = revertMatch[1];
        }
      }

      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        error: error instanceof Error ? error.message : String(error),
        revertReason,
      };
    }
  }
  /**
   * Process simulation queue
   */
  private processQueue(): void {
    if (
      this.simulationQueue.length === 0 ||
      this.activeSimulations >= this.maxConcurrentSimulations
    ) {
      return;
    }

    const next = this.simulationQueue.shift();
    if (next) {
      this.executeSimulation(next.opportunity, next.resolve, next.reject);
    }
  }

  /**
   * Start Anvil process with automatic restart capability
   */
  private async startAnvil(): Promise<void> {
    return new Promise((resolve, reject) => {
      let isResolved = false;
      let restartAttempts = 0;
      const maxRestartAttempts = 3;

      const startProcess = () => {
        // Start Anvil with fork configuration
        this.anvilProcess = spawn('anvil', [
          '--fork-url',
          this.forkUrl,
          '--port',
          this.anvilPort.toString(),
          '--host',
          '127.0.0.1',
          '--silent', // Reduce log output
          '--accounts',
          '10', // Create 10 test accounts
          '--balance',
          '10000', // 10000 ETH per account
        ]);

        this.anvilProcess.on('error', error => {
          if (!isResolved) {
            isResolved = true;
            reject(new Error(`Failed to start Anvil: ${error.message}`));
          } else {
            // Process crashed after startup - attempt restart
            this.handleAnvilCrash(error);
          }
        });

        this.anvilProcess.on('exit', (code, signal) => {
          if (!isResolved && code !== 0) {
            isResolved = true;
            reject(new Error(`Anvil exited with code ${code}, signal ${signal}`));
          } else if (code !== 0 && restartAttempts < maxRestartAttempts) {
            // Unexpected exit - attempt restart
            this.handleAnvilCrash(
              new Error(`Anvil exited unexpectedly: code ${code}, signal ${signal}`)
            );
          }
        });

        // Capture stdout/stderr for debugging
        if (this.anvilProcess.stdout) {
          this.anvilProcess.stdout.on('data', data => {
            this.emit('anvilOutput', { type: 'stdout', data: data.toString() });
          });
        }

        if (this.anvilProcess.stderr) {
          this.anvilProcess.stderr.on('data', data => {
            this.emit('anvilOutput', { type: 'stderr', data: data.toString() });
          });
        }
      };

      const handleRestart = () => {
        restartAttempts++;
        this.emit('anvilRestarting', { attempt: restartAttempts, maxAttempts: maxRestartAttempts });

        setTimeout(() => {
          startProcess();

          // Test connection after restart
          setTimeout(async () => {
            try {
              await this.testAnvilConnection();
              this.emit('anvilRestarted', { attempt: restartAttempts });
            } catch (error) {
              if (restartAttempts < maxRestartAttempts) {
                handleRestart();
              } else {
                this.emit('anvilRestartFailed', {
                  attempts: restartAttempts,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }, 2000);
        }, 1000 * restartAttempts); // Exponential backoff
      };

      this.handleAnvilCrash = (error: Error) => {
        this.emit('anvilCrashed', {
          error: error.message,
          restartAttempts,
          willRestart: restartAttempts < maxRestartAttempts,
        });

        if (restartAttempts < maxRestartAttempts) {
          handleRestart();
        }
      };

      // Start initial process
      startProcess();

      // Wait for Anvil to start
      setTimeout(async () => {
        if (!isResolved) {
          try {
            await this.testAnvilConnection();
            isResolved = true;
            resolve();
          } catch (error) {
            isResolved = true;
            reject(new Error(`Anvil connection test failed: ${error}`));
          }
        }
      }, 3000); // 3 second startup delay
    });
  }

  private handleAnvilCrash!: (error: Error) => void; // Will be assigned in startAnvil

  /**
   * Test Anvil connection
   */
  private async testAnvilConnection(): Promise<void> {
    const forkUrl = `http://127.0.0.1:${this.anvilPort}`;
    const testProvider = new ethers.JsonRpcProvider(forkUrl);

    // Test basic RPC call
    await testProvider.getBlockNumber();

    // Test fork functionality
    const chainId = await testProvider.getNetwork();
    if (!chainId) {
      throw new Error('Failed to get network info from Anvil');
    }
  }

  /**
   * Setup fork provider connection
   */
  private async setupForkProvider(): Promise<void> {
    const forkUrl = `http://127.0.0.1:${this.anvilPort}`;
    this.forkProvider = new ethers.JsonRpcProvider(forkUrl);

    // Test connection
    try {
      await this.forkProvider.getBlockNumber();
    } catch (error) {
      throw new Error(`Failed to connect to Anvil fork: ${error}`);
    }
  }

  /**
   * Get simulation statistics
   */
  getStats(): {
    activeSimulations: number;
    queuedSimulations: number;
    activeForks: number;
    isInitialized: boolean;
  } {
    return {
      activeSimulations: this.activeSimulations,
      queuedSimulations: this.simulationQueue.length,
      activeForks: this.activeForks.size,
      isInitialized: this.isInitialized,
    };
  }
}
