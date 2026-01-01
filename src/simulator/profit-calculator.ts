/**
 * Profit Calculator
 *
 * Calculates expected profit including all costs with real-time data.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { ArbitrageOpportunity } from '../types/opportunity';
import { GasEstimator } from './gas-estimator';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ChainlinkPriceOracleImpl } from '../oracles/chainlink-oracle';
import { AdvancedGasOptimizer } from './advanced-gas-optimizer';
import { createComponentLogger } from '../utils/logger';

export interface ProfitCalculatorOptions {
  readonly gasEstimator: GasEstimator;
  readonly connectionManager: RpcConnectionManager;
  readonly priceOracle?: ChainlinkPriceOracleImpl;
  readonly gasOptimizer?: AdvancedGasOptimizer;
  readonly flashLoanFeeBps?: number;
  readonly minProfitMarginPercent?: number;
}

export interface IPriceOracle {
  getEthUsdPrice(): Promise<number>;
  getTokenUsdPrice(tokenAddress: Address): Promise<number>;
}

export interface DetailedProfitCalculation {
  readonly grossProfit: bigint;
  readonly flashLoanFee: bigint;
  readonly gasCost: bigint;
  readonly slippageCost: bigint;
  readonly bridgeFees: bigint;
  readonly competitionCost: bigint;
  readonly netProfit: bigint;
  readonly profitMargin: number;
  readonly profitUsd: number;
  readonly isViable: boolean;
  readonly breakdownBps: {
    readonly flashLoanFeeBps: number;
    readonly gasCostBps: number;
    readonly slippageBps: number;
    readonly bridgeFeeBps: number;
    readonly competitionBps: number;
  };
  readonly calculatedAt: number;
  readonly confidence: number;
}

export interface ProfitThresholds {
  readonly minProfitUsd: number;
  readonly minProfitMargin: number;
  readonly maxGasCostPercent: number;
  readonly maxSlippagePercent: number;
}

/**
 * Enhanced price oracle implementation with real Chainlink feeds
 */
export class EnhancedPriceOracle implements IPriceOracle {
  private readonly logger = createComponentLogger('enhanced-price-oracle');
  private readonly provider: ethers.Provider;
  private readonly chainlinkOracle: ChainlinkPriceOracleImpl;
  private priceCache: Map<string, { price: number; timestamp: number; confidence: number }> =
    new Map();
  private readonly cacheTimeMs = 30000; // 30 seconds cache

  constructor(connectionManager: RpcConnectionManager) {
    this.provider = connectionManager.getProvider();
    this.chainlinkOracle = new ChainlinkPriceOracleImpl(connectionManager);
  }

  async getEthUsdPrice(): Promise<number> {
    const cacheKey = 'ETH-USD';
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs && cached.confidence > 0.8) {
      return cached.price;
    }

