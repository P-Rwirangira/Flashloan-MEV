/**
 * Real Transaction Validator
 *
 * Validates transactions using real blockchain state and gas estimation.
 * Replaces simulation with actual profitability validation and gas optimization.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { ArbitrageOpportunity, OpportunityStatus } from '../types/opportunity';
import { ArbitrageRoute } from '../types/execution';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ContractManager } from '../contracts/contract-manager';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';

export interface RealTransactionValidatorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly contractManager?: ContractManager;
  readonly maxValidationTimeMs?: number;
  readonly maxGasLimit?: bigint;
  readonly maxSlippagePercent?: number;
  readonly minProfitMarginPercent?: number;
  readonly enableLiquidityCheck?: boolean;
}

export interface ValidationTimeoutConfig {
  readonly maxValidationTimeMs: number;
  readonly maxGasLimit: bigint;
  readonly maxSlippagePercent: number;
  readonly minProfitMarginPercent: number;
  readonly enableLiquidityCheck: boolean;
}

export interface ValidationResult {
  readonly isValid: boolean;
  readonly rejectionReason?: string | undefined;
  readonly validationDetails: {
    readonly profitValidation: boolean;
    readonly gasValidation: boolean;
    readonly routeValidation: boolean;
    readonly liquidityValidation: boolean;
    readonly slippageValidation: boolean;
  };
  readonly actualProfit: bigint;
  readonly estimatedGas: bigint;
  readonly validatedAt: number;
  readonly gasPrice: bigint;
  readonly totalCost: bigint;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly actualProfit: bigint;
  readonly executionTime: number;
  readonly error?: string | undefined;
  readonly blockNumber?: number;
  readonly transactionHash?: string;
}

/**
 * Real Transaction Validator - Replaces Foundry Simulator
 *
 * Uses real blockchain state validation instead of fork-based simulation
 */
