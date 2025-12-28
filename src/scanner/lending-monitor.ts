/**
 * Lending Protocol Monitor
 *
 * Monitors health factors and liquidation opportunities across
 * Base lending protocols: Moonwell, Aave V3, Seamless
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';

// Lending protocol types
export enum LendingProtocol {
  MOONWELL = 'moonwell',
  AAVE_V3 = 'aave_v3',
  SEAMLESS = 'seamless',
}

// Health factor thresholds
export interface HealthFactorThresholds {
  critical: number; // Below this, liquidation is imminent (e.g., 1.05)
  warning: number; // Below this, position is at risk (e.g., 1.2)
  healthy: number; // Above this, position is safe (e.g., 1.5)
}

// Liquidation opportunity
export interface LiquidationOpportunity {
  id: string;
  protocol: LendingProtocol;
  borrower: string;
  healthFactor: number;
  collateralAsset: string;
  collateralAmount: bigint;
  debtAsset: string;
  debtAmount: bigint;
  liquidationBonus: number; // Percentage bonus for liquidator
  maxLiquidationAmount: bigint;
  estimatedProfit: bigint;
  gasEstimate: bigint;
  deadline: number; // Timestamp when opportunity expires
  blockNumber: number;
}

// Protocol configuration
export interface ProtocolConfig {
  protocol: LendingProtocol;
  comptrollerAddress: string;
  lensAddress?: string;
  dataProviderAddress?: string;
  liquidationThreshold: number;
  liquidationBonus: number;
  minProfitThreshold: bigint;
}

// Lending monitor options
export interface LendingMonitorOptions {
  protocols: ProtocolConfig[];
  healthFactorThresholds: HealthFactorThresholds;
  scanIntervalMs: number;
  maxPositionsPerScan: number;
  minProfitThreshold: bigint;
}

/**
 * Lending Protocol Monitor
 */
export class LendingProtocolMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('lending-monitor');
  private readonly options: LendingMonitorOptions;
  private readonly connectionManager: RpcConnectionManager;

  private isScanning = false;
  private scanInterval: NodeJS.Timeout | undefined;
  private lastScanBlock = 0;

  // Protocol-specific monitors
  private protocolMonitors: Map<LendingProtocol, ProtocolMonitor> = new Map();

  constructor(options: LendingMonitorOptions, connectionManager: RpcConnectionManager) {
    super();
    this.options = options;
    this.connectionManager = connectionManager;

    // Initialize protocol-specific monitors
    for (const config of options.protocols) {
      const monitor = this.createProtocolMonitor(config);
      this.protocolMonitors.set(config.protocol, monitor);
    }

    this.logger.info('Lending protocol monitor initialized', {
      protocols: options.protocols.map(p => p.protocol),
      scanInterval: options.scanIntervalMs,
      minProfit: options.minProfitThreshold.toString(),
    });
  }

  /**
   * Start monitoring lending protocols
   */
  startScanning(): void {
    if (this.isScanning) {
      this.logger.warn('Lending monitor is already scanning');
      return;
    }

    this.logger.info('Starting lending protocol monitoring');
    this.isScanning = true;

    // Start periodic scanning
    this.scanInterval = setInterval(() => {
      this.scanForLiquidationOpportunities().catch(error => {
        this.logger.logError(error as Error, { operation: 'liquidation-scan' });
      });
    }, this.options.scanIntervalMs);

    // Initial scan
    this.scanForLiquidationOpportunities().catch(error => {
      this.logger.logError(error as Error, { operation: 'initial-liquidation-scan' });
    });
  }

  /**
   * Stop monitoring
   */
  stopScanning(): void {
    if (!this.isScanning) {
      this.logger.warn('Lending monitor is not scanning');
      return;
    }

    this.logger.info('Stopping lending protocol monitoring');
    this.isScanning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  /**
   * Scan for liquidation opportunities across all protocols
   */
  private async scanForLiquidationOpportunities(): Promise<void> {
    const operationId = `liquidation-scan-${Date.now()}`;
    this.logger.startPerformanceTracking(operationId);

    try {
      const provider = this.connectionManager.getProvider();
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= this.lastScanBlock) {
        return; // No new blocks to scan
      }

      this.logger.debug('Scanning for liquidation opportunities', {
        currentBlock,
        lastScanBlock: this.lastScanBlock,
        protocols: Array.from(this.protocolMonitors.keys()),
      });

      const opportunities: LiquidationOpportunity[] = [];

      // Scan each protocol
      for (const [protocol, monitor] of this.protocolMonitors) {
        try {
          this.logger.markPerformance(operationId, `${protocol}-scan-start`);

          const protocolOpportunities = await monitor.scanForOpportunities(currentBlock);
          opportunities.push(...protocolOpportunities);

          this.logger.markPerformance(operationId, `${protocol}-scan-complete`);

          this.logger.debug(`Found ${protocolOpportunities.length} opportunities in ${protocol}`, {
            opportunities: protocolOpportunities.map(o => ({
              id: o.id,
              healthFactor: o.healthFactor,
              profit: o.estimatedProfit.toString(),
            })),
          });
        } catch (error) {
          this.logger.logError(error as Error, {
            protocol,
            operation: 'protocol-scan',
          });
        }
      }

      // Filter and rank opportunities
      const viableOpportunities = this.filterAndRankOpportunities(opportunities);

      this.logger.markPerformance(operationId, 'filtering-complete');

      // Emit opportunities
      for (const opportunity of viableOpportunities) {
        this.emit('liquidationOpportunityDetected', opportunity);
      }

      this.lastScanBlock = currentBlock;

      this.logger.info('Liquidation scan completed', {
        totalOpportunities: opportunities.length,
        viableOpportunities: viableOpportunities.length,
        blockNumber: currentBlock,
      });
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'liquidation-scan' });
    } finally {
      this.logger.endPerformanceTracking(operationId);
    }
  }

  /**
   * Filter and rank liquidation opportunities by profitability
   */
  private filterAndRankOpportunities(
    opportunities: LiquidationOpportunity[]
  ): LiquidationOpportunity[] {
    return opportunities
      .filter(opp => {
        // Filter by minimum profit threshold
        if (opp.estimatedProfit < this.options.minProfitThreshold) {
          return false;
        }

        // Filter by health factor (only critical positions)
        if (opp.healthFactor > this.options.healthFactorThresholds.critical) {
          return false;
        }

        // Filter expired opportunities
        if (opp.deadline < Date.now()) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Sort by estimated profit (descending)
        if (a.estimatedProfit > b.estimatedProfit) return -1;
        if (a.estimatedProfit < b.estimatedProfit) return 1;

        // If profit is equal, sort by health factor (ascending - more critical first)
        return a.healthFactor - b.healthFactor;
      })
      .slice(0, this.options.maxPositionsPerScan); // Limit number of opportunities
  }

  /**
   * Create protocol-specific monitor
   */
  private createProtocolMonitor(config: ProtocolConfig): ProtocolMonitor {
    switch (config.protocol) {
      case LendingProtocol.MOONWELL:
        return new MoonwellMonitor(
          config,
          this.connectionManager,
          this.options.healthFactorThresholds
        );

      case LendingProtocol.AAVE_V3:
        return new AaveV3Monitor(
          config,
          this.connectionManager,
          this.options.healthFactorThresholds
        );

      case LendingProtocol.SEAMLESS:
        return new SeamlessMonitor(
          config,
          this.connectionManager,
          this.options.healthFactorThresholds
        );

      default:
        throw new Error(`Unsupported lending protocol: ${config.protocol}`);
    }
  }

  /**
   * Get current monitoring status
   */
  getStatus() {
    return {
      isScanning: this.isScanning,
      lastScanBlock: this.lastScanBlock,
      protocols: Array.from(this.protocolMonitors.keys()),
      scanInterval: this.options.scanIntervalMs,
    };
  }
}

