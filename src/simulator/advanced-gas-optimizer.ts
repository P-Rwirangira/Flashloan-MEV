/**
 * Advanced Gas Optimizer
 *
 * Dynamic gas optimization with EIP-1559 support, base fee prediction,
 * and network congestion analysis
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ArbitrageOpportunity } from '../types/opportunity';

export interface GasOptimizationParams {
  urgency: number; // 0-1 scale (0 = can wait, 1 = immediate)
  targetBlocks: number; // Target inclusion within N blocks
  maxGasPrice: bigint;
  profitMargin: bigint; // Available profit for gas costs
}

export interface EIP1559Params {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
  confidence: number; // 0-1 scale
}

export interface GasOptimizationResult {
  gasLimit: bigint;
  eip1559Params: EIP1559Params;
  totalCost: bigint;
  inclusionProbability: number;
  reasoning: string[];
}

export interface NetworkConditions {
  currentBaseFee: bigint;
  baseFeeHistory: bigint[];
  pendingTransactionCount: number;
  averageGasPrice: bigint;
  congestionLevel: 'low' | 'medium' | 'high' | 'extreme';
  blockUtilization: number; // 0-1 scale
}

export class AdvancedGasOptimizer extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private networkConditions?: NetworkConditions;
  private gasHistory: Array<{ timestamp: number; baseFee: bigint; gasPrice: bigint }> = [];
  private readonly maxHistorySize = 100;

  constructor(connectionManager: RpcConnectionManager) {
    super();
    this.connectionManager = connectionManager;
  }

  /**
   * Optimize gas parameters for maximum profitability
   */
  async optimizeGas(
    opportunity: ArbitrageOpportunity,
    params: GasOptimizationParams
  ): Promise<GasOptimizationResult> {
    const reasoning: string[] = [];

    // Update network conditions
    await this.updateNetworkConditions();

    if (!this.networkConditions) {
      throw new Error('Failed to get network conditions');
    }

    // Calculate dynamic gas limit based on route complexity
    const gasLimit = this.calculateDynamicGasLimit(opportunity);
    reasoning.push(
      `Dynamic gas limit: ${gasLimit.toString()} (route complexity: ${opportunity.route.pools.length})`
    );

    // Predict optimal EIP-1559 parameters
    const eip1559Params = await this.predictOptimalEIP1559Params(params);
    reasoning.push(
      `Base fee prediction: ${ethers.formatUnits(eip1559Params.baseFeePerGas, 'gwei')} gwei`
    );
    reasoning.push(
      `Priority fee: ${ethers.formatUnits(eip1559Params.maxPriorityFeePerGas, 'gwei')} gwei`
    );

    // Calculate total cost
    const totalCost = gasLimit * eip1559Params.maxFeePerGas;

    // Validate against profit margin
    if (totalCost > params.profitMargin) {
      // Adjust parameters to fit within profit margin
      const adjustedParams = this.adjustForProfitMargin(
        eip1559Params,
        gasLimit,
        params.profitMargin
      );
      reasoning.push(
        `Adjusted for profit margin: max fee reduced to ${ethers.formatUnits(adjustedParams.maxFeePerGas, 'gwei')} gwei`
      );

      return {
        gasLimit,
        eip1559Params: adjustedParams,
        totalCost: gasLimit * adjustedParams.maxFeePerGas,
        inclusionProbability: this.calculateInclusionProbability(
          adjustedParams,
          params.targetBlocks
        ),
        reasoning,
      };
    }

    // Calculate inclusion probability
    const inclusionProbability = this.calculateInclusionProbability(
      eip1559Params,
      params.targetBlocks
    );
    reasoning.push(`Inclusion probability: ${(inclusionProbability * 100).toFixed(1)}%`);

    return {
      gasLimit,
      eip1559Params,
      totalCost,
      inclusionProbability,
      reasoning,
    };
  }

  /**
   * Calculate dynamic gas limit based on transaction complexity
   */
  private calculateDynamicGasLimit(opportunity: ArbitrageOpportunity): bigint {
    // Base costs
    const baseGas = 21000n; // Base transaction
    const flashLoanGas = 45000n; // Flash loan setup and callback
    const profitValidationGas = 25000n; // On-chain profit validation

    // Per-swap costs (more accurate based on DEX type)
    let swapGas = 0n;

    // Main route gas calculation
    for (let i = 0; i < opportunity.route.pools.length; i++) {
      // Uniswap V3 swaps are more expensive than Aerodrome
      if (opportunity.sourceDex === 'uniswap-v3' || opportunity.targetDex === 'uniswap-v3') {
        swapGas += 120000n; // Uniswap V3 swap with concentrated liquidity
      } else {
        swapGas += 80000n; // Aerodrome swap (simpler AMM)
      }
    }

    // Fallback route overhead (10% of total fallback complexity)
    const fallbackOverhead = opportunity.fallbackRoutes.reduce((total, route) => {
      return total + BigInt(route.pools.length) * 15000n; // Reduced overhead per fallback pool
    }, 0n);

    // Token transfer costs
    const transferGas = BigInt(opportunity.route.pools.length + 1) * 25000n;

    // Calculate total with network-based buffer
    const baseTotal =
      baseGas + flashLoanGas + swapGas + transferGas + profitValidationGas + fallbackOverhead;

    // Dynamic buffer based on network congestion
    let bufferMultiplier = 110n; // 10% base buffer
    if (this.networkConditions) {
      switch (this.networkConditions.congestionLevel) {
        case 'low':
          bufferMultiplier = 105n; // 5% buffer
          break;
        case 'medium':
          bufferMultiplier = 115n; // 15% buffer
          break;
        case 'high':
          bufferMultiplier = 125n; // 25% buffer
          break;
        case 'extreme':
          bufferMultiplier = 140n; // 40% buffer
          break;
      }
    }

    return (baseTotal * bufferMultiplier) / 100n;
  }

  /**
   * Predict optimal EIP-1559 parameters
   */
  private async predictOptimalEIP1559Params(params: GasOptimizationParams): Promise<EIP1559Params> {
    if (!this.networkConditions) {
      throw new Error('Network conditions not available');
    }

    // Predict base fee for target blocks
    const predictedBaseFee = this.predictBaseFee(params.targetBlocks);

    // Calculate priority fee based on urgency and competition
    const priorityFee = this.calculateOptimalPriorityFee(params.urgency);

    // Calculate max fee with safety margin
    const maxFeePerGas = predictedBaseFee + priorityFee;

    // Apply maximum gas price limit
    const cappedMaxFee = maxFeePerGas > params.maxGasPrice ? params.maxGasPrice : maxFeePerGas;
    const cappedPriorityFee =
      cappedMaxFee > predictedBaseFee ? cappedMaxFee - predictedBaseFee : priorityFee;

    // Calculate confidence based on prediction accuracy
    const confidence = this.calculatePredictionConfidence(params.targetBlocks);

    return {
      maxFeePerGas: cappedMaxFee,
      maxPriorityFeePerGas: cappedPriorityFee,
      baseFeePerGas: predictedBaseFee,
      confidence,
    };
  }

  /**
   * Predict base fee for future blocks
   */
  private predictBaseFee(targetBlocks: number): bigint {
    if (!this.networkConditions) {
      return ethers.parseUnits('1', 'gwei'); // Fallback
    }

    const currentBaseFee = this.networkConditions.currentBaseFee;
    const history = this.networkConditions.baseFeeHistory;

    if (history.length < 3) {
      // Not enough history, use current with small buffer
      return (currentBaseFee * 110n) / 100n; // 10% buffer
    }

    // Calculate trend from recent history
    const recentHistory = history.slice(-Math.min(10, history.length));
    let trend = 0n;

    for (let i = 1; i < recentHistory.length; i++) {
      const current = recentHistory[i];
      const previous = recentHistory[i - 1];
      if (current && previous) {
        trend += current - previous;
      }
    }

    const avgTrend = recentHistory.length > 1 ? trend / BigInt(recentHistory.length - 1) : 0n;

    // Project base fee forward
    let predictedBaseFee = currentBaseFee + avgTrend * BigInt(targetBlocks);

    // Apply bounds based on network utilization
    const utilizationMultiplier = this.getUtilizationMultiplier();
    predictedBaseFee = (predictedBaseFee * utilizationMultiplier) / 100n;

    // Ensure minimum base fee
    const minBaseFee = ethers.parseUnits('0.1', 'gwei');
    return predictedBaseFee > minBaseFee ? predictedBaseFee : minBaseFee;
  }

  /**
   * Calculate optimal priority fee based on urgency and competition
   */
  private calculateOptimalPriorityFee(urgency: number): bigint {
    if (!this.networkConditions) {
      return ethers.parseUnits('1', 'gwei'); // Fallback
    }

    // Base priority fee based on network conditions
    let basePriorityFee: bigint;

    switch (this.networkConditions.congestionLevel) {
      case 'low':
        basePriorityFee = ethers.parseUnits('0.5', 'gwei');
        break;
      case 'medium':
        basePriorityFee = ethers.parseUnits('1', 'gwei');
        break;
      case 'high':
        basePriorityFee = ethers.parseUnits('2', 'gwei');
        break;
      case 'extreme':
        basePriorityFee = ethers.parseUnits('5', 'gwei');
        break;
    }

    // Apply urgency multiplier
    const urgencyMultiplier = 100n + BigInt(Math.floor(urgency * 200)); // 1x to 3x based on urgency
    const adjustedPriorityFee = (basePriorityFee * urgencyMultiplier) / 100n;

    return adjustedPriorityFee;
  }

  /**
   * Get utilization-based multiplier for base fee prediction
   */
  private getUtilizationMultiplier(): bigint {
    if (!this.networkConditions) {
      return 100n; // No adjustment
    }

    const utilization = this.networkConditions.blockUtilization;

    if (utilization > 0.95) {
      return 130n; // 30% increase for very high utilization
    } else if (utilization > 0.8) {
      return 115n; // 15% increase for high utilization
    } else if (utilization < 0.5) {
      return 95n; // 5% decrease for low utilization
    }

    return 100n; // No adjustment for normal utilization
  }

  /**
   * Calculate prediction confidence
   */
  private calculatePredictionConfidence(targetBlocks: number): number {
    if (!this.networkConditions) {
      return 0.5; // Low confidence without data
    }

    let confidence = 0.8; // Base confidence

    // Reduce confidence for longer predictions
    if (targetBlocks > 3) {
      confidence *= Math.max(0.3, 1 - (targetBlocks - 3) * 0.1);
    }

    // Reduce confidence in extreme conditions
    if (this.networkConditions.congestionLevel === 'extreme') {
      confidence *= 0.7;
    }

    // Increase confidence with more historical data
    if (this.gasHistory.length > 50) {
      confidence = Math.min(0.95, confidence * 1.1);
    }

    return confidence;
  }

  /**
   * Adjust parameters to fit within profit margin
   */
  private adjustForProfitMargin(
    params: EIP1559Params,
    gasLimit: bigint,
    profitMargin: bigint
  ): EIP1559Params {
    const maxAffordableGasPrice = gasLimit > 0n ? profitMargin / gasLimit : 0n;

    if (maxAffordableGasPrice < params.baseFeePerGas) {
      // Can't afford even the base fee - return minimum viable params
      return {
        ...params,
        maxFeePerGas: params.baseFeePerGas,
        maxPriorityFeePerGas: 0n,
        confidence: 0.1, // Very low confidence
      };
    }

    const affordablePriorityFee = maxAffordableGasPrice - params.baseFeePerGas;
    const adjustedPriorityFee =
      affordablePriorityFee < params.maxPriorityFeePerGas
        ? affordablePriorityFee
        : params.maxPriorityFeePerGas;

    return {
      ...params,
      maxFeePerGas: params.baseFeePerGas + adjustedPriorityFee,
      maxPriorityFeePerGas: adjustedPriorityFee,
      confidence: params.confidence * 0.8, // Reduced confidence due to constraints
    };
  }

  /**
   * Calculate inclusion probability
   */
  private calculateInclusionProbability(params: EIP1559Params, targetBlocks: number): number {
    if (!this.networkConditions) {
      return 0.5; // Unknown
    }

    // Base probability from priority fee
    const avgGasPrice = this.networkConditions.averageGasPrice;
    const competitiveness = Number(params.maxFeePerGas) / Number(avgGasPrice);

    let baseProbability = Math.min(0.95, Math.max(0.1, competitiveness * 0.6));

    // Adjust for target blocks
    if (targetBlocks > 1) {
      baseProbability = 1 - Math.pow(1 - baseProbability, targetBlocks);
    }

    // Adjust for network congestion
    switch (this.networkConditions.congestionLevel) {
      case 'low':
        baseProbability = Math.min(0.95, baseProbability * 1.2);
        break;
      case 'high':
        baseProbability *= 0.8;
        break;
      case 'extreme':
        baseProbability *= 0.6;
        break;
    }

    return Math.max(0.05, Math.min(0.95, baseProbability));
  }

  /**
   * Update network conditions
   */
  private async updateNetworkConditions(): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();

      // Get latest block and fee data
      const [latestBlock, feeData, pendingBlock] = await Promise.all([
        provider.getBlock('latest'),
        provider.getFeeData(),
        provider.getBlock('pending').catch(() => null),
      ]);

      if (!latestBlock) {
        throw new Error('Failed to get latest block');
      }

      // Get base fee history
      const baseFeeHistory = await this.getBaseFeeHistory();

      // Calculate network metrics
      const blockUtilization =
        latestBlock.gasUsed && latestBlock.gasLimit
          ? Number(latestBlock.gasUsed) / Number(latestBlock.gasLimit)
          : 0.5;

      const pendingTxCount = pendingBlock?.transactions?.length || 0;

      const currentBaseFee = latestBlock.baseFeePerGas || ethers.parseUnits('1', 'gwei');
      const averageGasPrice = feeData.gasPrice || currentBaseFee;

      // Determine congestion level
      const congestionLevel = this.determineCongestionLevel(
        blockUtilization,
        pendingTxCount,
        currentBaseFee
      );

      this.networkConditions = {
        currentBaseFee,
        baseFeeHistory,
        pendingTransactionCount: pendingTxCount,
        averageGasPrice,
        congestionLevel,
        blockUtilization,
      };

      // Update gas history
      this.gasHistory.push({
        timestamp: Date.now(),
        baseFee: currentBaseFee,
        gasPrice: averageGasPrice,
      });

      // Keep history size manageable
      if (this.gasHistory.length > this.maxHistorySize) {
        this.gasHistory = this.gasHistory.slice(-this.maxHistorySize);
      }

      this.emit('networkConditionsUpdated', this.networkConditions);
    } catch (error) {
      this.emit('networkConditionsError', error);
      throw error;
    }
  }

  /**
   * Get base fee history from recent blocks
   */
  private async getBaseFeeHistory(): Promise<bigint[]> {
    try {
      const provider = this.connectionManager.getProvider();
      const latestBlockNumber = await provider.getBlockNumber();

      const history: bigint[] = [];
      const blocksToFetch = Math.min(10, latestBlockNumber);

      for (let i = 0; i < blocksToFetch; i++) {
        const block = await provider.getBlock(latestBlockNumber - i);
        if (block?.baseFeePerGas) {
          history.unshift(block.baseFeePerGas);
        }
      }

      return history;
    } catch (error) {
      return []; // Return empty history on error
    }
  }

  /**
   * Determine network congestion level
   */
  private determineCongestionLevel(
    blockUtilization: number,
    pendingTxCount: number,
    baseFee: bigint
  ): 'low' | 'medium' | 'high' | 'extreme' {
    const baseFeeGwei = Number(ethers.formatUnits(baseFee, 'gwei'));

    // Multiple factors determine congestion
    let congestionScore = 0;

    // Block utilization factor
    if (blockUtilization > 0.95) congestionScore += 3;
    else if (blockUtilization > 0.8) congestionScore += 2;
    else if (blockUtilization > 0.6) congestionScore += 1;

    // Pending transaction factor
    if (pendingTxCount > 1000) congestionScore += 3;
    else if (pendingTxCount > 500) congestionScore += 2;
    else if (pendingTxCount > 200) congestionScore += 1;

    // Base fee factor (Base L2 typically has lower fees)
    if (baseFeeGwei > 10) congestionScore += 3;
    else if (baseFeeGwei > 5) congestionScore += 2;
    else if (baseFeeGwei > 2) congestionScore += 1;

    // Determine level based on total score
    if (congestionScore >= 7) return 'extreme';
    if (congestionScore >= 5) return 'high';
    if (congestionScore >= 3) return 'medium';
    return 'low';
  }

  /**
   * Get current network conditions
   */
  getNetworkConditions(): NetworkConditions | undefined {
    return this.networkConditions;
  }

  /**
   * Get gas optimization statistics
   */
  getStats(): {
    historySize: number;
    networkConditions: NetworkConditions | undefined;
    averageBaseFee: bigint;
    baseFeeVolatility: number;
  } {
    const averageBaseFee =
      this.gasHistory.length > 0
        ? this.gasHistory.reduce((sum, entry) => sum + entry.baseFee, 0n) /
          BigInt(this.gasHistory.length)
        : 0n;

    // Calculate base fee volatility
    let volatility = 0;
    if (this.gasHistory.length > 1) {
      const prices = this.gasHistory.map(entry => Number(entry.baseFee));
      const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      const variance =
        prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
      volatility = Math.sqrt(variance) / mean;
    }

    return {
      historySize: this.gasHistory.length,
      networkConditions: this.networkConditions,
      averageBaseFee,
      baseFeeVolatility: volatility,
    };
  }
}
