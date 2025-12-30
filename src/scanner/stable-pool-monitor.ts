/**
 * Stable Pool Monitor
 *
 * Monitors Aerodrome stable pools for imbalance opportunities
 * and rebalancing incentives on Base blockchain.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';

// Stable pool imbalance opportunity
export interface StablePoolOpportunity {
  id: string;
  poolAddress: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  imbalanceRatio: number; // Deviation from 50:50 (e.g., 0.1 = 10% deviation)
  rebalanceDirection: 'token0_to_token1' | 'token1_to_token0';
  optimalRebalanceAmount: bigint;
  estimatedIncentive: bigint; // Expected incentive/reward for rebalancing
  estimatedProfit: bigint; // Net profit after costs
  gasEstimate: bigint;
  deadline: number; // Timestamp when opportunity expires
  blockNumber: number;
  priority: 'high' | 'medium' | 'low';
}

// Stable pool state
export interface StablePoolState {
  poolAddress: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  fee: number; // Fee percentage (e.g., 0.0005 = 0.05%)
  lastUpdateBlock: number;
  lastUpdateTimestamp: number;
  isIncentivized: boolean;
  incentiveRate: bigint; // Incentive per unit rebalanced
}

// Stable pool configuration
export interface StablePoolConfig {
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  minImbalanceThreshold: number; // Minimum imbalance to consider (e.g., 0.05 = 5%)
  maxImbalanceThreshold: number; // Maximum safe imbalance (e.g., 0.2 = 20%)
  minProfitThreshold: bigint; // Minimum profit required
  priority: 'high' | 'medium' | 'low';
  isActive: boolean;
}

// Monitor options
export interface StablePoolMonitorOptions {
  pools: StablePoolConfig[];
  scanIntervalMs: number;
  minImbalanceThreshold: number; // Global minimum imbalance threshold
  maxOpportunitiesPerScan: number;
  minProfitThreshold: bigint;
  gasPrice: bigint;
}

/**
 * Stable Pool Monitor for Aerodrome
 */
