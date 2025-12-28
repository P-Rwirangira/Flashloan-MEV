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

/**
 * Flash Executor contract ABI (simplified for TypeScript interaction)
 * In production, this would be generated from the Solidity contract
 */
const FLASH_EXECUTOR_ABI = [
  // Main execution function
  'function executeArbitrage(address flashPool, uint256 amount0, uint256 amount1, bytes calldata routeData) external',
  
  // Flash callback (called by Uniswap V3 pool)
  'function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external',
  
  // View functions
  'function isAuthorizedPool(address pool) external view returns (bool)',
  'function getMinProfit() external view returns (uint256)',
  'function isPaused() external view returns (bool)',
  'function owner() external view returns (address)',
  
  // Admin functions
  'function setMinProfit(uint256 minProfit) external',
  'function addAuthorizedPool(address pool) external',
  'function removeAuthorizedPool(address pool) external',
  'function pause() external',
  'function unpause() external',
  'function emergencyWithdraw(address token, uint256 amount) external',
  
  // Events
  'event ArbitrageExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 profit, uint256 gasUsed)',
  'event ArbitrageFailed(address indexed caller, string reason, uint256 gasUsed)',
  'event UnauthorizedCallback(address indexed caller, address indexed pool)',
  'event InsufficientProfit(uint256 actualProfit, uint256 minProfit)',
  'event PauseStateChanged(bool isPaused, address indexed caller)',
  'event PoolAuthorizationChanged(address indexed pool, bool isAuthorized)',
];

/**
 * Flash Executor contract wrapper
 * Provides TypeScript interface for interacting with deployed Flash Executor contract
 */
export class FlashExecutorContract extends EventEmitter implements IFlashExecutor {
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
    contractAddress: Address,
    provider: ethers.Provider,
    config: FlashExecutorConfig,
    safetyConfig: SafetyGuardConfig,
    signer?: ethers.Signer
  ) {
    super();

    this.config = config;
    this.safetyConfig = safetyConfig;

    // Create contract instance
    this.contract = new Contract(
      contractAddress,
      FLASH_EXECUTOR_ABI,
      signer || provider
    );

    if (signer) {
      this.signer = signer;
    }

    this.setupEventListeners();
  }

  /**
   * Get the contract instance (guaranteed to be defined)
   */
  private getContract(): Contract {
    return this.contract as Contract;
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
      // @ts-ignore - Contract is guaranteed to be initialized in constructor
      await this.getContract()['owner']();
      
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['executeArbitrage'](
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
    console.warn('uniswapV3FlashCallback called directly with:', { fee0, fee1, data });
    throw new Error('uniswapV3FlashCallback should not be called directly');
  }

  /**
   * Check if a pool is authorized for flash loans
   */
  async isAuthorizedPool(pool: Address): Promise<boolean> {
    try {
      // @ts-ignore - Contract is guaranteed to be initialized
      return await this.getContract()['isAuthorizedPool'](pool);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get minimum profit requirement
   */
  async getMinProfit(): Promise<BigNumberish> {
    // @ts-ignore - Contract is guaranteed to be initialized
    return await this.getContract()['getMinProfit']();
  }

  /**
   * Check if contract is paused
   */
  async isPaused(): Promise<boolean> {
    try {
      // @ts-ignore - Contract is guaranteed to be initialized
      return await this.getContract()['isPaused']();
    } catch (error) {
      return true; // Assume paused if contract not available
    }
  }

  /**
   * Get contract owner address
   */
  async owner(): Promise<Address> {
    // @ts-ignore - Contract is guaranteed to be initialized
    return await this.getContract()['owner']();
  }

  /**
   * Add authorized pool (admin only)
   */
  async addAuthorizedPool(pool: Address): AsyncResult<void> {
    if (!this.signer) {
      return { success: false, error: new Error('Signer required') };
    }

    try {
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['addAuthorizedPool'](pool);
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['removeAuthorizedPool'](pool);
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['setMinProfit'](minProfit);
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['pause']();
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['unpause']();
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
      // @ts-ignore - Contract is guaranteed to be initialized
      const tx = await this.getContract()['emergencyWithdraw'](token, amount);
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
    // This would typically use ethers.js ABI encoding
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    
    return abiCoder.encode(
      ['address[]', 'bool[]', 'uint256', 'uint256'],
      [
        routeData.pools,
        routeData.directions,
        routeData.minProfit,
        routeData.deadline,
      ]
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
        console.warn('Configuration minimum profit does not match contract state');
      }

      // Validate authorized pools
      for (const pool of this.config.authorizedPools) {
        const isAuthorized = await this.isAuthorizedPool(pool);
        if (!isAuthorized) {
          console.warn(`Pool ${pool} is not authorized in contract`);
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
    contract.on('ArbitrageExecuted', (caller, tokenIn, tokenOut, amountIn, profit, gasUsed, event) => {
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
    });

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

    // Listen for UnauthorizedCallback events
    contract.on('UnauthorizedCallback', (caller, pool, event) => {
      this.emit('UnauthorizedCallback', {
        caller,
        pool,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for InsufficientProfit events
    contract.on('InsufficientProfit', (actualProfit, minProfit, event) => {
      this.emit('InsufficientProfit', {
        actualProfit,
        minProfit,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    });

    // Listen for PauseStateChanged events
    contract.on('PauseStateChanged', (isPaused, caller, event) => {
      this.emit('PauseStateChanged', {
        isPaused,
        caller,
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
      averageGasPerExecution: this.executionCount > 0 ? this.totalGasUsed / BigInt(this.executionCount) : 0n,
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

  constructor(provider: ethers.Provider, signer?: ethers.Signer) {
    this.provider = provider;
    if (signer) {
      this.signer = signer;
    }
  }

  /**
   * Create Flash Executor contract instance
   */
  create(
    contractAddress: Address,
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
   * Note: This would require the actual contract bytecode and constructor parameters
   */
  async deploy(
    config: FlashExecutorConfig,
    safetyConfig: SafetyGuardConfig
  ): Promise<FlashExecutorContract> {
    if (!this.signer) {
      throw new Error('Signer required for contract deployment');
    }

    // Log configuration for debugging
    console.log('Deploying Flash Executor with config:', { config, safetyConfig });

    // In a real implementation, this would deploy the actual Solidity contract
    // For now, we'll throw an error indicating this needs to be implemented
    throw new Error('Contract deployment not implemented - requires Solidity contract bytecode');
  }

  /**
   * Get contract bytecode (placeholder)
   */
  getBytecode(): string {
    // This would return the actual compiled contract bytecode
    throw new Error('Contract bytecode not available - requires compiled Solidity contract');
  }

  /**
   * Get contract ABI
   */
  getABI(): any[] {
    return FLASH_EXECUTOR_ABI;
  }
}