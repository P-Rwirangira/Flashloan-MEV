/**
 * Transaction Types
 *
 * Types for transaction lifecycle management
 * Requirements: 1.2, 1.14
 */

import { Address } from './common';

/**
 * Transaction stages in lifecycle
 */
export enum TransactionStage {
  BUILDING = 'building',
  BUILT = 'built',
  SIMULATING = 'simulating',
  SIMULATED = 'simulated',
  SUBMITTING = 'submitting',
  SUBMITTED = 'submitted',
  PENDING = 'pending',
  CONFIRMING = 'confirming',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REPLACED = 'replaced',
}

/**
 * Transaction request structure
 */
export interface TransactionRequest {
  to: Address;
  data: string;
  value?: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce?: number;
  type?: number; // EIP-1559 type 2
}

/**
 * Transaction receipt information
 */
export interface TransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  from: Address;
  to: Address;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  status: number; // 1 for success, 0 for failure
  logs: TransactionLog[];
  cumulativeGasUsed: bigint;
}

/**
 * Transaction log entry
 */
export interface TransactionLog {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  logIndex: number;
}

/**
 * Transaction lifecycle data
 */
export interface TransactionLifecycleData {
  opportunityId: string;
  stage: TransactionStage;
  transaction?: TransactionRequest;
  transactionHash?: string;
  receipt?: TransactionReceipt;
  submissionAttempts: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  actualProfit?: bigint;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  metadata: Record<string, any>;
  stageHistory: TransactionStageTransition[];
}

/**
 * Transaction stage transition
 */
export interface TransactionStageTransition {
  from: TransactionStage;
  to: TransactionStage;
  timestamp: number;
  reason?: string;
  metadata?: Record<string, any>;
}

/**
 * Transaction submission result
 */
export interface TransactionSubmissionResult {
  success: boolean;
  transactionHash?: string;
  nonce?: number;
  gasPrice?: bigint;
  failureReason?: string;
  submissionTime: number;
}

/**
 * Transaction confirmation result
 */
export interface TransactionConfirmationResult {
  success: boolean;
  receipt?: TransactionReceipt;
  confirmationTime: number;
  blockNumber?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  failureReason?: string;
}

/**
 * Transaction replacement options
 */
export interface TransactionReplacementOptions {
  newGasPrice?: bigint;
  newMaxFeePerGas?: bigint;
  newMaxPriorityFeePerGas?: bigint;
  newData?: string;
  reason: string;
}

/**
 * Transaction simulation result
 */
export interface TransactionSimulationResult {
  success: boolean;
  gasUsed?: bigint;
  returnData?: string;
  revertReason?: string;
  stateChanges?: StateChange[];
  simulationTime: number;
}

/**
 * State change from simulation
 */
export interface StateChange {
  address: Address;
  slot: string;
  from: string;
  to: string;
}

/**
 * Gas estimation result
 */
export interface GasEstimationResult {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  estimatedCost: bigint;
  confidence: number; // 0-1 scale
}

/**
 * Transaction lifecycle manager configuration
 */
export interface TransactionLifecycleManagerConfig {
  maxSubmissionAttempts: number;
  submissionRetryDelayMs: number;
  confirmationTimeoutMs: number;
  confirmationBlocks: number;
  gasEstimationBuffer: number; // Percentage buffer for gas estimates
  enableSimulation: boolean;
  enableReplacement: boolean;
  replacementGasMultiplier: number;
  maxReplacementAttempts: number;
  enableNonceManagement: boolean;
  nonceGapRecovery: boolean;
}

/**
 * Nonce management state
 */
export interface NonceState {
  address: Address;
  currentNonce: number;
  pendingNonces: Set<number>;
  lastUpdated: number;
}

/**
 * Transaction pool status
 */
export interface TransactionPoolStatus {
  pending: number;
  queued: number;
  baseFee: bigint;
  gasPrice: bigint;
  congestionLevel: 'low' | 'medium' | 'high';
}

/**
 * Transaction lifecycle manager interface
 */
export interface ITransactionLifecycleManager {
  /**
   * Build transaction from parameters
   */
  buildTransaction(
    to: Address,
    data: string,
    value?: bigint,
    gasOptions?: Partial<GasEstimationResult>
  ): Promise<TransactionRequest>;

  /**
   * Simulate transaction execution
   */
  simulateTransaction(transaction: TransactionRequest): Promise<TransactionSimulationResult>;

  /**
   * Submit transaction to network
   */
  submitTransaction(
    opportunityId: string,
    transaction: TransactionRequest
  ): Promise<TransactionSubmissionResult>;

