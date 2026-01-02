/**
 * OracleAdapter
 *
 * Provides cached, timeout-backed access to ETH/USD and token/USD prices.
 * Wraps the existing ChainlinkPriceOracleImpl while adding:
 * - In-memory TTL cache (default 60s)
 * - Graceful fallbacks to last-good values (stale window configurable)
 * - Timeouts on underlying calls
 */

import { ethers } from 'ethers';

// Lazy import to avoid circular deps on module load
async function getChainlinkImpl() {
  const mod = await import('./chainlink-oracle');
  return mod.ChainlinkPriceOracleImpl as any;
}

export interface ProviderLike {
  getProvider: () => ethers.Provider;
}

export interface OracleAdapterOptions {
  ttlMs?: number; // cache TTL for fresh values
  staleWindowMs?: number; // allow serving stale values up to this window
  timeoutMs?: number; // timeout for underlying oracle calls
}

type CacheEntry = { value: number; ts: number };

export class OracleAdapter {
  private readonly providerLike: ProviderLike;
  private readonly ttlMs: number;
  private readonly staleWindowMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(providerLike: ProviderLike, opts?: OracleAdapterOptions) {
    this.providerLike = providerLike;
    this.ttlMs = opts?.ttlMs ?? 60_000; // 60s
    this.staleWindowMs = opts?.staleWindowMs ?? 5 * 60_000; // 5m
    this.timeoutMs = opts?.timeoutMs ?? 3_000; // 3s
  }

  private get now() {
    return Date.now();
  }

  private getCached(key: string): number | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    // Fresh within TTL
    if (this.now - e.ts <= this.ttlMs) return e.value;
    // Stale but within allowed stale window
    if (this.now - e.ts <= this.ttlMs + this.staleWindowMs) return e.value;
    return undefined;
  }

  private setCached(key: string, val: number) {
    this.cache.set(key, { value: val, ts: this.now });
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('oracle-timeout')), this.timeoutMs);
      p.then(v => {
        clearTimeout(to);
        resolve(v);
      }).catch(err => {
        clearTimeout(to);
        reject(err);
      });
    });
  }

  async getEthUsd(): Promise<number> {
    const key = 'ETH_USD';
    const fresh = this.getCached(key);
    if (fresh !== undefined && this.now - (this.cache.get(key)?.ts || 0) <= this.ttlMs)
      return fresh;

    try {
      const ChainlinkPriceOracleImpl = await getChainlinkImpl();
      const oracle = new ChainlinkPriceOracleImpl(this.providerLike);
      const price = await this.withTimeout(oracle.getEthUsdPrice());
      if (typeof price === 'number' && price > 0) {
        this.setCached(key, price);
        return price;
      }
      // fall through to stale
    } catch (_) {
      // ignore, fallback below
    }

    const cached = this.getCached(key);
    if (cached !== undefined) return cached; // serve last-good even if stale
    throw new Error('ETH/USD price unavailable');
  }

  async getTokenUsd(token: string): Promise<number> {
    const key = `TOKEN_USD_${token.toLowerCase()}`;
    const fresh = this.getCached(key);
    if (fresh !== undefined && this.now - (this.cache.get(key)?.ts || 0) <= this.ttlMs)
      return fresh;

    try {
      const ChainlinkPriceOracleImpl = await getChainlinkImpl();
      const oracle = new ChainlinkPriceOracleImpl(this.providerLike);
      const price = await this.withTimeout(oracle.getTokenUsdPrice(token));
      if (typeof price === 'number' && price > 0) {
        this.setCached(key, price);
        return price;
      }
    } catch (_) {
      // ignore
    }

    const cached = this.getCached(key);
    if (cached !== undefined) return cached;
    // As a conservative fallback, return 0 (caller should handle zero-good price by skipping trades)
    return 0;
  }
}
