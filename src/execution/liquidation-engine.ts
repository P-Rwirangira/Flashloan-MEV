/**
 * Liquidation Execution Engine
 *
 * Executes profitable liquidations across Base lending protocols
 * (Moonwell, Aave V3, Seamless) with flash loan integration
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import {
  ExecutionEngine,
  ExecutionResult,
  LiquidationOpportunity,
  OpportunityType,
} from '../types/execution';
import { TransactionRequest } from '../types/transaction';
import { FlashLoanManager } from './flash-loan-manager';
import { TransactionLifecycleManager } from './transaction-lifecycle-manager';
import { Address } from '../types/common';

export interface LiquidationEngineConfig {
  readonly maxSlippageBps: number;
  readonly minProfitThresholdUsd: number;
  readonly gasOptimizationEnabled: boolean;
  readonly enableProfitValidation: boolean;
  readonly maxLiquidationAmount: bigint;
  readonly supportedProtocols: string[];
  readonly healthFactorBuffer: number;
  readonly liquidationBonusThreshold: number;
  readonly resolveCTokensFromConfig?: boolean; // optionally resolve cTokens if not provided in opportunity
}

export interface LiquidationRoute {
  readonly steps: LiquidationStep[];
  readonly totalGasEstimate: bigint;
  readonly estimatedExecutionTime: number;
  readonly flashLoanRequired: boolean;
  readonly flashLoanAmount: bigint;
  readonly flashLoanToken: Address;
}

export interface LiquidationStep {
  readonly type: 'flashloan' | 'liquidate' | 'swap' | 'repay';
  readonly protocol?: string;
  readonly tokenIn?: Address;
  readonly tokenOut?: Address;
  readonly amountIn?: bigint;
  readonly amountOut?: bigint;
  readonly gasEstimate: bigint;
}

export class LiquidationEngine extends EventEmitter implements ExecutionEngine {
  private readonly logger = createComponentLogger('liquidation-engine');
  private readonly config: LiquidationEngineConfig;
  private readonly flashLoanManager: FlashLoanManager;
  private readonly transactionManager: TransactionLifecycleManager;

  // Protocol-specific liquidation interfaces
  private readonly protocolInterfaces = new Map<string, any>();

  constructor(
    config: LiquidationEngineConfig,
    flashLoanManager: FlashLoanManager,
    transactionManager: TransactionLifecycleManager
  ) {
    super();
    this.config = config;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;

    this.initializeProtocolInterfaces();

    // Use managers for future implementation
    this.logger.debug('LiquidationEngine initialized', {
      flashLoanManagerReady: !!this.flashLoanManager,
      transactionManagerReady: !!this.transactionManager,
    });
  }

  /**
   * Execute liquidation opportunity
   */
  async executeOpportunity(opportunity: LiquidationOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing liquidation opportunity', {
        opportunityId: opportunity.id,
        protocol: opportunity.protocol,
        borrower: opportunity.borrower,
        healthFactor: opportunity.healthFactor,
      });

      // Validate opportunity is still profitable
      const isStillProfitable = await this.validateLiquidationProfitability(opportunity);
      if (!isStillProfitable) {
        return {
          success: false,
          failureReason: 'Opportunity no longer profitable',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Calculate optimal liquidation size
      const optimalSize = await this.calculateOptimalLiquidationSize(opportunity);
      if (optimalSize === 0n) {
        return {
          success: false,
          failureReason: 'No profitable liquidation size found',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Create liquidation route
      const route = await this.createLiquidationRoute(opportunity, optimalSize);

      // Execute liquidation
      const result = await this.executeLiquidationRoute(opportunity, route);

      this.emit('liquidationExecuted', {
        opportunity,
        result,
        route,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('Liquidation execution failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Calculate optimal liquidation size
   */
  async calculateOptimalLiquidationSize(opportunity: LiquidationOpportunity): Promise<bigint> {
    try {
      // Get current debt and collateral amounts
      const debtAmount = opportunity.debtAmount;
      const maxLiquidationAmount = opportunity.maxLiquidationAmount;

      // Calculate maximum profitable liquidation based on liquidation bonus
      const liquidationBonusRate = opportunity.liquidationBonus;

      // Convert USD threshold to ETH amount using Chainlink oracle
      const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
      const connectionManager = { getProvider: () => this.transactionManager.getProvider() } as any;
      const oracle = new ChainlinkPriceOracleImpl(connectionManager);
      const ethPriceUsd = await oracle.getEthUsdPrice();
      const minProfitEth = this.config.minProfitThresholdUsd / Math.max(ethPriceUsd, 1e-6);
      const minProfitThreshold = ethers.parseEther(minProfitEth.toString());

      this.logger.debug('Liquidation parameters', {
        opportunityId: opportunity.id,
        debtAmount: debtAmount.toString(),
        maxLiquidationAmount: maxLiquidationAmount.toString(),
        liquidationBonusRate,
        minProfitThreshold: minProfitThreshold.toString(),
      });

      // Start with maximum allowed liquidation amount
      let optimalSize = maxLiquidationAmount;

      // Ensure we don't exceed debt amount
      if (optimalSize > debtAmount) {
        optimalSize = debtAmount;
      }

      // Ensure we don't exceed our configured maximum
      if (optimalSize > this.config.maxLiquidationAmount) {
        optimalSize = this.config.maxLiquidationAmount;
      }

      // Calculate expected profit for this size
      let expectedProfit = await this.calculateLiquidationProfit(opportunity, optimalSize);

      if (expectedProfit < minProfitThreshold) {
        // Try smaller sizes to find profitable amount
        const sizes = [optimalSize / 2n, optimalSize / 4n, optimalSize / 8n];

        for (const size of sizes) {
          const profit = await this.calculateLiquidationProfit(opportunity, size);
          if (profit >= minProfitThreshold) {
            optimalSize = size;
            expectedProfit = profit; // Update expectedProfit when profitable size found
            break;
          }
        }

        // Check the updated expectedProfit before returning 0
        if (expectedProfit < minProfitThreshold) {
          return 0n;
        }
      }

      this.logger.info('Calculated optimal liquidation size', {
        opportunityId: opportunity.id,
        optimalSize: optimalSize.toString(),
        expectedProfit: expectedProfit.toString(),
      });

      return optimalSize;
    } catch (error) {
      this.logger.error('Failed to calculate optimal liquidation size', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Validate liquidation profitability
   */
  async validateLiquidationProfitability(opportunity: LiquidationOpportunity): Promise<boolean> {
    try {
      // Check if health factor is still below liquidation threshold
      const currentHealthFactor = await this.getCurrentHealthFactor(
        opportunity.protocol,
        opportunity.borrower
      );

      if (currentHealthFactor >= 1.0 + this.config.healthFactorBuffer) {
        this.logger.warn('Health factor recovered, liquidation no longer valid', {
          opportunityId: opportunity.id,
          currentHealthFactor,
          threshold: 1.0 + this.config.healthFactorBuffer,
        });
        return false;
      }

      // Check if liquidation bonus is still above threshold
      if (opportunity.liquidationBonus < this.config.liquidationBonusThreshold) {
        this.logger.warn('Liquidation bonus below threshold', {
          opportunityId: opportunity.id,
          liquidationBonus: opportunity.liquidationBonus,
          threshold: this.config.liquidationBonusThreshold,
        });
        return false;
      }

      // Calculate current profitability
      const optimalSize = await this.calculateOptimalLiquidationSize(opportunity);
      if (optimalSize === 0n) {
        return false;
      }

      const expectedProfit = await this.calculateLiquidationProfit(opportunity, optimalSize);
      // Convert USD threshold to ETH using Chainlink oracle to avoid ETH-vs-USD mismatch
      try {
        const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
        const connectionManager = {
          getProvider: () => this.transactionManager.getProvider(),
        } as any;
        const oracle = new ChainlinkPriceOracleImpl(connectionManager);
        const ethPriceUsd = await oracle.getEthUsdPrice();
        const minProfitEth = this.config.minProfitThresholdUsd / Math.max(ethPriceUsd, 1e-6);
        const minProfitThreshold = ethers.parseEther(minProfitEth.toString());
        return expectedProfit >= minProfitThreshold;
      } catch (e) {
        throw new Error('ETH/USD price unavailable from oracle');
      }
    } catch (error) {
      this.logger.error('Failed to validate liquidation profitability', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Create liquidation execution route
   */
  private async createLiquidationRoute(
    opportunity: LiquidationOpportunity,
    liquidationSize: bigint
  ): Promise<LiquidationRoute> {
    const steps: LiquidationStep[] = [];
    let totalGasEstimate = 0n;
    let flashLoanRequired = false;
    let flashLoanAmount = 0n;
    const flashLoanToken = opportunity.debtAsset;

    // Step 1: Flash loan to get debt token
    flashLoanRequired = true;
    flashLoanAmount = liquidationSize;
    steps.push({
      type: 'flashloan',
      protocol: 'uniswap-v3', // Will be optimized by flash loan manager
      tokenIn: flashLoanToken,
      amountIn: flashLoanAmount,
      gasEstimate: 50000n,
    });

    // Step 2: Liquidate position
    steps.push({
      type: 'liquidate',
      protocol: opportunity.protocol,
      tokenIn: opportunity.debtAsset,
      tokenOut: opportunity.collateralAsset,
      amountIn: liquidationSize,
      amountOut: opportunity.collateralToSeize,
      gasEstimate: 200000n,
    });

    // Step 3: Swap collateral to debt token (if different)
    if (opportunity.collateralAsset !== opportunity.debtAsset) {
      steps.push({
        type: 'swap',
        tokenIn: opportunity.collateralAsset,
        tokenOut: opportunity.debtAsset,
        amountIn: opportunity.collateralToSeize,
        gasEstimate: 150000n,
      });
    }

    // Step 4: Repay flash loan
    steps.push({
      type: 'repay',
      protocol: 'uniswap-v3',
      tokenIn: flashLoanToken,
      amountIn: flashLoanAmount,
      gasEstimate: 50000n,
    });

    // Calculate total gas estimate
    totalGasEstimate = steps.reduce((total, step) => total + step.gasEstimate, 0n);

    return {
      steps,
      totalGasEstimate,
      estimatedExecutionTime: 3000, // 3 seconds
      flashLoanRequired,
      flashLoanAmount,
      flashLoanToken,
    };
  }

  /**
   * Execute liquidation route (REAL IMPLEMENTATION)
   */
  private async executeLiquidationRoute(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing liquidation route', {
        opportunityId: opportunity.id,
        steps: route.steps.length,
        flashLoanRequired: route.flashLoanRequired,
      });

      if (route.flashLoanRequired) {
        // Execute with flash loan
        return await this.executeWithFlashLoan(opportunity, route);
      } else {
        // Execute direct liquidation
        return await this.executeDirectLiquidation(opportunity, route);
      }
    } catch (error) {
      this.logger.error('Liquidation route execution failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Route execution failed',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Execute liquidation with flash loan
   */
  private async executeWithFlashLoan(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Build flash loan transaction
      const flashLoanTx = await this.buildFlashLoanTransaction(opportunity, route);

      // Submit transaction through lifecycle manager
      const transactionHash = await this.submitTransactionViaManager(flashLoanTx);

      // Wait for confirmation (simplified - in production would use proper monitoring)
      await new Promise(resolve => setTimeout(resolve, 5000));

      const profit = await this.calculateActualProfit(opportunity, route);

      return {
        success: true,
        transactionHash,
        profit,
        gasCost: BigInt(route.totalGasEstimate),
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    } catch (error) {
      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Flash loan execution failed',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Execute direct liquidation (without flash loan)
   */
  private async executeDirectLiquidation(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Build liquidation transaction
      const liquidationTx = await this.buildLiquidationTransaction(opportunity, route);

      // Submit transaction through lifecycle manager
      const transactionHash = await this.submitTransactionViaManager(liquidationTx);

      // Wait for confirmation (simplified - in production would use proper monitoring)
      await new Promise(resolve => setTimeout(resolve, 5000));

      const profit = await this.calculateActualProfit(opportunity, route);

      return {
        success: true,
        transactionHash,
        profit,
        gasCost: BigInt(route.totalGasEstimate),
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    } catch (error) {
      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Direct liquidation failed',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Build flash loan transaction for liquidation
   */
  private async buildFlashLoanTransaction(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<TransactionRequest> {
    const flashExecutorAddress = process.env['FLASH_EXECUTOR_ADDRESS'];
    if (!flashExecutorAddress) throw new Error('FLASH_EXECUTOR_ADDRESS not configured');

    const flashPool = process.env['FLASH_POOL_ADDRESS'];
    if (!flashPool) throw new Error('FLASH_POOL_ADDRESS not configured');

    // Determine which side to borrow (token0 vs token1) for the selected pool
    const tokenIsToken0Env = process.env['FLASH_POOL_TOKEN_IS_TOKEN0'];
    const borrowAsToken0 = tokenIsToken0Env ? tokenIsToken0Env.toLowerCase() !== 'false' : true;

    // Build liquidation payload (Solidity LiquidationPayload struct) and route data (RouteData)
    const abi = new ethers.Interface([
      'function executeLiquidationFlash(address flashPool,uint256 amount0,uint256 amount1,bytes liquidationData,bytes routeData) external',
    ]);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();

    // ProtocolType enum mapping: AAVE_V3=0, COMPOUND_LIKE=1
    const protocolType = opportunity.protocol === 'aave-v3' ? 0 : 1;

    // Load protocol addresses from contracts.yaml via ContractManager
    const { ContractManager } = await import('../contracts/contract-manager');
    const cm = (await (ContractManager as any).create?.()) as any;
    const protocols = cm.getProtocolAddresses();
    const aavePool = protocols?.aaveV3?.poolAddress;
    const moonwellComptroller = protocols?.compoundLike?.moonwell?.comptroller;
    const seamlessComptroller = protocols?.compoundLike?.seamless?.comptroller;

    // Protocol addresses from config with sane fallbacks
    const protocolAddress =
      opportunity.protocol === 'aave-v3'
        ? (aavePool as string)
        : opportunity.protocol === 'moonwell'
          ? (moonwellComptroller as string)
          : (seamlessComptroller as string);

    if (!protocolAddress) {
      throw new Error(`Protocol address not configured for ${opportunity.protocol}`);
    }

    let cDebtToken = (opportunity as any).cDebtToken ?? ethers.ZeroAddress;
    let cCollateralToken = (opportunity as any).cCollateralToken ?? ethers.ZeroAddress;

    // Optionally resolve cTokens via config mapping if omitted
    if (protocolType === 1 && this.config.resolveCTokensFromConfig) {
      try {
        const { ContractManager } = await import('../contracts/contract-manager');
        const cm = (await (ContractManager as any).create?.()) as any;
        if (cDebtToken === ethers.ZeroAddress) {
          const resolved = cm.getCTokenFor(
            opportunity.protocol as 'moonwell' | 'seamless',
            opportunity.debtAsset
          );
          if (resolved && /^0x[a-fA-F0-9]{40}$/.test(resolved)) {
            cDebtToken = resolved;
          }
        }
        if (cCollateralToken === ethers.ZeroAddress) {
          const resolved = cm.getCTokenFor(
            opportunity.protocol as 'moonwell' | 'seamless',
            opportunity.collateralAsset
          );
          if (resolved && /^0x[a-fA-F0-9]{40}$/.test(resolved)) {
            cCollateralToken = resolved;
          }
        }
      } catch (_) {}
    }

    if (
      protocolType === 1 &&
      (cDebtToken === ethers.ZeroAddress || cCollateralToken === ethers.ZeroAddress)
    ) {
      throw new Error(
        'Compound-like liquidation requires cDebtToken and cCollateralToken addresses'
      );
    }
    const receiveAToken = false;

    const liquidationPayload = abiCoder.encode(
      [
        'uint8', // protocol
        'address', // borrower
        'address', // debtAsset
        'address', // collateralAsset
        'uint256', // debtToCover
        'address', // protocolAddress
        'address', // cDebtToken
        'address', // cCollateralToken
        'bool', // receiveAToken
      ],
      [
        protocolType,
        opportunity.borrower,
        opportunity.debtAsset,
        opportunity.collateralAsset,
        route.flashLoanAmount,
        protocolAddress,
        cDebtToken,
        cCollateralToken,
        receiveAToken,
      ]
    );

    // RouteData encoding: we keep it empty unless provided by a higher-level optimizer
    const routeData = abiCoder.encode(
      ['address', 'address', 'uint256', 'uint256', 'address[]', 'uint24[]', 'bool[]', 'uint256'],
      [
        opportunity.debtAsset,
        opportunity.collateralAsset,
        0n, // amountIn for pre/post swaps determined in contract
        0n, // minAmountOut
        [],
        [],
        [],
        0n, // deadline 0 -> ignored by contract
      ]
    );

    const amount0 = borrowAsToken0 ? route.flashLoanAmount : 0n;
    const amount1 = borrowAsToken0 ? 0n : route.flashLoanAmount;

    const data = abi.encodeFunctionData('executeLiquidationFlash', [
      flashPool,
      amount0,
      amount1,
      liquidationPayload,
      routeData,
    ]);

    return {
      to: flashExecutorAddress as `0x${string}`,
      data,
      value: 0n,
      gasLimit: route.totalGasEstimate,
      maxFeePerGas: BigInt(50e9),
      maxPriorityFeePerGas: BigInt(2e9),
    };
  }

  /**
   * Build direct liquidation transaction
   */
  private async buildLiquidationTransaction(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<TransactionRequest> {
    // Get protocol liquidation contract and resolve correct address
    const protocolInterface = this.protocolInterfaces.get(opportunity.protocol);
    if (!protocolInterface) {
      throw new Error(`Protocol ${opportunity.protocol} not supported`);
    }

    // Resolve the correct address field based on protocol type
    let contractAddress: string;
    if (opportunity.protocol === 'moonwell' || opportunity.protocol === 'seamless') {
      contractAddress = (protocolInterface as any).comptrollerAddress;
    } else if (opportunity.protocol === 'aave-v3') {
      contractAddress = (protocolInterface as any).poolAddress;
    } else {
      contractAddress = (protocolInterface as any).address;
    }

    if (!contractAddress) {
      throw new Error(`No contract address found for protocol ${opportunity.protocol}`);
    }

    // Encode liquidation call
    const liquidationData = this.encodeDirectLiquidationData(opportunity, route);

    return {
      to: contractAddress as `0x${string}`,
      data: liquidationData,
      value: 0n,
      gasLimit: route.totalGasEstimate,
      maxFeePerGas: BigInt(50e9), // 50 gwei
      maxPriorityFeePerGas: BigInt(2e9), // 2 gwei
    };
  }

  /**
   * Encode liquidation data for flash loan execution
   */
  /**
   * Encode direct liquidation data
   */
  private encodeDirectLiquidationData(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): string {
    // Encode call data for protocol-specific liquidation
    this.logger.debug('Encoding direct liquidation data', {
      opportunityId: opportunity.id,
      routeSteps: route.steps.length,
      borrower: opportunity.borrower,
      protocol: opportunity.protocol,
    });

    if (opportunity.protocol === 'aave-v3') {
      // Aave V3 liquidationCall(address collateral,address debt,address user,uint256 debtToCover,bool receiveAToken)
      const iface = new ethers.Interface([
        'function liquidationCall(address collateral,address debt,address user,uint256 debtToCover,bool receiveAToken)',
      ]);
      return iface.encodeFunctionData('liquidationCall', [
        opportunity.collateralAsset,
        opportunity.debtAsset,
        opportunity.borrower,
        route.flashLoanAmount,
        false,
      ]);
    }

    // For Compound-like protocols (Moonwell/Seamless), liquidateBorrow on cToken
    if (opportunity.protocol === 'moonwell' || opportunity.protocol === 'seamless') {
      const iface = new ethers.Interface([
        'function liquidateBorrow(address borrower,uint256 repayAmount,address cTokenCollateral)',
      ]);
      // Here we assume collateralAsset is cTokenCollateral and debtAsset is cToken of debt
      return iface.encodeFunctionData('liquidateBorrow', [
        opportunity.borrower,
        route.flashLoanAmount,
        opportunity.collateralAsset,
      ]);
    }

    // Default: encode no-op to prevent execution
    throw new Error(
      `Unsupported protocol for direct liquidation encoding: ${opportunity.protocol}`
    );
  }

  /**
   * Calculate actual profit from liquidation
   */
  private async calculateActualProfit(
    opportunity: LiquidationOpportunity,
    route: LiquidationRoute
  ): Promise<bigint> {
    // In production, fetch receipt and compute exact PnL; here estimate using real gas price
    const provider = this.transactionManager.getProvider();
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
    const gasCost = BigInt(route.totalGasEstimate) * gasPrice;
    const estimatedProfit = opportunity.estimatedProfit;

    this.logger.debug('Calculating liquidation profit', {
      opportunity: opportunity.id,
      route: route.steps.length,
      estimatedProfit: estimatedProfit.toString(),
      gasCost: gasCost.toString(),
    });

    return estimatedProfit > gasCost ? estimatedProfit - gasCost : 0n;
  }

  /**
   * Submit transaction via transaction manager (wrapper method)
   */
  private async submitTransactionViaManager(transaction: TransactionRequest): Promise<string> {
    try {
      const result = await this.transactionManager.processTransaction(
        `liquidation-${Date.now()}`,
        async () => transaction
      );

      if (!result.success || !result.receipt?.transactionHash) {
        throw new Error(result.failureReason || 'Transaction submission failed');
      }

      return result.receipt.transactionHash;
    } catch (error) {
      this.logger.error('Failed to submit liquidation transaction via manager', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Calculate liquidation profit
   */
  private async calculateLiquidationProfit(
    opportunity: LiquidationOpportunity,
    liquidationSize: bigint
  ): Promise<bigint> {
    try {
      // Calculate liquidation bonus
      const liquidationBonus =
        (liquidationSize * BigInt(Math.floor(opportunity.liquidationBonus * 10000))) / 10000n;

      // Estimate flash loan fees (0.05% for Uniswap V3)
      const flashLoanFee = (liquidationSize * 5n) / 10000n;

      // Estimate gas costs using current network conditions
      const provider = this.transactionManager.getProvider();
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
      const gasLimit = 450000n; // Estimated total gas for liquidation
      const gasCost = gasPrice * gasLimit;

      // Estimate slippage costs (1% of liquidation size)
      const slippageCost = (liquidationSize * BigInt(this.config.maxSlippageBps)) / 10000n;

      // Calculate net profit
      const grossProfit = liquidationBonus;
      const totalCosts = flashLoanFee + gasCost + slippageCost;
      const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

      return netProfit;
    } catch (error) {
      this.logger.error('Failed to calculate liquidation profit', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Get current health factor for borrower
   */
  private async getCurrentHealthFactor(protocol: string, borrower: Address): Promise<number> {
    try {
      // Get provider for contract calls
      const provider = this.transactionManager.getProvider();

      // Protocol-specific health factor calculation
      switch (protocol.toLowerCase()) {
        case 'moonwell': {
          // Moonwell comptroller interface
          const comptrollerAbi = [
            'function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256)',
          ];
          const comptrollerAddress = '0x8E00D5e02E65A19337Cdba98bbA9F84d4186a180'; // Moonwell comptroller on Base
          const comptroller = new ethers.Contract(comptrollerAddress, comptrollerAbi, provider);

          const getAccountLiquidity = comptroller['getAccountLiquidity'];
          if (!getAccountLiquidity) {
            throw new Error('getAccountLiquidity method not found');
          }

          const [error, liquidity, shortfall] = await getAccountLiquidity(borrower);

          if (error !== 0n) {
            throw new Error(`Comptroller error: ${error}`);
          }

          // Health factor = liquidity / (liquidity + shortfall)
          // If shortfall > 0, position is liquidatable
          if (shortfall > 0n) {
            return Number(liquidity) / Number(liquidity + shortfall);
          }

          return 2.0; // Healthy position
        }

        case 'aave-v3': {
          // Aave V3 pool interface
          const poolAbi = [
            'function getUserAccountData(address user) external view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
          ];
          const poolAddress = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'; // Aave V3 pool on Base
          const pool = new ethers.Contract(poolAddress, poolAbi, provider);

          const getUserAccountData = pool['getUserAccountData'];
          if (!getUserAccountData) {
            throw new Error('getUserAccountData method not found');
          }

          const userData = await getUserAccountData(borrower);
          const healthFactor = userData[5]; // Health factor is the 6th element

          // Aave returns health factor scaled by 1e18
          return Number(healthFactor) / 1e18;
        }

        default:
          this.logger.warn('Unknown protocol for health factor calculation', { protocol });
          return 1.5; // Safe default
      }
    } catch (error) {
      this.logger.error('Failed to get current health factor', {
        protocol,
        borrower,
        error: error instanceof Error ? error.message : String(error),
      });
      return 1.5; // Safe default
    }
  }

  /**
   * Initialize protocol-specific interfaces
   */
  private initializeProtocolInterfaces(): void {
    // Initialize interfaces for each supported protocol
    for (const protocol of this.config.supportedProtocols) {
      switch (protocol) {
        case 'moonwell': {
          const addr = process.env['MOONWELL_COMPTROLLER_ADDRESS'];
          if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            throw new Error('MOONWELL_COMPTROLLER_ADDRESS is missing or invalid');
          }
          this.protocolInterfaces.set(protocol, {
            comptrollerAddress: addr,
            liquidationFunction: 'liquidateBorrow',
          });
          break;
        }
        case 'aave-v3': {
          const addr = process.env['AAVE_V3_POOL_ADDRESS'];
          if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            throw new Error('AAVE_V3_POOL_ADDRESS is missing or invalid');
          }
          this.protocolInterfaces.set(protocol, {
            poolAddress: addr,
            liquidationFunction: 'liquidationCall',
          });
          break;
        }
        case 'seamless': {
          const addr = process.env['SEAMLESS_COMPTROLLER_ADDRESS'];
          if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            throw new Error('SEAMLESS_COMPTROLLER_ADDRESS is missing or invalid');
          }
          this.protocolInterfaces.set(protocol, {
            comptrollerAddress: addr,
            liquidationFunction: 'liquidateBorrow',
          });
          break;
        }
      }
    }

    this.logger.info('Protocol interfaces initialized', {
      supportedProtocols: this.config.supportedProtocols,
    });
  }

  /**
   * Get supported opportunity types
   */
  getSupportedOpportunityTypes(): OpportunityType[] {
    return [OpportunityType.LIQUIDATION];
  }

  /**
   * Check if engine can handle opportunity
   */
  canHandleOpportunity(opportunity: any): boolean {
    return (
      opportunity.type === OpportunityType.LIQUIDATION &&
      this.config.supportedProtocols.includes(opportunity.protocol)
    );
  }
}
