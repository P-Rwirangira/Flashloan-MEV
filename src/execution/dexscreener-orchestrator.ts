/**
 * DexScreener Execution Orchestrator
 * Orchestrates opportunity detection and execution with RPC validation
 */

import { DexScreenerMonitor } from '../scanner/dexscreener-monitor.js';
import { DexScreenerArbitrageScanner } from '../scanner/dexscreener-arbitrage-scanner.js';
import { DexScreenerMultiHopScanner } from '../scanner/dexscreener-multihop-scanner.js';
import { DexScreenerDiscovery } from '../scanner/dexscreener-discovery.js';
import { logger } from '../utils/logger.js';
import type { ArbitrageOpportunity } from '../types/opportunity.js';
import type { Provider } from 'ethers';

export interface OrchestratorConfig {
  enableCrossDex: boolean;
  enableMultiHop: boolean;
  enableDiscovery: boolean;
  validateWithRpc: boolean;
  maxPriceDiscrepancy: number; // Percentage
  executionEnabled: boolean;
  paperTradingMode: boolean;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  rpcPrice?: number;
  dexscreenerPrice?: number;
  discrepancy?: number;
}

export class DexScreenerOrchestrator {
  private readonly monitor: DexScreenerMonitor;
  private readonly crossDexScanner: DexScreenerArbitrageScanner | undefined;
  private readonly multiHopScanner: DexScreenerMultiHopScanner | undefined;
  private readonly discovery: DexScreenerDiscovery | undefined;
  private readonly config: OrchestratorConfig;
  private readonly rpcProvider: Provider | undefined;
  
  private isRunning = false;
  private stats = {
    opportunitiesDetected: 0,
    opportunitiesValidated: 0,
    opportunitiesRejected: 0,
    opportunitiesExecuted: 0,
    validationErrors: 0
  };

  constructor(
    monitor: DexScreenerMonitor,
    config: OrchestratorConfig,
    crossDexScanner?: DexScreenerArbitrageScanner,
    multiHopScanner?: DexScreenerMultiHopScanner,
    discovery?: DexScreenerDiscovery,
    rpcProvider?: Provider
  ) {
    this.monitor = monitor;
    this.config = config;
    this.crossDexScanner = crossDexScanner;
    this.multiHopScanner = multiHopScanner;
    this.discovery = discovery;
    this.rpcProvider = rpcProvider;
  }

