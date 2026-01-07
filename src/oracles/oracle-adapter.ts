/**
 * Oracle Adapter
 *
 * Unified interface for price feeds with fallback mechanisms
 */

import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';
import { ChainlinkPriceOracleImpl } from './chainlink-oracle';

export interface PriceData {
  price: number;
  timestamp: number;
  source: string;
  confidence: number; // 0-1 scale
}

export interface OracleConfig {
  chainlinkEnabled: boolean;
  fallbackApiEnabled: boolean;
  cacheTimeMs: number;
  maxPriceAge: number;
  priceDeviationThreshold: number; // Maximum allowed deviation between sources
}

/**
 * Oracle Adapter with multiple price sources and fallback
 */
export class OracleAdapter {
  private readonly logger = createComponentLogger('oracle-adapter');
  private readonly chainlinkOracle: ChainlinkPriceOracleImpl;
  private readonly config: OracleConfig;

  // Price cache
  private priceCache = new Map<string, PriceData>();

  constructor(connectionManager: any, config: Partial<OracleConfig> = {}) {
    this.config = {
      chainlinkEnabled: config.chainlinkEnabled ?? true,
      fallbackApiEnabled: config.fallbackApiEnabled ?? true,
      cacheTimeMs: config.cacheTimeMs ?? 60000, // 1 minute
      maxPriceAge: config.maxPriceAge ?? 300000, // 5 minutes
      priceDeviationThreshold: config.priceDeviationThreshold ?? 0.05, // 5%
      ...config,
    };

    this.chainlinkOracle = new ChainlinkPriceOracleImpl(connectionManager);
  }

  /**
   * Get ETH/USD price with fallback
   */
  async getEthUsd(): Promise<number> {
    const cacheKey = 'ETH/USD';

    // Check cache first
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTimeMs) {
      return cached.price;
    }

    const prices: PriceData[] = [];

    // Try Chainlink first
    if (this.config.chainlinkEnabled) {
      try {
        const chainlinkPrice = await this.chainlinkOracle.getEthUsdPrice();
        prices.push({
          price: chainlinkPrice,
          timestamp: Date.now(),
          source: 'chainlink',
          confidence: 0.95,
        });
      } catch (error) {
        this.logger.warn('Chainlink ETH/USD price failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Try fallback API
    if (this.config.fallbackApiEnabled && prices.length === 0) {
      try {
        const apiPrice = await this.fetchEthPriceFromApi();
        prices.push({
          price: apiPrice,
          timestamp: Date.now(),
          source: 'coingecko',
          confidence: 0.8,
        });
      } catch (error) {
        this.logger.warn('Fallback API ETH/USD price failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (prices.length === 0) {
      throw new Error('No price sources available for ETH/USD');
    }

    // Use highest confidence price
    const bestPrice = prices.reduce((best, current) =>
      current.confidence > best.confidence ? current : best
    );

    // Cache the result
    this.priceCache.set(cacheKey, bestPrice);

    this.logger.debug('ETH/USD price retrieved', {
      price: bestPrice.price,
      source: bestPrice.source,
      confidence: bestPrice.confidence,
    });

    return bestPrice.price;
  }

  /**
   * Get token/USD price
   */
  async getTokenUsd(tokenAddress: Address): Promise<number> {
    const cacheKey = `${tokenAddress}/USD`;

    // Check cache first
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTimeMs) {
      return cached.price;
    }

    try {
      // Try Chainlink first
      if (this.config.chainlinkEnabled) {
        const price = await this.chainlinkOracle.getTokenUsdPrice(tokenAddress);

        const priceData: PriceData = {
          price,
          timestamp: Date.now(),
          source: 'chainlink',
          confidence: 0.95,
        };

        this.priceCache.set(cacheKey, priceData);
        return price;
      }
    } catch (error) {
      this.logger.warn('Chainlink token price failed', {
        token: tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback to 1.0 for stablecoins
    const stablecoins = [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI on Base
    ];

    if (stablecoins.includes(tokenAddress.toLowerCase())) {
      const priceData: PriceData = {
        price: 1.0,
        timestamp: Date.now(),
        source: 'hardcoded-stable',
        confidence: 0.99,
      };

      this.priceCache.set(cacheKey, priceData);
      return 1.0;
    }

    throw new Error(`No price feed available for token: ${tokenAddress}`);
  }

  /**
   * Fetch ETH price from external API
   */
  private async fetchEthPriceFromApi(): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as any;

      if (!data.ethereum || typeof data.ethereum.usd !== 'number') {
        throw new Error('Invalid API response format');
      }

      return data.ethereum.usd;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Clear price cache
   */
  clearCache(): void {
    this.priceCache.clear();
    this.logger.debug('Price cache cleared');
  }

  /**
   * Get cached prices for debugging
   */
  getCachedPrices(): Map<string, PriceData> {
    return new Map(this.priceCache);
  }
}
