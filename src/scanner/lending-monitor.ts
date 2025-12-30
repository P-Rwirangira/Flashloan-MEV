/**
 * Lending Protocol Monitor
 *
 * Monitors health factors and liquidation opportunities across
 * Base lending protocols: Moonwell, Aave V3, Seamless
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
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
  private readonly MOONWELL_COMPTROLLER_ABI = [
    'function getAllMarkets() external view returns (address[])',
    'function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256)',
    'function liquidationIncentiveMantissa() external view returns (uint256)',
    'function closeFactorMantissa() external view returns (uint256)',
    'function markets(address) external view returns (bool, uint256, bool)',
  ];

  private readonly MTOKEN_ABI = [
    'function borrowBalanceStored(address account) external view returns (uint256)',
    'function balanceOfUnderlying(address account) external view returns (uint256)',
    'function exchangeRateStored() external view returns (uint256)',
    'function underlying() external view returns (address)',
    'function symbol() external view returns (string)',
  ];

  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    this.logger.debug('Scanning Moonwell for liquidation opportunities', {
      blockNumber,
      protocol: this.config.protocol,
      comptroller: this.config.comptrollerAddress,
      minProfit: this.config.minProfitThreshold.toString(),
    });

    try {
      const provider = this.connectionManager.getProvider();
      const comptroller = new ethers.Contract(
        this.config.comptrollerAddress,
        this.MOONWELL_COMPTROLLER_ABI,
        provider
      ) as ethers.Contract & {
        getAllMarkets(): Promise<string[]>;
        getAccountLiquidity(account: string): Promise<[bigint, bigint, bigint]>;
        liquidationIncentiveMantissa(): Promise<bigint>;
        closeFactorMantissa(): Promise<bigint>;
      };

      // Get all markets
      const markets = await comptroller.getAllMarkets();
      this.logger.debug(`Found ${markets.length} Moonwell markets`);

      const opportunities: LiquidationOpportunity[] = [];

      // Get liquidation incentive and close factor
      const [liquidationIncentive, closeFactor] = await Promise.all([
        comptroller.liquidationIncentiveMantissa(),
        comptroller.closeFactorMantissa(),
      ]);

      const liquidationBonus = Number(liquidationIncentive) / 1e18 - 1; // Convert from mantissa
      const closeFactorRatio = Number(closeFactor) / 1e18;

      // For demonstration, we'll check a few known risky accounts
      // In production, this would involve scanning recent transactions or maintaining a list
      const riskAccounts = [
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6', // Example account
        '0x8ba1f109551bD432803012645Hac136c22C4e5c', // Example account
      ];

      for (const account of riskAccounts) {
        try {
          // Get account liquidity (error, liquidity, shortfall)
          const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(account);

          if (error > 0 || shortfall === 0n) {
            continue; // Skip if error or no shortfall
          }

          // Calculate health factor (simplified)
          const healthFactor = Number(liquidity) / (Number(shortfall) + Number(liquidity));

          if (healthFactor > this.thresholds.critical) {
            continue; // Not critical enough
          }

          // Get account positions in each market
          for (const marketAddress of markets) {
            try {
              const mToken = new ethers.Contract(
                marketAddress,
                this.MTOKEN_ABI,
                provider
              ) as ethers.Contract & {
                borrowBalanceStored(account: string): Promise<bigint>;
                balanceOfUnderlying(account: string): Promise<bigint>;
                symbol(): Promise<string>;
              };

              const [borrowBalance, collateralBalance, symbol] = await Promise.all([
                mToken.borrowBalanceStored(account),
                mToken.balanceOfUnderlying(account),
                mToken.symbol(),
              ]);

              if (borrowBalance === 0n || collateralBalance === 0n) {
                continue;
              }

              // Calculate liquidation amount (max 50% of debt)
              const maxLiquidationAmount =
                (borrowBalance * BigInt(Math.floor(closeFactorRatio * 1e18))) / BigInt(1e18);

              // Estimate profit (simplified calculation)
              const liquidationValue = maxLiquidationAmount;
              const bonusValue =
                (liquidationValue * BigInt(Math.floor(liquidationBonus * 1e18))) / BigInt(1e18);
              const gasEstimate = 300000n; // Estimated gas for liquidation
              const gasCost = gasEstimate * 20000000000n; // 20 gwei
              const estimatedProfit = bonusValue - gasCost;

              if (estimatedProfit < this.config.minProfitThreshold) {
                continue;
              }

              const opportunity: LiquidationOpportunity = {
                id: `moonwell-${account}-${marketAddress}-${blockNumber}`,
                protocol: LendingProtocol.MOONWELL,
                borrower: account,
                healthFactor,
                collateralAsset: marketAddress,
                collateralAmount: collateralBalance,
                debtAsset: marketAddress, // Simplified - same market
                debtAmount: borrowBalance,
                liquidationBonus,
                maxLiquidationAmount,
                estimatedProfit,
                gasEstimate,
                deadline: Date.now() + 300000, // 5 minutes
                blockNumber,
              };

              opportunities.push(opportunity);

              this.logger.info('Found Moonwell liquidation opportunity', {
                account,
                market: symbol,
                healthFactor: healthFactor.toFixed(3),
                profit: ethers.formatEther(estimatedProfit),
              });
            } catch (marketError) {
              this.logger.debug('Error checking market for account', {
                account,
                market: marketAddress,
                error: (marketError as Error).message,
              });
            }
          }
        } catch (accountError) {
          this.logger.debug('Error checking account liquidity', {
            account,
            error: (accountError as Error).message,
          });
        }
      }

      return opportunities;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'moonwell-scan',
        blockNumber,
      });
      return [];
    }
  }
}

/**
 * Aave V3 Protocol Monitor
 */
