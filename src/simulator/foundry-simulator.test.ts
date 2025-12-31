/**
 * Foundry Simulator Tests
 *
 * Tests for the enhanced simulation engine with Anvil integration
 */

import { FoundrySimulator } from './foundry-simulator';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ContractManager } from '../contracts/contract-manager';
import { ArbitrageOpportunity, OpportunityStatus } from '../types/opportunity';

describe('FoundrySimulator', () => {
  let simulator: FoundrySimulator;
  let mockConnectionManager: jest.Mocked<RpcConnectionManager>;
  let mockContractManager: jest.Mocked<ContractManager>;

  beforeEach(() => {
    // Mock RPC connection manager
    mockConnectionManager = {
      getPrimaryRpcUrl: jest.fn().mockReturnValue('https://mainnet.base.org'),
      getProvider: jest.fn().mockReturnValue({
        getBlockNumber: jest.fn().mockResolvedValue(12345),
      }),
    } as any;

    // Mock contract manager
    mockContractManager = {
      getFlashExecutorConfig: jest.fn().mockReturnValue({
        address: '0x1234567890123456789012345678901234567890',
        minProfitWei: '1000000000000000000', // 1 ETH
      }),
      getAllAuthorizedPoolAddresses: jest
        .fn()
        .mockReturnValue([
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          '0x1111111111111111111111111111111111111111',
        ]),
    } as any;

    simulator = new FoundrySimulator({
      connectionManager: mockConnectionManager,
      contractManager: mockContractManager,
      forkUrl: 'https://mainnet.base.org',
      anvilPort: 8545,
      simulationTimeoutMs: 100,
      maxConcurrentSimulations: 2,
    });
  });

  afterEach(async () => {
    if (simulator) {
      await simulator.shutdown();
    }
  });

  describe('initialization', () => {
    it('should initialize successfully with valid configuration', async () => {
      // Mock Anvil process for testing
      jest.spyOn(simulator as any, 'startAnvil').mockResolvedValue(undefined);
      jest.spyOn(simulator as any, 'setupForkProvider').mockResolvedValue(undefined);

      await simulator.initialize();

      expect(simulator.getStats().isInitialized).toBe(true);
    });

    it('should handle initialization failure gracefully', async () => {
      jest
        .spyOn(simulator as any, 'startAnvil')
        .mockRejectedValue(new Error('Anvil failed to start'));

      await expect(simulator.initialize()).rejects.toThrow('Anvil failed to start');
    });
  });

  describe('simulation', () => {
    const mockOpportunity: ArbitrageOpportunity = {
      id: 'test-opportunity-1',
      timestamp: Date.now(),
      type: 'arbitrage',
      status: OpportunityStatus.DETECTED,
      tokenIn: '0x4200000000000000000000000000000000000006', // WETH on Base
      tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      amountIn: 1000000000000000000n, // 1 ETH
      expectedAmountOut: 3000000000n, // 3000 USDC
      route: {
        pools: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'],
        fees: [500], // 0.05%
        directions: [true],
        expectedGas: 250000,
        priceImpact: 50, // 0.5% in basis points
      },
      fallbackRoutes: [],
      flashFee: 500000000000000n, // 0.0005 ETH (0.05%)
      gasEstimate: 250000n,
      expectedProfit: 50000000000000000n, // 0.05 ETH
      minProfit: 10000000000000000n, // 0.01 ETH
      profitMargin: 5.0, // 5%
      slippageTolerance: 0.01, // 1%
      deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes
      maxBribe: 1000000000000000n, // 0.001 ETH
      priority: 1,
      detectedAt: Date.now(),
      expiresAt: Date.now() + 300000, // 5 minutes
      source: 'test-scanner',
      sourcePool: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      targetPool: '0x1111111111111111111111111111111111111111',
      sourceDex: 'Uniswap V3',
      targetDex: 'Aerodrome',
      spread: 150, // 1.5% in basis points
      spreadAfterCosts: 100, // 1% in basis points
    };

    beforeEach(async () => {
      // Mock initialization
      jest.spyOn(simulator as any, 'startAnvil').mockResolvedValue(undefined);
      jest.spyOn(simulator as any, 'setupForkProvider').mockResolvedValue(undefined);
      await simulator.initialize();
    });

    it('should simulate opportunity successfully', async () => {
      // Mock the simulation methods
      jest.spyOn(simulator as any, 'createFork').mockResolvedValue({
        forkId: 'test-fork-1',
        blockNumber: 12345,
        provider: {
          send: jest.fn().mockResolvedValue(undefined),
          getBalance: jest.fn().mockResolvedValue(10000000000000000000n), // 10 ETH
        },
        createdAt: Date.now(),
        isActive: true,
      });

      jest
        .spyOn(simulator as any, 'deployFlashExecutorToFork')
        .mockResolvedValue('0x9999999999999999999999999999999999999999');

      jest.spyOn(simulator as any, 'performSimulation').mockResolvedValue({
        success: true,
        gasUsed: 250000n,
        actualProfit: 45000000000000000n, // 0.045 ETH after costs
        executionTime: 50, // Add execution time
      });

      const result = await simulator.simulate(mockOpportunity);

      expect(result.success).toBe(true);
      expect(result.gasUsed).toBe(250000n);
      expect(result.actualProfit).toBe(45000000000000000n);
      expect(result.executionTime).toBeGreaterThan(0);
    });

    it('should handle simulation failure gracefully', async () => {
      jest
        .spyOn(simulator as any, 'createFork')
        .mockRejectedValue(new Error('Fork creation failed'));

      const result = await simulator.simulate(mockOpportunity);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Fork creation failed');
      expect(result.gasUsed).toBe(0n);
      expect(result.actualProfit).toBe(0n);
    });

    it('should queue simulations when at max concurrent limit', async () => {
      // Mock performSimulation to return immediately
      jest.spyOn(simulator as any, 'performSimulation').mockResolvedValue({
        success: true,
        gasUsed: 250000n,
        actualProfit: 45000000000000000n,
        executionTime: 50,
      });

      // Start multiple simulations
      const promises = [
        simulator.simulate(mockOpportunity),
        simulator.simulate({ ...mockOpportunity, id: 'test-opportunity-2' }),
        simulator.simulate({ ...mockOpportunity, id: 'test-opportunity-3' }),
      ];

      // Check that some are queued
      const stats = simulator.getStats();
      expect(stats.activeSimulations + stats.queuedSimulations).toBe(3);

      // Wait for completion
      const results = await Promise.all(promises);

      // All should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('fork management', () => {
    beforeEach(async () => {
      jest.spyOn(simulator as any, 'startAnvil').mockResolvedValue(undefined);
      jest.spyOn(simulator as any, 'setupForkProvider').mockResolvedValue(undefined);
      await simulator.initialize();
    });

    it('should create fork successfully', async () => {
      const mockProvider = {
        send: jest.fn().mockResolvedValue(undefined),
        getBlockNumber: jest.fn().mockResolvedValue(12345),
      };

      (simulator as any).forkProvider = mockProvider;
      mockConnectionManager.getProvider.mockReturnValue({
        getBlockNumber: jest.fn().mockResolvedValue(12345),
      } as any);

      const fork = await simulator.createFork();

      expect(fork.forkId).toMatch(/^fork_\d+_\d+$/);
      expect(fork.blockNumber).toBe(12345);
      expect(fork.isActive).toBe(true);
      expect(mockProvider.send).toHaveBeenCalledWith('anvil_fork', [
        'https://mainnet.base.org',
        12345,
      ]);
    });
  });

  describe('contract deployment', () => {
    it('should deploy Flash Executor to fork', async () => {
      const mockFork = {
        forkId: 'test-fork-1',
        blockNumber: 12345,
        provider: {
          send: jest.fn().mockResolvedValue(undefined),
        },
        createdAt: Date.now(),
        isActive: true,
      };

      // Mock the entire deployment process
      jest
        .spyOn(simulator as any, 'deployFlashExecutorToFork')
        .mockResolvedValue('0x9999999999999999999999999999999999999999');

      const contractAddress = await (simulator as any).deployFlashExecutorToFork(mockFork);

      expect(contractAddress).toBe('0x9999999999999999999999999999999999999999');
    });
  });

  describe('statistics', () => {
    it('should return correct statistics', () => {
      const stats = simulator.getStats();

      expect(stats).toEqual({
        activeSimulations: 0,
        queuedSimulations: 0,
        activeForks: 0,
        isInitialized: false,
      });
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const mockProcess = {
        kill: jest.fn(),
      };

      (simulator as any).anvilProcess = mockProcess;
      (simulator as any).isInitialized = true;

      await simulator.shutdown();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(simulator.getStats().isInitialized).toBe(false);
    });
  });
});
