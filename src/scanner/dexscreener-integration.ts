/**
 * DexScreener Integration Entry Point
 * Factory for creating and initializing DexScreener components
 */

import { DexScreenerClient, DexScreenerConfig as ClientConfig } from './dexscreener-client.js';
import { DexScreenerMonitor, DexScreenerMonitorConfig } from './dexscreener-monitor.js';
import { DexScreenerArbitrageScanner, ArbitrageScannerConfig } from './dexscreener-arbitrage-scanner.js';
import { DexScreenerMultiHopScanner, MultiHopConfig } from './dexscreener-multihop-scanner.js';
import { DexScreenerDiscovery, DiscoveryConfig } from './dexscreener-discovery.js';
import { DexScreenerOrchestrator, OrchestratorConfig } from '../execution/dexscreener-orchestrator.js';
import { logger } from '../utils/logger.js';
import type { Provider } from 'ethers';

export interface DexScreenerIntegrationConfig {
  client: ClientConfig;
  monitor: DexScreenerMonitorConfig;
  crossDexScanner?: ArbitrageScannerConfig;
  multiHopScanner?: MultiHopConfig;
  discovery?: DiscoveryConfig;
  orchestrator: OrchestratorConfig;
}

export class DexScreenerIntegration {
  private readonly client: DexScreenerClient;
  private readonly monitor: DexScreenerMonitor;
  private readonly crossDexScanner?: DexScreenerArbitrageScanner;
  private readonly multiHopScanner?: DexScreenerMultiHopScanner;
  private readonly discovery?: DexScreenerDiscovery;
  private readonly orchestrator: DexScreenerOrchestrator;

  constructor(config: DexScreenerIntegrationConfig, rpcProvider?: Provider) {
    // Initialize client
    this.client = new DexScreenerClient(config.client);
    logger.info('DexScreener client initialized');

    // Initialize monitor
    this.monitor = new DexScreenerMonitor(this.client, config.monitor);
    logger.info('DexScreener monitor initialized');

    // Initialize scanners if enabled
    if (config.crossDexScanner) {
      this.crossDexScanner = new DexScreenerArbitrageScanner(
        this.monitor,
        config.crossDexScanner
      );
      logger.info('Cross-DEX scanner initialized');
    }

    if (config.multiHopScanner) {
      this.multiHopScanner = new DexScreenerMultiHopScanner(
        this.monitor,
        config.multiHopScanner,
        rpcProvider  // Pass RPC provider for real reserve fetching
      );
      logger.info('Multi-hop scanner initialized with RPC provider');
    }

    if (config.discovery) {
      this.discovery = new DexScreenerDiscovery(this.client, config.discovery);
      logger.info('Discovery service initialized');
    }

    // Initialize orchestrator
    this.orchestrator = new DexScreenerOrchestrator(
      this.monitor,
      config.orchestrator,
      this.crossDexScanner,
      this.multiHopScanner,
      this.discovery,
      rpcProvider
    );
    logger.info('DexScreener orchestrator initialized');
  }

  /**
   * Start all components
   */
  async start(): Promise<void> {
    logger.info('Starting DexScreener integration');
    await this.orchestrator.start();
    logger.info('DexScreener integration started successfully');
  }

  /**
   * Stop all components
   */
  stop(): void {
    logger.info('Stopping DexScreener integration');
    this.orchestrator.stop();
    logger.info('DexScreener integration stopped');
  }

  /**
   * Get orchestrator for direct access
   */
  getOrchestrator(): DexScreenerOrchestrator {
    return this.orchestrator;
  }

  /**
   * Get monitor for direct access
   */
  getMonitor(): DexScreenerMonitor {
    return this.monitor;
  }

  /**
   * Get client for direct access
   */
  getClient(): DexScreenerClient {
    return this.client;
  }

  /**
   * Get statistics from all components
   */
  getStats() {
    return this.orchestrator.getStats();
  }
}

/**
 * Factory function to create DexScreener integration from config
 */
export function createDexScreenerIntegration(
  config: any,
  rpcProvider?: Provider
): DexScreenerIntegration {
  const dexscreenerConfig = config.dexscreener;

  if (!dexscreenerConfig || !dexscreenerConfig.enabled) {
    throw new Error('DexScreener not enabled in configuration');
  }

  // Extract pool addresses from allowedPools if not specified
  const poolAddresses = dexscreenerConfig.poolAddresses?.length > 0
    ? dexscreenerConfig.poolAddresses
    : extractPoolAddresses(config.allowedPools);

  const integrationConfig: DexScreenerIntegrationConfig = {
    client: {
      apiUrl: dexscreenerConfig.apiUrl,
      maxRequestsPerMinute: dexscreenerConfig.maxRequestsPerMinute,
      cacheTimeMs: dexscreenerConfig.cacheTimeMs,
      retryDelayMs: dexscreenerConfig.retryDelayMs,
      maxRetries: dexscreenerConfig.maxRetries,
      timeout: dexscreenerConfig.timeout
    },
    monitor: {
      chain: dexscreenerConfig.chain,
      poolAddresses,
      minLiquidityUsd: dexscreenerConfig.minLiquidityUsd,
      minVolume24hUsd: dexscreenerConfig.minVolume24hUsd,
      updateIntervalMs: dexscreenerConfig.updateIntervalMs,
      enableAutoDiscovery: dexscreenerConfig.enableAutoDiscovery,
      maxStaleDataMs: dexscreenerConfig.maxStaleDataMs
    },
    orchestrator: dexscreenerConfig.orchestrator
  };

  // Add scanners if enabled
  if (dexscreenerConfig.crossDexScanner?.enabled) {
    integrationConfig.crossDexScanner = dexscreenerConfig.crossDexScanner;
  }

  if (dexscreenerConfig.multiHopScanner?.enabled) {
    integrationConfig.multiHopScanner = dexscreenerConfig.multiHopScanner;
  }

  if (dexscreenerConfig.discovery?.enabled) {
    integrationConfig.discovery = dexscreenerConfig.discovery;
  }

  return new DexScreenerIntegration(integrationConfig, rpcProvider);
}

/**
 * Extract pool addresses from allowedPools configuration
 */
function extractPoolAddresses(allowedPools: any): string[] {
  const addresses: string[] = [];

  if (allowedPools?.uniswapV3) {
    for (const pool of allowedPools.uniswapV3) {
      if (pool.enabled !== false && pool.address) {
        addresses.push(pool.address);
      }
    }
  }

  if (allowedPools?.aerodrome) {
    for (const pool of allowedPools.aerodrome) {
      if (pool.enabled !== false && pool.address) {
        addresses.push(pool.address);
      }
    }
  }

  return addresses;
}
