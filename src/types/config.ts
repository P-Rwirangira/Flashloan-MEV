/**
 * Configuration Types
 *
 * Types for system configuration and settings.
 */

import { Address, NetworkConfig, GasConfig, TimingConfig } from './common';

// Strategy configuration
export interface StrategyConfig {
  readonly enabled: boolean;
  readonly minProfitUSD: number;
  readonly maxSlippageBps: number;
  readonly maxGasPriceGwei: number;
}

// Arbitrage strategy configuration
export interface ArbitrageConfig extends StrategyConfig {
  readonly pairs: string[];
  readonly maxRoutes: number;
  readonly fallbackRoutes: number;
}

// Liquidation strategy configuration
export interface LiquidationConfig extends StrategyConfig {
  readonly minHealthFactor: number;
  readonly maxCloseFactor: number;
  readonly protocols: string[];
}

// Rebalancing strategy configuration
export interface RebalancingConfig extends StrategyConfig {
  readonly minImbalanceBps: number;
  readonly incentiveThreshold: number;
  readonly stablePools: Address[];
}

// Pool allowlists
export interface PoolAllowlists {
  readonly uniswapV3: Address[];
  readonly aerodrome: Address[];
}

// Relay configuration
export interface RelayConfig {
  readonly primary: string;
  readonly fallbacks: string[];
  readonly maxBribeGwei: number;
  readonly endpoints: Record<string, string>;
  readonly apiKeys: Record<string, string>;
}

// Monitoring configuration
export interface MonitoringConfig {
  readonly metricsPort: number;
  readonly healthCheckPort: number;
  readonly alerting: {
    readonly consecutiveRevertThreshold: number;
    readonly latencyThresholdMs: number;
    readonly successRateThreshold: number;
  };
}

// Main configuration interface
export interface Config {
  readonly network: NetworkConfig;
  readonly gas: GasConfig;
  readonly timing: TimingConfig;

  readonly strategies: {
    readonly arbitrage: ArbitrageConfig;
    readonly liquidation: LiquidationConfig;
    readonly rebalancing: RebalancingConfig;
  };

  readonly allowedPools: PoolAllowlists;
  readonly relays: RelayConfig;
  readonly monitoring: MonitoringConfig;
}
