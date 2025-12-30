/**
 * Base Scanner
 *
 * Core scanner implementation for Base blockchain monitoring.
 * Coordinates multiple scanning components and provides unified interface.
 */

import { EventEmitter } from 'events';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { UniswapV3Monitor } from './uniswap-v3-monitor';
import { AerodromeMonitor } from './aerodrome-monitor';
import { OpportunityDetector, ArbitrageOpportunity } from './opportunity-detector';
import { PoolAllowlist } from '../types/config';
import { Address } from '../types/common';
import { BigNumberish } from 'ethers';
import { createComponentLogger } from '../utils/logger';

export interface BaseScannerOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlist[];
  readonly opportunityDetection: {
    readonly minProfitThreshold: BigNumberish;
    readonly maxSlippage: number;
    readonly maxGasPrice: BigNumberish;
    readonly confidenceThreshold: number;
    readonly riskTolerance: number;
  };
  readonly monitoring: {
    readonly updateIntervalMs?: number;
    readonly maxRetries?: number;
    readonly enableUniswapV3?: boolean;
    readonly enableAerodrome?: boolean;
  };
}

export interface ScannerStats {
  readonly isScanning: boolean;
  readonly monitors: {
    readonly uniswapV3: { enabled: boolean; poolCount: number; isActive: boolean };
    readonly aerodrome: { enabled: boolean; poolCount: number; isActive: boolean };
  };
  readonly opportunities: {
    readonly totalDetected: number;
    readonly recentCount: number;
    readonly avgConfidence: number;
    readonly avgRiskScore: number;
  };
  readonly performance: {
    readonly uptime: number;
    readonly lastUpdate: number;
    readonly errorCount: number;
  };
}

export class BaseScanner extends EventEmitter {
  private readonly logger = createComponentLogger('base-scanner');
  private readonly connectionManager: RpcConnectionManager;
  private readonly options: BaseScannerOptions;

  // Component instances
  private uniswapV3Monitor?: UniswapV3Monitor;
  private aerodromeMonitor?: AerodromeMonitor;
  private opportunityDetector: OpportunityDetector;

  // State tracking
  private isScanning = false;
  private startTime?: number;
  private errorCount = 0;
  private lastUpdateTime = 0;

  constructor(options: BaseScannerOptions) {
    super();
    this.connectionManager = options.connectionManager;
    this.options = options;

    // Initialize opportunity detector
    this.opportunityDetector = new OpportunityDetector(options.opportunityDetection);
    this.setupOpportunityDetectorEvents();

    // Initialize monitors based on configuration
    this.initializeMonitors();
  }

  private initializeMonitors(): void {
    const { monitoring } = this.options;

    // Initialize Uniswap V3 monitor
    if (monitoring.enableUniswapV3 !== false) {
      this.uniswapV3Monitor = new UniswapV3Monitor({
        connectionManager: this.connectionManager,
        allowedPools: this.options.allowedPools.filter(
          pool => pool.dex === 'uniswap-v3' && pool.enabled
        ),
        updateIntervalMs: monitoring.updateIntervalMs ?? 5000,
        maxRetries: monitoring.maxRetries ?? 3,
      });
      this.setupUniswapV3Events();
    }

    // Initialize Aerodrome monitor
    if (monitoring.enableAerodrome !== false) {
      this.aerodromeMonitor = new AerodromeMonitor({
        connectionManager: this.connectionManager,
        allowedPools: this.options.allowedPools.filter(
          pool => pool.dex === 'aerodrome' && pool.enabled
        ),
        updateIntervalMs: monitoring.updateIntervalMs ?? 5000,
        maxRetries: monitoring.maxRetries ?? 3,
      });
      this.setupAerodromeEvents();
    }

    this.logger.info('Scanner monitors initialized', {
      uniswapV3Enabled: !!this.uniswapV3Monitor,
      aerodromeEnabled: !!this.aerodromeMonitor,
      totalPools: this.options.allowedPools.length,
    });
  }

  private setupUniswapV3Events(): void {
    if (!this.uniswapV3Monitor) return;

    this.uniswapV3Monitor.on('poolUpdated', event => {
      this.lastUpdateTime = Date.now();
      this.opportunityDetector.updateUniswapPool(event.newState);

      this.emit('poolStateChanged', {
        dex: 'uniswap-v3',
        pool: event.pool,
        state: event.newState,
        blockNumber: event.blockNumber,
      });

      this.logger.debug('Uniswap V3 pool updated', {
        pool: event.pool,
        blockNumber: event.blockNumber,
      });
    });

    this.uniswapV3Monitor.on('monitoringError', error => {
      this.errorCount++;
      this.logger.logError(error as Error, {
        component: 'uniswap-v3-monitor',
        errorCount: this.errorCount,
      });
      this.emit('monitoringError', { component: 'uniswap-v3', error });
    });

    this.uniswapV3Monitor.on('poolInitialized', (address, state) => {
      this.logger.info('Uniswap V3 pool initialized', { address });
      this.emit('poolInitialized', { dex: 'uniswap-v3', address, state });
    });
  }

