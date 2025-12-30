/**
 * Uniswap Monitor (Legacy)
 *
 * Legacy wrapper for Uniswap V2/V3 monitoring.
 * For V3 monitoring, use UniswapV3Monitor directly.
 */

import { EventEmitter } from 'events';
import { UniswapV3Monitor, UniswapV3MonitorOptions } from './uniswap-v3-monitor';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { PoolAllowlist } from '../types/config';
import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';

export interface UniswapMonitorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlist[];
  readonly enableV3Monitoring?: boolean;
  readonly updateIntervalMs?: number;
  readonly maxRetries?: number;
}

export class UniswapMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('uniswap-monitor');
  private readonly connectionManager: RpcConnectionManager;
  private readonly options: UniswapMonitorOptions;

  // V3 monitor instance
  private v3Monitor?: UniswapV3Monitor;
  private isMonitoring = false;

  constructor(options: UniswapMonitorOptions) {
    super();
    this.connectionManager = options.connectionManager;
    this.options = options;

    // Initialize V3 monitor if enabled
    if (options.enableV3Monitoring !== false) {
      this.initializeV3Monitor();
    }
  }

  private initializeV3Monitor(): void {
    const v3Options: UniswapV3MonitorOptions = {
      connectionManager: this.connectionManager,
      allowedPools: this.options.allowedPools,
      updateIntervalMs: this.options.updateIntervalMs ?? 5000,
      maxRetries: this.options.maxRetries ?? 3,
    };

    this.v3Monitor = new UniswapV3Monitor(v3Options);

    // Forward V3 events
    this.v3Monitor.on('poolUpdated', event => {
      this.emit('poolUpdated', event);
      this.logger.debug('Pool state updated', {
        pool: event.pool,
        blockNumber: event.blockNumber,
      });
    });

    this.v3Monitor.on('poolInitialized', (address, state) => {
      this.emit('poolInitialized', address, state);
      this.logger.info('Pool initialized', { address });
    });

    this.v3Monitor.on('monitoringError', error => {
      this.emit('monitoringError', error);
      this.logger.logError(error as Error, { operation: 'v3-monitoring' });
    });
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.logger.info('Starting Uniswap monitoring', {
      v3Enabled: !!this.v3Monitor,
      poolCount: this.options.allowedPools.length,
    });

    try {
      // Start V3 monitoring if available
      if (this.v3Monitor) {
        await this.v3Monitor.startMonitoring();
        this.logger.info('V3 monitoring started successfully');
      }

      this.isMonitoring = true;
      this.emit('monitoringStarted');
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'start-monitoring' });
      throw error;
    }
  }

  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      this.logger.warn('Monitor is not running');
      return;
    }

    this.logger.info('Stopping Uniswap monitoring');

    try {
      // Stop V3 monitoring if available
      if (this.v3Monitor) {
        await this.v3Monitor.stopMonitoring();
        this.logger.info('V3 monitoring stopped');
      }

      this.isMonitoring = false;
      this.emit('monitoringStopped');
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'stop-monitoring' });
      throw error;
    }
  }

  // Delegate methods to V3 monitor
  getPoolState(poolAddress: Address) {
    return this.v3Monitor?.getPoolState(poolAddress);
  }

  getAllPoolStates() {
    return this.v3Monitor?.getAllPoolStates() || new Map();
  }

  getMonitoredPools(): Address[] {
    return this.v3Monitor?.getMonitoredPools() || [];
  }

  async addPool(poolConfig: PoolAllowlist): Promise<void> {
    if (this.v3Monitor) {
      await this.v3Monitor.addPool(poolConfig);
      this.logger.info('Pool added to monitoring', { address: poolConfig.address });
    }
  }

  removePool(poolAddress: Address): void {
    if (this.v3Monitor) {
      this.v3Monitor.removePool(poolAddress);
      this.logger.info('Pool removed from monitoring', { address: poolAddress });
    }
  }

  async updatePoolState(poolAddress: Address): Promise<void> {
    if (this.v3Monitor) {
      await this.v3Monitor.updatePoolState(poolAddress);
    }
  }

  isActive(): boolean {
    return this.isMonitoring;
  }

  getMonitoringStats() {
    return {
      isMonitoring: this.isMonitoring,
      v3Enabled: !!this.v3Monitor,
      poolCount: this.getMonitoredPools().length,
      monitoredPools: this.getMonitoredPools(),
    };
  }
}
