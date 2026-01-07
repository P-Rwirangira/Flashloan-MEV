/**
 * Execution State Types
 *
 * Defines state management types for opportunity execution lifecycle
 * Requirements: 1.5, 2.2
 */

import { Address } from './common';

/**
 * Opportunity execution states
 */
export enum OpportunityState {
  DETECTED = 'detected',
  VALIDATING = 'validating',
  SIMULATING = 'simulating',
  QUEUED = 'queued',
  EXECUTING = 'executing',
  PENDING = 'pending',
  CONFIRMING = 'confirming',
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * State transition record
 */
export interface OpportunityStateTransition {
  from: OpportunityState;
  to: OpportunityState;
  timestamp: number;
  reason?: string | undefined;
  metadata?: Record<string, any> | undefined;
}

/**
 * Opportunity state data
 */
export interface OpportunityStateData {
  id: string;
  state: OpportunityState;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number | undefined;
  transitions: OpportunityStateTransition[];
  metadata: Record<string, any>;
  executorAddress?: Address | undefined; // Address of the executor handling this opportunity
  originAddress?: Address | undefined; // Address where the opportunity was detected (e.g., pool address)
}

/**
 * State machine events
 */
export interface StateChangeEvent {
  opportunityId: string;
  previousState: OpportunityState;
  newState: OpportunityState;
  timestamp: number;
  reason?: string | undefined;
  metadata?: Record<string, any> | undefined;
}

/**
 * State query options
 */
export interface StateQueryOptions {
  states?: OpportunityState[];
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  includeTransitions?: boolean;
}

/**
 * State query result
 */
export interface StateQueryResult {
  opportunities: OpportunityStateData[];
  totalCount: number;
  hasMore: boolean;
}

/**
 * State machine configuration
 */
export interface StateMachineConfig {
  enablePersistence: boolean;
  maxRetainedStates: number;
  stateExpirationMs: number;
  enableTransitionValidation: boolean;
  enableEventEmission: boolean;
  defaultExecutorAddress?: Address | undefined; // Default executor address for opportunities
  trackOriginAddresses?: boolean | undefined; // Whether to track origin addresses in state data
}

/**
 * Valid state transitions map
 */
export const VALID_TRANSITIONS: Record<OpportunityState, OpportunityState[]> = {
  [OpportunityState.DETECTED]: [
    OpportunityState.VALIDATING,
    OpportunityState.EXPIRED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.VALIDATING]: [
    OpportunityState.SIMULATING,
    OpportunityState.FAILED,
    OpportunityState.EXPIRED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.SIMULATING]: [
    OpportunityState.QUEUED,
    OpportunityState.FAILED,
    OpportunityState.EXPIRED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.QUEUED]: [
    OpportunityState.EXECUTING,
    OpportunityState.EXPIRED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.EXECUTING]: [
    OpportunityState.PENDING,
    OpportunityState.FAILED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.PENDING]: [
    OpportunityState.CONFIRMING,
    OpportunityState.FAILED,
    OpportunityState.CANCELLED,
  ],
  [OpportunityState.CONFIRMING]: [OpportunityState.COMPLETED, OpportunityState.FAILED],
  [OpportunityState.COMPLETED]: [], // Terminal state
  [OpportunityState.FAILED]: [], // Terminal state
  [OpportunityState.EXPIRED]: [], // Terminal state
  [OpportunityState.CANCELLED]: [], // Terminal state
};

/**
 * Terminal states that cannot transition further
 */
export const TERMINAL_STATES: Set<OpportunityState> = new Set([
  OpportunityState.COMPLETED,
  OpportunityState.FAILED,
  OpportunityState.EXPIRED,
  OpportunityState.CANCELLED,
]);

/**
 * Active states that indicate ongoing processing
 */
export const ACTIVE_STATES: Set<OpportunityState> = new Set([
  OpportunityState.DETECTED,
  OpportunityState.VALIDATING,
  OpportunityState.SIMULATING,
  OpportunityState.QUEUED,
  OpportunityState.EXECUTING,
  OpportunityState.PENDING,
  OpportunityState.CONFIRMING,
]);

/**
 * Error types for state machine operations
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: OpportunityState,
    public readonly to: OpportunityState,
    public readonly opportunityId?: string
  ) {
    super(
      `Invalid state transition from ${from} to ${to}${opportunityId ? ` for opportunity ${opportunityId}` : ''}`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class OpportunityNotFoundError extends Error {
  constructor(public readonly opportunityId: string) {
    super(`Opportunity not found: ${opportunityId}`);
    this.name = 'OpportunityNotFoundError';
  }
}

export class StateExpiredError extends Error {
  constructor(
    public readonly opportunityId: string,
    public readonly state: OpportunityState
  ) {
    super(`Opportunity ${opportunityId} has expired in state ${state}`);
    this.name = 'StateExpiredError';
  }
}
