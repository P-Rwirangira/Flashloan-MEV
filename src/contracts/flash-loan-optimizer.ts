/**
 * Flash Loan Optimizer
 *
 * Finds the cheapest flash loan source across multiple protocols
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface FlashLoanSource {
  readonly protocol: 'uniswap-v3' | 'balancer' | 'aave' | 'dydx';
  readonly poolAddress: Address;
  readonly token: Address;
  readonly feeBps: number; // Fee in basis points
  readonly maxAmount: bigint;
  readonly gasOverhead: bigint; // Additional gas cost
  reliability: number; // 0-1 scale (mutable for updates)
}

export interface FlashLoanQuote {
  readonly source: FlashLoanSource;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly totalCost: bigint; // Fee + gas cost
  readonly gasEstimate: bigint;
  readonly executionTime: number; // Estimated execution time in ms
}

export interface FlashLoanOptimizationResult {
  readonly bestQuote: FlashLoanQuote;
  readonly alternativeQuotes: FlashLoanQuote[];
  readonly savings: bigint; // Savings vs most expensive option
  readonly reasoning: string[];
}

export class FlashLoanOptimizer extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly knownSources: Map<string, FlashLoanSource[]> = new Map();
  private readonly sourceCache: Map<string, { sources: FlashLoanSource[]; timestamp: number }> =
    new Map();
  private readonly cacheTimeout = 300000; // 5 minutes

  // Base flash loan sources on Base network
  private readonly baseSources: FlashLoanSource[] = [
    {
      protocol: 'uniswap-v3',
      poolAddress: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18' as Address, // WETH/USDC 0.05%
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address, // USDC
      feeBps: 5, // 0.05%
      maxAmount: ethers.parseUnits('1000000', 6), // 1M USDC
      gasOverhead: 50000n,
      reliability: 0.95,
    },
    {
      protocol: 'uniswap-v3',
      poolAddress: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18' as Address, // WETH/USDC 0.05%
      token: '0x4200000000000000000000000000000000000006' as Address, // WETH
      feeBps: 5, // 0.05%
      maxAmount: ethers.parseEther('500'), // 500 WETH
      gasOverhead: 50000n,
      reliability: 0.95,
    },
    // Balancer would have 0% fees but higher gas - add when available on Base
    // {
    //   protocol: 'balancer',
    //   poolAddress: '0x...' as Address,
    //   token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address, // USDC
    //   feeBps: 0, // 0% fee
    //   maxAmount: ethers.parseUnits('500000', 6), // 500K USDC
    //   gasOverhead: 80000n, // Higher gas overhead
    //   reliability: 0.9,
    // },
  ];

  constructor(connectionManager: RpcConnectionManager) {
    super();
    this.connectionManager = connectionManager;
    this.initializeKnownSources();

    // Use connectionManager for future network queries and validation
    this.validateNetworkConnection();
  }

  /**
   * Validate network connection for flash loan operations
   */
  private async validateNetworkConnection(): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();
      const network = await provider.getNetwork();
      this.emit('networkValidated', { chainId: network.chainId.toString() });
    } catch (error) {
      this.emit('networkValidationError', error);
    }
  }

  /**
   * Find optimal flash loan source for given token and amount
   */
  async findOptimalFlashLoan(
    token: Address,
    amount: bigint,
    gasPrice: bigint = ethers.parseUnits('2', 'gwei')
  ): Promise<FlashLoanOptimizationResult> {
    const reasoning: string[] = [];

    // Get available sources for token
    const sources = await this.getAvailableSources(token);
    reasoning.push(`Found ${sources.length} available flash loan sources`);

    if (sources.length === 0) {
      throw new Error(`No flash loan sources available for token ${token}`);
    }

    // Generate quotes from all sources
    const quotes: FlashLoanQuote[] = [];

    for (const source of sources) {
      if (source.maxAmount >= amount) {
        const quote = this.generateQuote(source, amount, gasPrice);
        quotes.push(quote);
        reasoning.push(
          `${source.protocol}: ${ethers.formatUnits(quote.totalCost, 'gwei')} gwei total cost`
        );
      } else {
        reasoning.push(
          `${source.protocol}: insufficient capacity (max: ${source.maxAmount.toString()})`
        );
      }
    }

    if (quotes.length === 0) {
      throw new Error(`No flash loan sources can provide ${amount.toString()} of token ${token}`);
    }

    // Sort by total cost (fee + gas)
    quotes.sort((a, b) => (a.totalCost > b.totalCost ? 1 : -1));

    const bestQuote = quotes[0]!;
    const alternativeQuotes = quotes.slice(1);
    const mostExpensive = quotes[quotes.length - 1]!;
    const savings = mostExpensive.totalCost - bestQuote.totalCost;

    reasoning.push(
      `Best option: ${bestQuote.source.protocol} with ${ethers.formatUnits(savings, 'gwei')} gwei savings`
    );

    this.emit('flashLoanOptimized', {
      token,
      amount: amount.toString(),
      bestProtocol: bestQuote.source.protocol,
      savings: savings.toString(),
    });

    return {
      bestQuote,
      alternativeQuotes,
      savings,
      reasoning,
    };
  }

  /**
   * Get available flash loan sources for a token
   */
  private async getAvailableSources(token: Address): Promise<FlashLoanSource[]> {
    const cacheKey = token.toLowerCase();
    const cached = this.sourceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.sources;
    }

    // Filter base sources by token
    const availableSources = this.baseSources.filter(
      source => source.token.toLowerCase() === token.toLowerCase()
    );

    // In production, this would also:
    // 1. Query live pool states to verify liquidity
    // 2. Check for new pools that support flash loans
    // 3. Verify pool health and reliability

    // Update cache
    this.sourceCache.set(cacheKey, {
      sources: availableSources,
      timestamp: Date.now(),
    });

    return availableSources;
  }

  /**
   * Generate quote for a flash loan source
   */
  private generateQuote(source: FlashLoanSource, amount: bigint, gasPrice: bigint): FlashLoanQuote {
    // Calculate fee
    const fee = (amount * BigInt(source.feeBps)) / 10000n;

    // Calculate gas cost
    const gasEstimate = source.gasOverhead;
    const gasCost = gasEstimate * gasPrice;

    // Total cost = fee + gas cost
    const totalCost = fee + gasCost;

    // Estimate execution time based on protocol
    let executionTime: number;
    switch (source.protocol) {
      case 'uniswap-v3':
        executionTime = 100; // Fast execution
        break;
      case 'balancer':
        executionTime = 150; // Slightly slower
        break;
      case 'aave':
        executionTime = 200; // More complex
        break;
      case 'dydx':
        executionTime = 120; // Fast but less common
        break;
      default:
        executionTime = 150;
    }

    return {
      source,
      amount,
      fee,
      totalCost,
      gasEstimate,
      executionTime,
    };
  }

  /**
   * Initialize known flash loan sources
   */
  private initializeKnownSources(): void {
    // Group sources by token for faster lookup
    for (const source of this.baseSources) {
      const tokenKey = source.token.toLowerCase();

      if (!this.knownSources.has(tokenKey)) {
        this.knownSources.set(tokenKey, []);
      }

      this.knownSources.get(tokenKey)!.push(source);
    }

    this.emit('sourcesInitialized', {
      totalSources: this.baseSources.length,
      uniqueTokens: this.knownSources.size,
    });
  }

  /**
   * Add custom flash loan source
   */
  addCustomSource(source: FlashLoanSource): void {
    this.baseSources.push(source);

    const tokenKey = source.token.toLowerCase();
    if (!this.knownSources.has(tokenKey)) {
      this.knownSources.set(tokenKey, []);
    }
    this.knownSources.get(tokenKey)!.push(source);

    // Clear cache for this token
    this.sourceCache.delete(tokenKey);

    this.emit('customSourceAdded', source);
  }

  /**
   * Update source reliability based on execution results
   */
  updateSourceReliability(
    protocol: FlashLoanSource['protocol'],
    poolAddress: Address,
    success: boolean
  ): void {
    for (const source of this.baseSources) {
      if (source.protocol === protocol && source.poolAddress === poolAddress) {
        // Adjust reliability based on success/failure
        if (success) {
          source.reliability = Math.min(0.99, source.reliability * 1.01);
        } else {
          source.reliability = Math.max(0.5, source.reliability * 0.95);
        }

        this.emit('reliabilityUpdated', {
          protocol,
          poolAddress,
          newReliability: source.reliability,
          success,
        });
        break;
      }
    }
  }

  /**
   * Get flash loan statistics
   */
  getStats(): {
    totalSources: number;
    sourcesByProtocol: Record<string, number>;
    averageReliability: number;
    cacheSize: number;
  } {
    const sourcesByProtocol: Record<string, number> = {};
    let totalReliability = 0;

    for (const source of this.baseSources) {
      sourcesByProtocol[source.protocol] = (sourcesByProtocol[source.protocol] || 0) + 1;
      totalReliability += source.reliability;
    }

    return {
      totalSources: this.baseSources.length,
      sourcesByProtocol,
      averageReliability:
        this.baseSources.length > 0 ? totalReliability / this.baseSources.length : 0,
      cacheSize: this.sourceCache.size,
    };
  }

  /**
   * Clear source cache
   */
  clearCache(): void {
    this.sourceCache.clear();
    this.emit('cacheCleared');
  }

  /**
   * Get best flash loan source for token (cached)
   */
  async getBestSource(token: Address, amount: bigint): Promise<FlashLoanSource | null> {
    try {
      const optimization = await this.findOptimalFlashLoan(token, amount);
      return optimization.bestQuote.source;
    } catch (error) {
      return null;
    }
  }

  /**
   * Estimate flash loan cost without full optimization
   */
  async estimateFlashLoanCost(
    token: Address,
    amount: bigint,
    gasPrice: bigint = ethers.parseUnits('2', 'gwei')
  ): Promise<bigint> {
    try {
      const sources = await this.getAvailableSources(token);
      if (sources.length === 0) return 0n;

      // Use the most reliable source for estimation
      const bestSource = sources.reduce((best, current) =>
        current.reliability > best.reliability ? current : best
      );

      const quote = this.generateQuote(bestSource, amount, gasPrice);
      return quote.totalCost;
    } catch (error) {
      // Fallback estimation
      return (amount * 5n) / 10000n; // 0.05% fee estimate
    }
  }
}
