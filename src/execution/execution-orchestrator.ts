/**
 * Execution Orchestrator
 *
 * Central coordinator that manages execution across all opportunity types
 * Requirements: 1.1, 1.12, 1.15
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';
import { OpportunityStateMachine } from './opportunity-state-machine';
import { OpportunityState } from '../types/execution-state';
import {
  BaseOpportunity,
  ExecutionResult,
  ExecutionStatus,
  ExecutionCapacity,
  ExecutionPriority,
  QueuedOpportunity,
  IExecutionEngine,
  ExecutionOrchestratorConfig,
  ResourceAllocation,
  ExecutionMetrics,
  OpportunityType,
  OpportunityPhase,
  ExecutionContext,
} from '../types/execution';

/**
 * Priority queue for opportunities
 */
class PriorityQueue<T> {
  private items: Array<{ item: T; priority: number }> = [];

  enqueue(item: T, priority: number): void {
    const queueItem = { item, priority };
    let added = false;

    for (let i = 0; i < this.items.length; i++) {
      const currentItem = this.items[i];
      if (currentItem && queueItem.priority > currentItem.priority) {
        this.items.splice(i, 0, queueItem);
        added = true;
        break;
      }
    }

    if (!added) {
      this.items.push(queueItem);
    }
  }

  dequeue(): T | undefined {
    const item = this.items.shift();
    return item?.item;
  }

  peek(): T | undefined {
    return this.items[0]?.item;
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  toArray(): T[] {
    return this.items.map(item => item.item);
  }
}

/**
 * Execution Orchestrator Implementation
 */
export class ExecutionOrchestrator extends EventEmitter {
  private readonly logger = createComponentLogger('execution-orchestrator');
  private readonly config: ExecutionOrchestratorConfig;
  private readonly stateMachine: OpportunityStateMachine;
  private readonly executionEngines = new Map<OpportunityType, IExecutionEngine>();
  private readonly executionQueue = new PriorityQueue<QueuedOpportunity>();
  private readonly activeExecutions = new Map<string, Promise<ExecutionResult>>();
  private readonly resourceAllocations = new Map<string, ResourceAllocation>();

  private isRunning = false;
  private isPaused = false;
  private circuitBreakerActive = false;
  private circuitBreakerReason?: string | undefined;
  private consecutiveFailures = 0;
  private lastExecutionAt?: number;

  // Metrics
  private metrics: ExecutionMetrics = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    totalProfit: 0n,
    totalGasCost: 0n,
    avgExecutionTime: 0,
    successRate: 0,
    profitPerExecution: 0n,
    executionsByType: {} as Record<OpportunityType, number>,
    executionsByPhase: {} as Record<OpportunityPhase, number>,
  };

  private executionTimes: number[] = [];
  private processingInterval?: NodeJS.Timeout | undefined;
  private circuitBreakerRecoveryTimer?: NodeJS.Timeout | undefined;

  constructor(
    config: Partial<ExecutionOrchestratorConfig> = {},
    stateMachine?: OpportunityStateMachine
  ) {
    super();

    this.config = {
      maxConcurrentExecutions: config.maxConcurrentExecutions ?? 3,
      executionTimeoutMs: config.executionTimeoutMs ?? 45000,
      queueMaxSize: config.queueMaxSize ?? 100,
      priorityWeights: config.priorityWeights ?? {
        [ExecutionPriority.LOW]: 1,
        [ExecutionPriority.NORMAL]: 2,
        [ExecutionPriority.HIGH]: 3,
        [ExecutionPriority.CRITICAL]: 4,
      },
      enableCircuitBreaker: config.enableCircuitBreaker ?? true,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerRecoveryTimeMs: config.circuitBreakerRecoveryTimeMs ?? 300000, // 5 minutes
      enableGracefulShutdown: config.enableGracefulShutdown ?? true,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 30000,
      ...config,
    };

    this.stateMachine = stateMachine || new OpportunityStateMachine();

    // Initialize metrics by type and phase
    Object.values(OpportunityType).forEach(type => {
      this.metrics.executionsByType[type] = 0;
    });
    Object.values(OpportunityPhase).forEach(phase => {
      this.metrics.executionsByPhase[phase] = 0;
    });

    this.setupEventHandlers();
    this.logger.info('Execution orchestrator initialized', { config: this.config });
  }

