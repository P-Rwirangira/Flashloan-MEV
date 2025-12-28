/**
 * Flash Executor Contract Interface
 *
 * This file contains the TypeScript interfaces and types for the Flash Executor contract.
 * The actual Solidity contract is in FlashExecutor.sol
 */

import { BigNumberish } from 'ethers';
import { Address, AsyncResult } from '../types/common';

/**
 * Route data structure for arbitrage execution
 */
export interface RouteData {
  pools: Address[];
  directions: boolean[];
  minProfit: BigNumberish;
  deadline: number;
}

/**
 * Arbitrage parameters for execution
 */
export interface ArbitrageParams {
  flashPool: Address;
  amount0: BigNumberish;
  amount1: BigNumberish;
  routeData: RouteData;
}

/**
 * Flash Executor configuration
 */
export interface FlashExecutorConfig {
  minProfitWei: BigNumberish;
  maxGasPrice: BigNumberish;
  authorizedPools: Address[];
  fallbackRouteLimit: number;
}

/**
 * Safety guard configuration
 */
export interface SafetyGuardConfig {
  maxGasLimit: number;
  maxFlashLoanAmount: BigNumberish;
  reentrancyProtection: boolean;
}

/**
 * Flash Executor error types
 */
export enum FlashExecutorError {
  UNAUTHORIZED_CALLBACK = 'UnauthorizedCallback',
  INSUFFICIENT_PROFIT = 'InsufficientProfit',
  INVALID_ROUTE = 'InvalidRoute',
  DEADLINE_EXCEEDED = 'DeadlineExceeded',
  CONTRACT_PAUSED = 'ContractPaused',
  FLASH_LOAN_FAILED = 'FlashLoanFailed',
  SWAP_FAILED = 'SwapFailed',
}

/**
 * Flash Executor contract interface
 */
export interface IFlashExecutor {
  // Main execution functions
  executeArbitrage(
    flashPool: Address,
    amount0: BigNumberish,
    amount1: BigNumberish,
    routeData: RouteData
  ): Promise<void>;

  uniswapV3FlashCallback(fee0: BigNumberish, fee1: BigNumberish, data: string): Promise<void>;

  // View functions
  isAuthorizedPool(pool: Address): Promise<boolean>;
  getMinProfit(): Promise<BigNumberish>;
  isPaused(): Promise<boolean>;
  owner(): Promise<Address>;

  // Admin functions
  addAuthorizedPool(pool: Address): AsyncResult<void>;
  removeAuthorizedPool(pool: Address): AsyncResult<void>;
  setMinProfit(minProfit: BigNumberish): AsyncResult<void>;
  pause(): AsyncResult<void>;
  unpause(): AsyncResult<void>;
  emergencyWithdraw(token: Address, amount: BigNumberish): AsyncResult<void>;
}

/**
 * Flash Executor events
 */
export interface FlashExecutorEvents {
  ArbitrageExecuted: {
    caller: Address;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: BigNumberish;
    profit: BigNumberish;
    gasUsed: BigNumberish;
    blockNumber: number;
    transactionHash: string;
  };

  ArbitrageFailed: {
    caller: Address;
    reason: string;
    gasUsed: BigNumberish;
    blockNumber: number;
    transactionHash: string;
  };

  UnauthorizedCallback: {
    caller: Address;
    pool: Address;
    blockNumber: number;
    transactionHash: string;
  };

  InsufficientProfit: {
    actualProfit: BigNumberish;
    minProfit: BigNumberish;
    blockNumber: number;
    transactionHash: string;
  };

  PauseStateChanged: {
    isPaused: boolean;
    caller: Address;
    blockNumber: number;
    transactionHash: string;
  };

  PoolAuthorizationChanged: {
    pool: Address;
    isAuthorized: boolean;
    blockNumber: number;
    transactionHash: string;
  };
}

/**
 * Contract deployment parameters
 */
