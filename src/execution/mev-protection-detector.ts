/**
 * MEV Protection Detection and Safe Backrunning
 *
 * Identifies MEV-protected transactions and assesses backrun safety
 * with ethical guidelines enforcement
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';

export interface MEVProtectionDetectorConfig {
  readonly enableEthicalGuidelines: boolean;
  readonly maxSlippageImpact: number;
  readonly minProtectionSignalConfidence: number;
  readonly backrunSafetyThreshold: number;
  readonly protectionServiceTimeout: number;
  readonly consentVerificationRequired: boolean;
  readonly maxBackrunSize: bigint;
  readonly protectionSignalCacheMs: number;
}

export interface ProtectionService {
  readonly name: string;
  readonly type: 'flashbots-protect' | 'cow-protocol' | 'eden-network' | 'mistx' | 'taichi';
  readonly enabled: boolean;
  readonly detectionMethod: 'transaction-analysis' | 'mempool-monitoring' | 'relay-detection';
  readonly confidenceScore: number;
  readonly endpoint?: string;
  readonly contractAddresses: Address[];
}

export interface ProtectionSignal {
  readonly transactionHash: string;
  readonly service: ProtectionService;
  readonly protectionType:
    | 'mev-protection'
    | 'private-mempool'
    | 'delayed-reveal'
    | 'commit-reveal';
  readonly confidence: number;
  readonly userConsent: boolean;
  readonly protectionLevel: 'basic' | 'advanced' | 'premium';
  readonly detectedAt: number;
  readonly expiresAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface BackrunOpportunity {
  readonly id: string;
  readonly protectedTransaction: string;
  readonly targetToken: Address;
  readonly estimatedSlippage: number;
  readonly slippageImpact: number;
  readonly backrunSize: bigint;
  readonly estimatedProfit: bigint;
  readonly safetyScore: number;
  readonly ethicalScore: number;
  readonly timing: {
    readonly optimalDelay: number;
    readonly maxDelay: number;
    readonly blockTarget: number;
  };
  readonly risks: string[];
  readonly complianceChecks: {
    readonly userConsent: boolean;
    readonly protectionRespected: boolean;
    readonly ethicalGuidelines: boolean;
    readonly legalCompliance: boolean;
  };
  readonly createdAt: number;
}

export interface BackrunValidationResult {
  readonly opportunity: BackrunOpportunity;
  readonly approved: boolean;
  readonly rejectionReasons: string[];
  readonly safetyAssessment: {
    readonly overallScore: number;
    readonly technicalSafety: number;
    readonly ethicalCompliance: number;
    readonly legalCompliance: number;
    readonly userProtection: number;
  };
  readonly recommendations: string[];
  readonly validatedAt: number;
}

export interface SlippageAnalysis {
  readonly transaction: string;
  readonly token: Address;
  readonly pool: Address;
  readonly priceImpact: number;
  readonly slippageEstimate: number;
  readonly liquidityDepth: bigint;
  readonly volumeImpact: number;
  readonly recoveryTime: number;
  readonly backrunWindow: number;
}

export class MEVProtectionDetector extends EventEmitter {
  private readonly logger = createComponentLogger('mev-protection-detector');
  private readonly config: MEVProtectionDetectorConfig;
  private readonly provider: ethers.Provider;

  // Protection services registry
  private readonly protectionServices = new Map<string, ProtectionService>();
  private readonly protectionSignals = new Map<string, ProtectionSignal>();

  // Backrun opportunity tracking
  private readonly activeOpportunities = new Map<string, BackrunOpportunity>();
  private opportunityCounter = 0;

  // Ethical guidelines and compliance
  private readonly ethicalGuidelines = new Set<string>();
  private readonly complianceRules = new Map<
    string,
    (opportunity: BackrunOpportunity) => boolean
  >();

  constructor(provider: ethers.Provider, config: MEVProtectionDetectorConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.initializeProtectionServices();
    this.initializeEthicalGuidelines();
    this.initializeComplianceRules();
    this.startProtectionMonitoring();

    this.logger.info('MEV protection detector initialized', {
      enableEthicalGuidelines: this.config.enableEthicalGuidelines,
      maxSlippageImpact: this.config.maxSlippageImpact,
      protectionServices: this.protectionServices.size,
    });
  }

  /**
   * Detect MEV protection in transaction
   */
  async detectProtection(transactionHash: string): Promise<ProtectionSignal[]> {
    try {
      this.logger.debug('Detecting MEV protection', { transactionHash });

      const signals: ProtectionSignal[] = [];

      // Check cached signals first
      const cachedSignal = this.protectionSignals.get(transactionHash);
      if (cachedSignal && cachedSignal.expiresAt > Date.now()) {
        return [cachedSignal];
      }

      // Get transaction details
      const transaction = await this.provider.getTransaction(transactionHash);
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      // Check each protection service
      for (const [serviceName, service] of this.protectionServices) {
        if (!service.enabled) continue;

        try {
          const signal = await this.checkProtectionService(transaction, service);
          if (signal) {
            signals.push(signal);

            // Cache the signal
            this.protectionSignals.set(transactionHash, signal);
          }
        } catch (error) {
          this.logger.warn('Protection service check failed', {
            service: serviceName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.emit('protectionDetected', {
        transactionHash,
        signals,
        timestamp: Date.now(),
      });

      return signals;
    } catch (error) {
      this.logger.error('Protection detection failed', {
        transactionHash,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Assess backrun safety for protected transaction
   */
  async assessBackrunSafety(
    protectedTransaction: string,
    targetToken: Address,
    backrunSize: bigint
  ): Promise<BackrunValidationResult> {
    try {
      this.logger.debug('Assessing backrun safety', {
        protectedTransaction,
        targetToken,
        backrunSize: backrunSize.toString(),
      });

      // Detect protection signals
      const protectionSignals = await this.detectProtection(protectedTransaction);

      // Analyze slippage impact
      const slippageAnalysis = await this.analyzeSlippageImpact(
        protectedTransaction,
        targetToken,
        backrunSize
      );

      // Create backrun opportunity
      const opportunity = await this.createBackrunOpportunity(
        protectedTransaction,
        targetToken,
        backrunSize,
        protectionSignals,
        slippageAnalysis
      );

      // Validate opportunity
      const validation = await this.validateBackrunOpportunity(opportunity);

      this.emit('backrunAssessed', {
        opportunity,
        validation,
        timestamp: Date.now(),
      });

      return validation;
    } catch (error) {
      this.logger.error('Backrun safety assessment failed', {
        protectedTransaction,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Check specific protection service
   */
  private async checkProtectionService(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    try {
      switch (service.type) {
        case 'flashbots-protect':
          return await this.checkFlashbotsProtect(transaction, service);

        case 'cow-protocol':
          return await this.checkCowProtocol(transaction, service);

        case 'eden-network':
          return await this.checkEdenNetwork(transaction, service);

        case 'mistx':
          return await this.checkMistX(transaction, service);

        case 'taichi':
          return await this.checkTaichi(transaction, service);

        default:
          this.logger.warn('Unknown protection service type', { type: service.type });
          return null;
      }
    } catch (error) {
      this.logger.error('Protection service check failed', {
        service: service.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check Flashbots Protect
   */
  private async checkFlashbotsProtect(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    // Check if transaction uses Flashbots Protect patterns
    const isProtected = this.isFlashbotsProtected(transaction);

    if (!isProtected) return null;

    return {
      transactionHash: transaction.hash,
      service,
      protectionType: 'mev-protection',
      confidence: service.confidenceScore,
      userConsent: true, // Flashbots Protect implies user consent
      protectionLevel: 'advanced',
      detectedAt: Date.now(),
      expiresAt: Date.now() + this.config.protectionSignalCacheMs,
      metadata: {
        method: 'transaction-analysis',
        gasPrice: transaction.gasPrice?.toString(),
        to: transaction.to,
      },
    };
  }

  /**
   * Check CoW Protocol protection
   */
  private async checkCowProtocol(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    // Check if transaction is a CoW Protocol settlement
    const isCowProtected = this.isCowProtocolTransaction(transaction);

    if (!isCowProtected) return null;

    return {
      transactionHash: transaction.hash,
      service,
      protectionType: 'private-mempool',
      confidence: service.confidenceScore,
      userConsent: true, // CoW Protocol implies user consent
      protectionLevel: 'premium',
      detectedAt: Date.now(),
      expiresAt: Date.now() + this.config.protectionSignalCacheMs,
      metadata: {
        method: 'contract-analysis',
        settlement: true,
      },
    };
  }

  /**
   * Check Eden Network protection
   */
  private async checkEdenNetwork(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    // Check Eden Network patterns
    const isEdenProtected = this.isEdenNetworkTransaction(transaction);

    if (!isEdenProtected) return null;

    return {
      transactionHash: transaction.hash,
      service,
      protectionType: 'mev-protection',
      confidence: service.confidenceScore,
      userConsent: true,
      protectionLevel: 'basic',
      detectedAt: Date.now(),
      expiresAt: Date.now() + this.config.protectionSignalCacheMs,
      metadata: {
        method: 'relay-detection',
      },
    };
  }

  /**
   * Check mistX protection
   */
  private async checkMistX(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    // Check mistX patterns
    const isMistXProtected = this.isMistXTransaction(transaction);

    if (!isMistXProtected) return null;

    return {
      transactionHash: transaction.hash,
      service,
      protectionType: 'private-mempool',
      confidence: service.confidenceScore,
      userConsent: true,
      protectionLevel: 'advanced',
      detectedAt: Date.now(),
      expiresAt: Date.now() + this.config.protectionSignalCacheMs,
      metadata: {
        method: 'mempool-monitoring',
      },
    };
  }

  /**
   * Check Taichi Network protection
   */
  private async checkTaichi(
    transaction: ethers.TransactionResponse,
    service: ProtectionService
  ): Promise<ProtectionSignal | null> {
    // Check Taichi patterns
    const isTaichiProtected = this.isTaichiTransaction(transaction);

    if (!isTaichiProtected) return null;

    return {
      transactionHash: transaction.hash,
      service,
      protectionType: 'delayed-reveal',
      confidence: service.confidenceScore,
      userConsent: true,
      protectionLevel: 'premium',
      detectedAt: Date.now(),
      expiresAt: Date.now() + this.config.protectionSignalCacheMs,
      metadata: {
        method: 'commit-reveal-analysis',
      },
    };
  }

  /**
   * Analyze slippage impact from protected transaction
   */
  private async analyzeSlippageImpact(
    transactionHash: string,
    targetToken: Address,
    backrunSize: bigint
  ): Promise<SlippageAnalysis> {
    try {
      // Get transaction receipt for analysis
      const receipt = await this.provider.getTransactionReceipt(transactionHash);
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      // Analyze transaction logs for DEX interactions
      const dexInteractions = this.analyzeDEXInteractions(receipt.logs);

      // Find relevant pool for target token
      const relevantPool = this.findRelevantPool(dexInteractions, targetToken);

      if (!relevantPool) {
        throw new Error('No relevant pool found for target token');
      }

      // Calculate slippage metrics
      const priceImpact = this.calculatePriceImpact(relevantPool, backrunSize);
      const slippageEstimate = this.estimateSlippage(relevantPool, backrunSize);
      const liquidityDepth = this.getLiquidityDepth(relevantPool);
      const volumeImpact = this.calculateVolumeImpact(relevantPool, backrunSize);
      const recoveryTime = this.estimateRecoveryTime(priceImpact);
      const backrunWindow = this.calculateBackrunWindow(recoveryTime);

      return {
        transaction: transactionHash,
        token: targetToken,
        pool: relevantPool.address,
        priceImpact,
        slippageEstimate,
        liquidityDepth,
        volumeImpact,
        recoveryTime,
        backrunWindow,
      };
    } catch (error) {
      this.logger.error('Slippage analysis failed', {
        transactionHash,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative estimates
      return {
        transaction: transactionHash,
        token: targetToken,
        pool: '0x0000000000000000000000000000000000000000' as Address,
        priceImpact: 0.05, // 5% conservative estimate
        slippageEstimate: 0.03, // 3% conservative estimate
        liquidityDepth: 1000000n, // 1M conservative estimate
        volumeImpact: 0.02, // 2% conservative estimate
        recoveryTime: 30000, // 30 seconds
        backrunWindow: 15000, // 15 seconds
      };
    }
  }

  /**
   * Create backrun opportunity assessment
   */
  private async createBackrunOpportunity(
    protectedTransaction: string,
    targetToken: Address,
    backrunSize: bigint,
    protectionSignals: ProtectionSignal[],
    slippageAnalysis: SlippageAnalysis
  ): Promise<BackrunOpportunity> {
    const opportunityId = this.generateOpportunityId();

    // Calculate safety and ethical scores
    const safetyScore = this.calculateSafetyScore(slippageAnalysis, protectionSignals);
    const ethicalScore = this.calculateEthicalScore(protectionSignals, backrunSize);

    // Estimate profit (simplified)
    const estimatedProfit = this.estimateBackrunProfit(slippageAnalysis, backrunSize);

    // Calculate optimal timing
    const timing = this.calculateOptimalTiming(slippageAnalysis);

    // Identify risks
    const risks = this.identifyRisks(protectionSignals, slippageAnalysis);

    // Perform compliance checks
    const complianceChecks = this.performComplianceChecks(protectionSignals, backrunSize);

    return {
      id: opportunityId,
      protectedTransaction,
      targetToken,
      estimatedSlippage: slippageAnalysis.slippageEstimate,
      slippageImpact: slippageAnalysis.priceImpact,
      backrunSize,
      estimatedProfit,
      safetyScore,
      ethicalScore,
      timing,
      risks,
      complianceChecks,
      createdAt: Date.now(),
    };
  }

  /**
   * Validate backrun opportunity
   */
  private async validateBackrunOpportunity(
    opportunity: BackrunOpportunity
  ): Promise<BackrunValidationResult> {
    const rejectionReasons: string[] = [];

    // Check safety threshold
    if (opportunity.safetyScore < this.config.backrunSafetyThreshold) {
      rejectionReasons.push(
        `Safety score ${opportunity.safetyScore} below threshold ${this.config.backrunSafetyThreshold}`
      );
    }

    // Check slippage impact
    if (opportunity.slippageImpact > this.config.maxSlippageImpact) {
      rejectionReasons.push(
        `Slippage impact ${opportunity.slippageImpact} exceeds maximum ${this.config.maxSlippageImpact}`
      );
    }

    // Check ethical guidelines
    if (this.config.enableEthicalGuidelines && opportunity.ethicalScore < 0.8) {
      rejectionReasons.push(`Ethical score ${opportunity.ethicalScore} below required 0.8`);
    }

    // Check compliance
    if (!opportunity.complianceChecks.userConsent && this.config.consentVerificationRequired) {
      rejectionReasons.push('User consent not verified');
    }

    if (!opportunity.complianceChecks.protectionRespected) {
      rejectionReasons.push('Protection signals not properly respected');
    }

    // Check size limits
    if (opportunity.backrunSize > this.config.maxBackrunSize) {
      rejectionReasons.push(
        `Backrun size ${opportunity.backrunSize} exceeds maximum ${this.config.maxBackrunSize}`
      );
    }

    // Apply custom compliance rules
    for (const [ruleName, ruleFunction] of this.complianceRules) {
      if (!ruleFunction(opportunity)) {
        rejectionReasons.push(`Failed compliance rule: ${ruleName}`);
      }
    }

    const approved = rejectionReasons.length === 0;

    // Calculate detailed safety assessment
    const safetyAssessment = {
      overallScore: opportunity.safetyScore,
      technicalSafety: Math.min(
        1.0,
        1.0 - opportunity.slippageImpact / this.config.maxSlippageImpact
      ),
      ethicalCompliance: opportunity.ethicalScore,
      legalCompliance: opportunity.complianceChecks.legalCompliance ? 1.0 : 0.0,
      userProtection: opportunity.complianceChecks.userConsent ? 1.0 : 0.0,
    };

    // Generate recommendations
    const recommendations = this.generateRecommendations(opportunity, rejectionReasons);

    return {
      opportunity,
      approved,
      rejectionReasons,
      safetyAssessment,
      recommendations,
      validatedAt: Date.now(),
    };
  }

  /**
   * Transaction pattern detection methods
   */
  private isFlashbotsProtected(transaction: ethers.TransactionResponse): boolean {
    // Check for Flashbots Protect patterns
    // This is a simplified implementation - real detection would be more sophisticated
    return (
      (transaction.to !== null &&
        this.protectionServices
          .get('flashbots-protect')
          ?.contractAddresses.includes(transaction.to as Address)) ||
      false
    );
  }

  private isCowProtocolTransaction(transaction: ethers.TransactionResponse): boolean {
    // Check for CoW Protocol settlement patterns
    return (
      (transaction.to !== null &&
        this.protectionServices
          .get('cow-protocol')
          ?.contractAddresses.includes(transaction.to as Address)) ||
      false
    );
  }

  private isEdenNetworkTransaction(transaction: ethers.TransactionResponse): boolean {
    // Check for Eden Network patterns
    return (
      (transaction.to !== null &&
        this.protectionServices
          .get('eden-network')
          ?.contractAddresses.includes(transaction.to as Address)) ||
      false
    );
  }

  private isMistXTransaction(transaction: ethers.TransactionResponse): boolean {
    // Check for mistX patterns
    return (
      (transaction.to !== null &&
        this.protectionServices
          .get('mistx')
          ?.contractAddresses.includes(transaction.to as Address)) ||
      false
    );
  }

  private isTaichiTransaction(transaction: ethers.TransactionResponse): boolean {
    // Check for Taichi patterns
    return (
      (transaction.to !== null &&
        this.protectionServices
          .get('taichi')
          ?.contractAddresses.includes(transaction.to as Address)) ||
      false
    );
  }

  /**
   * Analysis helper methods
   */
  private analyzeDEXInteractions(
    logs: readonly ethers.Log[]
  ): Array<{ address: Address; topics: readonly string[] }> {
    return logs.map(log => ({
      address: log.address as Address,
      topics: log.topics,
    }));
  }

  private findRelevantPool(
    interactions: Array<{ address: Address; topics: readonly string[] }>,
    _targetToken: Address
  ): { address: Address } | null {
    // Simplified pool finding - would be more sophisticated in production
    return interactions.length > 0 ? { address: interactions[0]!.address } : null;
  }

  private calculatePriceImpact(_pool: { address: Address }, _backrunSize: bigint): number {
    // Simplified price impact calculation
    return 0.02; // 2% default
  }

  private estimateSlippage(_pool: { address: Address }, _backrunSize: bigint): number {
    // Simplified slippage estimation
    return 0.015; // 1.5% default
  }

  private getLiquidityDepth(_pool: { address: Address }): bigint {
    // Simplified liquidity depth
    return ethers.parseEther('1000000'); // 1M ETH
  }

  private calculateVolumeImpact(_pool: { address: Address }, _backrunSize: bigint): number {
    // Simplified volume impact
    return 0.01; // 1% default
  }

  private estimateRecoveryTime(priceImpact: number): number {
    // Recovery time based on price impact
    return Math.max(5000, priceImpact * 100000); // 5-50 seconds
  }

  private calculateBackrunWindow(recoveryTime: number): number {
    // Backrun window is typically half the recovery time
    return recoveryTime / 2;
  }

  private calculateSafetyScore(
    slippageAnalysis: SlippageAnalysis,
    protectionSignals: ProtectionSignal[]
  ): number {
    let score = 1.0;

    // Reduce score based on slippage impact
    score -= slippageAnalysis.priceImpact * 2;

    // Reduce score based on protection strength
    // Determine maximum protection level with empty-array guard
    const levels = protectionSignals.map(s =>
      s.protectionLevel === 'premium' ? 0.9 : s.protectionLevel === 'advanced' ? 0.7 : 0.5
    );
    const maxProtectionLevel = levels.length > 0 ? Math.max(...levels) : 0;
    score -= maxProtectionLevel * 0.3;

    return Math.max(0, Math.min(1, score));
  }

  private calculateEthicalScore(
    protectionSignals: ProtectionSignal[],
    backrunSize: bigint
  ): number {
    let score = 1.0;

    // Check if user explicitly opted for protection
    const hasExplicitConsent = protectionSignals.some(s => s.userConsent);
    if (!hasExplicitConsent) {
      score -= 0.5;
    }

    // Reduce score for large backruns
    const sizeRatio = Number(backrunSize) / Number(this.config.maxBackrunSize);
    score -= sizeRatio * 0.3;

    return Math.max(0, Math.min(1, score));
  }

  private estimateBackrunProfit(slippageAnalysis: SlippageAnalysis, backrunSize: bigint): bigint {
    // Simplified profit estimation
    const profitRate = slippageAnalysis.priceImpact * 0.5; // Capture 50% of price impact
    return BigInt(Math.floor(Number(backrunSize) * profitRate));
  }

  private calculateOptimalTiming(slippageAnalysis: SlippageAnalysis): {
    optimalDelay: number;
    maxDelay: number;
    blockTarget: number;
  } {
    return {
      optimalDelay: 1000, // 1 second
      maxDelay: slippageAnalysis.backrunWindow,
      blockTarget: 1, // Next block
    };
  }

  private identifyRisks(
    protectionSignals: ProtectionSignal[],
    slippageAnalysis: SlippageAnalysis
  ): string[] {
    const risks: string[] = [];

    if (slippageAnalysis.priceImpact > 0.03) {
      risks.push('High price impact detected');
    }

    if (protectionSignals.length > 0) {
      risks.push('MEV protection detected - ethical concerns');
    }

    if (slippageAnalysis.recoveryTime > 30000) {
      risks.push('Long recovery time - increased competition risk');
    }

    return risks;
  }

  private performComplianceChecks(
    protectionSignals: ProtectionSignal[],
    backrunSize: bigint
  ): {
    userConsent: boolean;
    protectionRespected: boolean;
    ethicalGuidelines: boolean;
    legalCompliance: boolean;
  } {
    const userConsent = protectionSignals.some(s => s.userConsent);
    const protectionRespected =
      protectionSignals.length === 0 ||
      protectionSignals.every(s => s.confidence < this.config.minProtectionSignalConfidence);
    const ethicalGuidelines = this.config.enableEthicalGuidelines
      ? backrunSize <= this.config.maxBackrunSize
      : true;
    const legalCompliance = true; // Simplified - would check actual legal requirements

    return {
      userConsent,
      protectionRespected,
      ethicalGuidelines,
      legalCompliance,
    };
  }

  private generateRecommendations(
    opportunity: BackrunOpportunity,
    rejectionReasons: string[]
  ): string[] {
    const recommendations: string[] = [];

    if (rejectionReasons.length === 0) {
      recommendations.push('Opportunity approved for execution');
      recommendations.push(`Execute within ${opportunity.timing.maxDelay}ms for optimal results`);
    } else {
      recommendations.push('Opportunity rejected due to safety/ethical concerns');

      if (opportunity.slippageImpact > this.config.maxSlippageImpact) {
        recommendations.push('Consider reducing backrun size to minimize slippage impact');
      }

      if (opportunity.safetyScore < this.config.backrunSafetyThreshold) {
        recommendations.push('Wait for better market conditions or different opportunity');
      }
    }

    return recommendations;
  }

  /**
   * Initialize protection services
   */
  private initializeProtectionServices(): void {
    // Flashbots Protect
    this.protectionServices.set('flashbots-protect', {
      name: 'Flashbots Protect',
      type: 'flashbots-protect',
      enabled: true,
      detectionMethod: 'transaction-analysis',
      confidenceScore: 0.95,
      contractAddresses: [
        '0x6C280dB098dB673d30d5B34eC04B6387185D3620' as Address, // Flashbots Protect
      ],
    });

    // CoW Protocol
    this.protectionServices.set('cow-protocol', {
      name: 'CoW Protocol',
      type: 'cow-protocol',
      enabled: true,
      detectionMethod: 'transaction-analysis',
      confidenceScore: 0.98,
      contractAddresses: [
        '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as Address, // CoW Settlement
      ],
    });

    // Eden Network
    this.protectionServices.set('eden-network', {
      name: 'Eden Network',
      type: 'eden-network',
      enabled: true,
      detectionMethod: 'relay-detection',
      confidenceScore: 0.85,
      contractAddresses: [],
    });

    // mistX
    this.protectionServices.set('mistx', {
      name: 'mistX',
      type: 'mistx',
      enabled: true,
      detectionMethod: 'mempool-monitoring',
      confidenceScore: 0.9,
      contractAddresses: [],
    });

    // Taichi Network
    this.protectionServices.set('taichi', {
      name: 'Taichi Network',
      type: 'taichi',
      enabled: true,
      detectionMethod: 'transaction-analysis',
      confidenceScore: 0.92,
      contractAddresses: [],
    });

    this.logger.info('Protection services initialized', {
      serviceCount: this.protectionServices.size,
    });
  }

  /**
   * Initialize ethical guidelines
   */
  private initializeEthicalGuidelines(): void {
    this.ethicalGuidelines.add('Respect user protection preferences');
    this.ethicalGuidelines.add('Only backrun transactions with explicit consent');
    this.ethicalGuidelines.add('Minimize negative impact on protected users');
    this.ethicalGuidelines.add('Maintain transparency in MEV extraction');
    this.ethicalGuidelines.add('Contribute to ecosystem health and fairness');

    this.logger.info('Ethical guidelines initialized', {
      guidelineCount: this.ethicalGuidelines.size,
    });
  }

  /**
   * Initialize compliance rules
   */
  private initializeComplianceRules(): void {
    // Rule: Respect protection signals
    this.complianceRules.set('respect-protection', opportunity => {
      return opportunity.complianceChecks.protectionRespected;
    });

    // Rule: Verify user consent
    this.complianceRules.set('verify-consent', opportunity => {
      return !this.config.consentVerificationRequired || opportunity.complianceChecks.userConsent;
    });

    // Rule: Size limits
    this.complianceRules.set('size-limits', opportunity => {
      return opportunity.backrunSize <= this.config.maxBackrunSize;
    });

    // Rule: Safety threshold
    this.complianceRules.set('safety-threshold', opportunity => {
      return opportunity.safetyScore >= this.config.backrunSafetyThreshold;
    });

    this.logger.info('Compliance rules initialized', {
      ruleCount: this.complianceRules.size,
    });
  }

  /**
   * Start protection monitoring
   */
  private startProtectionMonitoring(): void {
    // Clean up expired signals periodically
    setInterval(() => {
      this.cleanupExpiredSignals();
    }, this.config.protectionSignalCacheMs / 4);

    this.logger.info('Protection monitoring started');
  }

  /**
   * Clean up expired protection signals
   */
  private cleanupExpiredSignals(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [txHash, signal] of this.protectionSignals) {
      if (signal.expiresAt < now) {
        this.protectionSignals.delete(txHash);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Cleaned up expired protection signals', { cleanedCount });
    }
  }

  /**
   * Generate unique opportunity ID
   */
  private generateOpportunityId(): string {
    return `backrun_${Date.now()}_${++this.opportunityCounter}`;
  }

  /**
   * Get detector statistics
   */
  getDetectorStats(): {
    protectionServices: number;
    activeSignals: number;
    activeOpportunities: number;
    ethicalGuidelines: number;
    complianceRules: number;
  } {
    return {
      protectionServices: this.protectionServices.size,
      activeSignals: this.protectionSignals.size,
      activeOpportunities: this.activeOpportunities.size,
      ethicalGuidelines: this.ethicalGuidelines.size,
      complianceRules: this.complianceRules.size,
    };
  }

  /**
   * Stop detector
   */
  stop(): void {
    this.protectionSignals.clear();
    this.activeOpportunities.clear();
    this.logger.info('MEV protection detector stopped');
  }
}
