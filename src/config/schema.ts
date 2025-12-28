/**
 * Configuration Schema
 *
 * Zod schemas for configuration validation.
 */

import { z } from 'zod';

// Address validation schema
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

// Network configuration schema
const networkConfigSchema = z.object({
  chainId: z.number().positive(),
  name: z.string().min(1),
  rpcUrl: z.string().url(),
  wsUrl: z.string().url().optional().or(z.literal('')),
  fallbackRpcs: z.array(z.string().url()),
});

// Gas configuration schema
const gasConfigSchema = z.object({
  maxGasPrice: z.string().or(z.number()),
  gasLimit: z.number().positive(),
  priorityFee: z.string().or(z.number()),
  baseFeeMultiplier: z.number().positive().max(10),
});

// Timing configuration schema
const timingConfigSchema = z.object({
  maxLatencyMs: z.number().positive().max(10000),
  timeoutMs: z.number().positive().max(60000),
  retryDelayMs: z.number().positive().max(5000),
  maxRetries: z.number().int().min(0).max(10),
  simulationTimeoutMs: z.number().positive().max(5000),
});

// Strategy configuration schemas
const strategyConfigSchema = z.object({
  enabled: z.boolean(),
  minProfitUSD: z.number().positive(),
  maxSlippageBps: z.number().int().min(0).max(10000),
  maxGasPriceGwei: z.number().positive(),
  maxPositionSize: z.number().positive(),
  cooldownMs: z.number().int().min(0),
});

const arbitrageConfigSchema = strategyConfigSchema.extend({
  pairs: z.array(z.string()),
  maxRoutes: z.number().int().min(1).max(10),
  fallbackRoutes: z.number().int().min(0).max(5),
  minSpreadBps: z.number().int().min(0).max(10000),
  maxPriceImpactBps: z.number().int().min(0).max(10000),
  dexPriority: z.array(z.string()),
  competitionThreshold: z.number().min(0).max(10),
});

const liquidationConfigSchema = strategyConfigSchema.extend({
  minHealthFactor: z.number().positive().max(2),
  maxCloseFactor: z.number().min(0).max(1),
  protocols: z.array(z.string()),
  minLiquidationBonus: z.number().min(0).max(1),
  maxLiquidationAmount: z.number().positive(),
  healthFactorBuffer: z.number().min(0).max(1),
});

const rebalancingConfigSchema = strategyConfigSchema.extend({
  minImbalanceBps: z.number().int().min(0).max(10000),
  incentiveThreshold: z.number().min(0).max(1),
  stablePools: z.array(addressSchema),
  maxRebalanceAmount: z.number().positive(),
  targetUtilization: z.number().min(0).max(1),
});

// Pool allowlist schema
const poolAllowlistSchema = z.object({
  address: addressSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(10),
  minTvl: z.number().min(0),
  maxSlippage: z.number().min(0).max(1),
  tags: z.array(z.string()),
});

const poolAllowlistsSchema = z.object({
  uniswapV3: z.array(poolAllowlistSchema),
  aerodrome: z.array(poolAllowlistSchema),
});

// Token allowlist schema
const tokenAllowlistSchema = z.object({
  address: addressSchema,
  symbol: z.string().min(1).max(10),
  decimals: z.number().int().min(0).max(18),
  enabled: z.boolean(),
  trusted: z.boolean(),
  maxAmount: z.number().positive(),
});

// Relay configuration schema
const relayEndpointSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  apiKey: z.string().optional().or(z.literal('')),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(10),
  maxLatencyMs: z.number().positive(),
  rateLimit: z.number().positive(),
});

const relayConfigSchema = z.object({
  primary: z.string(),
  fallbacks: z.array(z.string()),
  maxBribeGwei: z.number().positive(),
  endpoints: z.record(z.string(), relayEndpointSchema),
  retryAttempts: z.number().int().min(0).max(5),
  timeoutMs: z.number().positive(),
});

// Alert configuration schema
const alertConfigSchema = z.object({
  enabled: z.boolean(),
  webhook: z.string().url().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  slack: z.string().url().optional().or(z.literal('')),
  threshold: z.number().positive(),
  cooldownMs: z.number().positive(),
});

// Monitoring configuration schema
const monitoringConfigSchema = z.object({
  metricsPort: z.number().int().min(1000).max(65535),
  healthCheckPort: z.number().int().min(1000).max(65535),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']),
  alerting: z.object({
    consecutiveRevertThreshold: z.number().int().min(1).max(100),
    latencyThresholdMs: z.number().positive(),
    successRateThreshold: z.number().min(0).max(1),
    profitThresholdUSD: z.number().positive(),
    alerts: z.record(z.string(), alertConfigSchema),
  }),
  circuitBreaker: z.object({
    enabled: z.boolean(),
    failureThreshold: z.number().int().min(1).max(100),
    recoveryTimeMs: z.number().positive(),
    halfOpenMaxCalls: z.number().int().min(1).max(100),
  }),
});

// Security configuration schema
const securityConfigSchema = z.object({
  maxConcurrentTx: z.number().int().min(1).max(100),
  maxDailyLoss: z.number().positive(),
  emergencyStop: z.boolean(),
  allowedCallers: z.array(addressSchema),
  rateLimits: z.object({
    requestsPerSecond: z.number().positive(),
    burstSize: z.number().positive(),
  }),
});

// Performance configuration schema
const performanceConfigSchema = z.object({
  maxLatencyMs: z.number().positive(),
  simulationTimeoutMs: z.number().positive(),
  maxRetries: z.number().int().min(0).max(10),
  batchSize: z.number().int().min(1).max(1000),
  cacheSize: z.number().int().min(0).max(10000),
  cacheTtlMs: z.number().positive(),
});

// Main configuration schema
export const configSchema = z.object({
  network: networkConfigSchema,
  gas: gasConfigSchema,
  timing: timingConfigSchema,
  security: securityConfigSchema,
  performance: performanceConfigSchema,

  strategies: z.object({
    arbitrage: arbitrageConfigSchema,
    liquidation: liquidationConfigSchema,
    rebalancing: rebalancingConfigSchema,
  }),

  allowedPools: poolAllowlistsSchema,
  allowedTokens: z.array(tokenAllowlistSchema),
  relays: relayConfigSchema,
  monitoring: monitoringConfigSchema,

  environment: z.enum(['development', 'staging', 'production']),
  debug: z.boolean(),
  dryRun: z.boolean(),
});

export type ConfigSchema = z.infer<typeof configSchema>;
