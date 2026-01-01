/**
 * Private Relay Types
 *
 * Types for private relay integration and MEV protection
 * Requirements: 1.3
 */

import { Address } from './common';
import { TransactionRequest } from './transaction';

/**
 * Supported private relay providers
 */
export enum RelayProvider {
  FLASHBOTS_PROTECT = 'flashbots-protect',
  BLOXROUTE = 'bloxroute',
  LOCAL_NODE = 'local-node',
}

/**
 * Relay authentication configuration
 */
export interface RelayAuthentication {
  type: 'none' | 'api-key' | 'signature' | 'bearer';
  apiKey?: string;
  privateKey?: string;
  bearerToken?: string;
  customHeaders?: Record<string, string>;
}

/**
 * Relay capabilities and features
 */
export interface RelayCapabilities {
  supportsBundle: boolean;
  supportsCancellation: boolean;
  supportsReplacement: boolean;
  supportsSimulation: boolean;
  maxTransactionsPerBundle: number;
  estimatedInclusionTime: number; // milliseconds
  supportedChains: number[];
}

/**
 * Relay cost structure
 */
export interface RelayCosts {
  baseFee: bigint;
  priorityFeeMultiplier: number;
  bundleFee?: bigint;
  maxBribe?: bigint;
  costPerGas?: bigint;
}

/**
 * Relay performance metrics
 */
export interface RelayMetrics {
  totalSubmissions: number;
  successfulSubmissions: number;
  failedSubmissions: number;
  avgLatency: number;
  successRate: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
}

/**
 * Relay provider configuration
 */
export interface RelayProviderConfig {
  name: string;
  provider: RelayProvider;
  endpoint: string;
  authentication: RelayAuthentication;
  capabilities: RelayCapabilities;
  costs: RelayCosts;
  enabled: boolean;
  priority: number; // Lower number = higher priority
  maxRetries: number;
  timeoutMs: number;
}

/**
 * Transaction submission options
 */
export interface SubmissionOptions {
  maxBribe?: bigint;
  targetBlockNumber?: number;
  urgency?: 'low' | 'medium' | 'high' | 'critical';
  enableFallback?: boolean;
  preferredRelay?: RelayProvider;
  bundleTransactions?: TransactionRequest[];
  simulateFirst?: boolean;
  fromAddress?: Address; // Address to submit from for validation
}

/**
 * Relay submission result
 */
export interface RelaySubmissionResult {
  success: boolean;
  relayProvider: RelayProvider;
  transactionHash?: string;
  bundleHash?: string;
  submissionId?: string;
  latency: number;
  gasPriceUsed?: bigint;
  bribeAmount?: bigint;
  failureReason?: string;
  retryCount: number;
  timestamp: number;
  pending?: boolean;
}

/**
 * Bundle submission for multiple transactions
 */
export interface BundleSubmission {
  transactions: TransactionRequest[];
  targetBlockNumber?: number;
  maxBribe?: bigint;
  minTimestamp?: number;
  maxTimestamp?: number;
}

/**
 * Bundle submission result
 */
export interface BundleSubmissionResult {
  success: boolean;
  bundleHash?: string | undefined;
  submissionId?: string | undefined;
  relayProvider: RelayProvider;
  transactionHashes?: string[] | undefined;
  latency: number;
  totalBribe?: bigint | undefined;
  failureReason?: string | undefined;
  timestamp: number;
}

/**
 * Relay selection criteria
 */
export interface RelaySelectionCriteria {
  transaction: TransactionRequest;
  options: SubmissionOptions;
  currentGasPrice: bigint;
  networkCongestion: 'low' | 'medium' | 'high';
  urgency: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Private relay manager configuration
 */
export interface PrivateRelayManagerConfig {
  defaultRelay: RelayProvider;
  enableFallback: boolean;
  maxConcurrentSubmissions: number;
  selectionStrategy: 'cost' | 'speed' | 'reliability' | 'balanced';
  enableMetrics: boolean;
  metricsRetentionMs: number;
  enableBundles: boolean;
  maxBundleSize: number;
  relayProviders: RelayProviderConfig[];
}

/**
 * Private relay manager interface
 */
export interface IPrivateRelayManager {
  /**
   * Submit transaction via optimal relay
   */
  submitTransaction(
    transaction: TransactionRequest,
    options?: SubmissionOptions
  ): Promise<RelaySubmissionResult>;

  /**
   * Submit bundle of transactions
   */
  submitBundle(
    bundle: BundleSubmission,
    options?: SubmissionOptions
  ): Promise<BundleSubmissionResult>;

  /**
   * Get optimal relay for transaction
   */
  selectOptimalRelay(criteria: RelaySelectionCriteria): Promise<RelayProviderConfig>;

  /**
   * Get relay metrics
   */
  getRelayMetrics(provider?: RelayProvider): RelayMetrics | Record<RelayProvider, RelayMetrics>;

  /**
   * Check relay availability
   */
  checkRelayHealth(provider: RelayProvider): Promise<boolean>;

  /**
   * Update relay configuration
   */
  updateRelayConfig(provider: RelayProvider, config: Partial<RelayProviderConfig>): void;
}

/**
 * Relay events
 */
export interface RelayEvents {
  transactionSubmitted: {
    relayProvider: RelayProvider;
    transactionHash?: string | undefined;
    latency: number;
    timestamp: number;
  };

  transactionFailed: {
    relayProvider: RelayProvider;
    reason: string;
    retryCount: number;
    timestamp: number;
  };

  relayUnavailable: {
    relayProvider: RelayProvider;
    reason: string;
    timestamp: number;
  };

  relayRecovered: {
    relayProvider: RelayProvider;
    downtime: number;
    timestamp: number;
  };

  bundleSubmitted: {
    relayProvider: RelayProvider;
    bundleHash?: string | undefined;
    transactionCount: number;
    timestamp: number;
  };

  fallbackActivated: {
    originalRelay: RelayProvider;
    fallbackRelay: RelayProvider;
    reason: string;
    timestamp: number;
  };
}

/**
 * Relay error types
 */
export class RelayError extends Error {
  constructor(
    message: string,
    public readonly provider: RelayProvider,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class RelayUnavailableError extends RelayError {
  constructor(provider: RelayProvider, reason: string) {
    super(`Relay ${provider} unavailable: ${reason}`, provider, true);
    this.name = 'RelayUnavailableError';
  }
}

export class RelayAuthenticationError extends RelayError {
  constructor(provider: RelayProvider, reason: string) {
    super(`Authentication failed for ${provider}: ${reason}`, provider, false);
    this.name = 'RelayAuthenticationError';
  }
}

export class RelayTimeoutError extends RelayError {
  constructor(provider: RelayProvider, timeoutMs: number) {
    super(`Relay ${provider} timeout after ${timeoutMs}ms`, provider, true);
    this.name = 'RelayTimeoutError';
  }
}

export class BundleSubmissionError extends RelayError {
  constructor(
    provider: RelayProvider,
    reason: string,
    public readonly bundleHash?: string
  ) {
    super(`Bundle submission failed on ${provider}: ${reason}`, provider, true);
    this.name = 'BundleSubmissionError';
  }
}