  private setupAerodromeEvents(): void {
    if (!this.aerodromeMonitor) return;

    this.aerodromeMonitor.on('poolUpdated', event => {
      this.lastUpdateTime = Date.now();
      this.opportunityDetector.updateAerodromePool(event.newState);

      this.emit('poolStateChanged', {
        dex: 'aerodrome',
        pool: event.pool,
        state: event.newState,
        blockNumber: event.blockNumber,
      });

      this.logger.debug('Aerodrome pool updated', {
        pool: event.pool,
        blockNumber: event.blockNumber,
      });
    });

    this.aerodromeMonitor.on('monitoringError', error => {
      this.errorCount++;
      this.logger.logError(error as Error, {
        component: 'aerodrome-monitor',
        errorCount: this.errorCount,
      });
      this.emit('monitoringError', { component: 'aerodrome', error });
    });

    this.aerodromeMonitor.on('poolInitialized', (address, state) => {
      this.logger.info('Aerodrome pool initialized', { address });
      this.emit('poolInitialized', { dex: 'aerodrome', address, state });
    });
  }

  private setupOpportunityDetectorEvents(): void {
    this.opportunityDetector.on('opportunityDetected', (opportunity: ArbitrageOpportunity) => {
      this.logger.info('Arbitrage opportunity detected', {
        id: opportunity.id,
        type: opportunity.type,
        priority: opportunity.metadata.priority,
        netProfit: opportunity.profitEstimate.netProfit.toString(),
        confidence: opportunity.profitEstimate.confidence,
      });

      this.emit('opportunityDetected', opportunity);
    });
  }

