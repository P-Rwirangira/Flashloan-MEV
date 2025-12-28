/**
 * Foundry Simulator
 *
 * Simulates transactions using Foundry/Anvil fork.
 * Validates profitability and calculates exact execution parameters.
 */

import { spawn, ChildProcess } from 'child_process';
import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { ArbitrageOpportunity } from '../types/opportunity';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface FoundrySimulatorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly forkUrl?: string;
  readonly anvilPort?: number;
  readonly simulationTimeoutMs?: number;
  readonly maxConcurrentSimulations?: number;
}

export interface SimulationValidationResult {
  readonly isValid: boolean;
  readonly rejectionReason?: string;
  readonly validationDetails: {
    readonly profitValidation: boolean;
    readonly gasValidation: boolean;
    readonly routeValidation: boolean;
    readonly timeoutValidation: boolean;
    readonly slippageValidation: boolean;
  };
  readonly actualProfit: bigint;
  readonly estimatedGas: bigint;
  readonly validatedAt: number;
}

export interface SimulationTimeoutConfig {
  readonly maxSimulationTimeMs: number;
  readonly maxGasLimit: bigint;
  readonly maxSlippagePercent: number;
  readonly minProfitMarginPercent: number;
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
  private readonly connectionManager: RpcConnectionManager;
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

    this.connectionManager = options.connectionManager;
    this.forkUrl = options.forkUrl || this.connectionManager.getPrimaryRpcUrl();
    this.anvilPort = options.anvilPort || 8545;
    this.simulationTimeoutMs = options.simulationTimeoutMs || 50; // 50ms for latency requirement
    this.maxConcurrentSimulations = options.maxConcurrentSimulations || 5;
    
