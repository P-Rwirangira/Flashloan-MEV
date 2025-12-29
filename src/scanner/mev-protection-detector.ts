/**
 * MEV Protection Detector
 *
 * Detects transactions using MEV protection services and identifies safe backrun opportunities
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { Address } from '../types/common';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface ProtectedTransaction {
  readonly hash: string;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly gasPrice: bigint;
  readonly gasLimit: bigint;
  readonly data: string;
  readonly protectionService: 'flashbots-protect' | 'cow-swap' | 'private-pool' | 'unknown';
  readonly backrunSafety: 'safe' | 'risky' | 'unsafe';
  readonly estimatedSlippage: number; // 0-1 scale
  readonly tokenAddresses: Address[];
  readonly detectedAt: number;
}

export interface BackrunOpportunity {
  readonly id: string;
  readonly protectedTx: ProtectedTransaction;
  readonly opportunityType: 'arbitrage' | 'liquidation' | 'sandwich-protection';
  readonly estimatedProfit: bigint;
  readonly riskScore: number; // 0-1 scale
  readonly timeWindow: number; // milliseconds until opportunity expires
  readonly requiredGasPrice: bigint;
}

export interface MEVProtectionStats {
  readonly totalProtectedTxs: number;
  readonly safeBackrunOpportunities: number;
  readonly protectionServiceBreakdown: Record<string, number>;
  readonly averageSlippage: number;
  readonly detectionAccuracy: number;
}

export class MEVProtectionDetector extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly protectedTransactions: Map<string, ProtectedTransaction> = new Map();
  private readonly backrunOpportunities: Map<string, BackrunOpportunity> = new Map();

  // Known MEV protection service indicators
  private readonly protectionIndicators = {
    'flashbots-protect': [
      '0x0000000000000000000000000000000000000000', // Flashbots relay
      'mev-boost', // MEV-Boost related
      'flashbots', // Flashbots in transaction data
    ],
    'cow-swap': [
      '0x9008d19f58aabd9ed0d60971565aa8510560ab41', // CoW Protocol Settlement
      'cowswap',
      'gnosis-safe',
    ],
    'private-pool': ['private', 'protected', 'anti-mev'],
  };

  // Known safe backrun patterns
  private readonly safeBackrunPatterns = [
    'uniswap-v2-swap',
    'uniswap-v3-swap',
    'aerodrome-swap',
    'token-transfer',
    'approve',
  ];

  private readonly maxHistorySize = 1000;
  private readonly opportunityTimeoutMs = 30000; // 30 seconds - integrate timeout for cleanup

  constructor(connectionManager: RpcConnectionManager) {
    super();
    this.connectionManager = connectionManager;

    // Use opportunityTimeoutMs for periodic cleanup
    setInterval(() => {
      this.cleanupExpiredOpportunities();
    }, this.opportunityTimeoutMs);
  }

  /**
   * Start monitoring for MEV-protected transactions
   */
  async startMonitoring(): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();

      // Listen for pending transactions
      provider.on('pending', async (txHash: string) => {
        try {
          await this.analyzePendingTransaction(txHash);
        } catch (error) {
          // Skip failed analysis
        }
      });

      // Listen for new blocks to clean up expired opportunities
      provider.on('block', (blockNumber: number) => {
        // Use blockNumber for logging and metrics
        this.emit('blockProcessed', { blockNumber, timestamp: Date.now() });
        this.cleanupExpiredOpportunities();
      });

      this.emit('monitoringStarted');
    } catch (error) {
      this.emit('monitoringError', error);
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    const provider = this.connectionManager.getProvider();
    provider.removeAllListeners('pending');
    provider.removeAllListeners('block');

    this.protectedTransactions.clear();
    this.backrunOpportunities.clear();

    this.emit('monitoringStopped');
  }

  /**
   * Analyze a pending transaction for MEV protection
   */
  private async analyzePendingTransaction(txHash: string): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();
      const tx = await provider.getTransaction(txHash);

      if (!tx) return;

      // Detect protection service
      const protectionService = this.detectProtectionService(tx);

      if (protectionService === 'unknown') {
        // Not a protected transaction
        return;
      }

      // Analyze transaction safety for backrunning
      const backrunSafety = this.analyzeBackrunSafety(tx);

      // Extract token addresses from transaction data
      const tokenAddresses = this.extractTokenAddresses(tx.data);

      // Estimate slippage tolerance
      const estimatedSlippage = this.estimateSlippage(tx);

      const protectedTx: ProtectedTransaction = {
        hash: txHash,
        from: tx.from as Address,
        to: (tx.to || '0x0000000000000000000000000000000000000000') as Address,
        value: tx.value,
        gasPrice: tx.gasPrice || 0n,
        gasLimit: tx.gasLimit,
        data: tx.data,
        protectionService,
        backrunSafety,
        estimatedSlippage,
        tokenAddresses,
        detectedAt: Date.now(),
      };

      this.protectedTransactions.set(txHash, protectedTx);

      // If safe for backrunning, create opportunity
      if (backrunSafety === 'safe') {
        await this.createBackrunOpportunity(protectedTx);
      }

      this.emit('protectedTransactionDetected', protectedTx);

      // Cleanup old transactions
      this.cleanupOldTransactions();
    } catch (error) {
      // Skip failed analysis
    }
  }

  /**
   * Detect MEV protection service from transaction
   */
  private detectProtectionService(
    tx: ethers.TransactionResponse
  ): ProtectedTransaction['protectionService'] {
    const txData = tx.data.toLowerCase();
    const toAddress = tx.to?.toLowerCase() || '';

    // Check for Flashbots Protect indicators
    for (const indicator of this.protectionIndicators['flashbots-protect']) {
      if (txData.includes(indicator.toLowerCase()) || toAddress.includes(indicator.toLowerCase())) {
        return 'flashbots-protect';
      }
    }

    // Check for CoW Swap indicators
    for (const indicator of this.protectionIndicators['cow-swap']) {
      if (txData.includes(indicator.toLowerCase()) || toAddress.includes(indicator.toLowerCase())) {
        return 'cow-swap';
      }
    }

    // Check for private pool indicators
    for (const indicator of this.protectionIndicators['private-pool']) {
      if (txData.includes(indicator.toLowerCase())) {
        return 'private-pool';
      }
    }

    // Additional heuristics for protection detection
    if (this.hasProtectionHeuristics(tx)) {
      return 'private-pool';
    }

    return 'unknown';
  }

  /**
   * Check for protection heuristics
   */
  private hasProtectionHeuristics(tx: ethers.TransactionResponse): boolean {
    // High gas price with specific patterns might indicate protection
    const gasPrice = tx.gasPrice || 0n;
    const highGasThreshold = ethers.parseUnits('20', 'gwei');

    if (gasPrice > highGasThreshold) {
      // Check for MEV protection patterns in transaction data
      const txData = tx.data.toLowerCase();

      // Look for deadline parameters (common in protected swaps)
      if (txData.includes('deadline') || txData.length > 1000) {
        return true;
      }

      // Check for complex routing (multiple hops)
      const hopCount = (txData.match(/a9059cbb/g) || []).length; // transfer function selector
      if (hopCount > 2) {
        return true;
      }
    }

    return false;
  }

  /**
   * Analyze if transaction is safe for backrunning
   */
  private analyzeBackrunSafety(
    tx: ethers.TransactionResponse
  ): ProtectedTransaction['backrunSafety'] {
    const txData = tx.data.toLowerCase();

    // Check for safe patterns
    let safePatternCount = 0;
    for (const pattern of this.safeBackrunPatterns) {
      if (txData.includes(pattern.replace('-', '').toLowerCase())) {
        safePatternCount++;
      }
    }

    // Check for risky patterns
    const riskyPatterns = ['multicall', 'batch', 'flashloan', 'liquidate'];

    let riskyPatternCount = 0;
    for (const pattern of riskyPatterns) {
      if (txData.includes(pattern)) {
        riskyPatternCount++;
      }
    }

    // Determine safety level
    if (riskyPatternCount > 0) {
      return 'unsafe';
    } else if (safePatternCount > 0) {
      return 'safe';
    } else {
      return 'risky';
    }
  }

  /**
   * Extract token addresses from transaction data
   */
  private extractTokenAddresses(data: string): Address[] {
    const addresses: Address[] = [];

    // Look for 20-byte addresses in transaction data
    const addressRegex = /0x[a-fA-F0-9]{40}/g;
    const matches = data.match(addressRegex);

    if (matches) {
      for (const match of matches) {
        // Validate address format and add if unique
        if (ethers.isAddress(match) && !addresses.includes(match as Address)) {
          addresses.push(match as Address);
        }
      }
    }

    return addresses;
  }

  /**
   * Estimate slippage tolerance from transaction
   */
  private estimateSlippage(tx: ethers.TransactionResponse): number {
    // Analyze gas price to estimate urgency/slippage tolerance
    const gasPrice = tx.gasPrice || 0n;
    const baseGasPrice = ethers.parseUnits('2', 'gwei');

    if (gasPrice <= baseGasPrice) {
      return 0.005; // 0.5% for low gas price
    } else if (gasPrice <= ethers.parseUnits('10', 'gwei')) {
      return 0.01; // 1% for medium gas price
    } else if (gasPrice <= ethers.parseUnits('50', 'gwei')) {
      return 0.03; // 3% for high gas price
    } else {
      return 0.05; // 5% for very high gas price
    }
  }

  /**
   * Create backrun opportunity from protected transaction
   */
  private async createBackrunOpportunity(protectedTx: ProtectedTransaction): Promise<void> {
    try {
      // Analyze the transaction to determine opportunity type
      const opportunityType = this.determineOpportunityType(protectedTx);

      // Estimate potential profit
      const estimatedProfit = await this.estimateBackrunProfit(protectedTx);

      if (estimatedProfit <= 0n) {
        return; // No profitable opportunity
      }

      // Calculate risk score
      const riskScore = this.calculateRiskScore(protectedTx);

      // Determine time window
      const timeWindow = this.calculateTimeWindow(protectedTx);

      // Calculate required gas price to backrun
      const requiredGasPrice = this.calculateRequiredGasPrice(protectedTx);

      const opportunity: BackrunOpportunity = {
        id: `backrun-${protectedTx.hash}-${Date.now()}`,
        protectedTx,
        opportunityType,
        estimatedProfit,
        riskScore,
        timeWindow,
        requiredGasPrice,
      };

      this.backrunOpportunities.set(opportunity.id, opportunity);
      this.emit('backrunOpportunityCreated', opportunity);
    } catch (error) {
      // Skip failed opportunity creation
    }
  }

  /**
   * Determine opportunity type from protected transaction
   */
  private determineOpportunityType(
    protectedTx: ProtectedTransaction
  ): BackrunOpportunity['opportunityType'] {
    const txData = protectedTx.data.toLowerCase();

    if (txData.includes('swap') || txData.includes('exchange')) {
      return 'arbitrage';
    } else if (txData.includes('liquidate') || txData.includes('seize')) {
      return 'liquidation';
    } else {
      return 'sandwich-protection';
    }
  }

  /**
   * Estimate potential backrun profit
   */
  private async estimateBackrunProfit(protectedTx: ProtectedTransaction): Promise<bigint> {
    // This is a simplified estimation - real implementation would:
    // 1. Simulate the protected transaction
    // 2. Analyze resulting price impact
    // 3. Calculate arbitrage opportunities created

    // For now, estimate based on transaction value and slippage
    const txValue = protectedTx.value;
    const slippage = protectedTx.estimatedSlippage;

    if (txValue > 0n) {
      // Estimate profit as a fraction of slippage
      const potentialProfit = (txValue * BigInt(Math.floor(slippage * 1000))) / 10000n;
      return potentialProfit;
    }

    // For token swaps, estimate based on gas price (proxy for transaction size)
    const gasValue = protectedTx.gasPrice * protectedTx.gasLimit;
    const estimatedTxSize = gasValue * 100n; // Rough estimate
    const potentialProfit = (estimatedTxSize * BigInt(Math.floor(slippage * 500))) / 10000n;

    return potentialProfit;
  }

  /**
   * Calculate risk score for backrun opportunity
   */
  private calculateRiskScore(protectedTx: ProtectedTransaction): number {
    let riskScore = 0.3; // Base risk

    // Increase risk for unknown protection services
    if (protectedTx.protectionService === 'unknown') {
      riskScore += 0.2;
    }

    // Increase risk for complex transactions
    if (protectedTx.data.length > 2000) {
      riskScore += 0.1;
    }

    // Increase risk for high slippage
    if (protectedTx.estimatedSlippage > 0.03) {
      riskScore += 0.2;
    }

    // Decrease risk for known safe patterns
    if (protectedTx.backrunSafety === 'safe') {
      riskScore -= 0.1;
    }

    return Math.max(0.1, Math.min(0.9, riskScore));
  }

  /**
   * Calculate time window for opportunity
   */
  private calculateTimeWindow(protectedTx: ProtectedTransaction): number {
    // Base time window
    let timeWindow = 15000; // 15 seconds

    // Adjust based on protection service
    switch (protectedTx.protectionService) {
      case 'flashbots-protect':
        timeWindow = 12000; // Faster execution
        break;
      case 'cow-swap':
        timeWindow = 30000; // Longer settlement time
        break;
      case 'private-pool':
        timeWindow = 10000; // Very fast
        break;
    }

    // Adjust based on gas price (higher gas = more urgent)
    const gasPrice = protectedTx.gasPrice;
    const baseGasPrice = ethers.parseUnits('2', 'gwei');

    if (gasPrice > baseGasPrice * 5n) {
      timeWindow *= 0.5; // Half time for high gas price
    } else if (gasPrice > baseGasPrice * 2n) {
      timeWindow *= 0.7; // Reduced time for medium gas price
    }

    return Math.max(5000, timeWindow); // Minimum 5 seconds
  }

  /**
   * Calculate required gas price to successfully backrun
   */
  private calculateRequiredGasPrice(protectedTx: ProtectedTransaction): bigint {
    // Need to bid higher than the protected transaction
    const protectedGasPrice = protectedTx.gasPrice;

    // Add 10-20% premium depending on protection service
    let premiumPercent = 110; // 10% default

    switch (protectedTx.protectionService) {
      case 'flashbots-protect':
        premiumPercent = 105; // 5% premium (less competition)
        break;
      case 'cow-swap':
        premiumPercent = 115; // 15% premium (batch auction)
        break;
      case 'private-pool':
        premiumPercent = 120; // 20% premium (private competition)
        break;
    }

    return (protectedGasPrice * BigInt(premiumPercent)) / 100n;
  }

  /**
   * Get current backrun opportunities
   */
  getBackrunOpportunities(): BackrunOpportunity[] {
    const now = Date.now();
    const activeOpportunities: BackrunOpportunity[] = [];

    for (const opportunity of this.backrunOpportunities.values()) {
      const timeElapsed = now - opportunity.protectedTx.detectedAt;
      if (timeElapsed < opportunity.timeWindow) {
        activeOpportunities.push(opportunity);
      }
    }

    return activeOpportunities.sort((a, b) => (b.estimatedProfit > a.estimatedProfit ? 1 : -1));
  }

  /**
   * Get MEV protection statistics
   */
  getStats(): MEVProtectionStats {
    const protectionServiceBreakdown: Record<string, number> = {};
    let totalSlippage = 0;
    let safeBackrunCount = 0;

    for (const tx of this.protectedTransactions.values()) {
      protectionServiceBreakdown[tx.protectionService] =
        (protectionServiceBreakdown[tx.protectionService] || 0) + 1;

      totalSlippage += tx.estimatedSlippage;

      if (tx.backrunSafety === 'safe') {
        safeBackrunCount++;
      }
    }

    return {
      totalProtectedTxs: this.protectedTransactions.size,
      safeBackrunOpportunities: safeBackrunCount,
      protectionServiceBreakdown,
      averageSlippage:
        this.protectedTransactions.size > 0 ? totalSlippage / this.protectedTransactions.size : 0,
      detectionAccuracy: 0.85, // Placeholder - would be calculated from validation data
    };
  }

  /**
   * Clean up expired opportunities
   */
  private cleanupExpiredOpportunities(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, opportunity] of this.backrunOpportunities) {
      const timeElapsed = now - opportunity.protectedTx.detectedAt;
      if (timeElapsed > opportunity.timeWindow) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.backrunOpportunities.delete(id);
    }
  }

  /**
   * Clean up old transactions
   */
  private cleanupOldTransactions(): void {
    if (this.protectedTransactions.size > this.maxHistorySize) {
      const entries = Array.from(this.protectedTransactions.entries());
      entries.sort((a, b) => b[1].detectedAt - a[1].detectedAt);

      this.protectedTransactions.clear();
      for (const [hash, tx] of entries.slice(0, this.maxHistorySize)) {
        this.protectedTransactions.set(hash, tx);
      }
    }
  }
}
