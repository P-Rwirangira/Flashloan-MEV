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

  uniswapV3FlashCallback(
    fee0: BigNumberish,
    fee1: BigNumberish,
    data: string
  ): Promise<void>;

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