    try {
      // Use Chainlink oracle for real price
      const price = await this.chainlinkOracle.getEthUsdPrice();

      this.priceCache.set(cacheKey, {
        price,
        timestamp: Date.now(),
        confidence: 0.95,
      });

      return price;
    } catch (error) {
      // Fallback to cached price if available
      if (cached) {
        return cached.price;
      }

      // Try to get price from DEX as last resort
      try {
        const ethPrice = await this.getEthPriceFromDex();
        this.priceCache.set(cacheKey, {
          price: ethPrice,
          timestamp: Date.now(),
          confidence: 0.7,
        });
        return ethPrice;
      } catch (dexError) {
        this.logger.error('Failed to get ETH price from any source', {
          chainlinkError: error instanceof Error ? error.message : String(error),
          dexError: dexError instanceof Error ? dexError.message : String(dexError),
        });
        throw new Error('Unable to fetch ETH price from any source');
      }
    }
  }

  /**
   * Get ETH price from DEX pools as fallback
   */
  private async getEthPriceFromDex(): Promise<number> {
    try {
      // Query WETH/USDC pool on Uniswap V3 (Base)
      const wethUsdcPool = '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18';
      const poolContract = new ethers.Contract(
        wethUsdcPool,
        ['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'],
        this.provider
      );

      const slot0 = await (poolContract['slot0'] as any)();
      const sqrtPriceX96 = slot0[0];

      // Convert sqrtPriceX96 to price
      const price = Math.pow(Number(sqrtPriceX96) / Math.pow(2, 96), 2) * Math.pow(10, 6 - 18);
      const ethPriceUsd = (1 / price) * Math.pow(10, 12);

      return ethPriceUsd;
    } catch (error) {
      this.logger.error('Failed to get ETH price from DEX', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getTokenUsdPrice(tokenAddress: Address): Promise<number> {
    const cacheKey = `${tokenAddress}-USD`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs && cached.confidence > 0.8) {
      return cached.price;
    }

    try {
      // Use Chainlink oracle for real price
      const price = await this.chainlinkOracle.getTokenUsdPrice(tokenAddress);

      this.priceCache.set(cacheKey, {
        price,
        timestamp: Date.now(),
        confidence: 0.9,
      });

      return price;
    } catch (error) {
      // Fallback to cached price if available
      if (cached) {
        return cached.price;
      }

      // Derive from ETH price as fallback
      return this.deriveTokenPriceFromEth(tokenAddress);
    }
  }

  private async deriveTokenPriceFromEth(tokenAddress: Address): Promise<number> {
    try {
      // First try to get price from DEX pools
      const dexPrice = await this.getTokenPriceFromDex(tokenAddress);
      if (dexPrice > 0) {
        this.priceCache.set(`${tokenAddress}-USD`, {
          price: dexPrice,
          timestamp: Date.now(),
          confidence: 0.8,
        });
        return dexPrice;
      }
    } catch (error) {
      this.logger.warn('Failed to get token price from DEX', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback to known token prices
    const ethPrice = await this.getEthUsdPrice();
    const tokenAddressLower = tokenAddress.toLowerCase();

    const knownTokenPrices: Record<string, number> = {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0, // USDC
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 1.0, // DAI
      '0x4200000000000000000000000000000000000006': ethPrice, // WETH
      '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': ethPrice * 1.1, // wstETH
    };

    const knownPrice = knownTokenPrices[tokenAddressLower];
    if (knownPrice !== undefined) {
      return knownPrice;
    }

    // For unknown tokens, conservative estimate
    return ethPrice * 0.05;
  }

  /**
   * Get token price from DEX pools
   */
  private async getTokenPriceFromDex(tokenAddress: Address): Promise<number> {
    try {
      const ethPrice = await this.getEthUsdPrice();

      // Try to find a pool with WETH or USDC
      const wethAddress = '0x4200000000000000000000000000000000000006';
      const usdcAddress = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

      const feeTiers = [500, 3000, 10000];

      for (const fee of feeTiers) {
        try {
          // Try WETH pair first
          const wethPoolAddress = await this.computePoolAddress(tokenAddress, wethAddress, fee);
          const wethPrice = await this.getPoolPrice(wethPoolAddress, tokenAddress, wethAddress);
          if (wethPrice > 0) {
            return wethPrice * ethPrice;
          }
        } catch {
          // Continue to next fee tier
        }

        try {
          // Try USDC pair
          const usdcPoolAddress = await this.computePoolAddress(tokenAddress, usdcAddress, fee);
          const usdcPrice = await this.getPoolPrice(usdcPoolAddress, tokenAddress, usdcAddress);
          if (usdcPrice > 0) {
            return usdcPrice;
          }
        } catch {
          // Continue to next fee tier
        }
      }

      return 0;
    } catch (error) {
      return 0;
    }
  }

  private async computePoolAddress(
    tokenA: Address,
    tokenB: Address,
    fee: number
  ): Promise<Address> {
    const factory = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
    const [token0, token1] =
      tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

    const salt = ethers.solidityPackedKeccak256(
      ['address', 'address', 'uint24'],
      [token0, token1, fee]
    );

    const initCodeHash = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';

    return ethers.getCreate2Address(factory, salt, initCodeHash) as Address;
  }

  private async getPoolPrice(
    poolAddress: Address,
    tokenA: Address,
    tokenB: Address
  ): Promise<number> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        ['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'],
        this.provider
      );

      const slot0 = await (poolContract['slot0'] as any)();
      const sqrtPriceX96 = slot0[0];

      if (sqrtPriceX96 === 0n) {
        return 0;
      }

      const price = Math.pow(Number(sqrtPriceX96) / Math.pow(2, 96), 2);
      return tokenA.toLowerCase() < tokenB.toLowerCase() ? price : 1 / price;
    } catch (error) {
      return 0;
    }
  }
}

