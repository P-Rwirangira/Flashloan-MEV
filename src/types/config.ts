/**
 * Configuration Types
 *
 * Types for system configuration and settings.
 */

import { Address, NetworkConfig, GasConfig, TimingConfig } from './common';

// Strategy configuration base
export interface StrategyConfig {
  readonly enabled: boolean;
  readonly minProfitUSD: number;
  readonly maxSlippageBps: number;
  readonly maxGasPriceGwei: number;
  readonly maxPositionSize: number;
  readonly cooldownMs: number;
}

// Arbitrage strategy configuration
export interface ArbitrageConfig extends StrategyConfig {
  readonly pairs: string[];
  readonly maxRoutes: number;
  readonly fallbackRoutes: number;
  readonly minSpreadBps: number;
  readonly maxPriceImpactBps: number;
  readonly dexPriority: string[];
  readonly competitionThreshold: number;
}

// Liquidation strategy configuration
export interface LiquidationConfig extends StrategyConfig {
  readonly minHealthFactor: number;
  readonly maxCloseFactor: number;
  readonly protocols: string[];
  readonly minLiquidationBonus: number;
  readonly maxLiquidationAmount: number;
  readonly healthFactorBuffer: number;
}

// Rebalancing strategy configuration
export interface RebalancingConfig extends StrategyConfig {
  readonly minImbalanceBps: number;
  readonly incentiveThreshold: number;
  readonly stablePools: Address[];
  readonly maxRebalanceAmount: number;
  readonly targetUtilization: number;
}

// Pool allowlists with metadata
export interface PoolAllowlist {
  readonly address: Address;
  readonly enabled: boolean;
  readonly priority: number;
  readonly minTvl: number;
  readonly maxSlippage: number;
  readonly tags: string[];
}

export interface PoolAllowlists {
  readonly uniswapV3: PoolAllowlist[];
  readonly aerodrome: PoolAllowlist[];
}

// Token allowlists
export interface TokenAllowlist {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly maxAmount: number;
}

// Relay configuration with failover
export interface RelayEndpoint {
  readonly name: string;
  readonly url: string;
  readonly apiKey?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly maxLatencyMs: number;
  readonly rateLimit: number;
}

export interface RelayConfig {
  readonly primary: string;
  readonly fallbacks: string[];
  readonly maxBribeGwei: number;
  readonly endpoints: Record<string, RelayEndpoint>;
  readonly retryAttempts: number;
  readonly timeoutMs: number;
}

// Monitoring and alerting configuration
export interface AlertConfig {
  readonly enabled: boolean;
  readonly webhook?: string;
  readonly email?: string;
  readonly slack?: string;
  readonly threshold: number;
  readonly cooldownMs: number;
}

export interface MonitoringConfig {
  readonly metricsPort: number;
  readonly healthCheckPort: number;
  readonly logLevel: string;
  readonly alerting: {
    readonly consecutiveRevertThreshold: number;
    readonly latencyThresholdMs: number;
    readonly successRateThreshold: number;
    readonly profitThresholdUSD: number;
    readonly alerts: Record<string, AlertConfig>;
  };
  readonly circuitBreaker: {
    readonly enabled: boolean;
    readonly failureThreshold: number;
    readonly recoveryTimeMs: number;
    readonly halfOpenMaxCalls: number;
  };
}

// Security configuration
export interface SecurityConfig {
  readonly maxConcurrentTx: number;
  readonly maxDailyLoss: number;
  readonly emergencyStop: boolean;
  readonly allowedCallers: Address[];
  readonly rateLimits: {
    readonly requestsPerSecond: number;
    readonly burstSize: number;
  };
}

// Performance configuration
export interface PerformanceConfig {
  readonly maxLatencyMs: number;
  readonly simulationTimeoutMs: number;
  readonly maxRetries: number;
  readonly batchSize: number;
  readonly cacheSize: number;
  readonly cacheTtlMs: number;
}

// Main configuration interface
export interface Config {
  readonly network: NetworkConfig;
  readonly gas: GasConfig;
  readonly timing: TimingConfig;
  readonly security: SecurityConfig;
  readonly performance: PerformanceConfig;

  readonly strategies: {
    readonly arbitrage: ArbitrageConfig;
    readonly liquidation: LiquidationConfig;
    readonly rebalancing: RebalancingConfig;
  };

  readonly allowedPools: PoolAllowlists;
  readonly allowedTokens: TokenAllowlist[];
  readonly relays: RelayConfig;
  readonly monitoring: MonitoringConfig;

  // Environment-specific overrides
  readonly environment: 'development' | 'staging' | 'production';
  readonly debug: boolean;
  readonly dryRun: boolean;
}

// Configuration validation result
export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}
