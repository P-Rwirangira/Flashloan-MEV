/**
 * Flash Executor Contract Tests
 *
 * Unit tests for the Flash Executor contract implementation.
 */

import { ethers } from 'ethers';
import { FlashExecutorContract, FlashExecutorFactory } from '../../contracts/flash-executor-impl';
import { FlashExecutorConfig, SafetyGuardConfig } from '../../contracts/flash-executor';
import { Address } from '../../types/common';

// Mock provider for testing
const mockProvider = new ethers.JsonRpcProvider('http://localhost:8545');

// Test configuration
const testConfig: FlashExecutorConfig = {
  minProfitWei: ethers.parseEther('0.01'), // 0.01 ETH minimum profit
  maxSlippagePercent: 5, // 5% max slippage
  maxGasPrice: ethers.parseUnits('50', 'gwei'), // 50 gwei max gas price
  authorizedPools: [
    '0x1234567890123456789012345678901234567890' as Address,
    '0x2345678901234567890123456789012345678901' as Address,
  ],
  fallbackRouteLimit: 3,
  reentrancyProtection: true,
  pausable: true,
};

const testSafetyConfig: SafetyGuardConfig = {
  maxFlashLoanAmount: ethers.parseEther('100'), // 100 ETH max flash loan
  maxGasLimit: 500000,
  allowedTokens: [
    '0x1111111111111111111111111111111111111111' as Address,
    '0x2222222222222222222222222222222222222222' as Address,
  ],
  emergencyPause: false,
  circuitBreakerThreshold: 5,
};