  /**
   * Start scanning for opportunities
   */
  async startScanning(): Promise<void> {
    if (this.isScanning) {
      this.logger.warn('Scanner is already running');
      return;
    }

    this.logger.info('Starting Base blockchain scanning', {
      uniswapV3Enabled: !!this.uniswapV3Monitor,
      aerodromeEnabled: !!this.aerodromeMonitor,
      poolCount: this.options.allowedPools.length,
    });

    try {
      this.startTime = Date.now();
      this.errorCount = 0;

      // Start monitors
      if (this.uniswapV3Monitor) {
        await this.uniswapV3Monitor.startMonitoring();
        this.logger.info('Uniswap V3 monitoring started');
      }

      if (this.aerodromeMonitor) {
        await this.aerodromeMonitor.startMonitoring();
        this.logger.info('Aerodrome monitoring started');
      }

      this.isScanning = true;
      this.emit('scanningStarted');

      // Start periodic cleanup of old opportunities
      this.startPeriodicCleanup();
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'start-scanning' });
      throw error;
    }
  }

  /**
   * Stop scanning
   */
  async stopScanning(): Promise<void> {
    if (!this.isScanning) {
      this.logger.warn('Scanner is not running');
      return;
    }

    this.logger.info('Stopping Base blockchain scanning');

    try {
      // Stop monitors
      if (this.uniswapV3Monitor) {
        await this.uniswapV3Monitor.stopMonitoring();
        this.logger.info('Uniswap V3 monitoring stopped');
      }

      if (this.aerodromeMonitor) {
        await this.aerodromeMonitor.stopMonitoring();
        this.logger.info('Aerodrome monitoring stopped');
      }

      this.isScanning = false;
      this.emit('scanningStopped');
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'stop-scanning' });
      throw error;
    }
  }

  /**
   * Add a new pool to monitoring
   */
  async addPool(poolConfig: PoolAllowlist): Promise<void> {
    if (!poolConfig.enabled) {
      this.logger.debug('Skipping disabled pool', { address: poolConfig.address });
      return;
    }

    try {
      if (poolConfig.dex === 'uniswap-v3' && this.uniswapV3Monitor) {
        await this.uniswapV3Monitor.addPool(poolConfig);
      } else if (poolConfig.dex === 'aerodrome' && this.aerodromeMonitor) {
        await this.aerodromeMonitor.addPool(poolConfig);
      } else {
        throw new Error(`Unsupported DEX or monitor not available: ${poolConfig.dex}`);
      }

      this.logger.info('Pool added to scanning', {
        address: poolConfig.address,
        dex: poolConfig.dex,
      });
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'add-pool',
        address: poolConfig.address,
        dex: poolConfig.dex,
      });
      throw error;
    }
  }

  /**
   * Remove a pool from monitoring
   */
  removePool(poolAddress: Address, dex: 'uniswap-v3' | 'aerodrome'): void {
    try {
      if (dex === 'uniswap-v3' && this.uniswapV3Monitor) {
        this.uniswapV3Monitor.removePool(poolAddress);
      } else if (dex === 'aerodrome' && this.aerodromeMonitor) {
        this.aerodromeMonitor.removePool(poolAddress);
      } else {
        throw new Error(`Unsupported DEX or monitor not available: ${dex}`);
      }

      this.logger.info('Pool removed from scanning', { address: poolAddress, dex });
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'remove-pool',
        address: poolAddress,
        dex,
      });
      throw error;
    }
  }

  /**
   * Get current scanner statistics
   */
  getStats(): ScannerStats {
    const opportunities = this.opportunityDetector.getDetectedOpportunities();
    const recentOpportunities = opportunities.filter(
      op => Date.now() - op.metadata.detectedAt < 300000 // Last 5 minutes
    );

    return {
      isScanning: this.isScanning,
      monitors: {
        uniswapV3: {
          enabled: !!this.uniswapV3Monitor,
          poolCount: this.uniswapV3Monitor?.getMonitoredPools().length || 0,
          isActive: this.uniswapV3Monitor ? true : false,
        },
        aerodrome: {
          enabled: !!this.aerodromeMonitor,
          poolCount: this.aerodromeMonitor?.getMonitoredPools().length || 0,
          isActive: this.aerodromeMonitor ? true : false,
        },
      },
      opportunities: {
        totalDetected: opportunities.length,
        recentCount: recentOpportunities.length,
        avgConfidence:
          recentOpportunities.reduce((sum, op) => sum + op.profitEstimate.confidence, 0) /
            recentOpportunities.length || 0,
        avgRiskScore:
          recentOpportunities.reduce((sum, op) => sum + op.metadata.riskScore, 0) /
            recentOpportunities.length || 0,
      },
      performance: {
        uptime: this.startTime ? Date.now() - this.startTime : 0,
        lastUpdate: this.lastUpdateTime,
        errorCount: this.errorCount,
      },
    };
  }

  /**
   * Get all detected opportunities
   */
  getDetectedOpportunities(): ArbitrageOpportunity[] {
    return this.opportunityDetector.getDetectedOpportunities();
  }

  /**
   * Get opportunities by priority
   */
  getOpportunitiesByPriority(
    priority: 'low' | 'medium' | 'high' | 'critical'
  ): ArbitrageOpportunity[] {
    return this.opportunityDetector
      .getDetectedOpportunities()
      .filter(op => op.metadata.priority === priority);
  }

  /**
   * Force update all pool states
   */
  async forceUpdate(): Promise<void> {
    this.logger.info('Forcing update of all pool states');

    const updatePromises: Promise<void>[] = [];

    // Update Uniswap V3 pools
    if (this.uniswapV3Monitor) {
      const uniPools = this.uniswapV3Monitor.getMonitoredPools();
      updatePromises.push(...uniPools.map(pool => this.uniswapV3Monitor!.updatePoolState(pool)));
    }

    // Update Aerodrome pools
    if (this.aerodromeMonitor) {
      const aeroPools = this.aerodromeMonitor.getMonitoredPools();
      updatePromises.push(...aeroPools.map(pool => this.aerodromeMonitor!.updatePoolState(pool)));
    }

    await Promise.allSettled(updatePromises);
    this.lastUpdateTime = Date.now();
  }

  /**
   * Start periodic cleanup of old opportunities
   */
  private startPeriodicCleanup(): void {
    setInterval(() => {
      if (this.isScanning) {
        this.opportunityDetector.clearOldOpportunities(300000); // 5 minutes
      }
    }, 60000); // Every minute
  }

  /**
   * Check if scanner is healthy
   */
  isHealthy(): boolean {
    const stats = this.getStats();
    const timeSinceLastUpdate = Date.now() - stats.performance.lastUpdate;

    return (
      this.isScanning &&
      timeSinceLastUpdate < 60000 && // Updated within last minute
      stats.performance.errorCount < 10 // Less than 10 errors
    );
  }

  /**
   * Get monitored pools across all DEXs
   */
  getAllMonitoredPools(): { dex: string; address: Address }[] {
    const pools: { dex: string; address: Address }[] = [];

    if (this.uniswapV3Monitor) {
      pools.push(
        ...this.uniswapV3Monitor.getMonitoredPools().map(address => ({
          dex: 'uniswap-v3',
          address,
        }))
      );
    }

    if (this.aerodromeMonitor) {
      pools.push(
        ...this.aerodromeMonitor.getMonitoredPools().map(address => ({
          dex: 'aerodrome',
          address,
        }))
      );
    }

    return pools;
  }
}