  /**
   * Monitor transaction confirmation
   */
  monitorConfirmation(
    opportunityId: string,
    transactionHash: string,
    timeoutMs?: number
  ): Promise<TransactionConfirmationResult>;

  /**
   * Replace transaction (RBF)
   */
  replaceTransaction(
    opportunityId: string,
    options: TransactionReplacementOptions
  ): Promise<TransactionSubmissionResult>;

  /**
   * Cancel transaction
   */
  cancelTransaction(opportunityId: string, reason: string): Promise<boolean>;

  /**
   * Get transaction lifecycle data
   */
  getTransactionData(opportunityId: string): TransactionLifecycleData | undefined;

  /**
   * Process complete transaction lifecycle
   */
  processTransaction(
    opportunityId: string,
    transactionBuilder: () => Promise<TransactionRequest>
  ): Promise<TransactionConfirmationResult>;
}

/**
 * Transaction events
 */
export interface TransactionEvents {
  transactionBuilt: {
    opportunityId: string;
    transaction: TransactionRequest;
    timestamp: number;
  };

  transactionSimulated: {
    opportunityId: string;
    result: TransactionSimulationResult;
    timestamp: number;
  };

  transactionSubmitted: {
    opportunityId: string;
    transactionHash: string;
    nonce: number;
    gasPrice: bigint;
    timestamp: number;
  };

  transactionConfirmed: {
    opportunityId: string;
    receipt: TransactionReceipt;
    confirmationTime: number;
    timestamp: number;
  };

  transactionFailed: {
    opportunityId: string;
    stage: TransactionStage;
    reason: string;
    transactionHash?: string;
    timestamp: number;
  };

  transactionReplaced: {
    opportunityId: string;
    oldHash: string;
    newHash: string;
    reason: string;
    timestamp: number;
  };

  transactionCancelled: {
    opportunityId: string;
    reason: string;
    timestamp: number;
  };
}

/**
 * Transaction error types
 */
export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly opportunityId: string,
    public readonly stage: TransactionStage,
    public readonly transactionHash?: string
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

export class TransactionBuildError extends TransactionError {
  constructor(opportunityId: string, reason: string) {
    super(`Transaction build failed: ${reason}`, opportunityId, TransactionStage.BUILDING);
    this.name = 'TransactionBuildError';
  }
}

export class TransactionSimulationError extends TransactionError {
  constructor(
    opportunityId: string,
    public readonly revertReason?: string,
    public readonly gasUsed?: bigint
  ) {
    super(
      `Transaction simulation failed${revertReason ? `: ${revertReason}` : ''}`,
      opportunityId,
      TransactionStage.SIMULATING
    );
    this.name = 'TransactionSimulationError';
  }
}

export class TransactionSubmissionError extends TransactionError {
  constructor(
    opportunityId: string,
    reason: string,
    public readonly nonce?: number
  ) {
    super(`Transaction submission failed: ${reason}`, opportunityId, TransactionStage.SUBMITTING);
    this.name = 'TransactionSubmissionError';
  }
}

export class TransactionConfirmationError extends TransactionError {
  constructor(opportunityId: string, transactionHash: string, reason: string) {
    super(
      `Transaction confirmation failed: ${reason}`,
      opportunityId,
      TransactionStage.CONFIRMING,
      transactionHash
    );
    this.name = 'TransactionConfirmationError';
  }
}

export class TransactionTimeoutError extends TransactionError {
  constructor(opportunityId: string, transactionHash: string, timeoutMs: number) {
    super(
      `Transaction confirmation timeout after ${timeoutMs}ms`,
      opportunityId,
      TransactionStage.CONFIRMING,
      transactionHash
    );
    this.name = 'TransactionTimeoutError';
  }
}

export class TransactionReplacedError extends TransactionError {
  constructor(
    opportunityId: string,
    oldHash: string,
    public readonly newHash: string
  ) {
    super(
      `Transaction was replaced: ${oldHash} -> ${newHash}`,
      opportunityId,
      TransactionStage.REPLACED,
      oldHash
    );
    this.name = 'TransactionReplacedError';
  }
}

export class NonceGapError extends TransactionError {
  constructor(
    opportunityId: string,
    public readonly expectedNonce: number,
    public readonly actualNonce: number
  ) {
    super(
      `Nonce gap detected: expected ${expectedNonce}, got ${actualNonce}`,
      opportunityId,
      TransactionStage.SUBMITTING
    );
    this.name = 'NonceGapError';
  }
}
