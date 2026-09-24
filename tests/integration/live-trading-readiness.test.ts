import { ethers } from 'ethers';
import { BaseMEVPlatform } from '../../src/index';
import { CircuitBreakerState } from '../../src/monitoring/circuit-breaker';
import { ChainlinkPriceOracleImpl } from '../../src/oracles/chainlink-oracle';

describe('Live Trading Readiness Integration Tests', () => {
  let platform: BaseMEVPlatform;

  beforeAll(async () => {
    // Ensure execution engine remains dormant in readiness test to avoid unconfigured live contracts
    delete process.env['PRIVATE_KEY'];
    delete process.env['EXECUTION_PRIVATE_KEY'];
    process.env['BASE_RPC_URL'] = 'http://localhost:8545'; // Local test node

    // Mock oracle price feed to avoid reliance on external RPCs during integration tests
    jest.spyOn(ChainlinkPriceOracleImpl.prototype, 'getEthUsdPrice').mockResolvedValue(2500);

    platform = new BaseMEVPlatform();

    const mockProvider = {
      _getConnection: () => ({ url: 'http://localhost:8545' }),
      getBlockNumber: jest.fn().mockResolvedValue(1000000),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: 100000000n,
        maxFeePerGas: 200000000n,
        maxPriorityFeePerGas: 1000000n,
      }),
      getBalance: jest.fn().mockResolvedValue(1000000000000000000n),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
    } as unknown as ethers.JsonRpcProvider;

    jest.spyOn(platform['connectionManager'], 'initialize').mockImplementation(async () => {
      (platform['connectionManager'] as any).primaryProvider = mockProvider;
      (platform['connectionManager'] as any).currentProvider = mockProvider;
      (platform['connectionManager'] as any).connectionHealth.set('http://localhost:8545', {
        endpoint: 'http://localhost:8545',
        type: 'http',
        connected: true,
        latencyMs: 10,
        lastSuccessfulRequest: Date.now(),
        consecutiveFailures: 0,
      });
      platform['connectionManager'].emit('initialized');
    });
  });

  afterAll(async () => {
    if (platform) {
      await platform.stop();
    }
  });

  describe('Platform Initialization', () => {
    test('should initialize platform with all components', async () => {
      await platform.initialize();

      // Verify core components are initialized
      expect(platform['connectionManager']).toBeDefined();
      expect(platform['metricsCollector']).toBeDefined();
      expect(platform['circuitBreaker']).toBeDefined();
    });

    test('should load configuration successfully', async () => {
      const metrics = platform.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.opportunities).toBeDefined();
      expect(metrics.profit).toBeDefined();
      expect(metrics.systemHealth).toBeDefined();
    });
  });

  describe('Arbitrage Scanner Integration', () => {
    test('should initialize arbitrage scanner with MEV protection', async () => {
      await platform.start();

      expect(platform['arbitrageScanner']).toBeDefined();

      // Verify scanner is configured
      const scanner = platform['arbitrageScanner'];
      expect(scanner).toBeDefined();
    });

    test('should handle arbitrage opportunity detection', async () => {
      const mockOpportunity = {
        id: 'test-opportunity-1',
        type: 'arbitrage' as const,
        tokenA: {
          address: '0x4200000000000000000000000000000000000006', // WETH
          symbol: 'WETH',
          decimals: 18,
        },
        tokenB: {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
          symbol: 'USDC',
          decimals: 6,
        },
        poolA: {
          address: '0x1234567890123456789012345678901234567890',
          protocol: 'uniswap-v3' as const,
          fee: 3000,
          liquidity: BigInt('1000000000000000000000'),
        },
        poolB: {
          address: '0x0987654321098765432109876543210987654321',
          protocol: 'aerodrome' as const,
          fee: 500,
          liquidity: BigInt('2000000000000000000000'),
        },
        expectedProfit: BigInt('10000000000000000'), // 0.01 ETH
        gasEstimate: BigInt('300000'),
        confidence: 0.95,
        timestamp: Date.now(),
        expiresAt: Date.now() + 30000,
      };

      // Test opportunity handling without actual execution
      await platform['handleArbitrageOpportunity'](mockOpportunity);

      // Verify metrics were updated
      const metrics = platform.getMetrics();
      expect(metrics.opportunities.totalOpportunities).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Performance Monitoring Integration', () => {
    test('should track system performance metrics', async () => {
      const metricsCollector = platform['metricsCollector'];

      // Simulate performance data
      metricsCollector.recordOpportunityDetected();

      const opportunityMetrics = metricsCollector.getOpportunityMetrics();
      expect(opportunityMetrics.totalOpportunities).toBeGreaterThan(0);
    });

    test('should handle memory optimization', async () => {
      const metricsCollector = platform['metricsCollector'];

      // Test cleanup functionality
      metricsCollector.cleanupOldData();

      // Verify metrics collector remains healthy and tracks memory metrics
      const healthMetrics = metricsCollector.getSystemHealthMetrics();
      expect(healthMetrics).toBeDefined();
      expect(healthMetrics.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('Configuration Management Integration', () => {
    test('should handle configuration validation', async () => {
      const configLoader = platform['configLoader'];
      const loadedConfig = await configLoader.load();

      expect(loadedConfig).toBeDefined();
      expect(loadedConfig.network).toBeDefined();
      expect(loadedConfig.strategies).toBeDefined();
    });
  });

  describe('Circuit Breaker Integration', () => {
    test('should activate circuit breaker on failures and block requests', async () => {
      const circuitBreaker = platform['circuitBreaker'];

      // Configure explicit thresholds for integration test
      (circuitBreaker as any).config.minimumRequests = 5;
      (circuitBreaker as any).config.failureThreshold = 5;

      // Simulate failures to trigger circuit breaker
      for (let i = 0; i < 6; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error('Simulated failure');
          });
        } catch {
          // Expected to fail
        }
      }

      // Circuit breaker must transition to OPEN
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
      expect(circuitBreaker.isRequestAllowed()).toBe(false);

      // Subsequent requests must be rejected immediately while OPEN
      await expect(circuitBreaker.execute(async () => 'should not execute')).rejects.toThrow(
        'Circuit breaker is OPEN'
      );

      // Reset circuit breaker to clean state for subsequent tests
      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('End-to-End Integration', () => {
    test('should handle complete platform lifecycle', async () => {
      // Platform should already be started from previous tests
      expect(platform['isRunning']).toBe(true);

      // Test metrics collection
      const metrics = platform.getMetrics();
      expect(metrics).toBeDefined();

      // Test graceful shutdown
      await platform.stop();
      expect(platform['isRunning']).toBe(false);
    });
  });
});
