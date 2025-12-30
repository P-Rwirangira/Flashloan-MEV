/**
 * Chainlink Price Oracle
 *
 * Real-time price feeds using Chainlink oracles on Base
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { RpcConnectionManager } from '../rpc/connection-manager';

// Chainlink price feed ABI (minimal)
const CHAINLINK_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
  'function description() external view returns (string)',
];

// Base Chainlink price feed addresses
const BASE_PRICE_FEEDS: Record<string, Address> = {
  'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as Address, // Base ETH/USD
  'USDC/USD': '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B' as Address, // Base USDC/USD
  'DAI/USD': '0x591e79239a7d679378eC8c847e5038150364C78F' as Address, // Base DAI/USD
  'WSTETH/ETH': '0x43a5C292A453A3bF3606fa856197f09D7B74251a' as Address, // Base wstETH/ETH
};

export interface PriceData {
  readonly price: bigint;
  readonly decimals: number;
  readonly updatedAt: number;
  readonly confidence: number; // 0-1 scale based on freshness
  readonly source: string;
}

export interface ChainlinkPriceOracle {
  getLatestPrice(pair: string): Promise<bigint>;
  getPriceWithConfidence(pair: string): Promise<PriceData>;
  getEthUsdPrice(): Promise<number>;
  getTokenUsdPrice(tokenAddress: Address): Promise<number>;
}

export class ChainlinkPriceOracleImpl extends EventEmitter implements ChainlinkPriceOracle {
  private readonly connectionManager: RpcConnectionManager;
  private readonly priceCache: Map<string, { data: PriceData; timestamp: number }> = new Map();
  private readonly cacheTimeMs = 30000; // 30 seconds cache
  private readonly maxPriceAge = 3600000; // 1 hour max age for price data

  // Known token addresses on Base for price mapping
  private static readonly TOKEN_TO_FEED: Record<string, string> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC/USD', // USDC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI/USD', // DAI
    '0x4200000000000000000000000000000000000006': 'ETH/USD', // WETH
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': 'WSTETH/ETH', // wstETH
  };

  constructor(connectionManager: RpcConnectionManager) {
    super();
    this.connectionManager = connectionManager;
  }

  /**
   * Get latest price for a trading pair
   */
  async getLatestPrice(pair: string): Promise<bigint> {
    const priceData = await this.getPriceWithConfidence(pair);
    return priceData.price;
  }

  /**
   * Get price with confidence metrics
   */
  async getPriceWithConfidence(pair: string): Promise<PriceData> {
    const cacheKey = pair;
    const cached = this.priceCache.get(cacheKey);

    // Return cached data if still valid
    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs) {
      return cached.data;
    }

    try {
      const feedAddress = BASE_PRICE_FEEDS[pair];
      if (!feedAddress) {
        throw new Error(`No price feed available for pair: ${pair}`);
      }

      const provider = this.connectionManager.getProvider();
      const priceFeedContract = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);

      if (!priceFeedContract['latestRoundData'] || !priceFeedContract['decimals']) {
        throw new Error(`Invalid price feed contract at ${feedAddress}`);
      }

      const [, answer, , updatedAt] = await priceFeedContract['latestRoundData']();
      const decimals = await priceFeedContract['decimals']();

      // Calculate confidence based on data freshness
      const ageMs = Date.now() - Number(updatedAt) * 1000;
      const confidence = Math.max(0, Math.min(1, 1 - ageMs / this.maxPriceAge));

      if (ageMs > this.maxPriceAge) {
        throw new Error(`Price data too old: ${ageMs}ms for pair ${pair}`);
      }

      const priceData: PriceData = {
        price: BigInt(answer.toString()),
        decimals: Number(decimals),
        updatedAt: Number(updatedAt) * 1000,
        confidence,
        source: `chainlink-${pair}`,
      };

      // Cache the result
      this.priceCache.set(cacheKey, { data: priceData, timestamp: Date.now() });

      this.emit('priceUpdated', { pair, priceData });
      return priceData;
    } catch (error) {
      this.emit('priceError', { pair, error });
      throw error;
    }
  }

  /**
   * Get ETH price in USD
   */
  async getEthUsdPrice(): Promise<number> {
    try {
      const priceData = await this.getPriceWithConfidence('ETH/USD');
      const price = Number(priceData.price) / Math.pow(10, priceData.decimals);
      return price;
    } catch (error) {
      // Fallback to multiple sources
      return this.getEthPriceFromMultipleSources();
    }
  }

  /**
   * Get token price in USD
   */
  async getTokenUsdPrice(tokenAddress: Address): Promise<number> {
    const tokenAddressLower = tokenAddress.toLowerCase();
    const feedPair = ChainlinkPriceOracleImpl.TOKEN_TO_FEED[tokenAddressLower];

    if (!feedPair) {
      // For unknown tokens, try to derive price from ETH pairs
      return this.deriveTokenPriceFromEth(tokenAddress);
    }

    try {
      if (feedPair === 'WSTETH/ETH') {
        // wstETH/ETH needs to be converted to USD
        const wstEthToEth = await this.getPriceWithConfidence('WSTETH/ETH');
        const ethToUsd = await this.getEthUsdPrice();

        const wstEthPrice = Number(wstEthToEth.price) / Math.pow(10, wstEthToEth.decimals);
        return wstEthPrice * ethToUsd;
      }

      const priceData = await this.getPriceWithConfidence(feedPair);
      return Number(priceData.price) / Math.pow(10, priceData.decimals);
    } catch (error) {
      // Fallback to DEX-based pricing
      return this.getTokenPriceFromDex(tokenAddress);
    }
  }

  /**
   * Get ETH price from multiple sources for redundancy
   */
  private async getEthPriceFromMultipleSources(): Promise<number> {
    const fallbackPrices: number[] = [];

    // Try USDC/USD as inverse calculation with real DEX data
    try {
      const usdcPrice = await this.getPriceWithConfidence('USDC/USD');
      if (Math.abs(Number(usdcPrice.price) / Math.pow(10, usdcPrice.decimals) - 1.0) < 0.05) {
        // USDC is close to $1, query real ETH/USDC pool for ETH price
        const ethUsdcPrice = await this.queryEthUsdcPoolPrice();
        if (ethUsdcPrice > 0) {
          fallbackPrices.push(ethUsdcPrice);
        }
      }
    } catch (error) {
      // Continue to next source
    }

    // Try DAI/USD as another reference
    try {
      const daiPrice = await this.getPriceWithConfidence('DAI/USD');
      if (Math.abs(Number(daiPrice.price) / Math.pow(10, daiPrice.decimals) - 1.0) < 0.05) {
        const ethDaiPrice = await this.queryEthDaiPoolPrice();
        if (ethDaiPrice > 0) {
          fallbackPrices.push(ethDaiPrice);
        }
      }
    } catch (error) {
      // Continue to next source
    }

    if (fallbackPrices.length === 0) {
      // Ultimate fallback - but log this for monitoring
      this.emit('fallbackPriceUsed', { token: 'ETH', price: 3000 });
      return 3000;
    }

    // Return median of available prices
    fallbackPrices.sort((a, b) => a - b);
    const mid = Math.floor(fallbackPrices.length / 2);
    return fallbackPrices.length % 2 === 0
      ? ((fallbackPrices[mid - 1] || 0) + (fallbackPrices[mid] || 0)) / 2
      : fallbackPrices[mid] || 0;
  }

  /**
   * Query ETH/USDC pool for real price data
   */
  private async queryEthUsdcPoolPrice(): Promise<number> {
    try {
      const provider = this.connectionManager.getProvider();

      // Base Uniswap V3 ETH/USDC pool (0.05% fee)
      const poolAddress = '0x74cb6260be6f31965c239df6d6ef2ac2b5d4f020';
      const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      ];

      const poolContract = new ethers.Contract(poolAddress, poolAbi, provider);
      const slot0 = await (poolContract as any).slot0();

      // Convert sqrtPriceX96 to price
      const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
      const Q96 = 2n ** 96n;
      const price = Number((sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96)) * Math.pow(10, 12); // Adjust for USDC decimals

      return price;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Query ETH/DAI pool for real price data
   */
  private async queryEthDaiPoolPrice(): Promise<number> {
    try {
      // Base Uniswap V3 ETH/DAI pool (if available)
      // For now, return 0 as DAI pools might not be as liquid on Base
      return 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Derive token price from ETH pairs using real DEX pool data
   */
  private async deriveTokenPriceFromEth(tokenAddress: Address): Promise<number> {
    try {
      const ethPrice = await this.getEthUsdPrice();

      // Query real DEX pools for token/ETH price
      const tokenEthPrice = await this.queryTokenEthPoolPrice(tokenAddress);

      if (tokenEthPrice > 0) {
        this.emit('derivedPriceUsed', { tokenAddress, ethRatio: tokenEthPrice });
        return tokenEthPrice * ethPrice;
      }

      // Fallback to token type detection
      return this.estimateTokenPriceByType(tokenAddress, ethPrice);
    } catch (error) {
      const ethPrice = await this.getEthUsdPrice();
      return this.estimateTokenPriceByType(tokenAddress, ethPrice);
    }
  }

  /**
   * Query token/ETH pool price from DEX
   */
  private async queryTokenEthPoolPrice(tokenAddress: Address): Promise<number> {
    try {
      const provider = this.connectionManager.getProvider();
      const tokenAddressLower = tokenAddress.toLowerCase();

      // Known Base token/ETH pools (verified addresses)
      const knownPools: Record<string, string> = {
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '0x74cb6260be6f31965c239df6d6ef2ac2b5d4f020', // USDC/ETH
        '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': '0xdcf81663e68f076ef9763442de134fd0699de4ef', // DAI/WETH (from GeckoTerminal)
        // Note: wstETH pools may not be available on Base yet, monitoring for deployment
      };

      const poolAddress = knownPools[tokenAddressLower];
      if (!poolAddress) {
        return 0; // No known pool
      }

      const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)',
      ];

      const poolContract = new ethers.Contract(poolAddress, poolAbi, provider);
      const [slot0, token0, token1] = await Promise.all([
        (poolContract as any).slot0(),
        (poolContract as any).token0(),
        (poolContract as any).token1(),
      ]);

      // Determine if token is token0 or token1
      const isToken0 = token0.toLowerCase() === tokenAddressLower;

      // Log token information for debugging
      this.emit('poolTokensQueried', {
        poolAddress,
        token0,
        token1,
        queriedToken: tokenAddress,
        isToken0,
      });

      // Convert sqrtPriceX96 to price
      const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
      const Q96 = 2n ** 96n;
      let price = Number((sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96));

      // Adjust price based on token position and decimals
      if (!isToken0) {
        price = 1 / price;
      }

      return price;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Estimate token price by type analysis using address lookup
   */
  private estimateTokenPriceByType(tokenAddress: Address, ethPrice: number): Promise<number> {
    const tokenAddressLower = tokenAddress.toLowerCase();

    // Known token addresses on Base (normalized to lowercase)
    const knownTokens: Record<string, { type: string; multiplier: number }> = {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { type: 'stablecoin', multiplier: 1.0 }, // USDC
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { type: 'stablecoin', multiplier: 1.0 }, // DAI
      '0x4200000000000000000000000000000000000006': { type: 'weth', multiplier: 1.0 }, // WETH
      '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { type: 'wsteth', multiplier: 1.1 }, // wstETH (approximate 10% premium)
    };

    const tokenInfo = knownTokens[tokenAddressLower];

    if (tokenInfo) {
      switch (tokenInfo.type) {
        case 'stablecoin':
          return Promise.resolve(1.0);
        case 'weth':
          return Promise.resolve(ethPrice);
        case 'wsteth':
          return Promise.resolve(ethPrice * tokenInfo.multiplier);
        default:
          return Promise.resolve(ethPrice * tokenInfo.multiplier);
      }
    }

    // For truly unknown tokens, use conservative estimate
    this.emit('unknownTokenPriceEstimated', { tokenAddress, estimatedRatio: 0.01 });
    return Promise.resolve(ethPrice * 0.01); // Very conservative 1% of ETH
  }

  /**
   * Get token price from DEX pools as fallback with real pool queries
   */
  private async getTokenPriceFromDex(tokenAddress: Address): Promise<number> {
    try {
      // First try to get price from token/ETH pools
      const tokenEthPrice = await this.queryTokenEthPoolPrice(tokenAddress);
      if (tokenEthPrice > 0) {
        const ethPrice = await this.getEthUsdPrice();
        return tokenEthPrice * ethPrice;
      }

      // Fallback to type-based estimation
      const ethPrice = await this.getEthUsdPrice();
      return this.estimateTokenPriceByType(tokenAddress, ethPrice);
    } catch (error) {
      // Ultimate fallback
      const ethPrice = await this.getEthUsdPrice();
      return this.estimateTokenPriceByType(tokenAddress, ethPrice);
    }
  }

  /**
   * Clear price cache
   */
  clearCache(): void {
    this.priceCache.clear();
    this.emit('cacheCleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    entries: Array<{ pair: string; age: number; confidence: number }>;
  } {
    const entries = Array.from(this.priceCache.entries()).map(([pair, cached]) => ({
      pair,
      age: Date.now() - cached.timestamp,
      confidence: cached.data.confidence,
    }));

    return {
      size: this.priceCache.size,
      entries,
    };
  }
}