export interface DeploymentParams {
  owner: Address;
  minProfit: BigNumberish;
  authorizedPools: Address[];
}

/**
 * Contract statistics
 */
export interface ContractStats {
  totalExecutions: number;
  totalProfit: bigint;
  averageGasPerExecution: bigint;
  successRate: number;
}

/**
 * Flash Executor validation utilities
 */
export const FlashExecutorUtils = {
  /**
   * Validate arbitrage execution parameters
   */
  validateArbitrageParams: (
    flashPool: Address,
    amount0: BigNumberish,
    amount1: BigNumberish,
    routeData: RouteData
  ): boolean => {
    if (!flashPool || flashPool === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    if (BigInt(amount0.toString()) < 0n || BigInt(amount1.toString()) < 0n) {
      return false;
    }
    if (BigInt(amount0.toString()) === 0n && BigInt(amount1.toString()) === 0n) {
      return false;
    }
    if (!routeData.pools || routeData.pools.length === 0) {
      return false;
    }
    if (routeData.pools.length !== routeData.directions.length) {
      return false;
    }
    if (BigInt(routeData.minProfit.toString()) <= 0n) {
      return false;
    }
    if (routeData.deadline <= Date.now() / 1000) {
      return false;
    }
    return true;
  },

  /**
   * Validate flash callback parameters
   */
  validateFlashCallbackParams: (fee0: BigNumberish, fee1: BigNumberish, data: string): boolean => {
    if (BigInt(fee0.toString()) < 0n || BigInt(fee1.toString()) < 0n) {
      return false;
    }
    return typeof data === 'string';
  },

  /**
   * Validate pool authorization parameter
   */
  validatePoolParam: (pool: Address): boolean => {
    return pool !== '0x0000000000000000000000000000000000000000';
  },

  /**
   * Validate minimum profit parameter
   */
  validateMinProfitParam: (minProfit: BigNumberish): boolean => {
    return BigInt(minProfit.toString()) >= 0n;
  },

  /**
   * Validate emergency withdraw parameters
   */
  validateEmergencyWithdrawParams: (token: Address, amount: BigNumberish): boolean => {
    if (!token || token === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return BigInt(amount.toString()) > 0n;
  },

  /**
   * Check if error code is valid Flash Executor error
   */
  isValidFlashExecutorError: (errorCode: string): boolean => {
    return Object.values(FlashExecutorError).includes(errorCode as FlashExecutorError);
  },

  /**
   * Get error severity for Flash Executor errors
   */
  getErrorSeverity: (error: FlashExecutorError): 'low' | 'medium' | 'high' | 'critical' => {
    switch (error) {
      case FlashExecutorError.UNAUTHORIZED_CALLBACK:
      case FlashExecutorError.CONTRACT_PAUSED:
      case FlashExecutorError.FLASH_LOAN_FAILED:
        return 'critical';
      case FlashExecutorError.SWAP_FAILED:
      case FlashExecutorError.INVALID_ROUTE:
        return 'high';
      case FlashExecutorError.INSUFFICIENT_PROFIT:
      case FlashExecutorError.DEADLINE_EXCEEDED:
        return 'medium';
      default:
        return 'low';
    }
  },

  /**
   * Validate route data structure
   */
  validateRouteData: (routeData: RouteData): boolean => {
    if (!routeData.pools || !Array.isArray(routeData.pools)) {
      return false;
    }
    if (!routeData.directions || !Array.isArray(routeData.directions)) {
      return false;
    }
    if (routeData.pools.length !== routeData.directions.length) {
      return false;
    }
    if (routeData.pools.length === 0) {
      return false;
    }
    // Validate each pool address
    for (const pool of routeData.pools) {
      if (!pool || pool === '0x0000000000000000000000000000000000000000') {
        return false;
      }
    }
    // Validate directions are boolean
    for (const direction of routeData.directions) {
      if (typeof direction !== 'boolean') {
        return false;
      }
    }
    return true;
  },
};