/**
 * Base protocol monitor interface
 */
abstract class ProtocolMonitor {
  protected readonly config: ProtocolConfig;
  protected readonly connectionManager: RpcConnectionManager;
  protected readonly thresholds: HealthFactorThresholds;
  protected readonly logger: ReturnType<typeof createComponentLogger>;

  constructor(
    config: ProtocolConfig,
    connectionManager: RpcConnectionManager,
    thresholds: HealthFactorThresholds
  ) {
    this.config = config;
    this.connectionManager = connectionManager;
    this.thresholds = thresholds;
    this.logger = createComponentLogger(`${config.protocol}-monitor`);
  }

  abstract scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]>;
}

/**
 * Moonwell Protocol Monitor
 */
class MoonwellMonitor extends ProtocolMonitor {
  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    // TODO: Implement Moonwell-specific liquidation scanning
    // This would involve:
    // 1. Query Moonwell comptroller for accounts with low health factors
    // 2. Calculate liquidation amounts and bonuses
    // 3. Estimate gas costs and profits
    // 4. Return viable liquidation opportunities

    this.logger.debug('Scanning Moonwell for liquidation opportunities', { blockNumber });

    // Placeholder implementation
    return [];
  }
}

/**
 * Aave V3 Protocol Monitor
 */
class AaveV3Monitor extends ProtocolMonitor {
  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    // TODO: Implement Aave V3-specific liquidation scanning
    // This would involve:
    // 1. Query Aave V3 data provider for unhealthy positions
    // 2. Calculate liquidation parameters using Aave's formulas
    // 3. Estimate profits considering liquidation bonuses
    // 4. Return viable liquidation opportunities

    this.logger.debug('Scanning Aave V3 for liquidation opportunities', { blockNumber });

    // Placeholder implementation
    return [];
  }
}

/**
 * Seamless Protocol Monitor
 */
class SeamlessMonitor extends ProtocolMonitor {
  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    // TODO: Implement Seamless-specific liquidation scanning
    // This would involve:
    // 1. Query Seamless protocol for positions at risk
    // 2. Calculate liquidation parameters
    // 3. Estimate profitability
    // 4. Return viable liquidation opportunities

    this.logger.debug('Scanning Seamless for liquidation opportunities', { blockNumber });

    // Placeholder implementation
    return [];
  }
}
