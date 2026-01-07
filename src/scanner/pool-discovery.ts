/**
 * Automated pool discovery for Uniswap V3 and Aerodrome
 * Discovers pools via factory events and filters by liquidity/volume
 */

import { ethers } from 'ethers';
import type { Address } from '../types/common.js';
import type { RpcConnectionManager } from '../rpc/connection-manager.js';
import { createComponentLogger } from '../utils/logger.js';

// Factory addresses on Base
export const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
export const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

// Uniswap V3 Factory ABI (PoolCreated event)
const UNISWAP_V3_FACTORY_ABI = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

// Pool ABI for liquidity checks
const POOL_ABI = [
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

// ERC20 ABI for decimals
const ERC20_ABI = ['function decimals() external view returns (uint8)'];

export interface DiscoveredPool {
  address: Address;
  token0: Address;
  token1: Address;
  dex: 'uniswap-v3' | 'aerodrome';
  fee?: number; // Uniswap V3 fee tier
  stable?: boolean; // Aerodrome stable/volatile
  tvl: number; // Estimated TVL in USD
  liquidity: string; // Raw liquidity value
  createdBlock?: number;
  score: number; // Pool quality score (0-100)
}

export interface PoolDiscoveryConfig {
  minTvlUsd: number; // Minimum TVL to consider pool
  minScore: number; // Minimum quality score (0-100)
  maxPools: number; // Maximum pools to discover per DEX
  blockLookback: number; // How many blocks to look back for events
  enableUniswapV3: boolean;
  enableAerodrome: boolean;
}

const DEFAULT_CONFIG: PoolDiscoveryConfig = {
  minTvlUsd: 10000, // $10k minimum
  minScore: 50, // Score of 50+
  maxPools: 20,
  blockLookback: 100000, // ~2 days on Base (2s blocks)
  enableUniswapV3: true,
  enableAerodrome: true,
};

export class PoolDiscoveryService {
  private logger: ReturnType<typeof createComponentLogger>;
  private config: PoolDiscoveryConfig;

  constructor(
    private connectionManager: RpcConnectionManager,
    config?: Partial<PoolDiscoveryConfig>
  ) {
    this.logger = createComponentLogger('pool-discovery');
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Discover pools from both Uniswap V3 and Aerodrome
   */
  async discoverPools(): Promise<DiscoveredPool[]> {
    this.logger.info('Starting pool discovery', {
      minTvl: this.config.minTvlUsd,
      minScore: this.config.minScore,
      maxPoolsPerDex: this.config.maxPools,
    });

    const allPools: DiscoveredPool[] = [];

    try {
      // Discover Uniswap V3 pools
      if (this.config.enableUniswapV3) {
        const uniswapPools = await this.discoverUniswapV3Pools();
        allPools.push(...uniswapPools);
        this.logger.info('Uniswap V3 pools discovered', { count: uniswapPools.length });
      }

      // Discover Aerodrome pools
      if (this.config.enableAerodrome) {
        const aerodromePools = await this.discoverAerodromePools();
        allPools.push(...aerodromePools);
        this.logger.info('Aerodrome pools discovered', { count: aerodromePools.length });
      }

      // Filter and rank pools
      const qualifiedPools = allPools
        .filter((p) => p.tvl >= this.config.minTvlUsd && p.score >= this.config.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.config.maxPools * 2); // Get top pools across both DEXes

      this.logger.info('Pool discovery completed', {
        totalDiscovered: allPools.length,
        qualified: qualifiedPools.length,
      });

      return qualifiedPools;
    } catch (error) {
      this.logger.error('Pool discovery failed', { error });
      throw error;
    }
  }

  /**
   * Discover Uniswap V3 pools via factory events
   */
  private async discoverUniswapV3Pools(): Promise<DiscoveredPool[]> {
    const provider = this.connectionManager.getProvider();
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);

    try {
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - this.config.blockLookback);

      this.logger.debug('Querying Uniswap V3 PoolCreated events', {
        fromBlock,
        toBlock: currentBlock,
      });

      // Query PoolCreated events
      const filter = (factory.filters as any).PoolCreated();
      const events = await factory.queryFilter(filter, fromBlock, currentBlock);

      this.logger.info('Uniswap V3 PoolCreated events found', { count: events.length });

      // Process each pool
      const pools: DiscoveredPool[] = [];
      for (const event of events) {
        try {
          if (!('args' in event)) continue;
          const { token0, token1, fee, pool } = event.args as any;

          // Get pool liquidity
          const poolContract = new ethers.Contract(pool, POOL_ABI, provider);
          const liquidity = await (poolContract as any).liquidity();

          // Skip if no liquidity
          if (liquidity.toString() === '0') {
            continue;
          }

          // Estimate TVL (rough approximation)
          const tvl = await this.estimateUniswapV3TVL(pool, token0, token1);

          // Calculate pool score
          const score = this.calculatePoolScore(tvl, Number(liquidity), 'uniswap-v3');

          pools.push({
            address: pool as Address,
            token0: token0 as Address,
            token1: token1 as Address,
            dex: 'uniswap-v3',
            fee: Number(fee),
            tvl,
            liquidity: liquidity.toString(),
            createdBlock: event.blockNumber,
            score,
          });

          this.logger.debug('Discovered Uniswap V3 pool', {
            address: pool,
            token0,
            token1,
            fee: Number(fee),
            tvl: tvl.toFixed(2),
            score,
          });
        } catch (error) {
          this.logger.warn('Failed to process Uniswap V3 pool', {
            pool: 'args' in event ? (event.args as any)?.pool : 'unknown',
            error,
          });
        }
      }

      return pools.filter((p) => p.tvl >= this.config.minTvlUsd).slice(0, this.config.maxPools);
    } catch (error) {
      this.logger.error('Uniswap V3 pool discovery failed', { error });
      return [];
    }
  }

  /**
   * Discover Aerodrome pools via factory
   * Note: Aerodrome factory may not support standard Uniswap V2 interface
   */
  private async discoverAerodromePools(): Promise<DiscoveredPool[]> {
    this.logger.warn('Aerodrome auto-discovery not yet supported - factory interface incompatible');
    this.logger.info('Using configured Aerodrome pools from config/default.yaml');
    return [];
  }

  /**
   * Estimate Uniswap V3 pool TVL (rough approximation)
   */
  private async estimateUniswapV3TVL(
    poolAddress: string,
    token0: string,
    token1: string
  ): Promise<number> {
    try {
      const provider = this.connectionManager.getProvider();
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

      const [liquidity, slot0, decimals0, decimals1] = await Promise.all([
        (poolContract as any).liquidity(),
        (poolContract as any).slot0(),
        (new ethers.Contract(token0, ERC20_ABI, provider) as any).decimals(),
        (new ethers.Contract(token1, ERC20_ABI, provider) as any).decimals(),
      ]);

      // Rough TVL estimation based on liquidity and sqrt price
      // This is a simplified calculation
      const liquidityNum = Number(liquidity);
      const sqrtPriceX96 = slot0.sqrtPriceX96;
      const price = Math.pow(Number(sqrtPriceX96) / 2 ** 96, 2);

      // Estimate token amounts
      const amount0 = liquidityNum / Math.sqrt(price);
      const amount1 = liquidityNum * Math.sqrt(price);

      // Normalize by decimals
      const normalizedAmount0 = amount0 / 10 ** Number(decimals0);
      const normalizedAmount1 = amount1 / 10 ** Number(decimals1);

      // For now, assume $1 per token as rough approximation
      // In production, you'd fetch real prices from an oracle
      return (normalizedAmount0 + normalizedAmount1) * 1;
    } catch (error) {
      this.logger.debug('Failed to estimate Uniswap V3 TVL', { poolAddress, error });
      return 0;
    }
  }


  /**
   * Calculate pool quality score (0-100)
   * Based on: TVL, liquidity depth, and DEX reputation
   */
  private calculatePoolScore(tvl: number, liquidity: number, dex: string): number {
    let score = 0;

    // TVL score (0-40 points)
    if (tvl >= 10000000) score += 40; // $10M+
    else if (tvl >= 1000000) score += 30; // $1M+
    else if (tvl >= 100000) score += 20; // $100k+
    else if (tvl >= 10000) score += 10; // $10k+

    // Liquidity score (0-30 points)
    if (liquidity >= 1e24) score += 30;
    else if (liquidity >= 1e20) score += 20;
    else if (liquidity >= 1e18) score += 10;

    // DEX reputation score (0-30 points)
    if (dex === 'uniswap-v3') score += 30; // Most liquid
    else if (dex === 'aerodrome') score += 25; // Base native

    return Math.min(100, score);
  }
}
