/**
 * DexScreener Configuration Loader
 * Loads and validates DexScreener-specific configuration
 */

import { z } from 'zod';

export const DexScreenerClientConfigSchema = z.object({
  apiUrl: z.string().url(),
  maxRequestsPerMinute: z.number().min(1).max(300),
  cacheTimeMs: z.number().min(1000),
  retryDelayMs: z.number().min(100),
  maxRetries: z.number().min(0).max(10),
  timeout: z.number().min(1000)
});

export const DexScreenerMonitorConfigSchema = z.object({
  chain: z.string(),
  poolAddresses: z.array(z.string()),
  minLiquidityUsd: z.number().min(0),
  minVolume24hUsd: z.number().min(0),
  updateIntervalMs: z.number().min(1000),
  enableAutoDiscovery: z.boolean(),
  maxStaleDataMs: z.number().min(1000)
});

export const CrossDexScannerConfigSchema = z.object({
  enabled: z.boolean(),
  minSpreadPercent: z.number().min(0),
  minProfitUsd: z.number().min(0),
  minConfidenceScore: z.number().min(0).max(100),
  maxPriceImpactPercent: z.number().min(0),
  scanIntervalMs: z.number().min(1000)
});

export const MultiHopScannerConfigSchema = z.object({
  enabled: z.boolean(),
  maxHops: z.number().min(2).max(10),
  minSpreadPercent: z.number().min(0),
  minProfitUsd: z.number().min(0),
  minConfidenceScore: z.number().min(0).max(100),
  maxPriceImpactPercent: z.number().min(0),
  scanIntervalMs: z.number().min(1000),
  enabledTokens: z.array(z.string())
});

export const DiscoveryConfigSchema = z.object({
  enabled: z.boolean(),
  minLiquidityUsd: z.number().min(0),
  minVolume24hUsd: z.number().min(0),
  minVolume1hUsd: z.number().min(0),
  maxPoolAge: z.number().min(0),
  scanIntervalMs: z.number().min(1000),
  maxNewPoolsPerScan: z.number().min(1),
  whitelistedTokens: z.array(z.string()),
  blacklistedTokens: z.array(z.string())
});

export const OrchestratorConfigSchema = z.object({
  enableCrossDex: z.boolean(),
  enableMultiHop: z.boolean(),
  enableDiscovery: z.boolean(),
  validateWithRpc: z.boolean(),
  maxPriceDiscrepancy: z.number().min(0),
  executionEnabled: z.boolean(),
  paperTradingMode: z.boolean()
});

export const DexScreenerConfigSchema = z.object({
  enabled: z.boolean(),
  apiUrl: z.string().url(),
  maxRequestsPerMinute: z.number(),
  cacheTimeMs: z.number(),
  retryDelayMs: z.number(),
  maxRetries: z.number(),
  timeout: z.number(),
  chain: z.string(),
  poolAddresses: z.array(z.string()),
  minLiquidityUsd: z.number(),
  minVolume24hUsd: z.number(),
  updateIntervalMs: z.number(),
  enableAutoDiscovery: z.boolean(),
  maxStaleDataMs: z.number(),
  crossDexScanner: CrossDexScannerConfigSchema,
  multiHopScanner: MultiHopScannerConfigSchema,
  discovery: DiscoveryConfigSchema,
  orchestrator: OrchestratorConfigSchema
});

export type DexScreenerConfig = z.infer<typeof DexScreenerConfigSchema>;
export type DexScreenerClientConfig = z.infer<typeof DexScreenerClientConfigSchema>;
export type DexScreenerMonitorConfig = z.infer<typeof DexScreenerMonitorConfigSchema>;
export type CrossDexScannerConfig = z.infer<typeof CrossDexScannerConfigSchema>;
export type MultiHopScannerConfig = z.infer<typeof MultiHopScannerConfigSchema>;
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
