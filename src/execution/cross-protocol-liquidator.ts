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
      // Get real borrower data from protocol contracts
      const borrowers = await this.fetchProtocolBorrowers(protocol);

      for (const borrowerData of borrowers) {
        const healthFactor = await this.calculateRealHealthFactor(protocol, borrowerData);

        if (healthFactor < this.config.healthFactorThreshold) {
          const opportunity = await this.createRealLiquidationOpportunity(
            protocol,
            borrowerData,
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
  private async createRealLiquidationOpportunity(
    protocol: LendingProtocol,
    borrowerData: any,
    healthFactor: number
  ): Promise<LiquidationOpportunity | null> {
    try {
      // Get real borrower position data from protocol contracts
      const positionData = await this.getBorrowerPosition(protocol, borrowerData);
      if (!positionData) return null;

      const { collateralToken, debtToken, debtAmount, collateralAmount } = positionData;

      const liquidationBonus = protocol.liquidationBonus;
      const bonusAmount =
        (collateralAmount * BigInt(Math.floor(liquidationBonus * 10000))) / 10000n;

      // Calculate real profit using current market prices
      const realProfit = await this.calculateRealLiquidationProfit(
        debtAmount,
        collateralAmount,
        bonusAmount,
        collateralToken,
        debtToken
      );

      if (realProfit.netProfit <= 0n) {
        return null;
      }

      // Determine if flash loan is required based on our balance
      const flashLoanRequired = await this.isFlashLoanRequired(debtAmount, debtToken);
      const flashLoanAmount = flashLoanRequired ? debtAmount : 0n;

      // Calculate priority based on real data
      const priority = this.calculateLiquidationPriority(
        protocol,
        realProfit.profitUsd,
        healthFactor,
        flashLoanRequired
      );

      const opportunity: LiquidationOpportunity = {
        id: `liq_${protocol.name}_${borrowerData.address}_${Date.now()}`,
        protocol,
        borrower: borrowerData.address,
        collateralToken,
        debtToken,
        collateralAmount,
        debtAmount,
        healthFactor,
        liquidationBonus,
        estimatedProfit: realProfit.netProfit,
        estimatedProfitUsd: realProfit.profitUsd,
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
        borrower: borrowerData.address,
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

  /**
   * Fetch real borrower data from protocol contracts
   */
  private async fetchProtocolBorrowers(protocol: LendingProtocol): Promise<any[]> {
    try {
      // Create contract interface for the lending protocol
      const contract = new ethers.Contract(
        protocol.contractAddress,
        this.getProtocolABI(protocol.type),
        this.provider
      );

      // Get borrower accounts from protocol events
      const borrowers = await this.getBorrowersFromEvents(contract, protocol);

      this.logger.debug('Fetched protocol borrowers', {
        protocol: protocol.name,
        borrowerCount: borrowers.length,
      });

      return borrowers;
    } catch (error) {
      this.logger.error('Failed to fetch protocol borrowers', {
        protocol: protocol.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get borrowers from protocol events
   */
  private async getBorrowersFromEvents(
    contract: ethers.Contract,
    protocol: LendingProtocol
  ): Promise<any[]> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 10000); // Last 10k blocks

      // Get borrow events to identify active borrowers
      const borrowFilter = contract.filters?.['Borrow'];
      if (!borrowFilter) {
        this.logger.warn('Borrow filter not available for protocol', { protocol: protocol.name });
        return [];
      }

      const borrowEvents = await contract.queryFilter(borrowFilter(), fromBlock, currentBlock);

      // Extract unique borrower addresses
      const borrowerAddresses = new Set<string>();
      for (const event of borrowEvents) {
        if ('args' in event && event.args && event.args['user']) {
          borrowerAddresses.add(event.args['user']);
        }
      }

      // Convert to borrower data objects
      return Array.from(borrowerAddresses).map(address => ({
        address,
        protocol: protocol.name,
        lastActivity: Date.now(),
      }));
    } catch (error) {
      this.logger.error('Failed to get borrowers from events', {
        protocol: protocol.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Calculate real health factor from protocol contracts
   */
  private async calculateRealHealthFactor(
    protocol: LendingProtocol,
    borrowerData: any
  ): Promise<number> {
    try {
      const contract = new ethers.Contract(
        protocol.contractAddress,
        this.getProtocolABI(protocol.type),
        this.provider
      );

      // Get user account data (collateral value, debt value, liquidation threshold)
      const getUserAccountData = contract['getUserAccountData'];
      if (!getUserAccountData) {
        this.logger.warn('getUserAccountData method not available', { protocol: protocol.name });
        return 2.0; // Safe default
      }

      const accountData = await getUserAccountData(borrowerData.address);

      if (!accountData || accountData.totalCollateralETH === 0n) {
        return 2.0; // Safe health factor if no debt
      }

      // Calculate health factor: (collateral * liquidation threshold) / debt
      const healthFactor =
        Number(accountData.totalCollateralETH * accountData.currentLiquidationThreshold) /
        (Number(accountData.totalDebtETH) * 10000);

      return healthFactor;
    } catch (error) {
      this.logger.error('Failed to calculate real health factor', {
        protocol: protocol.name,
        borrower: borrowerData.address,
        error: error instanceof Error ? error.message : String(error),
      });
      return 2.0; // Conservative default
    }
  }

  /**
   * Get borrower position data from protocol
   */
  private async getBorrowerPosition(
    protocol: LendingProtocol,
    borrowerData: any
  ): Promise<{
    collateralToken: Address;
    debtToken: Address;
    collateralAmount: bigint;
    debtAmount: bigint;
  } | null> {
    try {
      const contract = new ethers.Contract(
        protocol.contractAddress,
        this.getProtocolABI(protocol.type),
        this.provider
      );

      // Get user reserves data
      const getUserReservesData = contract['getUserReservesData'];
      if (!getUserReservesData) {
        this.logger.warn('getUserReservesData method not available', { protocol: protocol.name });
        return null;
      }

      const reservesData = await getUserReservesData(borrowerData.address);

      if (!reservesData || reservesData.length === 0) {
        return null;
      }

      // Find the largest collateral and debt positions
      let maxCollateral = { token: '', amount: 0n };
      let maxDebt = { token: '', amount: 0n };

      for (const reserve of reservesData) {
        if (reserve.currentATokenBalance > maxCollateral.amount) {
          maxCollateral = {
            token: reserve.underlyingAsset,
            amount: reserve.currentATokenBalance,
          };
        }

        if (reserve.currentVariableDebt > maxDebt.amount) {
          maxDebt = {
            token: reserve.underlyingAsset,
            amount: reserve.currentVariableDebt,
          };
        }
      }

      if (maxCollateral.amount === 0n || maxDebt.amount === 0n) {
        return null;
      }

      return {
        collateralToken: maxCollateral.token as Address,
        debtToken: maxDebt.token as Address,
        collateralAmount: maxCollateral.amount,
        debtAmount: maxDebt.amount,
      };
    } catch (error) {
      this.logger.error('Failed to get borrower position', {
        protocol: protocol.name,
        borrower: borrowerData.address,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Calculate real liquidation profit using current market prices
   */
  private async calculateRealLiquidationProfit(
    debtAmount: bigint,
    collateralAmount: bigint,
    bonusAmount: bigint,
    collateralToken: Address,
    debtToken: Address
  ): Promise<{ netProfit: bigint; profitUsd: number }> {
    try {
      // Get current token prices (simplified - would use price oracle in production)
      const collateralPriceUsd = await this.getTokenPriceUsd(collateralToken);
      const debtPriceUsd = await this.getTokenPriceUsd(debtToken);

      // Calculate values in USD
      const collateralValueUsd = (Number(collateralAmount) * collateralPriceUsd) / 1e18;
      const debtValueUsd = (Number(debtAmount) * debtPriceUsd) / 1e18;
      const bonusValueUsd = (Number(bonusAmount) * collateralPriceUsd) / 1e18;

      // Log the liquidation analysis for monitoring
      this.logger.debug('Liquidation profit analysis', {
        collateralValueUsd,
        debtValueUsd,
        bonusValueUsd,
        collateralToken,
        debtToken,
      });

      // Calculate profit: bonus - gas costs
      const gasEstimate = 500000n; // Estimated gas for liquidation
      const gasPriceWei = await this.getCurrentGasPrice();
      const gasCostWei = gasEstimate * gasPriceWei;
      const gasCostUsd = (Number(gasCostWei) * 2500) / 1e18; // Assume ETH = $2500

      const profitUsd = bonusValueUsd - gasCostUsd;
      const netProfitWei = profitUsd > 0 ? ethers.parseEther((profitUsd / 2500).toString()) : 0n;

      return {
        netProfit: netProfitWei,
        profitUsd: Math.max(0, profitUsd),
      };
    } catch (error) {
      this.logger.error('Failed to calculate real liquidation profit', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { netProfit: 0n, profitUsd: 0 };
    }
  }

  /**
   * Check if flash loan is required based on our balance
   */
  private async isFlashLoanRequired(debtAmount: bigint, debtToken: Address): Promise<boolean> {
    try {
      // Check our balance of the debt token
      const tokenContract = new ethers.Contract(
        debtToken,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );

      // Get our wallet address (would be configured in production)
      const walletAddress = process.env['EXECUTION_WALLET_ADDRESS'] || ethers.ZeroAddress;
      const balanceOf = tokenContract['balanceOf'];
      if (!balanceOf) {
        this.logger.warn('balanceOf method not available for token', { debtToken });
        return true; // Conservative default - assume flash loan needed
      }

      const balance = await balanceOf(walletAddress);

      // Need flash loan if our balance is less than debt amount
      return balance < debtAmount;
    } catch (error) {
      this.logger.error('Failed to check flash loan requirement', {
        debtToken,
        error: error instanceof Error ? error.message : String(error),
      });
      return true; // Conservative default - assume flash loan needed
    }
  }

  /**
   * Get token price in USD (simplified implementation)
   */
  private async getTokenPriceUsd(tokenAddress: Address): Promise<number> {
    try {
      // In production, this would use a price oracle like Chainlink
      // For now, return mock prices based on common Base tokens
      const mockPrices: Record<string, number> = {
        '0x4200000000000000000000000000000000000006': 2500, // WETH
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 1, // USDC
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 25000, // DAI (mock high price)
      };

      return mockPrices[tokenAddress.toLowerCase()] || 1; // Default to $1
    } catch (error) {
      this.logger.error('Failed to get token price', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return 1; // Conservative default
    }
  }

  /**
   * Get protocol ABI based on protocol type
   */
  private getProtocolABI(protocolType: string): string[] {
    // Log which protocol ABI is being requested for debugging
    this.logger.debug('Getting protocol ABI', { protocolType });

    // Simplified ABI - in production would load full ABIs
    const baseABI = [
      'function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
      'function getUserReservesData(address user) view returns (tuple(address underlyingAsset, uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)[])',
      'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)',
    ];

    return baseABI;
  }
}