  /**
   * Register execution engine for opportunity type
   */
  registerExecutionEngine(type: OpportunityType, engine: IExecutionEngine): void {
    this.executionEngines.set(type, engine);
    this.logger.info('Execution engine registered', { type });
  }

  /**
   * Process opportunity for execution
   */
  async processOpportunity(opportunity: BaseOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Create opportunity in state machine
      this.stateMachine.createOpportunity(
        opportunity.id,
        OpportunityState.DETECTED,
        opportunity.expiresAt,
        { type: opportunity.type, phase: opportunity.phase },
        undefined, // executorAddress - will use default from config
        (opportunity as any).poolAddress || (opportunity as any).originAddress // originAddress from opportunity data
      );

      // Check if orchestrator is running and not paused
      if (!this.isRunning) {
        throw new Error('Execution orchestrator is not running');
      }

      if (this.isPaused) {
        throw new Error('Execution orchestrator is paused');
      }

      // Check circuit breaker
      if (this.circuitBreakerActive) {
        throw new Error(`Circuit breaker active: ${this.circuitBreakerReason}`);
      }

      // Validate opportunity
      await this.validateOpportunity(opportunity);

      // Calculate priority
      const priority = this.calculatePriority(opportunity);

      // Check capacity
      const capacity = this.getAvailableCapacity();
      if (
        capacity.availableCapacity <= 0 &&
        this.executionQueue.size() >= this.config.queueMaxSize
      ) {
        throw new Error('Execution queue is full');
      }

      // Queue or execute immediately
      if (capacity.availableCapacity > 0) {
        return await this.executeImmediately(opportunity);
      } else {
        return await this.queueForExecution(opportunity, priority);
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const result: ExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        executionTime,
        failureReason: error instanceof Error ? error.message : String(error),
      };

      this.handleExecutionFailure(opportunity, result);
      return result;
    }
  }

  /**
   * Get current execution status
   */
  getExecutionStatus(): ExecutionStatus {
    return {
      isRunning: this.isRunning,
      activeOpportunities: this.activeExecutions.size,
      queuedOpportunities: this.executionQueue.size(),
      successRate: this.metrics.successRate,
      avgLatency: this.metrics.avgExecutionTime,
      circuitBreakerActive: this.circuitBreakerActive,
      circuitBreakerReason: this.circuitBreakerReason,
      lastExecutionAt: this.lastExecutionAt,
    };
  }

  /**
   * Get available execution capacity
   */
  getAvailableCapacity(): ExecutionCapacity {
    const currentExecutions = this.activeExecutions.size;
    const availableCapacity = Math.max(0, this.config.maxConcurrentExecutions - currentExecutions);
    const queueLength = this.executionQueue.size();

    // Estimate wait time based on average execution time and queue position
    const estimatedWaitTime =
      queueLength > 0 && this.metrics.avgExecutionTime > 0
        ? (queueLength / Math.max(1, availableCapacity)) * this.metrics.avgExecutionTime
        : 0;

    return {
      maxConcurrentExecutions: this.config.maxConcurrentExecutions,
      currentExecutions,
      availableCapacity,
      queueLength,
      estimatedWaitTime,
    };
  }

  /**
   * Pause execution (emergency control)
   */
  pauseExecution(reason: string): void {
    this.isPaused = true;
    this.logger.warn('Execution paused', { reason });
    this.emit('executionPaused', { reason, timestamp: Date.now() });
  }

  /**
   * Resume execution
   */
  resumeExecution(): void {
    this.isPaused = false;
    this.logger.info('Execution resumed');
    this.emit('executionResumed', { timestamp: Date.now() });

    // Start processing queue if not already running
    this.startQueueProcessing();
  }

  /**
   * Start orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Execution orchestrator is already running');
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.circuitBreakerActive = false;
    this.consecutiveFailures = 0;

    this.startQueueProcessing();

    this.logger.info('Execution orchestrator started');
    this.emit('orchestratorStarted', { timestamp: Date.now() });
  }

  /**
   * Stop orchestrator
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Execution orchestrator is not running');
      return;
    }

    this.logger.info('Stopping execution orchestrator...');
    this.isRunning = false;

    // Stop queue processing
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    // Handle graceful shutdown
    if (this.config.enableGracefulShutdown && this.activeExecutions.size > 0) {
      this.logger.info('Waiting for active executions to complete...', {
        activeCount: this.activeExecutions.size,
      });

      const shutdownPromise = Promise.all(Array.from(this.activeExecutions.values()));
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(resolve, this.config.shutdownTimeoutMs);
      });

      await Promise.race([shutdownPromise, timeoutPromise]);
    }

    // Clear queue
    this.executionQueue.clear();

    // Clear circuit breaker recovery timer
    if (this.circuitBreakerRecoveryTimer) {
      clearTimeout(this.circuitBreakerRecoveryTimer);
      this.circuitBreakerRecoveryTimer = undefined;
    }

    // Shutdown state machine
    this.stateMachine.shutdown();

    this.logger.info('Execution orchestrator stopped');
    this.emit('orchestratorStopped', { timestamp: Date.now() });
  }

  /**
   * Get execution metrics
   */
  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  /**
   * Validate opportunity before execution
   */
  private async validateOpportunity(opportunity: BaseOpportunity): Promise<void> {
    this.stateMachine.transition(
      opportunity.id,
      OpportunityState.VALIDATING,
      'Starting validation'
    );

    // Check if execution engine exists for this type
    const engine = this.executionEngines.get(opportunity.type);
    if (!engine) {
      throw new Error(`No execution engine registered for type: ${opportunity.type}`);
    }

    // Check if opportunity has expired
    if (opportunity.expiresAt && Date.now() > opportunity.expiresAt) {
      throw new Error('Opportunity has expired');
    }

    // Check if engine can execute this opportunity
    const canExecute = await engine.canExecute(opportunity);
    if (!canExecute) {
      throw new Error('Execution engine cannot execute this opportunity');
    }

    this.stateMachine.transition(opportunity.id, OpportunityState.SIMULATING, 'Validation passed');
  }

  /**
   * Calculate execution priority
   */
  private calculatePriority(opportunity: BaseOpportunity): ExecutionPriority {
    // Base priority on profit and confidence
    const profitScore = Number(opportunity.estimatedProfit) / 1e18; // Convert to ETH
    const confidenceScore = opportunity.confidence;

    // Calculate time urgency (closer to expiration = higher priority)
    let urgencyScore = 1;
    if (opportunity.expiresAt) {
      const timeToExpiry = opportunity.expiresAt - Date.now();
      const maxTimeToExpiry = 60000; // 1 minute
      urgencyScore = Math.max(0, Math.min(1, 1 - timeToExpiry / maxTimeToExpiry));
    }

    const totalScore = profitScore * 0.4 + confidenceScore * 0.3 + urgencyScore * 0.3;

    if (totalScore >= 0.8) return ExecutionPriority.CRITICAL;
    if (totalScore >= 0.6) return ExecutionPriority.HIGH;
    if (totalScore >= 0.3) return ExecutionPriority.NORMAL;
    return ExecutionPriority.LOW;
  }

  /**
   * Execute opportunity immediately
   */
  private async executeImmediately(opportunity: BaseOpportunity): Promise<ExecutionResult> {
    this.stateMachine.transition(opportunity.id, OpportunityState.QUEUED, 'Executing immediately');
    return await this.executeOpportunity(opportunity);
  }

  /**
   * Queue opportunity for execution
   */
  private async queueForExecution(
    opportunity: BaseOpportunity,
    priority: ExecutionPriority
  ): Promise<ExecutionResult> {
    const engine = this.executionEngines.get(opportunity.type)!;
    const estimatedExecutionTime = await engine.estimateExecutionTime(opportunity);

    const queuedOpportunity: QueuedOpportunity = {
      opportunity,
      priority,
      queuedAt: Date.now(),
      estimatedExecutionTime,
    };

    this.executionQueue.enqueue(queuedOpportunity, this.config.priorityWeights[priority]);
    this.stateMachine.transition(
      opportunity.id,
      OpportunityState.QUEUED,
      'Added to execution queue'
    );

    this.logger.debug('Opportunity queued', {
      opportunityId: opportunity.id,
      priority,
      queueSize: this.executionQueue.size(),
    });

    // Return a promise that resolves when the opportunity is executed
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;

      const handleExecuted = (result: ExecutionResult) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.removeListener(`failed:${opportunity.id}`, handleFailed);
        resolve(result);
      };

      const handleFailed = (result: ExecutionResult) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.removeListener(`executed:${opportunity.id}`, handleExecuted);
        resolve(result);
      };

      const handleTimeout = () => {
        this.removeListener(`executed:${opportunity.id}`, handleExecuted);
        this.removeListener(`failed:${opportunity.id}`, handleFailed);
        reject(new Error('Execution timeout while queued'));
      };

      timeoutHandle = setTimeout(handleTimeout, this.config.executionTimeoutMs);

      this.once(`executed:${opportunity.id}`, handleExecuted);
      this.once(`failed:${opportunity.id}`, handleFailed);
    });
  }

  /**
   * Execute opportunity
   */
  private async executeOpportunity(opportunity: BaseOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();
    const engine = this.executionEngines.get(opportunity.type)!;

    try {
      // Allocate resources
      const allocation = await this.allocateResources(opportunity);
      this.resourceAllocations.set(opportunity.id, allocation);

      // Transition to executing state
      this.stateMachine.transition(
        opportunity.id,
        OpportunityState.EXECUTING,
        'Starting execution'
      );

      // Create execution context
      const context: ExecutionContext = {
        gasPrice: 20000000000n, // 20 gwei - will be enhanced later
        gasLimit: await engine.estimateGas(opportunity),
        blockNumber: 0, // Will be set by execution engine
        timestamp: Date.now(),
        nonce: 0, // Will be managed by transaction lifecycle manager
        maxFeePerGas: 25000000000n, // 25 gwei
        maxPriorityFeePerGas: 2000000000n, // 2 gwei
      };

      // Execute with timeout
      const executionPromise = engine.execute(opportunity, context);
      this.activeExecutions.set(opportunity.id, executionPromise);

      const timeoutPromise = new Promise<ExecutionResult>((_, reject) => {
        setTimeout(() => reject(new Error('Execution timeout')), this.config.executionTimeoutMs);
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Clean up
      this.activeExecutions.delete(opportunity.id);
      this.resourceAllocations.delete(opportunity.id);

      const executionTime = Date.now() - startTime;
      result.executionTime = executionTime;

      if (result.success) {
        this.handleExecutionSuccess(opportunity, result);
      } else {
        this.handleExecutionFailure(opportunity, result);
      }

      return result;
    } catch (error) {
      // Clean up on error
      this.activeExecutions.delete(opportunity.id);
      this.resourceAllocations.delete(opportunity.id);

      const executionTime = Date.now() - startTime;
      const result: ExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        executionTime,
        failureReason: error instanceof Error ? error.message : String(error),
      };

      this.handleExecutionFailure(opportunity, result);
      return result;
    }
  }

  /**
   * Allocate resources for execution
   */
  private async allocateResources(opportunity: BaseOpportunity): Promise<ResourceAllocation> {
    const engine = this.executionEngines.get(opportunity.type)!;
    const estimatedDuration = await engine.estimateExecutionTime(opportunity);
    const gasLimit = await engine.estimateGas(opportunity);

    return {
      opportunityId: opportunity.id,
      allocatedAt: Date.now(),
      estimatedDuration,
      resources: {
        gasLimit,
        flashLoanCapacity: opportunity.estimatedProfit, // Simplified for now
        relayCapacity: 1,
      },
    };
  }

  /**
   * Handle successful execution
   */
  private handleExecutionSuccess(opportunity: BaseOpportunity, result: ExecutionResult): void {
    this.stateMachine.transition(
      opportunity.id,
      OpportunityState.COMPLETED,
      'Execution successful'
    );

    // Update metrics
    this.metrics.totalExecutions++;
    this.metrics.successfulExecutions++;
    this.metrics.totalProfit += result.profit || 0n;
    this.metrics.totalGasCost += result.gasCost || 0n;
    this.metrics.executionsByType[opportunity.type]++;
    this.metrics.executionsByPhase[opportunity.phase]++;

    this.executionTimes.push(result.executionTime);
    this.updateDerivedMetrics();

    // Reset circuit breaker
    this.consecutiveFailures = 0;
    if (this.circuitBreakerActive) {
      this.circuitBreakerActive = false;
      this.circuitBreakerReason = undefined;
      this.logger.info('Circuit breaker reset after successful execution');
    }

    this.lastExecutionAt = Date.now();

    this.logger.info('Execution successful', {
      opportunityId: opportunity.id,
      profit: result.profit?.toString(),
      executionTime: result.executionTime,
    });

    this.emit(`executed:${opportunity.id}`, result);
    this.emit('executionSuccess', { opportunity, result });
  }

  /**
   * Handle failed execution
   */
  private handleExecutionFailure(opportunity: BaseOpportunity, result: ExecutionResult): void {
    this.stateMachine.transition(opportunity.id, OpportunityState.FAILED, result.failureReason);

    // Update metrics
    this.metrics.totalExecutions++;
    this.metrics.failedExecutions++;
    this.metrics.totalGasCost += result.gasCost || 0n;
    this.metrics.executionsByType[opportunity.type]++;
    this.metrics.executionsByPhase[opportunity.phase]++;

    this.executionTimes.push(result.executionTime);
    this.updateDerivedMetrics();

    // Handle circuit breaker
    this.consecutiveFailures++;
    if (
      this.config.enableCircuitBreaker &&
      this.consecutiveFailures >= this.config.circuitBreakerThreshold
    ) {
      this.activateCircuitBreaker(`${this.consecutiveFailures} consecutive failures`);
    }

    this.logger.warn('Execution failed', {
      opportunityId: opportunity.id,
      reason: result.failureReason,
      executionTime: result.executionTime,
    });

    this.emit(`failed:${opportunity.id}`, result);
    this.emit('executionFailure', { opportunity, result });
  }

  /**
   * Update derived metrics
   */
  private updateDerivedMetrics(): void {
    this.metrics.successRate =
      this.metrics.totalExecutions > 0
        ? this.metrics.successfulExecutions / this.metrics.totalExecutions
        : 0;

    this.metrics.avgExecutionTime =
      this.executionTimes.length > 0
        ? this.executionTimes.reduce((sum, time) => sum + time, 0) / this.executionTimes.length
        : 0;

    this.metrics.profitPerExecution =
      this.metrics.totalExecutions > 0
        ? this.metrics.totalProfit / BigInt(this.metrics.totalExecutions)
        : 0n;

    // Keep only recent execution times for rolling average
    if (this.executionTimes.length > 100) {
      this.executionTimes = this.executionTimes.slice(-100);
    }
  }

  /**
   * Activate circuit breaker
   */
  private activateCircuitBreaker(reason: string): void {
    this.circuitBreakerActive = true;
    this.circuitBreakerReason = reason;

    this.logger.error('Circuit breaker activated', { reason });
    this.emit('circuitBreakerActivated', { reason, timestamp: Date.now() });

    // Schedule recovery attempt
    this.circuitBreakerRecoveryTimer = setTimeout(() => {
      if (this.circuitBreakerActive) {
        this.logger.info('Attempting circuit breaker recovery');
        this.circuitBreakerActive = false;
        this.circuitBreakerReason = undefined;
        this.consecutiveFailures = 0;
        this.circuitBreakerRecoveryTimer = undefined;
        this.emit('circuitBreakerRecovered', { timestamp: Date.now() });
      }
    }, this.config.circuitBreakerRecoveryTimeMs);
  }

  /**
   * Start queue processing
   */
  private startQueueProcessing(): void {
    if (this.processingInterval) {
      return;
    }

    this.processingInterval = setInterval(async () => {
      if (!this.isRunning || this.isPaused || this.circuitBreakerActive) {
        return;
      }

      const capacity = this.getAvailableCapacity();
      if (capacity.availableCapacity <= 0 || this.executionQueue.size() === 0) {
        return;
      }

      const queuedOpportunity = this.executionQueue.dequeue();
      if (queuedOpportunity) {
        // Check if opportunity has expired while in queue
        const { opportunity } = queuedOpportunity;
        if (opportunity.expiresAt && Date.now() > opportunity.expiresAt) {
          this.stateMachine.transition(
            opportunity.id,
            OpportunityState.EXPIRED,
            'Expired while queued'
          );
          return;
        }

        // Execute the opportunity
        this.executeOpportunity(opportunity).catch(error => {
          this.logger.error('Queue processing error', {
            opportunityId: opportunity.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, 100); // Check every 100ms
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle state machine events
    this.stateMachine.on('stateChanged', event => {
      this.emit('opportunityStateChanged', event);
    });

    this.stateMachine.on('opportunityTerminated', event => {
      // Clean up any remaining resources
      this.resourceAllocations.delete(event.opportunityId);
    });
  }
}
