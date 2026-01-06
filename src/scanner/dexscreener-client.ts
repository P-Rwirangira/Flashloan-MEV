/**
 * DexScreener API Client
 * Handles all API interactions with rate limiting and caching
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';

export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  pairCreatedAt?: number;
}

export interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

interface CachedData<T> {
  data: T;
  timestamp: number;
}

export interface DexScreenerConfig {
  apiUrl: string;
  maxRequestsPerMinute: number;
  cacheTimeMs: number;
  retryDelayMs: number;
  maxRetries: number;
  timeout: number;
}

export class DexScreenerClient {
  private readonly client: AxiosInstance;
  private readonly config: DexScreenerConfig;
  private cache = new Map<string, CachedData<DexScreenerResponse>>();
  private requestCount = 0;
  private requestResetTime = Date.now() + 60000;

  constructor(config: DexScreenerConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: config.timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MEV-Bot/1.0'
      }
    });

    logger.info('DexScreener client initialized', {
      apiUrl: config.apiUrl,
      rateLimit: config.maxRequestsPerMinute
    });
  }

  /**
   * Fetch pairs by chain and addresses
   */
  async fetchPairs(chain: string, addresses: string[]): Promise<DexScreenerPair[]> {
    if (addresses.length === 0) {
      return [];
    }

    const cacheKey = `pairs-${chain}-${addresses.sort().join(',')}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached.pairs;
    }

    await this.enforceRateLimit();

    const url = `/pairs/${chain}/${addresses.join(',')}`;
    
    try {
      const response = await this.client.get<DexScreenerResponse>(url);
      
      if (response.data && response.data.pairs) {
        this.setCache(cacheKey, response.data);
        logger.debug('Fetched pairs from DexScreener', {
          chain,
          count: response.data.pairs.length,
          addresses: addresses.length
        });
        return response.data.pairs;
      }

      return [];
    } catch (error) {
      logger.error('Failed to fetch pairs from DexScreener', {
        error: error instanceof Error ? error.message : 'Unknown error',
        url,
        addresses: addresses.length
      });
      throw error;
    }
  }

  /**
   * Fetch all pairs for a specific token
   */
  async fetchTokenPairs(chain: string, tokenAddress: string): Promise<DexScreenerPair[]> {
    const cacheKey = `token-${chain}-${tokenAddress}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached.pairs;
    }

    await this.enforceRateLimit();

    const url = `/tokens/${tokenAddress}`;
    
    try {
      const response = await this.client.get<DexScreenerResponse>(url);
      
      if (response.data && response.data.pairs) {
        // Filter by chain
        const chainPairs = response.data.pairs.filter(p => p.chainId === chain);
        this.setCache(cacheKey, { ...response.data, pairs: chainPairs });
        
        logger.debug('Fetched token pairs from DexScreener', {
          chain,
          token: tokenAddress,
          count: chainPairs.length
        });
        
        return chainPairs;
      }

      return [];
    } catch (error) {
      logger.error('Failed to fetch token pairs from DexScreener', {
        error: error instanceof Error ? error.message : 'Unknown error',
        token: tokenAddress
      });
      throw error;
    }
  }

  /**
   * Search for pairs by query
   */
  async searchPairs(query: string): Promise<DexScreenerPair[]> {
    const cacheKey = `search-${query}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached.pairs;
    }

    await this.enforceRateLimit();

    const url = `/search?q=${encodeURIComponent(query)}`;
    
    try {
      const response = await this.client.get<DexScreenerResponse>(url);
      
      if (response.data && response.data.pairs) {
        this.setCache(cacheKey, response.data);
        logger.debug('Search results from DexScreener', {
          query,
          count: response.data.pairs.length
        });
        return response.data.pairs;
      }

      return [];
    } catch (error) {
      logger.error('Failed to search pairs on DexScreener', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query
      });
      throw error;
    }
  }

  /**
   * Get cached data if still valid
   */
  private getFromCache(key: string): DexScreenerResponse | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    const age = Date.now() - cached.timestamp;
    if (age > this.config.cacheTimeMs) {
      this.cache.delete(key);
      return null;
    }

    logger.debug('Cache hit', { key, age });
    return cached.data;
  }

  /**
   * Set cache data
   */
  private setCache(key: string, data: DexScreenerResponse): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Enforce rate limiting
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Reset counter if minute has passed
    if (now >= this.requestResetTime) {
      this.requestCount = 0;
      this.requestResetTime = now + 60000;
    }

    // Check if we've hit the limit
    if (this.requestCount >= this.config.maxRequestsPerMinute) {
      const waitTime = this.requestResetTime - now;
      logger.warn('Rate limit reached, waiting', { waitTime });
      await this.sleep(waitTime);
      this.requestCount = 0;
      this.requestResetTime = Date.now() + 60000;
    }

    this.requestCount++;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; oldestAge: number; newestAge: number } {
    const now = Date.now();
    let oldestAge = 0;
    let newestAge = Infinity;

    for (const cached of this.cache.values()) {
      const age = now - cached.timestamp;
      oldestAge = Math.max(oldestAge, age);
      newestAge = Math.min(newestAge, age);
    }

    return {
      size: this.cache.size,
      oldestAge,
      newestAge: newestAge === Infinity ? 0 : newestAge
    };
  }
}