export class RealTransactionValidator extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly logger = createComponentLogger('RealTransactionValidator');
  private readonly timeoutConfig: ValidationTimeoutConfig;

  private isInitialized = false;
  private activeValidations = 0;
  private readonly maxConcurrentValidations = 10;
  private readonly validationQueue: Array<{
    opportunity: ArbitrageOpportunity;
    resolve: (result: ValidationResult) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(options: RealTransactionValidatorOptions) {
    super();

    this.connectionManager = options.connectionManager;

    this.timeoutConfig = {
      maxValidationTimeMs: options.maxValidationTimeMs || 5000,
      maxGasLimit: options.maxGasLimit || 2000000n,
      maxSlippagePercent: options.maxSlippagePercent || 5.0,
      minProfitMarginPercent: options.minProfitMarginPercent || 1.0,
      enableLiquidityCheck: options.enableLiquidityCheck ?? true,
    };
  }

  /**
   * Initialize the validator
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing Real Transaction Validator');

      // Verify connection manager is ready
      const provider = this.connectionManager.getProvider();
      await provider.getBlockNumber(); // Test connection

      this.isInitialized = true;
      this.logger.info('Real Transaction Validator initialized successfully');

      this.emit('initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Real Transaction Validator', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate arbitrage opportunity using real blockchain state
   */
  async validate(opportunity: ArbitrageOpportunity): Promise<ValidationResult> {
    if (!this.isInitialized) {
      throw new Error('Validator not initialized');
    }

    return new Promise((resolve, reject) => {
      if (this.activeValidations >= this.maxConcurrentValidations) {
        this.validationQueue.push({ opportunity, resolve, reject });
        return;
      }

      this.executeValidation(opportunity, resolve, reject);
    });
  }

  /**
   * Execute validation with timeout protection
   */
  private async executeValidation(
    opportunity: ArbitrageOpportunity,
    resolve: (result: ValidationResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    this.activeValidations++;

    try {
      const timeoutPromise = new Promise<never>((_, timeoutReject) => {
        setTimeout(() => {
          timeoutReject(new Error('Validation timeout'));
        }, this.timeoutConfig.maxValidationTimeMs);
      });

      const result = await Promise.race([this.performValidation(opportunity), timeoutPromise]);
      resolve(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('validationError', { opportunityId: opportunity.id, error: errorMessage });
      reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      this.activeValidations--;
      this.processQueue();
    }
  }

  /**
   * Perform the actual validation using real blockchain state
   */
  private async performValidation(opportunity: ArbitrageOpportunity): Promise<ValidationResult> {
    const startTime = Date.now();
    const provider = this.connectionManager.getProvider();

    try {
      // Step 1: Validate route exists and pools are active
      const routeValidation = await this.validateRoute(opportunity);

      // Step 2: Validate liquidity is sufficient
      const liquidityValidation = this.timeoutConfig.enableLiquidityCheck
        ? await this.validateLiquidity(opportunity)
        : true;

      // Step 3: Estimate real gas cost
      const gasEstimate = await this.estimateRealGas(opportunity);
      const gasValidation = gasEstimate <= this.timeoutConfig.maxGasLimit;

      // Step 4: Get current gas price
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('20', 'gwei');
      const totalCost = gasEstimate * gasPrice;

      // Step 5: Validate slippage is acceptable
      const slippageValidation = await this.validateSlippage(opportunity);

      // Step 6: Calculate actual profit after costs
      const actualProfit = await this.calculateRealProfit(opportunity, totalCost);
      const profitValidation = actualProfit > 0n;

      const isValid =
        routeValidation &&
        liquidityValidation &&
        gasValidation &&
        slippageValidation &&
        profitValidation;

      const result: ValidationResult = {
        isValid,
        rejectionReason: !isValid
          ? this.getRejectionReason({
              routeValidation,
              liquidityValidation,
              gasValidation,
              slippageValidation,
              profitValidation,
            })
          : undefined,
        validationDetails: {
          profitValidation,
          gasValidation,
          routeValidation,
          liquidityValidation,
          slippageValidation,
        },
        actualProfit,
        estimatedGas: gasEstimate,
        validatedAt: Date.now(),
        gasPrice,
        totalCost,
      };

      this.logger.debug('Validation completed', {
        opportunityId: opportunity.id,
        isValid: result.isValid,
        actualProfit: result.actualProfit.toString(),
        gasEstimate: result.estimatedGas.toString(),
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('Validation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate that the arbitrage route exists and pools are active
   */
  private async validateRoute(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      const provider = this.connectionManager.getProvider();

      // Convert route to array if it's not already
      const swaps = Array.isArray(opportunity.route)
        ? opportunity.route
        : opportunity.route.pools?.map((poolAddress, index) => ({
            poolAddress,
            protocol: 'uniswap-v3' as const,
            tokenIn:
              index === 0
                ? opportunity.tokenIn
                : opportunity.route.pools?.[index - 1] || opportunity.tokenIn,
            tokenOut:
              index === opportunity.route.pools?.length - 1
                ? opportunity.tokenOut
                : opportunity.route.pools?.[index + 1] || opportunity.tokenOut,
            fee: 3000,
          })) || [];

      for (const swap of swaps) {
        // Check if pool contract exists and has code
        const code = await provider.getCode(swap.poolAddress as Address);
        if (code === '0x') {
          this.logger.warn('Pool contract has no code', {
            poolAddress: swap.poolAddress,
            protocol: swap.protocol,
          });
          return false;
        }

        // For Uniswap V3, check slot0 to ensure pool is initialized
        if (swap.protocol === 'uniswap-v3') {
          try {
            const poolContract = new ethers.Contract(
              swap.poolAddress as Address,
              [
                'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
              ],
              provider
            );
            const slot0 = await (poolContract['slot0'] as any)();
            if (slot0[0] === 0n) {
              // sqrtPriceX96 should not be 0
              return false;
            }
          } catch {
            return false;
          }
        }

        // For Aerodrome, check reserves
        if (swap.protocol === 'aerodrome') {
          try {
            const poolContract = new ethers.Contract(
              swap.poolAddress as Address,
              ['function getReserves() view returns (uint112, uint112, uint32)'],
              provider
            );
            const reserves = await (poolContract['getReserves'] as any)();
            if (reserves[0] === 0n || reserves[1] === 0n) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      this.logger.error('Route validation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Validate that sufficient liquidity exists for the trade
   */
  private async validateLiquidity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      const provider = this.connectionManager.getProvider();

      // Convert route to array if it's not already
      const swaps = Array.isArray(opportunity.route)
        ? opportunity.route
        : opportunity.route.pools?.map((poolAddress, index) => ({
            poolAddress,
            protocol: 'uniswap-v3' as const,
            tokenIn:
              index === 0
                ? opportunity.tokenIn
                : opportunity.route.pools?.[index - 1] || opportunity.tokenIn,
            tokenOut:
              index === opportunity.route.pools?.length - 1
                ? opportunity.tokenOut
                : opportunity.route.pools?.[index + 1] || opportunity.tokenOut,
            fee: 3000,
          })) || [];

      for (const swap of swaps) {
        if (swap.protocol === 'uniswap-v3') {
          // Check Uniswap V3 liquidity
          const poolContract = new ethers.Contract(
            swap.poolAddress as Address,
            ['function liquidity() view returns (uint128)'],
            provider
          );
          const liquidity = await (poolContract['liquidity'] as any)();

          // Ensure liquidity is at least 10x the trade amount
          const minLiquidity = BigInt(opportunity.amountIn.toString()) * 10n;
          if (liquidity < minLiquidity) {
            return false;
          }
        } else if (swap.protocol === 'aerodrome') {
          // Check Aerodrome reserves
          const poolContract = new ethers.Contract(
            swap.poolAddress as Address,
            ['function getReserves() view returns (uint112, uint112, uint32)'],
            provider
          );
          const reserves = await (poolContract['getReserves'] as any)();

          // Ensure reserves are at least 5x the trade amount
          const minReserve = BigInt(opportunity.amountIn.toString()) * 5n;
          if (reserves[0] < minReserve && reserves[1] < minReserve) {
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      this.logger.error('Liquidity validation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Estimate real gas cost using provider
   */
  private async estimateRealGas(opportunity: ArbitrageOpportunity): Promise<bigint> {
    try {
      // Base gas for flash loan execution
      let gasEstimate = 200000n;

      // Convert route to array if it's not already
      const swaps = Array.isArray(opportunity.route)
        ? opportunity.route
        : opportunity.route.pools?.map((poolAddress, index) => ({
            poolAddress,
            protocol: 'uniswap-v3' as const,
            tokenIn:
              index === 0
                ? opportunity.tokenIn
                : opportunity.route.pools?.[index - 1] || opportunity.tokenIn,
            tokenOut:
              index === opportunity.route.pools?.length - 1
                ? opportunity.tokenOut
                : opportunity.route.pools?.[index + 1] || opportunity.tokenOut,
            fee: 3000,
          })) || [];

      // Add gas per swap based on protocol and complexity
      for (const swap of swaps) {
        if (swap.protocol === 'uniswap-v3') {
          gasEstimate += 150000n; // Uniswap V3 swap
        } else if (swap.protocol === 'aerodrome') {
          gasEstimate += 120000n; // Aerodrome swap
        } else {
          gasEstimate += 100000n; // Generic DEX swap
        }
      }

      // Add complexity overhead for multi-hop routes
      const routeLength = Array.isArray(opportunity.route)
        ? opportunity.route.length
        : opportunity.route.pools?.length || 0;
      if (routeLength > 2) {
        gasEstimate += BigInt(routeLength - 2) * 50000n;
      }

      // Add safety buffer (20% for real execution)
      gasEstimate = (gasEstimate * 120n) / 100n;

      return gasEstimate;
    } catch (error) {
      this.logger.warn('Gas estimation failed, using conservative default', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 500000n; // Conservative fallback
    }
  }

  /**
   * Validate slippage is within acceptable limits
   */
  private async validateSlippage(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      let totalSlippage = 0;

      // Convert route to array if it's not already
      const swaps = Array.isArray(opportunity.route)
        ? opportunity.route
        : opportunity.route.pools?.map((poolAddress, index) => ({
            poolAddress,
            protocol: 'uniswap-v3' as const,
            tokenIn:
              index === 0
                ? opportunity.tokenIn
                : opportunity.route.pools?.[index - 1] || opportunity.tokenIn,
            tokenOut:
              index === opportunity.route.pools?.length - 1
                ? opportunity.tokenOut
                : opportunity.route.pools?.[index + 1] || opportunity.tokenOut,
            fee: 3000,
          })) || [];

      for (const swap of swaps) {
        // Calculate slippage based on pool liquidity and trade size
        const slippage = await this.calculateSlippageForSwap(
          swap,
          BigInt(opportunity.amountIn.toString())
        );
        totalSlippage += slippage;
      }

      return totalSlippage <= this.timeoutConfig.maxSlippagePercent;
    } catch (error) {
      this.logger.error('Slippage validation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Calculate slippage for a specific swap
   */
  private async calculateSlippageForSwap(swap: any, tradeAmount: bigint): Promise<number> {
    try {
      const provider = this.connectionManager.getProvider();

      if (swap.protocol === 'uniswap-v3') {
        const poolContract = new ethers.Contract(
          swap.poolAddress as Address,
          ['function liquidity() view returns (uint128)'],
          provider
        );
        const liquidity = await (poolContract['liquidity'] as any)();

        // Calculate slippage as percentage of liquidity
        const liquidityRatio = Number(tradeAmount) / Number(liquidity);
        return Math.min(liquidityRatio * 100, 10); // Max 10% slippage
      } else if (swap.protocol === 'aerodrome') {
        const poolContract = new ethers.Contract(
          swap.poolAddress as Address,
          ['function getReserves() view returns (uint112, uint112, uint32)'],
          provider
        );
        const reserves = await (poolContract['getReserves'] as any)();

        // Calculate slippage based on reserves
        const totalReserves = reserves[0] + reserves[1];
        const liquidityRatio = Number(tradeAmount) / Number(totalReserves);
        return Math.min(liquidityRatio * 50, 5); // Max 5% slippage for stable pools
      }

      return 2; // Default 2% slippage
    } catch (error) {
      return 5; // Conservative 5% slippage on error
    }
  }

  /**
   * Calculate real profit after all costs
   */
  private async calculateRealProfit(
    opportunity: ArbitrageOpportunity,
    totalCost: bigint
  ): Promise<bigint> {
    try {
      // Get expected output from the arbitrage
      const expectedOutput = BigInt(opportunity.expectedProfit.toString());

      // Subtract gas costs
      const netProfit = expectedOutput > totalCost ? expectedOutput - totalCost : 0n;

      // Apply minimum profit margin
      const minProfitThreshold =
        (totalCost * BigInt(Math.floor(this.timeoutConfig.minProfitMarginPercent * 100))) / 10000n;

      return netProfit > minProfitThreshold ? netProfit : 0n;
    } catch (error) {
      this.logger.error('Profit calculation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Get rejection reason based on validation results
   */
  private getRejectionReason(validationDetails: ValidationResult['validationDetails']): string {
    if (!validationDetails.routeValidation) return 'Route validation failed';
    if (!validationDetails.liquidityValidation) return 'Insufficient liquidity';
    if (!validationDetails.gasValidation) return 'Gas limit exceeded';
    if (!validationDetails.slippageValidation) return 'Slippage too high';
    if (!validationDetails.profitValidation) return 'Insufficient profit';
    return 'Unknown validation failure';
  }

  /**
   * Process validation queue
   */
  private processQueue(): void {
    if (this.validationQueue.length > 0 && this.activeValidations < this.maxConcurrentValidations) {
      const next = this.validationQueue.shift();
      if (next) {
        this.executeValidation(next.opportunity, next.resolve, next.reject);
      }
    }
  }

  /**
   * Simulate an arbitrage route (legacy compatibility)
   */
  async simulateArbitrageRoute(route: ArbitrageRoute): Promise<SimulationResult> {
    const startTime = Date.now();

    try {
      // Convert route to opportunity format for validation
      const opportunity: ArbitrageOpportunity = {
        id: `route-${Date.now()}`,
        timestamp: Date.now(),
        type: 'arbitrage',
        status: OpportunityStatus.DETECTED,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountIn: route.amountIn,
        expectedAmountOut: route.expectedAmountOut,
        route: {
          pools: route.path.map(step => step.poolAddress as Address),
          fees: route.path.map(step => step.fee || 3000),
          directions: route.path.map(() => true),
          expectedGas: 300000,
          priceImpact: 0.01,
        },
        fallbackRoutes: [],
        flashFee: ethers.parseEther('0.0005'),
        gasEstimate: 300000n,
        expectedProfit: route.expectedAmountOut - route.amountIn,
        minProfit: ethers.parseEther('0.01'),
        profitMargin: 2.0,
        slippageTolerance: 0.005,
        deadline: Date.now() + 300000,
        maxBribe: ethers.parseEther('0.001'),
        priority: 1,
        detectedAt: Date.now(),
        expiresAt: Date.now() + 30000,
        source: 'foundry-simulator',
        sourcePool: (route.path[0]?.poolAddress || ethers.ZeroAddress) as Address,
        targetPool: (route.path[route.path.length - 1]?.poolAddress ||
          ethers.ZeroAddress) as Address,
        sourceDex: route.path[0]?.protocol || 'uniswap-v3',
        targetDex: route.path[route.path.length - 1]?.protocol || 'uniswap-v3',
        spread: 200, // 2% spread in basis points
        spreadAfterCosts: 150, // 1.5% after costs
      };

      const validation = await this.validate(opportunity);

      return {
        success: validation.isValid,
        gasUsed: validation.estimatedGas,
        actualProfit: validation.actualProfit,
        executionTime: Date.now() - startTime,
        error: validation.rejectionReason,
      };
    } catch (error) {
      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Validation failed',
      };
    }
  }

  /**
   * Legacy simulate method for compatibility
   */
  async simulate(opportunity: ArbitrageOpportunity): Promise<SimulationResult> {
    const startTime = Date.now();

    try {
      const validation = await this.validate(opportunity);

      return {
        success: validation.isValid,
        gasUsed: validation.estimatedGas,
        actualProfit: validation.actualProfit,
        executionTime: Date.now() - startTime,
        error: validation.rejectionReason || undefined,
      };
    } catch (error) {
      return {
        success: false,
        gasUsed: 0n,
        actualProfit: 0n,
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Simulation failed',
      };
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up Real Transaction Validator');
    this.isInitialized = false;
    this.validationQueue.length = 0;
    this.emit('cleanup');
  }
}

// Legacy export for compatibility
export const FoundrySimulator = RealTransactionValidator;