export class ProfitCalculator extends EventEmitter {
  private readonly gasEstimator: GasEstimator;
  private readonly priceOracle: IPriceOracle;
  private readonly gasOptimizer: AdvancedGasOptimizer | undefined;
  private readonly flashLoanFeeBps: number;
  private readonly minProfitMarginPercent: number;
  private readonly logger = createComponentLogger('profit-calculator');

  // Calculation cache
  private calculationCache: Map<string, DetailedProfitCalculation> = new Map();
  private readonly cacheTimeoutMs = 5000;

  constructor(options: ProfitCalculatorOptions) {
    super();

    this.gasEstimator = options.gasEstimator;
    this.priceOracle = options.priceOracle || new EnhancedPriceOracle(options.connectionManager);
    this.gasOptimizer = options.gasOptimizer;
    this.flashLoanFeeBps = options.flashLoanFeeBps || 5; // 0.05% default
    this.minProfitMarginPercent = options.minProfitMarginPercent || 1.0; // 1.0% for Base L2
  }

  /**
   * Get current gas price from provider
   */
  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      // Use the connection manager from the enhanced price oracle
      const provider = (this.priceOracle as EnhancedPriceOracle)['provider'];
      if (provider) {
        const feeData = await provider.getFeeData();
        return feeData.gasPrice || ethers.parseUnits('20', 'gwei');
      }