class AaveV3Monitor extends ProtocolMonitor {
  private readonly AAVE_V3_DATA_PROVIDER_ABI = [
    'function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[])',
    'function getUserReservesData(address user) external view returns (tuple(address underlyingAsset, uint256 scaledATokenBalance, bool usageAsCollateralEnabled, uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool stableBorrowRateEnabled)[])',
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  ];

  private readonly AAVE_V3_POOL_ABI = [
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  ];

  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    this.logger.debug('Scanning Aave V3 for liquidation opportunities', { blockNumber });

    try {
      const provider = this.connectionManager.getProvider();

      // Aave V3 addresses on Base (if deployed)
      const dataProviderAddress =
        this.config.dataProviderAddress || '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac'; // Example address
      const poolAddress = this.config.comptrollerAddress; // Pool address

      const dataProvider = new ethers.Contract(
        dataProviderAddress,
        this.AAVE_V3_DATA_PROVIDER_ABI,
        provider
      ) as ethers.Contract & {
        getAllReservesTokens(): Promise<Array<{ symbol: string; tokenAddress: string }>>;
        getUserReservesData(user: string): Promise<
          Array<{
            underlyingAsset: string;
            currentATokenBalance: bigint;
            currentVariableDebt: bigint;
            usageAsCollateralEnabled: boolean;
          }>
        >;
        getReserveConfigurationData(asset: string): Promise<{
          liquidationThreshold: bigint;
          liquidationBonus: bigint;
        }>;
      };

      const pool = new ethers.Contract(
        poolAddress,
        this.AAVE_V3_POOL_ABI,
        provider
      ) as ethers.Contract & {
        getUserAccountData(user: string): Promise<{
          totalCollateralBase: bigint;
          totalDebtBase: bigint;
          healthFactor: bigint;
        }>;
      };

      const opportunities: LiquidationOpportunity[] = [];

      // Get all reserves
      const reserves = await dataProvider.getAllReservesTokens();
      this.logger.debug(`Found ${reserves.length} Aave V3 reserves`);

      // Sample risky accounts (in production, would scan recent transactions or maintain a list)
      const riskAccounts = [
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        '0x8ba1f109551bD432803012645Hac136c22C4e5c',
      ];

      for (const account of riskAccounts) {
        try {
          // Get user account data
          const accountData = await pool.getUserAccountData(account);
          const healthFactor = Number(accountData.healthFactor) / 1e18;

          if (healthFactor > this.thresholds.critical) {
            continue; // Not critical enough
          }

          // Get user reserves data
          const userReserves = await dataProvider.getUserReservesData(account);

          for (const reserve of userReserves) {
            if (reserve.currentVariableDebt === 0n || !reserve.usageAsCollateralEnabled) {
              continue;
            }

            // Get reserve configuration
            const reserveConfig = await dataProvider.getReserveConfigurationData(
              reserve.underlyingAsset
            );

            // Calculate liquidation parameters
            const liquidationBonus = Number(reserveConfig.liquidationBonus) / 10000 - 1; // Convert from basis points
            const maxLiquidationAmount = reserve.currentVariableDebt / 2n; // Max 50% of debt

            // Estimate profit
            const liquidationValue = maxLiquidationAmount;
            const bonusValue =
              (liquidationValue * BigInt(Math.floor(liquidationBonus * 1e18))) / BigInt(1e18);
            const gasEstimate = 400000n; // Estimated gas for Aave liquidation
            const gasCost = gasEstimate * 25000000000n; // 25 gwei
            const estimatedProfit = bonusValue - gasCost;

            if (estimatedProfit < this.config.minProfitThreshold) {
              continue;
            }

            const opportunity: LiquidationOpportunity = {
              id: `aave-v3-${account}-${reserve.underlyingAsset}-${blockNumber}`,
              protocol: LendingProtocol.AAVE_V3,
              borrower: account,
              healthFactor,
              collateralAsset: reserve.underlyingAsset,
              collateralAmount: reserve.currentATokenBalance,
              debtAsset: reserve.underlyingAsset,
              debtAmount: reserve.currentVariableDebt,
              liquidationBonus,
              maxLiquidationAmount,
              estimatedProfit,
              gasEstimate,
              deadline: Date.now() + 300000, // 5 minutes
              blockNumber,
            };

            opportunities.push(opportunity);

            this.logger.info('Found Aave V3 liquidation opportunity', {
              account,
              asset: reserve.underlyingAsset,
              healthFactor: healthFactor.toFixed(3),
              profit: ethers.formatEther(estimatedProfit),
            });
          }
        } catch (accountError) {
          this.logger.debug('Error checking Aave V3 account', {
            account,
            error: (accountError as Error).message,
          });
        }
      }

      return opportunities;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'aave-v3-scan',
        blockNumber,
      });
      return [];
    }
  }
}

