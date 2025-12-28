/**
 * Configuration Validator
 *
 * Validates configuration against schema with detailed error reporting.
 */

import { ZodError } from 'zod';
import { configSchema, ConfigSchema } from './schema';
import { Config, ConfigValidationResult } from '../types/config';

export interface ValidatorOptions {
  readonly strict?: boolean;
  readonly allowUnknownKeys?: boolean;
}

export class ConfigValidator {
  constructor(options: ValidatorOptions = {}) {
    // Store options for potential future use
    if (options.strict !== undefined || options.allowUnknownKeys !== undefined) {
      // Options are available for future enhancements
    }
  }

  /**
   * Validate configuration against schema
   */
  validate(config: unknown): ConfigValidationResult {
    try {
      const validatedConfig = configSchema.parse(config);
      const warnings = this.generateWarnings(validatedConfig);

      return {
        valid: true,
        errors: [],
        warnings,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = this.formatZodErrors(error);
        return {
          valid: false,
          errors,
          warnings: [],
        };
      }

      return {
        valid: false,
        errors: [`Validation failed: ${error}`],
        warnings: [],
      };
    }
  }

  /**
   * Validate and return typed configuration
   */
  validateAndParse(config: unknown): Config {
    const result = this.validate(config);

    if (!result.valid) {
      throw new Error(`Configuration validation failed:\n${result.errors.join('\n')}`);
    }

    return configSchema.parse(config) as Config;
  }

  /**
   * Validate configuration with business logic checks
   */
  validateBusinessLogic(config: Config): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Network validation
    if (config.network.chainId !== 8453) {
      warnings.push('Configuration is not for Base mainnet (chainId: 8453)');
    }

    // Strategy validation
    if (config.strategies.arbitrage.enabled) {
      if (config.strategies.arbitrage.minProfitUSD <= 0) {
        errors.push('Arbitrage minimum profit must be positive');
      }

      if (config.strategies.arbitrage.maxSlippageBps > 1000) {
        warnings.push('Arbitrage max slippage is very high (>10%)');
      }
    }

    if (config.strategies.liquidation.enabled) {
      if (config.strategies.liquidation.minHealthFactor >= 1.0) {
        errors.push('Liquidation min health factor must be less than 1.0');
      }

      if (config.strategies.liquidation.maxCloseFactor > 0.5) {
        warnings.push('Liquidation max close factor is high (>50%)');
      }
    }

    // Gas configuration validation
    const maxGasPrice =
      typeof config.gas.maxGasPrice === 'string'
        ? parseFloat(config.gas.maxGasPrice)
        : config.gas.maxGasPrice;

    if (maxGasPrice > 100) {
      warnings.push('Max gas price is very high (>100 gwei)');
    }

    // Pool allowlist validation
    const uniV3Pools = config.allowedPools.uniswapV3.filter(p => p.enabled);
    const aeroPools = config.allowedPools.aerodrome.filter(p => p.enabled);

    if (uniV3Pools.length === 0 && config.strategies.arbitrage.enabled) {
      errors.push('No enabled Uniswap V3 pools for arbitrage strategy');
    }

    if (aeroPools.length === 0 && config.strategies.arbitrage.enabled) {
      errors.push('No enabled Aerodrome pools for arbitrage strategy');
    }

    // Token allowlist validation
    const enabledTokens = config.allowedTokens.filter(t => t.enabled);
    if (enabledTokens.length < 2) {
      errors.push('At least 2 enabled tokens required for trading');
    }

    // Relay configuration validation
    const enabledRelays = Object.values(config.relays.endpoints).filter(r => r.enabled);
    if (enabledRelays.length === 0) {
      warnings.push('No enabled relay endpoints configured');
    }

    // Security validation
    if (config.security.maxConcurrentTx > 10) {
      warnings.push('High concurrent transaction limit may increase risk');
    }

    if (config.security.emergencyStop) {
      warnings.push('Emergency stop is enabled - system will not execute trades');
    }

    // Performance validation
    if (config.performance.maxLatencyMs > 1000) {
      warnings.push('Max latency is high (>1s) - may miss opportunities');
    }

    if (config.timing.simulationTimeoutMs > config.performance.maxLatencyMs) {
      errors.push('Simulation timeout exceeds max latency - will cause missed opportunities');
    }

    // Monitoring validation
    if (!config.monitoring.circuitBreaker.enabled && config.environment === 'production') {
      warnings.push('Circuit breaker disabled in production environment');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Format Zod validation errors into readable messages
   */
  private formatZodErrors(error: ZodError): string[] {
    return error.errors.map(err => {
      const path = err.path.length > 0 ? err.path.join('.') : 'root';
      return `${path}: ${err.message}`;
    });
  }

  /**
   * Generate warnings for potentially problematic configurations
   */
  private generateWarnings(config: ConfigSchema): string[] {
    const warnings: string[] = [];

    // Check for development settings in production
    if (config.environment === 'production') {
      if (config.debug) {
        warnings.push('Debug mode enabled in production environment');
      }

      if (config.dryRun) {
        warnings.push('Dry run mode enabled in production environment');
      }
    }

    // Check for missing optional but recommended settings
    if (!config.network.wsUrl) {
      warnings.push('WebSocket URL not configured - real-time monitoring may be limited');
    }

    if (config.network.fallbackRpcs.length === 0) {
      warnings.push('No fallback RPC endpoints configured');
    }

    return warnings;
  }
}
