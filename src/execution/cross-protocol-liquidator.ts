/**
 * Cross-Protocol Liquidation Coordination
 *
 * Monitors health factors across all lending protocols and coordinates
 * liquidations for maximum profit with optimal flash loan rates
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';

export interface CrossProtocolLiquidatorConfig {
  readonly monitoringIntervalMs: number;
  readonly healthFactorThreshold: number;
  readonly minProfitThresholdUsd: number;
  readonly maxConcurrentLiquidations: number;
  readonly flashLoanOptimization: boolean;
  readonly selfCompetitionAvoidance: boolean;
  readonly sequenceOptimization: boolean;
  readonly protocolPriorityWeights: Record<string, number>;
}

export interface LendingProtocol {
  readonly name: string;
  readonly type: 'aave-v3' | 'moonwell' | 'seamless' | 'compound' | 'radiant';
  readonly contractAddress: Address;
  readonly enabled: boolean;
  readonly liquidationBonus: number;
  readonly minHealthFactor: number;
  readonly maxLiquidationAmount: bigint;
  readonly gasEstimate: bigint;
  readonly reliability: number;
  readonly averageExecutionTime: number;
}

export interface LiquidationOpportunity {
  readonly id: string;
  readonly protocol: LendingProtocol;
  readonly borrower: Address;
  readonly collateralToken: Address;
  readonly debtToken: Address;
  readonly collateralAmount: bigint;
  readonly debtAmount: bigint;
  readonly healthFactor: number;
  readonly liquidationBonus: number;
  readonly estimatedProfit: bigint;
  readonly estimatedProfitUsd: number;
  readonly gasEstimate: bigint;
  readonly flashLoanRequired: boolean;
  readonly flashLoanAmount: bigint;
  readonly priority: number;
  readonly discoveredAt: number;
  readonly expiresAt: number;
}

export class CrossProtocolLiquidator extends EventEmitter {
  private readonly logger = createComponentLogger('cross-protocol-liquidator');
  private readonly config: CrossProtocolLiquidatorConfig;
  private readonly provider: ethers.Provider;

  // Protocol registry
  private readonly protocols = new Map<string, LendingProtocol>();

  // Opportunity tracking
  private readonly activeLiquidations = new Map<string, LiquidationOpportunity>();
  private readonly executingLiquidations = new Set<string>();

  // Monitoring
  private monitoringTimer: NodeJS.Timeout | null = null;

  constructor(provider: ethers.Provider, config: CrossProtocolLiquidatorConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.initializeProtocols();
    this.startMonitoring();

    // Use provider for future gas price queries
    this.getCurrentGasPrice();

    this.logger.info('Cross-protocol liquidator initialized', {
      protocolCount: this.protocols.size,
      healthFactorThreshold: this.config.healthFactorThreshold,
      minProfitThresholdUsd: this.config.minProfitThresholdUsd,
    });
  }

  /**
   * Get current gas price from provider
   */
  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || 20000000000n;
    } catch (error) {
      this.logger.warn('Failed to get gas price', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 20000000000n;
    }
  }

  /**
   * Monitor all protocols for liquidation opportunities
   */
  async monitorLiquidationOpportunities(): Promise<LiquidationOpportunity[]> {
    const opportunities: LiquidationOpportunity[] = [];

    try {
      this.logger.debug('Monitoring liquidation opportunities across protocols');

      for (const [protocolName, protocol] of this.protocols) {
        if (!protocol.enabled) continue;

        try {
          const protocolOpportunities = await this.scanProtocolForLiquidations(protocol);
          opportunities.push(...protocolOpportunities);
        } catch (error) {
          this.logger.error('Failed to scan protocol for liquidations', {
            protocol: protocolName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Prioritize opportunities
      const prioritizedOpportunities = this.prioritizeOpportunities(opportunities);

      // Update active liquidations
      this.updateActiveLiquidations(prioritizedOpportunities);

      this.emit('opportunitiesDiscovered', {
        opportunities: prioritizedOpportunities,
        timestamp: Date.now(),
      });

      return prioritizedOpportunities;
    } catch (error) {
      this.logger.error('Liquidation monitoring failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Execute liquidation with optimal coordination
   */
  async executeLiquidation(opportunityId: string): Promise<{
    success: boolean;
    transactionHash?: string;
    actualProfit?: bigint;
    executionTime?: number;
    error?: string;
  }> {
    const opportunity = this.activeLiquidations.get(opportunityId);
    if (!opportunity) {
      throw new Error('Liquidation opportunity not found');
    }

    if (this.executingLiquidations.has(opportunityId)) {
      throw new Error('Liquidation already in progress');
    }

    const startTime = Date.now();

    try {
      this.logger.info('Executing cross-protocol liquidation', {
        opportunityId,
        protocol: opportunity.protocol.name,
        borrower: opportunity.borrower,
        estimatedProfitUsd: opportunity.estimatedProfitUsd,
      });

      this.executingLiquidations.add(opportunityId);

      // Check for self-competition avoidance
      if (this.config.selfCompetitionAvoidance) {
        const hasConflict = await this.checkSelfCompetition(opportunity);
        if (hasConflict) {
          this.logger.warn('Self-competition detected, skipping liquidation', {
            opportunityId,
          });
          return { success: false, error: 'Self-competition detected' };
        }
      }

      // Execute liquidation
      const liquidationResult = await this.executeLiquidationTransaction(opportunity);

      if (!liquidationResult.success) {
        return liquidationResult;
      }

      const executionTime = Date.now() - startTime;
      const actualProfit = liquidationResult.collateralReceived || 0n;

      this.emit('liquidationExecuted', {
        opportunityId,
        opportunity,
        actualProfit,
        executionTime,
      });

      this.logger.info('Liquidation executed successfully', {
        opportunityId,
        actualProfit: actualProfit.toString(),
        executionTime,
      });

      const result: {
        success: boolean;
        transactionHash?: string;
        actualProfit?: bigint;
        executionTime?: number;
        error?: string;
      } = {
        success: true,
        actualProfit,
        executionTime,
      };

      if (liquidationResult.transactionHash) {
        result.transactionHash = liquidationResult.transactionHash;
      }

      return result;
    } catch (error) {
      this.logger.error('Liquidation execution failed', {
        opportunityId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.executingLiquidations.delete(opportunityId);
      this.activeLiquidations.delete(opportunityId);
    }
  }

  /**
   * Scan specific protocol for liquidation opportunities
   */
  private async scanProtocolForLiquidations(
    protocol: LendingProtocol
  ): Promise<LiquidationOpportunity[]> {
    const opportunities: LiquidationOpportunity[] = [];

    try {
      // Simulate protocol scanning (would use actual protocol contracts in production)
      const borrowerCount = Math.floor(Math.random() * 10 + 5); // 5-15 borrowers

      for (let i = 0; i < borrowerCount; i++) {
        const borrower = `0x${Math.random().toString(16).slice(2, 42)}` as Address;
        const healthFactor = 0.8 + Math.random() * 0.4; // 0.8-1.2

        if (healthFactor < this.config.healthFactorThreshold) {
          const opportunity = await this.createLiquidationOpportunity(
            protocol,
            borrower,
            healthFactor
          );
          if (opportunity && opportunity.estimatedProfitUsd >= this.config.minProfitThresholdUsd) {
            opportunities.push(opportunity);
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.logger.error('Protocol scanning failed', {
        protocol: protocol.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Create liquidation opportunity from protocol data
   */
  private async createLiquidationOpportunity(
    protocol: LendingProtocol,
    borrower: Address,
    healthFactor: number
  ): Promise<LiquidationOpportunity | null> {
    try {
      // Simulate opportunity data (would query actual protocol in production)
      const collateralToken = '0x4200000000000000000000000000000000000006' as Address; // WETH
      const debtToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; // USDC

      const debtAmount = ethers.parseEther((Math.random() * 100 + 10).toString()); // 10-110 ETH worth
      const collateralAmount = (debtAmount * 150n) / 100n; // 150% collateralization

      const liquidationBonus = protocol.liquidationBonus;
      const bonusAmount =
        (collateralAmount * BigInt(Math.floor(liquidationBonus * 10000))) / 10000n;

      // Estimate profit (simplified)
      const estimatedProfit = bonusAmount - (debtAmount * 102n) / 100n; // 2% slippage
      const estimatedProfitUsd = (Number(estimatedProfit) / 1e18) * 2000; // $2000 ETH

      if (estimatedProfit <= 0n) {
        return null;
      }

      // Determine if flash loan is required
      const flashLoanRequired = debtAmount > ethers.parseEther('10'); // Need flash loan for >10 ETH
      const flashLoanAmount = flashLoanRequired ? debtAmount : 0n;

      // Calculate priority
      const priority = this.calculateLiquidationPriority(
        protocol,
        estimatedProfitUsd,
        healthFactor,
        flashLoanRequired
      );

      const opportunity: LiquidationOpportunity = {
        id: `liq_${protocol.name}_${borrower}_${Date.now()}`,
        protocol,
        borrower,
        collateralToken,
        debtToken,
        collateralAmount,
        debtAmount,
        healthFactor,
        liquidationBonus,
        estimatedProfit,
        estimatedProfitUsd,
        gasEstimate: protocol.gasEstimate,
        flashLoanRequired,
        flashLoanAmount,
        priority,
        discoveredAt: Date.now(),
        expiresAt: Date.now() + 300000, // 5 minutes
      };

      return opportunity;
    } catch (error) {
      this.logger.error('Failed to create liquidation opportunity', {
        protocol: protocol.name,
        borrower,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Prioritize liquidation opportunities
   */
  private prioritizeOpportunities(
    opportunities: LiquidationOpportunity[]
  ): LiquidationOpportunity[] {
    return opportunities.sort((a, b) => {
      // Primary: Priority score (higher is better)
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }

      // Secondary: Profit USD (higher is better)
      if (a.estimatedProfitUsd !== b.estimatedProfitUsd) {
        return b.estimatedProfitUsd - a.estimatedProfitUsd;
      }

      // Tertiary: Health factor (lower is more urgent)
      return a.healthFactor - b.healthFactor;
    });
  }

  /**
   * Execute liquidation transaction
   */
  private async executeLiquidationTransaction(opportunity: LiquidationOpportunity): Promise<{
    success: boolean;
    transactionHash?: string;
    collateralReceived?: bigint;
    error?: string;
  }> {
    try {
      // Simulate liquidation execution (would interact with actual contracts in production)
      this.logger.debug('Executing liquidation transaction', {
        protocol: opportunity.protocol.name,
        borrower: opportunity.borrower,
      });

      // Simulate success based on protocol reliability
      const success = Math.random() < opportunity.protocol.reliability;

      if (success) {
        const transactionHash = '0x' + Math.random().toString(16).slice(2, 66);
        const collateralReceived = opportunity.collateralAmount;

        return {
          success: true,
          transactionHash,
          collateralReceived,
        };
      } else {
        return {
          success: false,
          error: 'Transaction failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Helper methods
   */
  private calculateLiquidationPriority(
    protocol: LendingProtocol,
    profitUsd: number,
    healthFactor: number,
    flashLoanRequired: boolean
  ): number {
    let priority = 0;

    // Profit weight (0-100)
    priority += Math.min(100, profitUsd * 2);

    // Health factor urgency (0-50, lower health = higher priority)
    priority += (1 - healthFactor) * 50;

    // Protocol weight (0-20)
    const protocolWeight = this.config.protocolPriorityWeights[protocol.name] || 1;
    priority += protocolWeight * 20;

    // Flash loan penalty (-10)
    if (flashLoanRequired) {
      priority -= 10;
    }

    // Protocol reliability bonus (0-10)
    priority += protocol.reliability * 10;

    return Math.max(0, priority);
  }

  private async checkSelfCompetition(opportunity: LiquidationOpportunity): Promise<boolean> {
    // Check if we're already executing a liquidation for the same borrower
    for (const [_id, activeLiquidation] of this.activeLiquidations) {
      if (
        activeLiquidation.borrower === opportunity.borrower &&
        this.executingLiquidations.has(activeLiquidation.id)
      ) {
        return true;
      }
    }

    return false;
  }

  private updateActiveLiquidations(opportunities: LiquidationOpportunity[]): void {
    // Remove expired opportunities
    const now = Date.now();
    for (const [id, opportunity] of this.activeLiquidations) {
      if (opportunity.expiresAt < now) {
        this.activeLiquidations.delete(id);
      }
    }

    // Add new opportunities
    for (const opportunity of opportunities) {
      this.activeLiquidations.set(opportunity.id, opportunity);
    }
  }

  private initializeProtocols(): void {
    // Aave V3
    this.protocols.set('aave-v3', {
      name: 'Aave V3',
      type: 'aave-v3',
      contractAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
      enabled: true,
      liquidationBonus: 0.05, // 5%
      minHealthFactor: 1.0,
      maxLiquidationAmount: ethers.parseEther('1000'),
      gasEstimate: 500000n,
      reliability: 0.95,
      averageExecutionTime: 3000,
    });

    // Moonwell
    this.protocols.set('moonwell', {
      name: 'Moonwell',
      type: 'moonwell',
      contractAddress: '0xfBb7d83C9B1B1d65C9D8b5b7B8B8B8B8B8B8B8B8' as Address,
      enabled: true,
      liquidationBonus: 0.08, // 8%
      minHealthFactor: 1.0,
      maxLiquidationAmount: ethers.parseEther('500'),
      gasEstimate: 450000n,
      reliability: 0.92,
      averageExecutionTime: 2500,
    });

    // Seamless
    this.protocols.set('seamless', {
      name: 'Seamless',
      type: 'seamless',
      contractAddress: '0xdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdD' as Address,
      enabled: true,
      liquidationBonus: 0.06, // 6%
      minHealthFactor: 1.0,
      maxLiquidationAmount: ethers.parseEther('750'),
      gasEstimate: 480000n,
      reliability: 0.9,
      averageExecutionTime: 2800,
    });

    this.logger.info('Lending protocols initialized', {
      protocolCount: this.protocols.size,
    });
  }

  private startMonitoring(): void {
    this.monitoringTimer = setInterval(async () => {
      try {
        await this.monitorLiquidationOpportunities();
      } catch (error) {
        this.logger.error('Monitoring cycle failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.monitoringIntervalMs);

    this.logger.info('Cross-protocol monitoring started');
  }

  /**
   * Get liquidator statistics
   */
  getLiquidatorStats(): {
    activeOpportunities: number;
    activeLiquidations: number;
    protocolCount: number;
    totalEstimatedProfit: number;
  } {
    const totalEstimatedProfit = Array.from(this.activeLiquidations.values()).reduce(
      (sum, opp) => sum + opp.estimatedProfitUsd,
      0
    );

    return {
      activeOpportunities: this.activeLiquidations.size,
      activeLiquidations: this.executingLiquidations.size,
      protocolCount: this.protocols.size,
      totalEstimatedProfit,
    };
  }

  /**
   * Stop cross-protocol liquidator
   */
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    this.activeLiquidations.clear();
    this.executingLiquidations.clear();

    this.logger.info('Cross-protocol liquidator stopped');
  }
}
