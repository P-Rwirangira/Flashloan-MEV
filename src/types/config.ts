/**
 * Configuration Types
 *
 * Types for platform configuration and settings.
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// Pool allowlist configuration
export interface PoolAllowlist {
  readonly address: Address;
  readonly dex: 'uniswap-v3' | 'aerodrome';
  readonly enabled: boolean;
  readonly priority: number;
  readonly minTvl: BigNumberish;
  readonly maxSlippage: number;
  readonly fee?: number; // Pool fee in basis points (e.g., 30 for 0.3%)
  readonly tags?: string[];
}

// Pool allowlists by DEX
export interface PoolAllowlists {
  readonly uniswapV3: PoolAllowlist[];
  readonly aerodrome: PoolAllowlist[];
}

// Token allowlist configuration
export interface TokenAllowlist {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly maxAmount: BigNumberish;
}

// Network configuration
export interface NetworkConfig {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly wsUrl?: string;
  readonly fallbackRpcs: string[];
}

// Gas configuration
export interface GasConfig {
  readonly maxGasPrice: BigNumberish;
  readonly gasLimit: number;
  readonly priorityFee: BigNumberish;
  readonly baseFeeMultiplier: number;
}

// Timing configuration
export interface TimingConfig {
  readonly maxLatencyMs: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxRetries: number;
  readonly simulationTimeoutMs: number;
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

// Arbitrage strategy configuration
export interface ArbitrageConfig {
  readonly enabled: boolean;
  readonly minProfitUSD: number;
  readonly maxSlippageBps: number;
  readonly maxGasPriceGwei: number;
  readonly maxPositionSize: number;
  readonly cooldownMs: number;
  readonly pairs: string[];
  readonly maxRoutes: number;
  readonly fallbackRoutes: number;
  readonly minSpreadBps: number;
  readonly maxPriceImpactBps: number;
  readonly dexPriority: string[];
  readonly competitionThreshold: number;
  // MEV Protection Features
  readonly enableMEVProtection?: boolean;
  readonly enableSandwichDetection?: boolean;
  readonly enableFrontRunningProtection?: boolean;
  readonly mempoolMonitoringEnabled?: boolean;
  readonly competitorAnalysisEnabled?: boolean;
  readonly adaptiveGasPricing?: boolean;
  readonly maxCompetitorGasMultiplier?: number;
  readonly sandwichDetectionThreshold?: number;
  readonly frontRunningTimeWindow?: number;
  readonly enablePrivateMempool?: boolean;
  // Multi-hop Arbitrage Features
  readonly enableMultiHop?: boolean;
  readonly maxHops?: number;
  readonly multiHopMinProfitMultiplier?: number;
  readonly enableTriangularArbitrage?: boolean;
  readonly enablePathOptimization?: boolean;
  readonly pathOptimizationDepth?: number;
}

// Liquidation strategy configuration
export interface LiquidationConfig {
  readonly enabled: boolean;
  readonly minProfitUSD: number;
  readonly maxSlippageBps: number;
  readonly maxGasPriceGwei: number;
  readonly maxPositionSize: number;
  readonly cooldownMs: number;
  readonly minHealthFactor: number;
  readonly maxCloseFactor: number;
  readonly protocols: string[];
  readonly minLiquidationBonus: number;
  readonly maxLiquidationAmount: number;
  readonly healthFactorBuffer: number;
}

// Rebalancing strategy configuration
export interface RebalancingConfig {
  readonly enabled: boolean;
  readonly minProfitUSD: number;
  readonly maxSlippageBps: number;
  readonly maxGasPriceGwei: number;
  readonly maxPositionSize: number;
  readonly cooldownMs: number;
  readonly minImbalanceBps: number;
  readonly incentiveThreshold: number;
  readonly stablePools: Address[];
  readonly maxRebalanceAmount: number;
  readonly targetUtilization: number;
}

// Strategy configurations
export interface StrategyConfigs {
  readonly arbitrage: ArbitrageConfig;
  readonly liquidation: LiquidationConfig;
  readonly rebalancing: RebalancingConfig;
}

// Relay configuration
export interface RelayConfig {
  readonly primary: string;
  readonly fallbacks: string[];
  readonly maxBribeGwei: number;
  readonly retryAttempts: number;
  readonly timeoutMs: number;
  readonly endpoints: Record<string, RelayEndpointConfig>;
}

// Relay endpoint configuration
export interface RelayEndpointConfig {
  readonly name: string;
  readonly url: string;
  readonly apiKey?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly maxLatencyMs: number;
  readonly rateLimit: number;
}

// Monitoring configuration
export interface MonitoringConfig {
  readonly metricsPort: number;
  readonly healthCheckPort: number;
  readonly logLevel: string;
  readonly alerting: AlertingConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
}

// Alerting configuration
export interface AlertingConfig {
  readonly consecutiveRevertThreshold: number;
  readonly latencyThresholdMs: number;
  readonly successRateThreshold: number;
  readonly profitThresholdUSD: number;
  readonly alerts: {
    readonly slack?: SlackAlertConfig;
    readonly email?: EmailAlertConfig;
  };
}

// Slack alert configuration
export interface SlackAlertConfig {
  readonly enabled: boolean;
  readonly webhook: string;
  readonly threshold: number;
  readonly cooldownMs: number;
}

// Email alert configuration
export interface EmailAlertConfig {
  readonly enabled: boolean;
  readonly email: string;
  readonly threshold: number;
  readonly cooldownMs: number;
}

// Circuit breaker configuration
export interface CircuitBreakerConfig {
  readonly enabled: boolean;
  readonly failureThreshold: number;
  readonly recoveryTimeMs: number;
  readonly halfOpenMaxCalls: number;
}

// Main configuration interface
export interface Config {
  readonly network: NetworkConfig;
  readonly gas: GasConfig;
  readonly timing: TimingConfig;
  readonly security: SecurityConfig;
  readonly performance: PerformanceConfig;
  readonly strategies: StrategyConfigs;
  readonly allowedPools: PoolAllowlists;
  readonly allowedTokens: TokenAllowlist[];
  readonly relays: RelayConfig;
  readonly monitoring: MonitoringConfig;
  readonly environment: string;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly paperTrading?: boolean;
}

// Configuration validation result
export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

// Configuration utilities
export const ConfigUtils = {
  /**
   * Validate pool allowlist
   */
  validatePoolAllowlist: (pool: PoolAllowlist): boolean => {
    if (!pool.address || !pool.dex) return false;
    if (pool.priority < 0 || pool.maxSlippage < 0) return false;
    if (!['uniswap-v3', 'aerodrome'].includes(pool.dex)) return false;
    return true;
  },

  /**
   * Validate token allowlist
   */
  validateTokenAllowlist: (token: TokenAllowlist): boolean => {
    if (!token.address || !token.symbol) return false;
    if (token.decimals == null || !Number.isInteger(token.decimals)) return false;
    if (token.decimals < 0 || token.decimals > 77) return false;
    return true;
  },

  /**
   * Get default arbitrage config
   */
  getDefaultArbitrageConfig: (): ArbitrageConfig => ({
    enabled: true,
    minProfitUSD: 5.0,
    maxSlippageBps: 50,
    maxGasPriceGwei: 50,
    maxPositionSize: 10000,
    cooldownMs: 1000,
    pairs: ['WETH/USDC', 'wstETH/ETH'],
    maxRoutes: 3,
    fallbackRoutes: 2,
    minSpreadBps: 10,
    maxPriceImpactBps: 100,
    dexPriority: ['uniswap-v3', 'aerodrome'],
    competitionThreshold: 2,
  }),

  /**
   * Get default liquidation config
   */
  getDefaultLiquidationConfig: (): LiquidationConfig => ({
    enabled: false,
    minProfitUSD: 10.0,
    maxSlippageBps: 100,
    maxGasPriceGwei: 100,
    maxPositionSize: 50000,
    cooldownMs: 5000,
    minHealthFactor: 0.95,
    maxCloseFactor: 0.5,
    protocols: ['moonwell', 'aave-v3', 'seamless'],
    minLiquidationBonus: 0.05,
    maxLiquidationAmount: 100000,
    healthFactorBuffer: 0.02,
  }),

  /**
   * Get default rebalancing config
   */
  getDefaultRebalancingConfig: (): RebalancingConfig => ({
    enabled: false,
    minProfitUSD: 3.0,
    maxSlippageBps: 30,
    maxGasPriceGwei: 30,
    maxPositionSize: 5000,
    cooldownMs: 2000,
    minImbalanceBps: 50,
    incentiveThreshold: 0.1,
    stablePools: [],
    maxRebalanceAmount: 20000,
    targetUtilization: 0.8,
  }),

  /**
   * Merge configurations with defaults
   */
  mergeWithDefaults: (userConfig: Partial<Config>): Config => {
    const defaultConfig: Config = {
      network: {
        chainId: 8453,
        name: 'base',
        rpcUrl: 'https://mainnet.base.org',
        fallbackRpcs: ['https://base.llamarpc.com'],
      },
      gas: {
        maxGasPrice: '50000000000', // 50 gwei
        gasLimit: 500000,
        priorityFee: '2000000000', // 2 gwei
        baseFeeMultiplier: 1.2,
      },
      timing: {
        maxLatencyMs: 200,
        timeoutMs: 5000,
        retryDelayMs: 100,
        maxRetries: 3,
        simulationTimeoutMs: 50,
      },
      security: {
        maxConcurrentTx: 5,
        maxDailyLoss: 1000,
        emergencyStop: false,
        allowedCallers: [],
        rateLimits: {
          requestsPerSecond: 100,
          burstSize: 200,
        },
      },
      performance: {
        maxLatencyMs: 150,
        simulationTimeoutMs: 50,
        maxRetries: 3,
        batchSize: 10,
        cacheSize: 1000,
        cacheTtlMs: 30000,
      },
      strategies: {
        arbitrage: ConfigUtils.getDefaultArbitrageConfig(),
        liquidation: ConfigUtils.getDefaultLiquidationConfig(),
        rebalancing: ConfigUtils.getDefaultRebalancingConfig(),
      },
      allowedPools: {
        uniswapV3: [],
        aerodrome: [],
      },
      allowedTokens: [],
      relays: {
        primary: 'flashbots',
        fallbacks: ['bloxroute', 'local'],
        maxBribeGwei: 10,
        retryAttempts: 3,
        timeoutMs: 2000,
        endpoints: {},
      },
      monitoring: {
        metricsPort: 9090,
        healthCheckPort: 8080,
        logLevel: 'info',
        alerting: {
          consecutiveRevertThreshold: 5,
          latencyThresholdMs: 300,
          successRateThreshold: 0.7,
          profitThresholdUSD: 1.0,
          alerts: {},
        },
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10,
          recoveryTimeMs: 60000,
          halfOpenMaxCalls: 5,
        },
      },
      environment: 'development',
      debug: true,
      dryRun: true,
    };

    return ConfigUtils.deepMerge(defaultConfig, userConfig);
  },

  /**
   * Deep merge two objects, preserving nested structure
   */
  deepMerge: <T extends Record<string, any>>(target: T, source: Partial<T>): T => {
    const result = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        const sourceValue = source[key];
        const targetValue = result[key];

        if (
          sourceValue !== null &&
          typeof sourceValue === 'object' &&
          !Array.isArray(sourceValue) &&
          targetValue !== null &&
          typeof targetValue === 'object' &&
          !Array.isArray(targetValue)
        ) {
          // Both are objects, merge recursively
          result[key] = ConfigUtils.deepMerge(targetValue, sourceValue);
        } else {
          // Primitive value or array, replace directly
          result[key] = sourceValue as T[Extract<keyof T, string>];
        }
      }
    }

    return result;
  },
};