export class StablePoolMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('stable-pool-monitor');
  private readonly options: StablePoolMonitorOptions;
  private readonly connectionManager: RpcConnectionManager;

  private isScanning = false;
  private scanInterval: NodeJS.Timeout | undefined;
  private lastScanBlock = 0;

  // Pool state cache
  private poolStates: Map<string, StablePoolState> = new Map();
  private poolConfigs: Map<string, StablePoolConfig> = new Map();

  constructor(options: StablePoolMonitorOptions, connectionManager: RpcConnectionManager) {
    super();
    this.options = options;
    this.connectionManager = connectionManager;

    // Initialize pool configurations
    for (const config of options.pools) {
      this.poolConfigs.set(config.poolAddress.toLowerCase(), config);
    }

    this.logger.info('Stable pool monitor initialized', {
      poolCount: options.pools.length,
      scanInterval: options.scanIntervalMs,
      minImbalanceThreshold: `${(options.minImbalanceThreshold * 100).toFixed(1)}%`,
      minProfit: options.minProfitThreshold.toString(),
    });
  }

  /**
   * Start monitoring stable pools
   */
  startScanning(): void {
    if (this.isScanning) {
      this.logger.warn('Stable pool monitor is already scanning');
      return;
    }

    this.logger.info('Starting stable pool monitoring');
    this.isScanning = true;

    // Start periodic scanning
    this.scanInterval = setInterval(() => {
      this.scanForRebalanceOpportunities().catch(error => {
        this.logger.logError(error as Error, { operation: 'stable-pool-scan' });
      });
    }, this.options.scanIntervalMs);

    // Initial scan
    this.scanForRebalanceOpportunities().catch(error => {
      this.logger.logError(error as Error, { operation: 'initial-stable-pool-scan' });
    });
  }

  /**
   * Stop monitoring
   */
  stopScanning(): void {
    if (!this.isScanning) {
      this.logger.warn('Stable pool monitor is not scanning');
      return;
    }

    this.logger.info('Stopping stable pool monitoring');
    this.isScanning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  /**
   * Scan for rebalancing opportunities
   */
  private async scanForRebalanceOpportunities(): Promise<void> {
    const operationId = `stable-pool-scan-${Date.now()}`;
    this.logger.startPerformanceTracking(operationId);

    try {
      const provider = this.connectionManager.getProvider();
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock <= this.lastScanBlock) {
        return; // No new blocks to scan
      }

      this.logger.debug('Scanning stable pools for rebalancing opportunities', {
        currentBlock,
        lastScanBlock: this.lastScanBlock,
        poolCount: this.poolConfigs.size,
      });

      const opportunities: StablePoolOpportunity[] = [];

      // Scan each configured pool
      for (const [poolAddress, config] of this.poolConfigs) {
        if (!config.isActive) continue;

        try {
          this.logger.markPerformance(
            operationId,
            `${config.token0Symbol}-${config.token1Symbol}-scan-start`
          );

          // Update pool state
          const poolState = await this.updatePoolState(poolAddress, currentBlock);

          // Check for imbalance opportunities
          const opportunity = await this.analyzePoolImbalance(poolState, config);

          if (opportunity) {
            opportunities.push(opportunity);
          }

          this.logger.markPerformance(
            operationId,
            `${config.token0Symbol}-${config.token1Symbol}-scan-complete`
          );
        } catch (error) {
          this.logger.logError(error as Error, {
            poolAddress,
            operation: 'pool-analysis',
          });
        }
      }

      // Filter and rank opportunities
      const viableOpportunities = this.filterAndRankOpportunities(opportunities);

      this.logger.markPerformance(operationId, 'filtering-complete');

      // Emit opportunities
      for (const opportunity of viableOpportunities) {
        this.emit('stablePoolOpportunityDetected', opportunity);
      }

      this.lastScanBlock = currentBlock;

      this.logger.info('Stable pool scan completed', {
        totalOpportunities: opportunities.length,
        viableOpportunities: viableOpportunities.length,
        blockNumber: currentBlock,
      });
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'stable-pool-scan' });
    } finally {
      this.logger.endPerformanceTracking(operationId);
    }
  }

  /**
   * Update pool state from blockchain with real contract calls
   */
  private async updatePoolState(
    poolAddress: string,
    blockNumber: number
  ): Promise<StablePoolState> {
    const provider = this.connectionManager.getProvider();

    this.logger.debug('Updating pool state', {
      poolAddress,
      blockNumber,
      providerConnected: !!provider,
    });

    try {
      // Real Aerodrome pair contract ABI
      const pairAbi = [
        'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)',
        'function totalSupply() external view returns (uint256)',
        'function stable() external view returns (bool)',
        'function fee() external view returns (uint256)',
      ];

      const pairContract = new ethers.Contract(poolAddress, pairAbi, provider);

      // Fetch real pool data
      const [reserves, token0, token1, totalSupply, feeData] = await Promise.all([
        (pairContract as any).getReserves(),
        (pairContract as any).token0(),
        (pairContract as any).token1(),
        (pairContract as any).totalSupply(),
        (pairContract as any).fee().catch(() => 5n), // Default 0.05% fee
      ]);

      // Check if pool has incentives (query Aerodrome Voter contract)
      const isIncentivized = await this.checkPoolIncentives(poolAddress);
      const incentiveRate = isIncentivized ? await this.getIncentiveRate(poolAddress) : null;

      const realState: StablePoolState = {
        poolAddress,
        token0,
        token1,
        reserve0: BigInt(reserves.reserve0.toString()),
        reserve1: BigInt(reserves.reserve1.toString()),
        totalSupply: BigInt(totalSupply.toString()),
        fee: Number(feeData) / 10000, // Convert from basis points
        lastUpdateBlock: blockNumber,
        lastUpdateTimestamp: Date.now(),
        isIncentivized,
        incentiveRate: incentiveRate || 0n, // Use 0n if incentive rate is null
      };

      this.poolStates.set(poolAddress.toLowerCase(), realState);
      return realState;
    } catch (error) {
      this.logger.warn('Failed to fetch real pool state, using fallback', {
        poolAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Fallback to estimated state based on known pool configurations
      return this.createFallbackPoolState(poolAddress, blockNumber);
    }
  }

  /**
   * Check if pool has active incentives using Aerodrome Voter contract
   */
  private async checkPoolIncentives(poolAddress: string): Promise<boolean> {
    try {
      const provider = this.connectionManager.getProvider();

      // Aerodrome Voter contract on Base
      const voterAddress = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';
      const voterAbi = [
        'function gauges(address pool) external view returns (address gauge)',
        'function isAlive(address gauge) external view returns (bool)',
      ];

      const voterContract = new ethers.Contract(voterAddress, voterAbi, provider);

      // Get gauge address for this pool
      const gaugeAddress = await (voterContract as any).gauges(poolAddress.toLowerCase());

      // Check if gauge exists and is alive
      if (gaugeAddress && gaugeAddress !== ethers.ZeroAddress) {
        const isAlive = await (voterContract as any).isAlive(gaugeAddress);
        return isAlive;
      }

      return false;
    } catch (error) {
      this.logger.warn('Failed to check pool incentives', { poolAddress, error });
      return false; // Conservative assumption on error
    }
  }

  /**
   * Get incentive rate for pool
   */
  private async getIncentiveRate(poolAddress: string): Promise<bigint | null> {
    try {
      const provider = this.connectionManager.getProvider();

      // First get the gauge address from the Voter contract
      const voterAddress = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';
      const voterAbi = ['function gauges(address pool) external view returns (address gauge)'];
      const voterContract = new ethers.Contract(voterAddress, voterAbi, provider);

      const gaugeAddress = await (voterContract as any).gauges(poolAddress.toLowerCase());

      if (!gaugeAddress || gaugeAddress === ethers.ZeroAddress) {
        this.logger.debug('No gauge found for pool', { poolAddress });
        return null;
      }

      // Query the gauge for reward rate
      const gaugeAbi = [
        'function rewardRate() external view returns (uint256)',
        'function rewardRateByEpoch(uint256 timestamp) external view returns (uint256)',
      ];

      const gaugeContract = new ethers.Contract(gaugeAddress, gaugeAbi, provider);

      // Try to get current reward rate
      const rewardRate = await (gaugeContract as any).rewardRate();

      if (rewardRate && rewardRate > 0n) {
        return BigInt(rewardRate.toString());
      }

      this.logger.debug('No active reward rate for gauge', { poolAddress, gaugeAddress });
      return null;
    } catch (error) {
      this.logger.error('Failed to get incentive rate from gauge contract', {
        poolAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null; // Return null on error so callers can handle missing data
    }
  }

  /**
   * Create fallback pool state when real data is unavailable
   */
  private createFallbackPoolState(poolAddress: string, blockNumber: number): StablePoolState {
    const config = this.poolConfigs.get(poolAddress.toLowerCase());

    if (!config) {
      throw new Error(`No configuration found for pool ${poolAddress}`);
    }

    // Create realistic fallback state based on configuration
    const baseReserve = ethers.parseEther('100000'); // 100K base reserve

    return {
      poolAddress,
      token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      token1: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      reserve0: baseReserve / 1000000000000n, // Adjust for USDC decimals
      reserve1: baseReserve, // DAI has 18 decimals
      totalSupply: baseReserve,
      fee: 0.0005, // 0.05%
      lastUpdateBlock: blockNumber,
      lastUpdateTimestamp: Date.now(),
      isIncentivized: config.priority === 'high',
      incentiveRate: config.priority === 'high' ? ethers.parseEther('0.001') : 0n,
    };
  }

  /**
   * Analyze pool for imbalance opportunities
   */
  private async analyzePoolImbalance(
    poolState: StablePoolState,
    config: StablePoolConfig
  ): Promise<StablePoolOpportunity | null> {
    // Calculate imbalance ratio
    const imbalanceRatio = this.calculateImbalanceRatio(poolState);

    // Check if imbalance exceeds threshold
    if (Math.abs(imbalanceRatio) < config.minImbalanceThreshold) {
      return null; // Not imbalanced enough
    }

    // Check if imbalance is within safe limits
    if (Math.abs(imbalanceRatio) > config.maxImbalanceThreshold) {
      this.logger.warn('Pool imbalance exceeds safe limits', {
        poolAddress: poolState.poolAddress,
        imbalanceRatio: `${(imbalanceRatio * 100).toFixed(2)}%`,
        maxThreshold: `${(config.maxImbalanceThreshold * 100).toFixed(2)}%`,
      });
      return null; // Too risky
    }

    // Determine rebalance direction
    const rebalanceDirection: 'token0_to_token1' | 'token1_to_token0' =
      imbalanceRatio > 0 ? 'token0_to_token1' : 'token1_to_token0';

    // Calculate optimal rebalance amount
    const optimalRebalanceAmount = this.calculateOptimalRebalanceAmount(poolState, imbalanceRatio);

    // Estimate incentives and costs
    const estimatedIncentive = this.calculateRebalanceIncentive(poolState, optimalRebalanceAmount);
    const gasEstimate = this.estimateRebalanceGas();
    const gasCost = gasEstimate * this.options.gasPrice;
    const estimatedProfit = estimatedIncentive - gasCost;

    // Check profitability
    if (estimatedProfit < config.minProfitThreshold) {
      return null; // Not profitable enough
    }

    const opportunity: StablePoolOpportunity = {
      id: `stable-rebalance-${poolState.poolAddress}-${Date.now()}`,
      poolAddress: poolState.poolAddress,
      token0: poolState.token0,
      token1: poolState.token1,
      reserve0: poolState.reserve0,
      reserve1: poolState.reserve1,
      imbalanceRatio,
      rebalanceDirection,
      optimalRebalanceAmount,
      estimatedIncentive,
      estimatedProfit,
      gasEstimate,
      deadline: Date.now() + 300000, // 5 minutes
      blockNumber: poolState.lastUpdateBlock,
      priority: config.priority,
    };

    this.logger.debug('Stable pool rebalancing opportunity detected', {
      poolAddress: poolState.poolAddress,
      imbalanceRatio: `${(imbalanceRatio * 100).toFixed(2)}%`,
      direction: rebalanceDirection,
      rebalanceAmount: optimalRebalanceAmount.toString(),
      estimatedProfit: estimatedProfit.toString(),
    });

    return opportunity;
  }

  /**
   * Calculate imbalance ratio (deviation from 50:50)
   */
  private calculateImbalanceRatio(poolState: StablePoolState): number {
    // Convert reserves to same decimal precision for comparison
    // Assuming token0 is USDC (6 decimals) and token1 is DAI (18 decimals)
    const reserve0Normalized = Number(poolState.reserve0) * 1e12; // Convert USDC to 18 decimals
    const reserve1Normalized = Number(poolState.reserve1);

    const totalValue = reserve0Normalized + reserve1Normalized;
    if (totalValue === 0) return 0;

    const token0Ratio = reserve0Normalized / totalValue;
    const idealRatio = 0.5; // 50:50 for stable pools

    return token0Ratio - idealRatio; // Positive means token0 is over-represented
  }

  /**
   * Calculate optimal rebalance amount
   */
  private calculateOptimalRebalanceAmount(
    poolState: StablePoolState,
    imbalanceRatio: number
  ): bigint {
    // Calculate amount needed to restore 50:50 balance
    // This is a simplified calculation - real implementation would use Aerodrome's stable swap math

    const reserve0Normalized = Number(poolState.reserve0) * 1e12;
    const reserve1Normalized = Number(poolState.reserve1);
    const totalValue = reserve0Normalized + reserve1Normalized;

    const excessAmount = (Math.abs(imbalanceRatio) * totalValue) / 2;

    // Convert back to token precision
    if (imbalanceRatio > 0) {
      // Too much token0, need to swap token0 to token1
      return BigInt(Math.floor(excessAmount / 1e12)); // Convert back to USDC precision
    } else {
      // Too much token1, need to swap token1 to token0
      return BigInt(Math.floor(excessAmount)); // Keep DAI precision
    }
  }

  /**
   * Calculate rebalancing incentive
   */
  private calculateRebalanceIncentive(poolState: StablePoolState, rebalanceAmount: bigint): bigint {
    if (!poolState.isIncentivized) {
      return 0n;
    }

    // Calculate incentive based on amount rebalanced
    // This is a simplified calculation - real implementation would query incentive contracts
    const incentivePerUnit = poolState.incentiveRate;
    const normalizedAmount = Number(rebalanceAmount) / 1e18; // Normalize to 18 decimals

    return BigInt(Math.floor(normalizedAmount)) * incentivePerUnit;
  }

  /**
   * Estimate gas cost for rebalancing
   */
  private estimateRebalanceGas(): bigint {
    // Estimated gas for stable pool rebalancing:
    // - Swap through stable pool: ~150k gas
    // - Incentive claim (if applicable): ~80k gas
    // - Safety margin: 20%
    return 276000n; // (150k + 80k) * 1.2
  }

  /**
   * Filter and rank rebalancing opportunities
   */
  private filterAndRankOpportunities(
    opportunities: StablePoolOpportunity[]
  ): StablePoolOpportunity[] {
    return opportunities
      .filter(opp => {
        // Filter by minimum profit threshold
        if (opp.estimatedProfit < this.options.minProfitThreshold) {
          return false;
        }

        // Filter expired opportunities
        if (opp.deadline < Date.now()) {
          return false;
        }

        // Filter by minimum imbalance threshold
        if (Math.abs(opp.imbalanceRatio) < this.options.minImbalanceThreshold) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Sort by priority first
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
        if (priorityDiff !== 0) return priorityDiff;

        // Then by estimated profit (descending)
        if (a.estimatedProfit > b.estimatedProfit) return -1;
        if (a.estimatedProfit < b.estimatedProfit) return 1;

        // Finally by imbalance severity (descending)
        return Math.abs(b.imbalanceRatio) - Math.abs(a.imbalanceRatio);
      })
      .slice(0, this.options.maxOpportunitiesPerScan);
  }

  /**
   * Add pool to monitoring
   */
  addPool(config: StablePoolConfig): void {
    this.poolConfigs.set(config.poolAddress.toLowerCase(), config);

    this.logger.info('Added stable pool to monitoring', {
      poolAddress: config.poolAddress,
      tokens: `${config.token0Symbol}/${config.token1Symbol}`,
      priority: config.priority,
    });
  }

  /**
   * Remove pool from monitoring
   */
  removePool(poolAddress: string): void {
    const normalizedAddress = poolAddress.toLowerCase();
    this.poolConfigs.delete(normalizedAddress);
    this.poolStates.delete(normalizedAddress);

    this.logger.info('Removed stable pool from monitoring', { poolAddress });
  }

  /**
   * Update pool configuration
   */
  updatePoolConfig(poolAddress: string, updates: Partial<StablePoolConfig>): void {
    const normalizedAddress = poolAddress.toLowerCase();
    const existingConfig = this.poolConfigs.get(normalizedAddress);

    if (!existingConfig) {
      throw new Error(`Pool not found: ${poolAddress}`);
    }

    const updatedConfig = { ...existingConfig, ...updates };
    this.poolConfigs.set(normalizedAddress, updatedConfig);

    this.logger.info('Updated stable pool configuration', {
      poolAddress,
      updates,
    });
  }

  /**
   * Get current monitoring status
   */
  getStatus() {
    return {
      isScanning: this.isScanning,
      lastScanBlock: this.lastScanBlock,
      poolCount: this.poolConfigs.size,
      activePoolCount: Array.from(this.poolConfigs.values()).filter(c => c.isActive).length,
      scanInterval: this.options.scanIntervalMs,
    };
  }

  /**
   * Get pool states
   */
  getPoolStates(): Map<string, StablePoolState> {
    return new Map(this.poolStates);
  }

  /**
   * Get pool configurations
   */
  getPoolConfigs(): Map<string, StablePoolConfig> {
    return new Map(this.poolConfigs);
  }
}