/**
 * Seamless Protocol Monitor
 */
class SeamlessMonitor extends ProtocolMonitor {
  private readonly SEAMLESS_COMPTROLLER_ABI = [
    'function getAllMarkets() external view returns (address[])',
    'function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256)',
    'function liquidationIncentiveMantissa() external view returns (uint256)',
    'function closeFactorMantissa() external view returns (uint256)',
  ];

  private readonly SEAMLESS_CTOKEN_ABI = [
    'function borrowBalanceStored(address account) external view returns (uint256)',
    'function balanceOfUnderlying(address account) external view returns (uint256)',
    'function underlying() external view returns (address)',
    'function symbol() external view returns (string)',
    'function exchangeRateStored() external view returns (uint256)',
  ];

  async scanForOpportunities(blockNumber: number): Promise<LiquidationOpportunity[]> {
    this.logger.debug('Scanning Seamless for liquidation opportunities', { blockNumber });

    try {
      const provider = this.connectionManager.getProvider();
      const comptroller = new ethers.Contract(
        this.config.comptrollerAddress,
        this.SEAMLESS_COMPTROLLER_ABI,
        provider
      ) as ethers.Contract & {
        getAllMarkets(): Promise<string[]>;
        getAccountLiquidity(account: string): Promise<[bigint, bigint, bigint]>;
        liquidationIncentiveMantissa(): Promise<bigint>;
        closeFactorMantissa(): Promise<bigint>;
      };

      // Get all markets
      const markets = await comptroller.getAllMarkets();
      this.logger.debug(`Found ${markets.length} Seamless markets`);

      const opportunities: LiquidationOpportunity[] = [];

      // Get liquidation parameters
      const [liquidationIncentive, closeFactor] = await Promise.all([
        comptroller.liquidationIncentiveMantissa(),
        comptroller.closeFactorMantissa(),
      ]);

      const liquidationBonus = Number(liquidationIncentive) / 1e18 - 1;
      const closeFactorRatio = Number(closeFactor) / 1e18;

      // Sample risky accounts
      const riskAccounts = [
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        '0x8ba1f109551bD432803012645Hac136c22C4e5c',
      ];

      for (const account of riskAccounts) {
        try {
          // Get account liquidity
          const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(account);

          if (error > 0 || shortfall === 0n) {
            continue;
          }

          // Calculate health factor
          const healthFactor = Number(liquidity) / (Number(shortfall) + Number(liquidity));

          if (healthFactor > this.thresholds.critical) {
            continue;
          }

          // Check positions in each market
          for (const marketAddress of markets) {
            try {
              const cToken = new ethers.Contract(
                marketAddress,
                this.SEAMLESS_CTOKEN_ABI,
                provider
              ) as ethers.Contract & {
                borrowBalanceStored(account: string): Promise<bigint>;
                balanceOfUnderlying(account: string): Promise<bigint>;
                symbol(): Promise<string>;
                underlying(): Promise<string>;
              };

              const [borrowBalance, collateralBalance, symbol, underlying] = await Promise.all([
                cToken.borrowBalanceStored(account),
                cToken.balanceOfUnderlying(account),
                cToken.symbol(),
                cToken.underlying(),
              ]);

              if (borrowBalance === 0n || collateralBalance === 0n) {
                continue;
              }

              // Calculate liquidation amount
              const maxLiquidationAmount =
                (borrowBalance * BigInt(Math.floor(closeFactorRatio * 1e18))) / BigInt(1e18);

              // Estimate profit
              const liquidationValue = maxLiquidationAmount;
              const bonusValue =
                (liquidationValue * BigInt(Math.floor(liquidationBonus * 1e18))) / BigInt(1e18);
              const gasEstimate = 350000n; // Estimated gas for Seamless liquidation
              const gasCost = gasEstimate * 22000000000n; // 22 gwei
              const estimatedProfit = bonusValue - gasCost;

              if (estimatedProfit < this.config.minProfitThreshold) {
                continue;
              }

              const opportunity: LiquidationOpportunity = {
                id: `seamless-${account}-${marketAddress}-${blockNumber}`,
                protocol: LendingProtocol.SEAMLESS,
                borrower: account,
                healthFactor,
                collateralAsset: underlying,
                collateralAmount: collateralBalance,
                debtAsset: underlying,
                debtAmount: borrowBalance,
                liquidationBonus,
                maxLiquidationAmount,
                estimatedProfit,
                gasEstimate,
                deadline: Date.now() + 300000, // 5 minutes
                blockNumber,
              };

              opportunities.push(opportunity);

              this.logger.info('Found Seamless liquidation opportunity', {
                account,
                market: symbol,
                healthFactor: healthFactor.toFixed(3),
                profit: ethers.formatEther(estimatedProfit),
              });
            } catch (marketError) {
              this.logger.debug('Error checking Seamless market for account', {
                account,
                market: marketAddress,
                error: (marketError as Error).message,
              });
            }
          }
        } catch (accountError) {
          this.logger.debug('Error checking Seamless account liquidity', {
            account,
            error: (accountError as Error).message,
          });
        }
      }

      return opportunities;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'seamless-scan',
        blockNumber,
      });
      return [];
    }
  }
}
