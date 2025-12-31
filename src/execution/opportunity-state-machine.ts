/**
 * Opportunity State Machine
 *
 * Manages opportunity lifecycle states with validation, persistence, and event emission
 * Requirements: 1.5, 2.2
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';
import {
  OpportunityState,
  OpportunityStateData,
  OpportunityStateTransition,
  StateChangeEvent,
  StateQueryOptions,
  StateQueryResult,
  StateMachineConfig,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  ACTIVE_STATES,
  InvalidStateTransitionError,
  OpportunityNotFoundError,
  StateExpiredError,
} from '../types/execution-state';

/**
 * Opportunity State Machine Implementation
 */
export class OpportunityStateMachine extends EventEmitter {
  private readonly logger = createComponentLogger('state-machine');
  private readonly config: StateMachineConfig;
  private readonly opportunities = new Map<string, OpportunityStateData>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(config: Partial<StateMachineConfig> = {}) {
    super();

    this.config = {
      enablePersistence: config.enablePersistence ?? true,
      maxRetainedStates: config.maxRetainedStates ?? 10000,
      stateExpirationMs: config.stateExpirationMs ?? 24 * 60 * 60 * 1000, // 24 hours
      enableTransitionValidation: config.enableTransitionValidation ?? true,
      enableEventEmission: config.enableEventEmission ?? true,
      ...config,
    };

    // Start cleanup interval for expired states
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredStates();
    }, 60000); // Every minute

    this.logger.info('Opportunity state machine initialized', {
      config: this.config,
    });
  }

  /**
   * Create a new opportunity state
   */
  createOpportunity(
    opportunityId: string,
    initialState: OpportunityState = OpportunityState.DETECTED,
    expiresAt?: number,
    metadata: Record<string, any> = {}
  ): OpportunityStateData {
    if (this.opportunities.has(opportunityId)) {
      throw new Error(`Opportunity ${opportunityId} already exists`);
    }

    const now = Date.now();
    const stateData: OpportunityStateData = {
      id: opportunityId,
      state: initialState,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      transitions: [],
      metadata: { ...metadata },
    };

    this.opportunities.set(opportunityId, stateData);

    this.logger.debug('Opportunity created', {
      opportunityId,
      initialState,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    });

    // Emit creation event
    if (this.config.enableEventEmission) {
      this.emit('opportunityCreated', {
        opportunityId,
        state: initialState,
        timestamp: now,
        metadata,
      });
    }

    // Check retention limits
    this.enforceRetentionLimits();

    return { ...stateData };
  }

  /**
   * Transition opportunity to new state
   */
  transition(
    opportunityId: string,
    newState: OpportunityState,
    reason?: string,
    metadata?: Record<string, any>
  ): boolean {
    const stateData = this.opportunities.get(opportunityId);
    if (!stateData) {
      throw new OpportunityNotFoundError(opportunityId);
    }

    // Check if opportunity has expired
    if (stateData.expiresAt && Date.now() > stateData.expiresAt) {
      throw new StateExpiredError(opportunityId, stateData.state);
    }

    const currentState = stateData.state;

    // Validate transition if enabled
    if (this.config.enableTransitionValidation) {
      if (!this.isValidTransition(currentState, newState)) {
        throw new InvalidStateTransitionError(currentState, newState, opportunityId);
      }
    }

    // Perform transition
    const now = Date.now();
    const transition: OpportunityStateTransition = {
      from: currentState,
      to: newState,
      timestamp: now,
      reason,
      metadata,
    };

    stateData.state = newState;
    stateData.updatedAt = now;
    stateData.transitions.push(transition);

    // Update metadata if provided
    if (metadata) {
      stateData.metadata = { ...stateData.metadata, ...metadata };
    }

    this.logger.debug('State transition completed', {
      opportunityId,
      from: currentState,
      to: newState,
      reason,
    });

    // Emit state change event
    if (this.config.enableEventEmission) {
      const event: StateChangeEvent = {
        opportunityId,
        previousState: currentState,
        newState,
        timestamp: now,
        reason,
        metadata,
      };

      this.emit('stateChanged', event);

      // Emit specific state events
      this.emit(`state:${newState}`, event);

      // Emit terminal state event if applicable
      if (TERMINAL_STATES.has(newState)) {
        this.emit('opportunityTerminated', event);
      }
    }

    return true;
  }

  /**
   * Get opportunity state data
   */
  getOpportunity(opportunityId: string): OpportunityStateData | undefined {
    const stateData = this.opportunities.get(opportunityId);
    return stateData ? { ...stateData } : undefined;
  }

  /**
   * Get current state of opportunity
   */
  getState(opportunityId: string): OpportunityState | undefined {
    return this.opportunities.get(opportunityId)?.state;
  }

  /**
   * Check if opportunity exists
   */
  hasOpportunity(opportunityId: string): boolean {
    return this.opportunities.has(opportunityId);
  }

  /**
   * Query opportunities by criteria
   */
  queryOpportunities(options: StateQueryOptions = {}): StateQueryResult {
    const { states, fromTimestamp, toTimestamp, limit = 100, includeTransitions = false } = options;

    let filtered = Array.from(this.opportunities.values());

    // Filter by states
    if (states && states.length > 0) {
      filtered = filtered.filter(opp => states.includes(opp.state));
    }

    // Filter by timestamp range
    if (fromTimestamp) {
      filtered = filtered.filter(opp => opp.updatedAt >= fromTimestamp);
    }
    if (toTimestamp) {
      filtered = filtered.filter(opp => opp.updatedAt <= toTimestamp);
    }

    // Sort by updated timestamp (newest first)
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);

    const totalCount = filtered.length;
    const hasMore = totalCount > limit;

    // Apply limit
    if (limit > 0) {
      filtered = filtered.slice(0, limit);
    }

    // Prepare results
    const opportunities = filtered.map(opp => ({
      ...opp,
      transitions: includeTransitions ? [...opp.transitions] : [],
    }));

    return {
      opportunities,
      totalCount,
      hasMore,
    };
  }

  /**
   * Get opportunities in active states
   */
  getActiveOpportunities(): OpportunityStateData[] {
    return this.queryOpportunities({
      states: Array.from(ACTIVE_STATES),
    }).opportunities;
  }

  /**
   * Get opportunities in terminal states
   */
  getTerminalOpportunities(): OpportunityStateData[] {
    return this.queryOpportunities({
      states: Array.from(TERMINAL_STATES),
    }).opportunities;
  }

  /**
   * Get state machine statistics
   */
  getStatistics(): {
    totalOpportunities: number;
    activeOpportunities: number;
    terminalOpportunities: number;
    stateDistribution: Record<OpportunityState, number>;
    avgTransitionsPerOpportunity: number;
  } {
    const all = Array.from(this.opportunities.values());
    const stateDistribution: Record<OpportunityState, number> = {} as any;

    // Initialize state distribution
    Object.values(OpportunityState).forEach(state => {
      stateDistribution[state] = 0;
    });

    // Count states and transitions
    let totalTransitions = 0;
    all.forEach(opp => {
      stateDistribution[opp.state]++;
      totalTransitions += opp.transitions.length;
    });

    const activeCount = all.filter(opp => ACTIVE_STATES.has(opp.state)).length;
    const terminalCount = all.filter(opp => TERMINAL_STATES.has(opp.state)).length;

    return {
      totalOpportunities: all.length,
      activeOpportunities: activeCount,
      terminalOpportunities: terminalCount,
      stateDistribution,
      avgTransitionsPerOpportunity: all.length > 0 ? totalTransitions / all.length : 0,
    };
  }

  /**
   * Remove opportunity from state machine
   */
  removeOpportunity(opportunityId: string): boolean {
    const existed = this.opportunities.delete(opportunityId);

    if (existed) {
      this.logger.debug('Opportunity removed', { opportunityId });

      if (this.config.enableEventEmission) {
        this.emit('opportunityRemoved', {
          opportunityId,
          timestamp: Date.now(),
        });
      }
    }

    return existed;
  }

  /**
   * Clear all opportunities
   */
  clear(): void {
    const count = this.opportunities.size;
    this.opportunities.clear();

    this.logger.info('All opportunities cleared', { count });

    if (this.config.enableEventEmission) {
      this.emit('allOpportunitiesCleared', {
        count,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Validate state transition
   */
  private isValidTransition(from: OpportunityState, to: OpportunityState): boolean {
    const validTransitions = VALID_TRANSITIONS[from];
    return validTransitions ? validTransitions.includes(to) : false;
  }

  /**
   * Clean up expired states
   */
  private cleanupExpiredStates(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, stateData] of this.opportunities) {
      // Check explicit expiration
      if (stateData.expiresAt && now > stateData.expiresAt) {
        expiredIds.push(id);
        continue;
      }

      // Check age-based expiration for terminal states
      if (TERMINAL_STATES.has(stateData.state)) {
        const age = now - stateData.updatedAt;
        if (age > this.config.stateExpirationMs) {
          expiredIds.push(id);
        }
      }
    }

    // Remove expired opportunities
    expiredIds.forEach(id => {
      const stateData = this.opportunities.get(id);
      if (stateData && !TERMINAL_STATES.has(stateData.state)) {
        // Transition to expired state if not already terminal
        try {
          this.transition(id, OpportunityState.EXPIRED, 'Automatic expiration');
        } catch (error) {
          this.logger.warn('Failed to transition expired opportunity', {
            opportunityId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // Remove terminal expired opportunities
        this.removeOpportunity(id);
      }
    });

    if (expiredIds.length > 0) {
      this.logger.debug('Cleaned up expired opportunities', {
        count: expiredIds.length,
      });
    }
  }

  /**
   * Enforce retention limits
   */
  private enforceRetentionLimits(): void {
    if (this.opportunities.size <= this.config.maxRetainedStates) {
      return;
    }

    // Get terminal opportunities sorted by age (oldest first)
    const terminalOpportunities = Array.from(this.opportunities.values())
      .filter(opp => TERMINAL_STATES.has(opp.state))
      .sort((a, b) => a.updatedAt - b.updatedAt);

    const excessCount = this.opportunities.size - this.config.maxRetainedStates;
    const toRemove = terminalOpportunities.slice(
      0,
      Math.min(excessCount, terminalOpportunities.length)
    );

    toRemove.forEach(opp => {
      this.removeOpportunity(opp.id);
    });

    if (toRemove.length > 0) {
      this.logger.debug('Enforced retention limits', {
        removed: toRemove.length,
        remaining: this.opportunities.size,
      });
    }
  }

  /**
   * Shutdown state machine
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.logger.info('Opportunity state machine shutdown', {
      finalOpportunityCount: this.opportunities.size,
    });

    this.removeAllListeners();
  }
}