describe('FlashExecutorContract', () => {
  let flashExecutor: FlashExecutorContract;
  const contractAddress = '0x1234567890123456789012345678901234567890' as Address;

  beforeEach(() => {
    // Create a new Flash Executor instance for each test
    flashExecutor = new FlashExecutorContract(
      contractAddress,
      mockProvider,
      testConfig,
      testSafetyConfig
    );
  });

  afterEach(async () => {
    // Clean up resources
    await flashExecutor.cleanup();
  });

  describe('Constructor', () => {
    it('should create Flash Executor with correct configuration', () => {
      expect(flashExecutor).toBeDefined();
      expect(flashExecutor.getAddress()).toBe(contractAddress);
      expect(flashExecutor.getConfig()).toEqual(testConfig);
      expect(flashExecutor.getSafetyConfig()).toEqual(testSafetyConfig);
    });

    it('should initialize with correct default state', () => {
      const stats = flashExecutor.getStats();
      expect(stats.executionCount).toBe(0);
      expect(stats.totalGasUsed).toBe(0n);
      expect(stats.totalProfit).toBe(0n);
      expect(stats.averageGasPerExecution).toBe(0n);
      expect(stats.isInitialized).toBe(false);
    });
  });

  describe('Configuration Management', () => {
    it('should return immutable configuration copies', () => {
      const config1 = flashExecutor.getConfig();
      const config2 = flashExecutor.getConfig();
      
      // Should be equal but not the same reference
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
      
      // Modifying returned config should not affect internal config
      (config1 as any).minProfitWei = ethers.parseEther('0.02');
      const config3 = flashExecutor.getConfig();
      expect(config3.minProfitWei).toEqual(ethers.parseEther('0.01'));
    });

    it('should return immutable safety configuration copies', () => {
      const safetyConfig1 = flashExecutor.getSafetyConfig();
      const safetyConfig2 = flashExecutor.getSafetyConfig();
      
      // Should be equal but not the same reference
      expect(safetyConfig1).toEqual(safetyConfig2);
      expect(safetyConfig1).not.toBe(safetyConfig2);
      
      // Modifying returned config should not affect internal config
      (safetyConfig1 as any).maxGasLimit = 1000000;
      const safetyConfig3 = flashExecutor.getSafetyConfig();
      expect(safetyConfig3.maxGasLimit).toBe(500000);
    });
  });

  describe('Flash Callback Interface', () => {
    it('should throw error when flash callback is called directly', async () => {
      await expect(
        flashExecutor.uniswapV3FlashCallback(
          ethers.parseEther('0.01'),
          ethers.parseEther('0.01'),
          '0x1234'
        )
      ).rejects.toThrow('uniswapV3FlashCallback should not be called directly');
    });

    it('should log parameters when flash callback is called directly', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      try {
        await flashExecutor.uniswapV3FlashCallback(
          ethers.parseEther('0.01'),
          ethers.parseEther('0.02'),
          '0xabcd'
        );
      } catch (error) {
        // Expected to throw
      }
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'uniswapV3FlashCallback called directly with:',
        {
          fee0: ethers.parseEther('0.01'),
          fee1: ethers.parseEther('0.02'),
          data: '0xabcd',
        }
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('Execution Requirements', () => {
    it('should require initialization before execution', async () => {
      const routeData = {
        pools: [testConfig.authorizedPools[0]!],
        directions: [true],
        minProfit: testConfig.minProfitWei,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      };

      await expect(
        flashExecutor.executeArbitrage(
          testConfig.authorizedPools[0]!,
          ethers.parseEther('1'),
          0,
          routeData
        )
      ).rejects.toThrow('Flash Executor not initialized');
    });

    it('should require signer for transaction execution', async () => {
      // Create Flash Executor without signer
      const executorWithoutSigner = new FlashExecutorContract(
        contractAddress,
        mockProvider,
        testConfig,
        testSafetyConfig
        // No signer provided
      );

      const routeData = {
        pools: [testConfig.authorizedPools[0]],
        directions: [true],
        minProfit: testConfig.minProfitWei,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      // Mock initialization to bypass contract calls
      (executorWithoutSigner as any).isInitialized = true;

      await expect(
        executorWithoutSigner.executeArbitrage(
          testConfig.authorizedPools[0],
          ethers.parseEther('1'),
          0,
          routeData
        )
      ).rejects.toThrow('Signer required for transaction execution');

      await executorWithoutSigner.cleanup();
    });
  });

  describe('Admin Functions', () => {
    it('should require signer for admin functions', async () => {
      const result = await flashExecutor.addAuthorizedPool(
        '0x3333333333333333333333333333333333333333' as Address
      );
      
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Signer required');
    });

    it('should return error result for admin functions without signer', async () => {
      const testPool = '0x3333333333333333333333333333333333333333' as Address;
      
      const addResult = await flashExecutor.addAuthorizedPool(testPool);
      expect(addResult.success).toBe(false);
      
      const removeResult = await flashExecutor.removeAuthorizedPool(testPool);
      expect(removeResult.success).toBe(false);
      
      const setProfitResult = await flashExecutor.setMinProfit(ethers.parseEther('0.02'));
      expect(setProfitResult.success).toBe(false);
      
      const pauseResult = await flashExecutor.pause();
      expect(pauseResult.success).toBe(false);
      
      const unpauseResult = await flashExecutor.unpause();
      expect(unpauseResult.success).toBe(false);
      
      const withdrawResult = await flashExecutor.emergencyWithdraw(
        testPool,
        ethers.parseEther('1')
      );
      expect(withdrawResult.success).toBe(false);
    });
  });

  describe('Event Handling', () => {
    it('should be an event emitter', () => {
      expect(flashExecutor.on).toBeDefined();
      expect(flashExecutor.emit).toBeDefined();
      expect(flashExecutor.removeAllListeners).toBeDefined();
    });

    it('should allow event listener registration', () => {
      const mockListener = jest.fn();
      
      flashExecutor.on('ArbitrageExecuted', mockListener);
      flashExecutor.emit('ArbitrageExecuted', { test: 'data' });
      
      expect(mockListener).toHaveBeenCalledWith({ test: 'data' });
    });
  });

  describe('Statistics Tracking', () => {
    it('should track execution statistics', () => {
      const initialStats = flashExecutor.getStats();
      
      expect(initialStats).toEqual({
        executionCount: 0,
        totalGasUsed: 0n,
        totalProfit: 0n,
        averageGasPerExecution: 0n,
        isInitialized: false,
      });
    });

    it('should calculate average gas correctly', () => {
      // Simulate some executions by directly modifying internal state
      (flashExecutor as any).executionCount = 3;
      (flashExecutor as any).totalGasUsed = 300000n;
      
      const stats = flashExecutor.getStats();
      expect(stats.averageGasPerExecution).toBe(100000n);
    });

    it('should handle zero executions for average calculation', () => {
      const stats = flashExecutor.getStats();
      expect(stats.averageGasPerExecution).toBe(0n);
    });
  });
});

describe('FlashExecutorFactory', () => {
  let factory: FlashExecutorFactory;

  beforeEach(() => {
    factory = new FlashExecutorFactory(mockProvider);
  });

  describe('Constructor', () => {
    it('should create factory with provider only', () => {
      expect(factory).toBeDefined();
    });

    it('should create factory with provider and signer', () => {
      const mockSigner = ethers.Wallet.createRandom();
      const factoryWithSigner = new FlashExecutorFactory(mockProvider, mockSigner);
      expect(factoryWithSigner).toBeDefined();
    });
  });

  describe('Contract Creation', () => {
    it('should create Flash Executor contract instance', () => {
      const contractAddress = '0x1234567890123456789012345678901234567890' as Address;
      
      const executor = factory.create(contractAddress, testConfig, testSafetyConfig);
      
      expect(executor).toBeInstanceOf(FlashExecutorContract);
      expect(executor.getAddress()).toBe(contractAddress);
    });
  });

  describe('Contract Deployment', () => {
    it('should throw error for deployment without signer', async () => {
      await expect(
        factory.deploy(testConfig, testSafetyConfig)
      ).rejects.toThrow('Signer required for contract deployment');
    });

    it('should throw error for deployment (not implemented)', async () => {
      const mockSigner = ethers.Wallet.createRandom();
      const factoryWithSigner = new FlashExecutorFactory(mockProvider, mockSigner);
      
      await expect(
        factoryWithSigner.deploy(testConfig, testSafetyConfig)
      ).rejects.toThrow('Contract deployment not implemented - requires Solidity contract bytecode');
    });
  });

  describe('Contract Metadata', () => {
    it('should throw error for bytecode (not implemented)', () => {
      expect(() => factory.getBytecode()).toThrow(
        'Contract bytecode not available - requires compiled Solidity contract'
      );
    });

    it('should return contract ABI', () => {
      const abi = factory.getABI();
      expect(Array.isArray(abi)).toBe(true);
      expect(abi.length).toBeGreaterThan(0);
      
      // Check for key functions in ABI
      const abiStrings = abi.map(item => typeof item === 'string' ? item : JSON.stringify(item));
      expect(abiStrings.some(item => item.includes('executeArbitrage'))).toBe(true);
      expect(abiStrings.some(item => item.includes('uniswapV3FlashCallback'))).toBe(true);
    });
  });
});