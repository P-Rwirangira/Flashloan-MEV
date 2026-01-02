/**
 * Flash Executor Implementation
 *
 * TypeScript implementation for interacting with the Flash Executor contract.
 * Provides methods for executing arbitrage with flash loans and managing contract state.
 */

import { ethers, Contract, BigNumberish } from 'ethers';
import { EventEmitter } from 'events';
import {
  IFlashExecutor,
  FlashExecutorConfig,
  SafetyGuardConfig,
  RouteData,
  FlashExecutorError,
  ArbitrageParams,
} from './flash-executor';
import { Address, AsyncResult } from '../types/common';
import { createComponentLogger } from '../utils/logger';

/**
 * Flash Executor contract ABI - matches the deployed Solidity contract
 */
const FLASH_EXECUTOR_ABI = [
  // Main execution function
  'function executeArbitrage(address flashPool, uint256 amount0, uint256 amount1, bytes calldata routeData) external',

  // Flash callback (called by Uniswap V3 pool)
  'function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external',

  // View functions
  'function isAuthorizedPool(address pool) external view returns (bool)',
  'function getMinProfit() external view returns (uint256)',
  'function paused() external view returns (bool)',
  'function owner() external view returns (address)',

  // Admin functions
  'function setMinProfit(uint256 minProfit) external',
  'function addAuthorizedPool(address pool) external',
  'function removeAuthorizedPool(address pool) external',
  'function pause() external',
  'function unpause() external',
  'function emergencyWithdraw(address token, uint256 amount) external',
  'function emergencyWithdrawAll(address token) external',

  // Events
  'event ArbitrageExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 profit, uint256 gasUsed)',
  'event ArbitrageFailed(address indexed caller, string reason, uint256 gasUsed)',
  'event UnauthorizedCallbackAttempt(address indexed caller, address indexed pool)',
  'event InsufficientProfitEvent(uint256 actualProfit, uint256 minProfit)',
  'event PoolAuthorizationChanged(address indexed pool, bool isAuthorized)',
  'event Paused(address account)',
  'event Unpaused(address account)',
];

/**
 * Flash Executor contract wrapper
 * Provides TypeScript interface for interacting with deployed Flash Executor contract
 */
export class FlashExecutorContract extends EventEmitter implements IFlashExecutor {
  private readonly logger = createComponentLogger('flash-executor-contract');
  private contract: Contract;
  private readonly signer?: ethers.Signer;
  private readonly config: FlashExecutorConfig;
  private readonly safetyConfig: SafetyGuardConfig;

  // State tracking
  private isInitialized = false;
  private executionCount = 0;
  private totalGasUsed = 0n;
  private totalProfit = 0n;

  constructor(
    contractAddress: string,
    provider: ethers.Provider,
    config: FlashExecutorConfig,
    safetyConfig: SafetyGuardConfig,
    signer?: ethers.Signer
  ) {
    super();

    this.config = config;
    this.safetyConfig = safetyConfig;

    // Create contract instance
    this.contract = new Contract(contractAddress, FLASH_EXECUTOR_ABI, signer || provider);

    if (signer) {
      this.signer = signer;
    }

    this.setupEventListeners();
  }