  /**
   * Start orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Orchestrator already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting DexScreener orchestrator', {
      crossDex: this.config.enableCrossDex,
      multiHop: this.config.enableMultiHop,
      discovery: this.config.enableDiscovery,
      validation: this.config.validateWithRpc,
      execution: this.config.executionEnabled,
      paperTrading: this.config.paperTradingMode
    });

    // Start monitor
    await this.monitor.start();

    // Start scanners
    if (this.config.enableCrossDex && this.crossDexScanner) {
      await this.crossDexScanner.start();
    }

    if (this.config.enableMultiHop && this.multiHopScanner) {
      await this.multiHopScanner.start();
    }

    // Start discovery
    if (this.config.enableDiscovery && this.discovery) {
      await this.discovery.start();
    }

    logger.info('DexScreener orchestrator started successfully');
  }

  /**
   * Stop orchestrator
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping DexScreener orchestrator');

    this.monitor.stop();
    
    if (this.crossDexScanner) {
      this.crossDexScanner.stop();
    }
    
    if (this.multiHopScanner) {
      this.multiHopScanner.stop();
    }
    
    if (this.discovery) {
      this.discovery.stop();
    }

    this.isRunning = false;
    
    logger.info('DexScreener orchestrator stopped', {
      stats: this.stats
    });
  }

  /**
   * Get opportunities from all scanners
   */
  async getOpportunities(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    try {
      // Get cross-DEX opportunities
      if (this.config.enableCrossDex && this.crossDexScanner) {
        const crossDexOpps = await this.crossDexScanner.scan();
        this.stats.opportunitiesDetected += crossDexOpps.length;
        
        for (const opp of crossDexOpps) {
          const arbOpp = this.crossDexScanner.toArbitrageOpportunity(opp);
          opportunities.push(arbOpp);
        }
      }

      // Get multi-hop opportunities
      if (this.config.enableMultiHop && this.multiHopScanner) {
        const multiHopOpps = await this.multiHopScanner.scan();
        this.stats.opportunitiesDetected += multiHopOpps.length;
        
        for (const opp of multiHopOpps) {
          const arbOpp = this.multiHopScanner.toArbitrageOpportunity(opp);
          opportunities.push(arbOpp);
        }
      }

      // Validate opportunities if enabled
      if (this.config.validateWithRpc && this.rpcProvider) {
        const validated: ArbitrageOpportunity[] = [];
        
        for (const opp of opportunities) {
          const validation = await this.validateOpportunity(opp);
          
          if (validation.valid) {
            validated.push(opp);
            this.stats.opportunitiesValidated++;
          } else {
            this.stats.opportunitiesRejected++;
            logger.debug('Opportunity rejected by RPC validation', {
              id: opp.id,
              reason: validation.reason,
              discrepancy: validation.discrepancy
            });
          }
        }
        
        return validated;
      }

      return opportunities;
    } catch (error) {
      logger.error('Error getting opportunities', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Validate opportunity against RPC
   */
  private async validateOpportunity(
    opportunity: ArbitrageOpportunity
  ): Promise<ValidationResult> {
    if (!this.rpcProvider) {
      return { valid: true };
    }

    try {
      // Get pool from monitor
      const sourcePool = this.monitor.getPool(opportunity.sourcePool);
      const targetPool = this.monitor.getPool(opportunity.targetPool);

      if (!sourcePool || !targetPool) {
        return {
          valid: false,
          reason: 'Pool data not available'
        };
      }

      // In a real implementation, we would:
      // 1. Fetch actual pool state from RPC
      // 2. Calculate real price from reserves/sqrtPrice
      // 3. Compare with DexScreener price
      
      // For now, we do a simple freshness check
      const maxStaleTime = 30000; // 30 seconds
      const sourceAge = Date.now() - sourcePool.lastUpdate;
      const targetAge = Date.now() - targetPool.lastUpdate;

      if (sourceAge > maxStaleTime || targetAge > maxStaleTime) {
        return {
          valid: false,
          reason: 'Stale pool data',
          discrepancy: Math.max(sourceAge, targetAge)
        };
      }

      // Check if spread still exists (prices haven't converged)
      const spreadBps = opportunity.spread;
      if (spreadBps < 10) { // Less than 0.1%
        return {
          valid: false,
          reason: 'Spread too small',
          discrepancy: spreadBps
        };
      }

      return { valid: true };
    } catch (error) {
      this.stats.validationErrors++;
      logger.error('Error validating opportunity', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        valid: false,
        reason: 'Validation error'
      };
    }
  }

  /**
   * Execute opportunity
   */
  async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    if (!this.config.executionEnabled) {
      logger.warn('Execution disabled', { opportunityId: opportunity.id });
      return false;
    }

    if (this.config.paperTradingMode) {
      logger.info('Paper trading execution', {
        opportunityId: opportunity.id,
        type: opportunity.type,
        expectedProfit: opportunity.expectedProfit.toString(),
        source: opportunity.source
      });
      this.stats.opportunitiesExecuted++;
      return true;
    }

    // Real execution would happen here
    logger.warn('Real execution not implemented yet', {
      opportunityId: opportunity.id
    });
    
    return false;
  }

  /**
   * Add discovered pool to monitoring
   */
  async addDiscoveredPool(poolAddress: string): Promise<void> {
    this.monitor.addPool(poolAddress);
    logger.info('Added discovered pool to monitoring', { poolAddress });
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    isRunning: boolean;
    opportunitiesDetected: number;
    opportunitiesValidated: number;
    opportunitiesRejected: number;
    opportunitiesExecuted: number;
    validationErrors: number;
    monitorStats: ReturnType<DexScreenerMonitor['getStats']>;
    crossDexStats: ReturnType<DexScreenerArbitrageScanner['getStats']> | undefined;
    multiHopStats: ReturnType<DexScreenerMultiHopScanner['getStats']> | undefined;
    discoveryStats: ReturnType<DexScreenerDiscovery['getStats']> | undefined;
  } {
    return {
      isRunning: this.isRunning,
      ...this.stats,
      monitorStats: this.monitor.getStats(),
      crossDexStats: this.crossDexScanner?.getStats(),
      multiHopStats: this.multiHopScanner?.getStats(),
      discoveryStats: this.discovery?.getStats()
    };
  }

  /**
   * Get monitor instance (for direct access)
   */
  getMonitor(): DexScreenerMonitor {
    return this.monitor;
  }

  /**
   * Get cross-DEX scanner instance
   */
  getCrossDexScanner(): DexScreenerArbitrageScanner | undefined {
    return this.crossDexScanner;
  }

  /**
   * Get multi-hop scanner instance
   */
  getMultiHopScanner(): DexScreenerMultiHopScanner | undefined {
    return this.multiHopScanner;
  }

  /**
   * Get discovery instance
   */
  getDiscovery(): DexScreenerDiscovery | undefined {
    return this.discovery;
  }
}