      // Fallback to default gas price
      return ethers.parseUnits('20', 'gwei');
    } catch (error) {
      this.logger.warn('Failed to get gas price, using default', {
        error: error instanceof Error ? error.message : String(error),
      });
      return ethers.parseUnits('20', 'gwei');
    }
  }

  /**
   * Calculate detailed profit for arbitrage opportunity
   */
  async calculateDetailedProfit(
    opportunity: ArbitrageOpportunity
  ): Promise<DetailedProfitCalculation> {
    const cacheKey = `${opportunity.id}-${opportunity.detectedAt}`;
    const cached = this.calculationCache.get(cacheKey);

    if (cached && Date.now() - cached.calculatedAt < this.cacheTimeoutMs) {
      return cached;
    }

    try {
      const calculation = await this.performDetailedCalculation(opportunity);
      this.calculationCache.set(cacheKey, calculation);

      // Clean old cache entries
      this.cleanCache();

      return calculation;
    } catch (error) {
      this.logger.error('Failed to calculate detailed profit', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async performDetailedCalculation(
    opportunity: ArbitrageOpportunity
  ): Promise<DetailedProfitCalculation> {
    const startTime = Date.now();

    // Calculate gross profit
    const grossProfit = BigInt(opportunity.expectedProfit.toString());

    // Calculate flash loan fee
    const flashLoanFee =
      (BigInt(opportunity.amountIn.toString()) * BigInt(this.flashLoanFeeBps)) / 10000n;

    // Calculate gas cost with optimization if available
    let gasEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);

    // Apply gas optimization if available
    if (this.gasOptimizer) {
      try {
        const optimizationOptions = {
          urgency: 0.7, // Medium urgency for arbitrage
          targetBlocks: 2, // Target inclusion within 2 blocks
          maxGasPrice: ethers.parseUnits('100', 'gwei'),
          profitMargin: grossProfit,
          competitionLevel: 0.5, // Medium competition assumption
        };

        const optimizationResult = await this.gasOptimizer.optimizeGas(
          opportunity,
          optimizationOptions
        );

        // Update gas estimate with optimized values
        gasEstimate = {
          ...gasEstimate,
          gasLimit: optimizationResult.gasLimit,
          maxFeePerGas: optimizationResult.maxFeePerGas,
          maxPriorityFeePerGas: optimizationResult.maxPriorityFeePerGas,
          totalCost: optimizationResult.totalCost,
        };

        this.logger.debug('Applied gas optimization', {
          originalGasLimit: gasEstimate.gasLimit.toString(),
          optimizedGasLimit: optimizationResult.gasLimit.toString(),
          strategy: optimizationResult.strategy,
          inclusionProbability: optimizationResult.inclusionProbability,
        });
      } catch (error) {
        this.logger.warn('Gas optimization failed, using original estimate', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const gasPrice = await this.getCurrentGasPrice();
    const gasCost = gasEstimate.gasLimit * gasPrice;

    // Calculate slippage cost (simplified)
    const slippageCost = (grossProfit * 50n) / 10000n; // 0.5% slippage estimate

    // Bridge fees (none for single-chain arbitrage)
    const bridgeFees = 0n;

    // Competition cost
    const competitionCost = await this.calculateCompetitionCost(grossProfit, opportunity);

    // Calculate net profit
    const totalCosts = flashLoanFee + gasCost + slippageCost + bridgeFees + competitionCost;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin
    const profitMargin = grossProfit > 0n ? Number(netProfit) / Number(grossProfit) : 0;

    // Calculate USD value
    const ethPrice = await this.priceOracle.getEthUsdPrice();
    const profitUsd = Number(ethers.formatEther(netProfit)) * ethPrice;

    // Check viability
    const isViable = netProfit > 0n && profitMargin >= this.minProfitMarginPercent / 100;

    // Calculate breakdown in basis points
    const grossProfitNum = Number(grossProfit);
    const breakdownBps = {
      flashLoanFeeBps:
        grossProfitNum > 0 ? Math.round((Number(flashLoanFee) / grossProfitNum) * 10000) : 0,
      gasCostBps: grossProfitNum > 0 ? Math.round((Number(gasCost) / grossProfitNum) * 10000) : 0,
      slippageBps:
        grossProfitNum > 0 ? Math.round((Number(slippageCost) / grossProfitNum) * 10000) : 0,
      bridgeFeeBps: 0,
      competitionBps:
        grossProfitNum > 0 ? Math.round((Number(competitionCost) / grossProfitNum) * 10000) : 0,
    };

    return {
      grossProfit,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees,
      competitionCost,
      netProfit,
      profitMargin,
      profitUsd,
      isViable,
      breakdownBps,
      calculatedAt: startTime,
      confidence: 0.85, // Good confidence for real calculation
    };
  }

  private async calculateCompetitionCost(
    grossProfit: bigint,
    opportunity: ArbitrageOpportunity
  ): Promise<bigint> {
    const profitMargin = grossProfit > 0n ? Number(grossProfit) / Number(opportunity.amountIn) : 0;

    if (profitMargin > 0.05) {
      // >5% profit margin attracts competition
      // Assume we need to bid 10-20% of gross profit to win
      return (grossProfit * BigInt(Math.floor(Math.random() * 10 + 10))) / 100n;
    }

    return 0n;
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, value] of this.calculationCache.entries()) {
      if (now - value.calculatedAt > this.cacheTimeoutMs * 2) {
        this.calculationCache.delete(key);
      }
    }
  }

  async calculateMinProfitWei(minProfitUsd: number, tokenAddress: Address): Promise<bigint> {
    try {
      const tokenPrice = await this.priceOracle.getTokenUsdPrice(tokenAddress);
      const minProfitToken = minProfitUsd / tokenPrice;
      return ethers.parseEther(minProfitToken.toString());
    } catch (error) {
      // Fallback calculation
      const ethPrice = await this.priceOracle.getEthUsdPrice();
      return ethers.parseEther((minProfitUsd / ethPrice).toString());
    }
  }
}
