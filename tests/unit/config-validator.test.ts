/**
 * Unit & Regression Tests: Configuration Validator
 *
 * Verifies Zod schema validation, missing/invalid configuration detection,
 * and business rule enforcement (chain ID, minimum profit, slippage limits, health factors).
 */

import { ConfigValidator } from '../../src/config/validator';
import { ConfigLoader } from '../../src/config/loader';
import { Config } from '../../src/types/config';

describe('ConfigValidator Unit Tests', () => {
  let validator: ConfigValidator;
  let baseConfig: Config;

  beforeAll(async () => {
    const loader = new ConfigLoader({
      configPath: 'config/default.yaml',
      envPrefix: '',
    });
    baseConfig = await loader.load();
  });

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  describe('schema validation', () => {
    test('should validate the repository default configuration successfully', () => {
      const result = validator.validate(baseConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should reject malformed or missing required sections', () => {
      const invalidConfig = {
        network: {
          chainId: 'not-a-number', // Invalid type
        },
      };

      const result = validator.validate(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should throw meaningful error message in validateAndParse on failure', () => {
      expect(() => {
        validator.validateAndParse({});
      }).toThrow('Configuration validation failed');
    });
  });

  describe('validateBusinessLogic', () => {
    test('should pass business logic checks for valid base config', () => {
      const result = validator.validateBusinessLogic(baseConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should warn if chainId is not Base mainnet (8453)', () => {
      const nonBaseConfig: Config = {
        ...baseConfig,
        network: {
          ...baseConfig.network,
          chainId: 1, // Ethereum mainnet
        },
      };

      const result = validator.validateBusinessLogic(nonBaseConfig);

      expect(result.warnings).toContain('Configuration is not for Base mainnet (chainId: 8453)');
    });

    test('should reject non-positive minimum profit for arbitrage strategy', () => {
      const zeroProfitConfig: Config = {
        ...baseConfig,
        strategies: {
          ...baseConfig.strategies,
          arbitrage: {
            ...baseConfig.strategies.arbitrage,
            enabled: true,
            minProfitUSD: 0,
          },
        },
      };

      const result = validator.validateBusinessLogic(zeroProfitConfig);

      expect(result.errors).toContain('Arbitrage minimum profit must be positive');
    });

    test('should warn on dangerously high slippage (>10%)', () => {
      const highSlippageConfig: Config = {
        ...baseConfig,
        strategies: {
          ...baseConfig.strategies,
          arbitrage: {
            ...baseConfig.strategies.arbitrage,
            enabled: true,
            maxSlippageBps: 1500, // 15%
          },
        },
      };

      const result = validator.validateBusinessLogic(highSlippageConfig);

      expect(result.warnings).toContain('Arbitrage max slippage is very high (>10%)');
    });

    test('should reject liquidation strategy with health factor >= 1.0', () => {
      const invalidHealthFactorConfig: Config = {
        ...baseConfig,
        strategies: {
          ...baseConfig.strategies,
          liquidation: {
            ...baseConfig.strategies.liquidation,
            enabled: true,
            minHealthFactor: 1.05, // Accounts above 1.0 are healthy and cannot be liquidated
          },
        },
      };

      const result = validator.validateBusinessLogic(invalidHealthFactorConfig);

      expect(result.errors).toContain('Liquidation min health factor must be less than 1.0');
    });
  });
});