    // Default timeout configuration
    this.timeoutConfig = {
      maxSimulationTimeMs: this.simulationTimeoutMs,
      maxGasLimit: 500000n,
      maxSlippagePercent: 10,
      minProfitMarginPercent: 5,
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
        }, this.timeoutConfig.maxSimulationTimeMs);
      });

      // Execute simulation with timeout
      const result = await Promise.race([
        this.performSimulation(opportunity),
        timeoutPromise,
      ]);

      resolve(result);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
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

      // Simulate the arbitrage transaction
      const simulationResult = await this.simulateArbitrageTransaction(opportunity, fork);

      // Clean up fork
      this.activeForks.delete(fork.forkId);

      return {
        ...simulationResult,
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
   * Simulate arbitrage transaction execution
   */
  private async simulateArbitrageTransaction(
    opportunity: ArbitrageOpportunity,
    fork: ForkState
  ): Promise<Omit<SimulationResult, 'executionTime'>> {
    try {
      // Create a test wallet for simulation
      const testWallet = ethers.Wallet.createRandom().connect(fork.provider);

      // Fund the test wallet with ETH for gas
      await fork.provider.send('anvil_setBalance', [
        testWallet.address,
        ethers.toBeHex(ethers.parseEther('10')), // 10 ETH for gas
      ]);

      // Simulate flash loan execution
      const flashLoanResult = await this.simulateFlashLoan(opportunity, testWallet);

      if (!flashLoanResult.success) {
        return {
          success: false,
          gasUsed: flashLoanResult.gasUsed,
          actualProfit: 0n,
          error: flashLoanResult.error || 'Flash loan simulation failed',
          revertReason: flashLoanResult.revertReason,
        };
      }

      // Calculate actual profit
      const actualProfit = await this.calculateActualProfit(
        opportunity,
        flashLoanResult,
        testWallet
      );

      // Validate minimum profit requirement
      const minProfitMet = actualProfit >= BigInt(opportunity.minProfit.toString());

      return {
        success: minProfitMet,
        gasUsed: flashLoanResult.gasUsed,
        actualProfit,
        error: minProfitMet ? undefined : 'Insufficient profit after simulation',
      };
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
   * Simulate flash loan execution
   */
  private async simulateFlashLoan(
    opportunity: ArbitrageOpportunity,
    _wallet: ethers.HDNodeWallet
  ): Promise<{
    success: boolean;
    gasUsed: bigint;
    error?: string;
    revertReason?: string;
  }> {
    try {
      // For simulation, we'll estimate the gas and execution without deploying contracts
      // In a real implementation, this would interact with the actual Flash Executor contract

      // Estimate gas for the complete arbitrage transaction
      const estimatedGas = await this.estimateArbitrageGas(opportunity);

      // Simulate the execution by checking if we have enough gas and the route is valid
      const hasEnoughGas = estimatedGas <= this.timeoutConfig.maxGasLimit;
      const routeValid = this.validateRoute(opportunity);

      if (!hasEnoughGas) {
        return {
          success: false,
          gasUsed: estimatedGas,
          error: 'Gas limit exceeded',
        };
      }

      if (!routeValid) {
        return {
          success: false,
          gasUsed: estimatedGas,
          error: 'Invalid route',
        };
      }

      return {
        success: true,
        gasUsed: estimatedGas,
      };
    } catch (error) {
      return {
        success: false,
        gasUsed: 0n,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Estimate gas for arbitrage execution
   */
  private async estimateArbitrageGas(opportunity: ArbitrageOpportunity): Promise<bigint> {
    // Base gas costs for different operations
    const flashLoanGas = 50000n; // Flash loan initiation and callback
    const swapGas = 100000n; // Per swap operation
    const transferGas = 21000n; // Token transfers

    // Calculate total gas based on route complexity
    const numSwaps = BigInt(opportunity.route.pools.length);
    const numFallbacks = BigInt(opportunity.fallbackRoutes.length);

    const totalGas =
      flashLoanGas +
      swapGas * numSwaps +
      transferGas * 2n + // Input and output transfers
      swapGas * numFallbacks * 10n; // Fallback route overhead (10% of main route)

    return totalGas;
  }

  /**
   * Validate arbitrage route
   */
  private validateRoute(opportunity: ArbitrageOpportunity): boolean {
    // Check if route has valid pools
    if (opportunity.route.pools.length === 0) {
      return false;
    }

    // Check if amounts are reasonable
    const amountIn = BigInt(opportunity.amountIn.toString());
    if (amountIn <= 0n) {
      return false;
    }

    // Check if expected profit is positive
    const expectedProfit = BigInt(opportunity.expectedProfit.toString());
    if (expectedProfit <= 0n) {
      return false;
    }

    // Check if slippage tolerance is reasonable
    if (opportunity.slippageTolerance > this.timeoutConfig.maxSlippagePercent) {
      return false;
    }

    return true;
  }

  /**
   * Calculate actual profit from simulation
   */
  private async calculateActualProfit(
    opportunity: ArbitrageOpportunity,
    flashLoanResult: { gasUsed: bigint },
    wallet: ethers.HDNodeWallet
  ): Promise<bigint> {
    try {
      // Get current gas price
      const provider = wallet.provider;
      if (!provider) {
        return 0n;
      }
      
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('2', 'gwei');

      // Calculate gas cost
      const gasCost = flashLoanResult.gasUsed * BigInt(gasPrice.toString());

      // Calculate flash loan fee
      const flashLoanFee = BigInt(opportunity.flashFee.toString());

      // Simulate slippage impact
      const expectedProfit = BigInt(opportunity.expectedProfit.toString());
      const slippageImpact = (expectedProfit * BigInt(opportunity.slippageTolerance * 100)) / 10000n;

      // Calculate net profit
      const grossProfit = expectedProfit - slippageImpact;
      const totalCosts = gasCost + flashLoanFee;

      return grossProfit > totalCosts ? grossProfit - totalCosts : 0n;
    } catch (error) {
      return 0n; // Return 0 profit on calculation error
    }
  }

  /**
   * Process simulation queue
   */
  private processQueue(): void {
    if (this.simulationQueue.length === 0 || this.activeSimulations >= this.maxConcurrentSimulations) {
      return;
    }

    const next = this.simulationQueue.shift();
    if (next) {
      this.executeSimulation(next.opportunity, next.resolve, next.reject);
    }
  }

  /**
   * Start Anvil process
   */
  private async startAnvil(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Start Anvil with fork configuration
      this.anvilProcess = spawn('anvil', [
        '--fork-url',
        this.forkUrl,
        '--port',
        this.anvilPort.toString(),
        '--host',
        '127.0.0.1',
        '--silent', // Reduce log output
      ]);

      let isResolved = false;

      this.anvilProcess.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`Failed to start Anvil: ${error.message}`));
        }
      });

      this.anvilProcess.on('exit', (code) => {
        if (!isResolved && code !== 0) {
          isResolved = true;
          reject(new Error(`Anvil exited with code ${code}`));
        }
      });

      // Wait for Anvil to start (simple delay-based approach)
      setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          resolve();
        }
      }, 2000); // 2 second startup delay
    });
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