  /**
   * Get the contract instance (guaranteed to be defined)
   */
  private getContract(): Contract {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }
    return this.contract;
  }

  /**
   * Initialize the Flash Executor
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Verify contract is deployed and accessible
      const contract = this.getContract();
      await contract['owner']!();

      // Verify configuration matches contract state
      await this.validateConfiguration();

      this.isInitialized = true;
      this.emit('initialized');
    } catch (error) {
      this.emit('error', error);
      throw new Error(`Failed to initialize Flash Executor: ${error}`);
    }
  }

  /**
   * Execute arbitrage using flash loan
   */
  async executeArbitrage(
    flashPool: Address,
    amount0: BigNumberish,
    amount1: BigNumberish,
    routeData: RouteData
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Flash Executor not initialized');
    }

    if (!this.signer) {
      throw new Error('Signer required for transaction execution');
    }

    try {
      // Pre-execution validation
      await this.validateArbitrageParams({
        flashPool,
        amount0,
        amount1,
        routeData,
      });

      // Encode route data for contract call
      const encodedRouteData = this.encodeRouteData(routeData);

      // Execute transaction
      const contract = this.getContract();
      const tx = await contract['executeArbitrage']!(
        flashPool,
        amount0,
        amount1,
        encodedRouteData,
        {
          gasLimit: this.safetyConfig.maxGasLimit,
          maxFeePerGas: this.config.maxGasPrice,
        }
      );

      // Wait for confirmation
      const receipt = await tx.wait();

      this.executionCount++;
      this.totalGasUsed += BigInt(receipt.gasUsed.toString());

      this.emit('arbitrageExecuted', {
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed,
        blockNumber: receipt.blockNumber,
      });
    } catch (error) {
      this.emit('arbitrageFailed', {
        error: error instanceof Error ? error.message : String(error),
        flashPool,
        amount0,
        amount1,
      });
      throw error;
    }
  }

  /**
   * Uniswap V3 flash callback (should not be called directly)
   */
  async uniswapV3FlashCallback(
    fee0: BigNumberish,
    fee1: BigNumberish,
    data: string
  ): Promise<void> {
    // This method should only be called by the contract itself during flash loan execution
    // It's included here for interface compliance but should not be called directly
    // Log the parameters for debugging purposes
    this.logger.warn('uniswapV3FlashCallback called directly with:', { fee0, fee1, data });
    throw new Error('uniswapV3FlashCallback should not be called directly');
  }

  /**
   * Check if a pool is authorized for flash loans
   */
  async isAuthorizedPool(pool: Address): Promise<boolean> {
    try {
      const contract = this.getContract();
      return await contract['isAuthorizedPool']!(pool);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get minimum profit requirement
   */
  async getMinProfit(): Promise<BigNumberish> {
    const contract = this.getContract();
    return await contract['getMinProfit']!();
  }

  /**
   * Check if contract is paused
   */
  async isPaused(): Promise<boolean> {
    try {
      const contract = this.getContract();
      return await contract['paused']!();
    } catch (error) {
      return true; // Assume paused if contract not available
    }
  }

  /**
   * Get contract owner address
   */
  async owner(): Promise<Address> {
    const contract = this.getContract();
    return await contract['owner']!();
  }

  /**
   * Add authorized pool (admin only)
   */
  async addAuthorizedPool(pool: Address): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['addAuthorizedPool']!(pool);
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Remove authorized pool (admin only)
   */
  async removeAuthorizedPool(pool: Address): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['removeAuthorizedPool']!(pool);
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Set minimum profit requirement (admin only)
   */
  async setMinProfit(minProfit: BigNumberish): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['setMinProfit']!(minProfit);
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Pause contract (admin only)
   */
  async pause(): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['pause']!();
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Unpause contract (admin only)
   */
  async unpause(): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['unpause']!();
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Emergency withdraw tokens (admin only)
   */
  async emergencyWithdraw(token: Address, amount: BigNumberish): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      const contract = this.getContract();
      const tx = await contract['emergencyWithdraw']!(token, amount);
      await tx.wait();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Validate arbitrage parameters before execution
   */
  private async validateArbitrageParams(params: ArbitrageParams): Promise<void> {
    const { flashPool, amount0, amount1, routeData } = params;

    // Check if contract is paused
    if (await this.isPaused()) {
      throw new Error(FlashExecutorError.CONTRACT_PAUSED);
    }

    // Check if pool is authorized
    if (!(await this.isAuthorizedPool(flashPool))) {
      throw new Error(FlashExecutorError.UNAUTHORIZED_CALLBACK);
    }

    // Validate amounts
    const totalAmount = BigInt(amount0.toString()) + BigInt(amount1.toString());
    if (totalAmount > BigInt(this.safetyConfig.maxFlashLoanAmount.toString())) {
      throw new Error('Flash loan amount exceeds safety limit');
    }

    // Validate route
    if (routeData.pools.length === 0) {
      throw new Error(FlashExecutorError.INVALID_ROUTE);
    }

    if (routeData.pools.length > this.config.fallbackRouteLimit) {
      throw new Error('Route exceeds maximum complexity');
    }

    // Check deadline
    if (routeData.deadline < Math.floor(Date.now() / 1000)) {
      throw new Error(FlashExecutorError.DEADLINE_EXCEEDED);
    }

    // Validate minimum profit
    const minProfit = BigInt(routeData.minProfit.toString());
    const configMinProfit = BigInt(this.config.minProfitWei.toString());
    if (minProfit < configMinProfit) {
      throw new Error(FlashExecutorError.INSUFFICIENT_PROFIT);
    }
  }

  /**
   * Encode route data for contract call
   */
  private encodeRouteData(routeData: RouteData): string {
    // Encode route data as bytes for contract call
    // This matches the SwapRoute struct in the Solidity contract
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();

    return abiCoder.encode(
      ['address[]', 'bool[]', 'uint256', 'uint256'],
      [routeData.pools, routeData.directions, routeData.minProfit, routeData.deadline]
    );
  }

  /**
   * Validate configuration against contract state
   */
  private async validateConfiguration(): Promise<void> {
    try {
      // Check minimum profit matches
      const contractMinProfit = await this.getMinProfit();
      const configMinProfit = BigInt(this.config.minProfitWei.toString());

      if (BigInt(contractMinProfit.toString()) !== configMinProfit) {
        this.logger.warn('Configuration minimum profit does not match contract state', {
          contractMinProfit: contractMinProfit.toString(),
          configMinProfit: configMinProfit.toString(),
        });
      }

      // Validate authorized pools
      for (const pool of this.config.authorizedPools) {
        const isAuthorized = await this.isAuthorizedPool(pool);
        if (!isAuthorized) {
          this.logger.warn('Pool not authorized in contract', { pool });
        }
      }
    } catch (error) {
      throw new Error(`Configuration validation failed: ${error}`);
    }
  }

  /**
   * Setup event listeners for contract events
   */
  private setupEventListeners(): void {
    const contract = this.getContract();

    // Listen for ArbitrageExecuted events
    contract.on(
      'ArbitrageExecuted',
      (caller, tokenIn, tokenOut, amountIn, profit, gasUsed, event) => {
        this.totalProfit += BigInt(profit.toString());

        this.emit('ArbitrageExecuted', {
          caller,
          tokenIn,
          tokenOut,
          amountIn,
          profit,
          gasUsed,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
      }
    );

    // Listen for ArbitrageFailed events
    contract.on('ArbitrageFailed', (caller, reason, gasUsed, event) => {
      this.emit('ArbitrageFailed', {
        caller,
        reason,
        gasUsed,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for UnauthorizedCallbackAttempt events
    contract.on('UnauthorizedCallbackAttempt', (caller, pool, event) => {
      this.emit('UnauthorizedCallback', {
        caller,
        pool,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for InsufficientProfitEvent events
    contract.on('InsufficientProfitEvent', (actualProfit, minProfit, event) => {
      this.emit('InsufficientProfit', {
        actualProfit,
        minProfit,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for Paused/Unpaused events
    contract.on('Paused', (account, event) => {
      this.emit('PauseStateChanged', {
        isPaused: true,
        caller: account,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    contract.on('Unpaused', (account, event) => {
      this.emit('PauseStateChanged', {
        isPaused: false,
        caller: account,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for PoolAuthorizationChanged events
    contract.on('PoolAuthorizationChanged', (pool, isAuthorized, event) => {
      this.emit('PoolAuthorizationChanged', {
        pool,
        isAuthorized,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });
  }

  /**
   * Get execution statistics
   */
  getStats(): {
    executionCount: number;
    totalGasUsed: bigint;
    totalProfit: bigint;
    averageGasPerExecution: bigint;
    isInitialized: boolean;
  } {
    return {
      executionCount: this.executionCount,
      totalGasUsed: this.totalGasUsed,
      totalProfit: this.totalProfit,
      averageGasPerExecution:
        this.executionCount > 0 ? this.totalGasUsed / BigInt(this.executionCount) : 0n,
      isInitialized: this.isInitialized,
    };
  }

  /**
   * Get contract address
   */
  getAddress(): Address {
    return this.getContract().target as Address;
  }

  /**
   * Get current configuration
   */
  getConfig(): FlashExecutorConfig {
    return { ...this.config };
  }

  /**
   * Get safety configuration
   */
  getSafetyConfig(): SafetyGuardConfig {
    return { ...this.safetyConfig };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Remove all event listeners
    this.getContract().removeAllListeners();
    this.removeAllListeners();

    this.isInitialized = false;
  }
}

/**
 * Flash Executor factory for creating contract instances
 */
export class FlashExecutorFactory {
  private readonly provider: ethers.Provider;
  private readonly signer?: ethers.Signer;
  private readonly bytecode?: string | undefined;

  constructor(provider: ethers.Provider, signer?: ethers.Signer, bytecode?: string | undefined) {
    this.provider = provider;
    if (signer) {
      this.signer = signer;
    }
    this.bytecode = bytecode;
  }

  /**
   * Create Flash Executor contract instance
   */
  create(
    contractAddress: string,
    config: FlashExecutorConfig,
    safetyConfig: SafetyGuardConfig
  ): FlashExecutorContract {
    return new FlashExecutorContract(
      contractAddress,
      this.provider,
      config,
      safetyConfig,
      this.signer
    );
  }

  /**
   * Deploy new Flash Executor contract
   */
  async deploy(
    config: FlashExecutorConfig,
    safetyConfig: SafetyGuardConfig
  ): Promise<FlashExecutorContract> {
    if (!this.signer) {
      throw new Error('Signer required for contract deployment');
    }

    try {
      // Deploy the contract using ethers ContractFactory
      const contractFactory = new ethers.ContractFactory(
        FLASH_EXECUTOR_ABI,
        await this.getBytecode(),
        this.signer
      );

      const contract = await contractFactory.deploy(config.minProfitWei);
      await contract.waitForDeployment();

      const contractAddress = await contract.getAddress();

      // Create wrapper instance
      const flashExecutor = new FlashExecutorContract(
        contractAddress,
        this.provider,
        config,
        safetyConfig,
        this.signer
      );

      // Initialize and configure
      await flashExecutor.initialize();

      // Add authorized pools
      for (const pool of config.authorizedPools) {
        await flashExecutor.addAuthorizedPool(pool);
      }

      return flashExecutor;
    } catch (error) {
      throw new Error(`Contract deployment failed: ${error}`);
    }
  }

  /**
   * Get contract bytecode (loaded from compiled artifacts)
   */
  async getBytecode(): Promise<string> {
    // Use provided bytecode first
    if (this.bytecode) {
      return this.bytecode;
    }

    try {
      // Try environment variable path first
      const artifactPath = process.env['FLASH_EXECUTOR_ARTIFACT_PATH'];
      if (artifactPath) {
        const fs = await import('fs');
        const path = await import('path');
        const fullPath = path.resolve(artifactPath);
        const artifactContent = fs.readFileSync(fullPath, 'utf8');
        const artifact = JSON.parse(artifactContent);
        return artifact.bytecode;
      }

      // Fallback to default path
      const path = await import('path');
      const fs = await import('fs');
      const defaultPath = path.join(
        process.cwd(),
        'artifacts/contracts/FlashExecutor.sol/FlashExecutor.json'
      );
      const artifactContent = fs.readFileSync(defaultPath, 'utf8');
      const artifact = JSON.parse(artifactContent);
      return artifact.bytecode;
    } catch (error) {
      throw new Error(
        `Contract bytecode not available - run \"npm run build:contracts\" first or provide bytecode via constructor. Root cause: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get contract ABI
   */
  getABI(): any[] {
    return FLASH_EXECUTOR_ABI;
  }
}
