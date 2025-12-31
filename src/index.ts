/**
 * Base MEV Platform - Entry Point
 *
 * Flash-loan-native MEV platform for Base blockchain targeting:
 * - Phase 1: Cross-DEX arbitrage (Uniswap V3 ↔ Aerodrome)
 * - Phase 2: Long-tail liquidations on Base lending markets
 * - Phase 3: Stable/meta-pool rebalancing on Aerodrome stable pools
 */

import { logger, createComponentLogger, globalPerformanceTracker } from './utils/logger';
import { ConfigLoader } from './config/loader';
import { RpcConnectionManager } from './rpc/connection-manager';
import { ArbitrageScanner } from './scanner/arbitrage-scanner';
import { MetricsCollector } from './monitoring/metrics-collector';
import { CircuitBreaker } from './monitoring/circuit-breaker';
import { AlertingSystem } from './monitoring/alerting-system';
import { HealthCheckSystem } from './monitoring/health-check';
import { HealthServer } from './monitoring/health-server';
import { RelayProvider } from './bundler/private-relay';
import { LendingProtocolMonitor } from './scanner/lending-monitor';
import { StablePoolMonitor } from './scanner/stable-pool-monitor';
import { MempoolMonitor } from './scanner/mempool-monitor';
import { LiquidationProfitCalculator } from './simulator/liquidation-calculator';
import { StablePoolRebalancingCalculator } from './simulator/stable-pool-calculator';
import { ExecutionOrchestrator } from './execution/execution-orchestrator';
import { FlashLoanArbitrageEngine } from './execution/flash-loan-arbitrage-engine';
import { OpportunityStateMachine } from './execution/opportunity-state-machine';
import { FlashLoanManager } from './execution/flash-loan-manager';
import { TransactionLifecycleManager } from './execution/transaction-lifecycle-manager';
import { PrivateRelayManager } from './execution/private-relay-manager';
import { OpportunityType } from './types/execution';
import { RelayProvider as PrivateRelayProvider } from './types/private-relay';
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import path from 'path';

// Platform configuration
interface PlatformConfig {
  phases: {
    arbitrage: { enabled: boolean; priority: number };
    liquidations: { enabled: boolean; priority: number };
    stablePoolRebalancing: { enabled: boolean; priority: number };
  };
  gracefulDegradation: {
    enabled: boolean;
    fallbackToArbitrageOnly: boolean;
    maxConsecutiveFailures: number;
  };
  featureFlags: {
    enableLiquidationMonitoring: boolean;
    enableStablePoolMonitoring: boolean;
    enableAdvancedRouting: boolean;
    enablePerformanceOptimizations: boolean;
    enableExecutionEngine: boolean;
  };
  execution?: {
    enabled: boolean;
    maxConcurrentExecutions: number;
    profitThresholds: {
      arbitrage: number;
      liquidation: number;
      stablePool: number;
    };
    riskLimits: {
      maxSlippage: number;
      maxGasPrice: bigint;
      dailyLossLimit: bigint;
    };
  };
}

class BaseMEVPlatform extends EventEmitter {
  private configLoader: ConfigLoader;
  private connectionManager: RpcConnectionManager;
  private metricsCollector: MetricsCollector;
  private circuitBreaker: CircuitBreaker;
  private alertingSystem: AlertingSystem;
  private healthCheckSystem: HealthCheckSystem;
  private healthServer: HealthServer;

  // Execution engine
  private executionOrchestrator?: ExecutionOrchestrator;
  private flashLoanArbitrageEngine?: FlashLoanArbitrageEngine;
  private opportunityStateMachine?: OpportunityStateMachine;
  private flashLoanManager?: FlashLoanManager;
  private transactionLifecycleManager?: TransactionLifecycleManager;
  private privateRelayManager?: PrivateRelayManager;

  // Phase-specific components
  private arbitrageScanner?: ArbitrageScanner;
  private mempoolMonitor?: MempoolMonitor;
  private lendingMonitor?: LendingProtocolMonitor;
  private stablePoolMonitor?: StablePoolMonitor;
  private liquidationCalculator?: LiquidationProfitCalculator;
  private stablePoolCalculator?: StablePoolRebalancingCalculator;

  private isRunning = false;
  private platformLogger = createComponentLogger('platform');
  private config?: PlatformConfig;

  constructor() {
    super();

    // Initialize core components
    this.configLoader = new ConfigLoader({
      configPath: path.join(process.cwd(), 'config', 'default.yaml'),
      watchForChanges: true,
      envPrefix: 'MEV_',
    });

    // Initialize connection manager with default RPC URLs
    this.connectionManager = new RpcConnectionManager({
      network: {
        name: 'base',
        chainId: 8453,
        rpcUrl: process.env['BASE_RPC_URL'] || 'https://mainnet.base.org',
        wsUrl: process.env['BASE_WS_URL'] || 'wss://mainnet.base.org',
        fallbackRpcs: [
          'https://base-mainnet.g.alchemy.com/v2/demo',
          'https://base.blockpi.network/v1/rpc/public',
        ],
      },
      healthCheckIntervalMs: 30000,
      maxConsecutiveFailures: 3,
      connectionTimeoutMs: 10000,
      requestTimeoutMs: 30000,
    });

    this.metricsCollector = new MetricsCollector();

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 60000,
    });

    this.alertingSystem = new AlertingSystem(this.metricsCollector);

    this.healthCheckSystem = new HealthCheckSystem({
      metricsCollector: this.metricsCollector,
      circuitBreaker: this.circuitBreaker,
      checkIntervalMs: 30000,
      unhealthyThreshold: 3,
      degradedThreshold: 2,
    });

    this.healthServer = new HealthServer({
      port: parseInt(process.env['HEALTH_PORT'] || '3002', 10),
      host: process.env['HEALTH_HOST'] || '0.0.0.0',
      healthCheckSystem: this.healthCheckSystem,
      metricsCollector: this.metricsCollector,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Circuit breaker events
    this.circuitBreaker.on('stateChanged', data => {
      this.metricsCollector.updateCircuitBreakerStatus(data.newState);
      this.platformLogger.logCircuitBreakerStateChange(
        'platform',
        data.newState,
        'State change detected'
      );

      // Handle graceful degradation
      if (data.newState === 'open' && this.config?.gracefulDegradation.enabled) {
        this.handleGracefulDegradation();
      }
    });

    // Alerting system events
    this.alertingSystem.on('alertTriggered', alert => {
      this.platformLogger.warn('Alert triggered', {
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        timestamp: alert.timestamp,
      });
    });

    // Metrics collector events
    this.metricsCollector.on('opportunityFailure', data => {
      this.platformLogger.warn('Opportunity execution failed', {
        relay: data.relay,
        reason: data.reason,
        gasCost: data.gasCost?.toString(),
      });
    });

    // Log metrics periodically with enhanced formatting
    setInterval(() => {
      const metrics = this.getMetrics();
      this.platformLogger.debug('Platform metrics update', {
        opportunities: metrics.opportunities.totalOpportunities,
        winRate: `${(metrics.opportunities.winRate * 100).toFixed(2)}%`,
        totalProfit: `$${metrics.profit.totalProfitUSD.toFixed(2)}`,
        systemHealth: metrics.systemHealth.circuitBreakerStatus,
        activePhases: this.getActivePhases(),
      });
    }, 30000); // Every 30 seconds
  }

  async initialize(): Promise<void> {
    return globalPerformanceTracker.trackOperation('platform-initialization', async () => {
      this.platformLogger.info('Initializing Base MEV Platform...');

      // Load configuration
      const rawConfig = await this.configLoader.load();
      this.config = this.parseConfig(rawConfig);

      this.platformLogger.info('Configuration loaded successfully', {
        enabledPhases: Object.entries(this.config.phases)
          .filter(([, phase]) => phase.enabled)
          .map(([name]) => name),
        featureFlags: this.config.featureFlags,
      });

      // Initialize phase-specific components based on configuration
      await this.initializePhaseComponents();

      this.platformLogger.info('Base MEV Platform initialized successfully');
    });
  }

  private parseConfig(rawConfig: any): PlatformConfig {
    // Default configuration with all phases enabled
    return {
      phases: {
        arbitrage: {
          enabled: rawConfig.phases?.arbitrage?.enabled ?? true,
          priority: rawConfig.phases?.arbitrage?.priority ?? 1,
        },
        liquidations: {
          enabled: rawConfig.phases?.liquidations?.enabled ?? true,
          priority: rawConfig.phases?.liquidations?.priority ?? 2,
        },
        stablePoolRebalancing: {
          enabled: rawConfig.phases?.stablePoolRebalancing?.enabled ?? true,
          priority: rawConfig.phases?.stablePoolRebalancing?.priority ?? 3,
        },
      },
      gracefulDegradation: {
        enabled: rawConfig.gracefulDegradation?.enabled ?? true,
        fallbackToArbitrageOnly: rawConfig.gracefulDegradation?.fallbackToArbitrageOnly ?? true,
        maxConsecutiveFailures: rawConfig.gracefulDegradation?.maxConsecutiveFailures ?? 10,
      },
      featureFlags: {
        enableLiquidationMonitoring: rawConfig.featureFlags?.enableLiquidationMonitoring ?? true,
        enableStablePoolMonitoring: rawConfig.featureFlags?.enableStablePoolMonitoring ?? true,
        enableAdvancedRouting: rawConfig.featureFlags?.enableAdvancedRouting ?? true,
        enablePerformanceOptimizations:
          rawConfig.featureFlags?.enablePerformanceOptimizations ?? true,
        enableExecutionEngine: rawConfig.featureFlags?.enableExecutionEngine ?? true,
      },
      execution: {
        enabled: rawConfig.execution?.enabled ?? true,
        maxConcurrentExecutions: rawConfig.execution?.maxConcurrentExecutions ?? 5,
        profitThresholds: {
          arbitrage: rawConfig.execution?.profitThresholds?.arbitrage ?? 15.0,
          liquidation: rawConfig.execution?.profitThresholds?.liquidation ?? 25.0,
          stablePool: rawConfig.execution?.profitThresholds?.stablePool ?? 10.0,
        },
        riskLimits: {
          maxSlippage: rawConfig.execution?.riskLimits?.maxSlippage ?? 0.02,
          maxGasPrice: BigInt(rawConfig.execution?.riskLimits?.maxGasPrice ?? '50000000000'), // 50 gwei
          dailyLossLimit: BigInt(
            rawConfig.execution?.riskLimits?.dailyLossLimit ?? '1000000000000000000'
          ), // 1 ETH
        },
      },
    };
  }

  private async initializePhaseComponents(): Promise<void> {
    if (!this.config) throw new Error('Configuration not loaded');

    const rawConfig = await this.configLoader.load();

    // Phase 1: Cross-DEX Arbitrage
    if (this.config.phases.arbitrage.enabled) {
      this.platformLogger.info('Initializing Phase 1: Cross-DEX arbitrage');

      // Initialize pool manager
      const { PoolManager } = await import('./scanner/pool-manager');
      const poolManager = new PoolManager({
        connectionManager: this.connectionManager,
        allowedPools: rawConfig.allowedPools || { uniswapV3: [], aerodrome: [] },
        updateIntervalMs: 5000,
      });

      await poolManager.initialize();

      // Initialize arbitrage scanner
      this.arbitrageScanner = new ArbitrageScanner({
        poolManager,
        connectionManager: this.connectionManager,
        config: rawConfig.strategies.arbitrage,
        scanIntervalMs: 1000,
      });

      // Set up event listener for arbitrage opportunities
      this.arbitrageScanner.on('opportunityDetected', async (opportunity: any) => {
        await this.handleArbitrageOpportunity(opportunity);
      });

      this.platformLogger.info('Phase 1 arbitrage scanner initialized successfully');

      // Initialize mempool monitor for backrun opportunities
      this.mempoolMonitor = new MempoolMonitor({
        connectionManager: this.connectionManager,
        enabledProtocols: ['uniswap-v3' as any, 'aerodrome' as any],
        minSwapValue: ethers.parseEther('0.1'), // 0.1 ETH minimum
        maxPendingTxs: 500,
        filterSpam: true,
        enableBackrun: true,
        enableFrontrun: false, // Disabled for ethical reasons
        enableSandwich: false, // Disabled for ethical reasons
      });

      // Set up event listener for mempool opportunities
      this.mempoolMonitor.on('opportunityDetected', async (opportunity: any) => {
        await this.handleMempoolOpportunity(opportunity);
      });

      this.platformLogger.info('Mempool monitor initialized successfully');
    }

    // Phase 2: Liquidations
    if (
      this.config.phases.liquidations.enabled &&
      this.config.featureFlags.enableLiquidationMonitoring
    ) {
      this.platformLogger.info('Initializing Phase 2: Liquidation monitoring');

      // Initialize lending protocol monitor with real connection manager
      this.lendingMonitor = new LendingProtocolMonitor(
        {
          protocols: [
            {
              protocol: 'moonwell' as any,
              comptrollerAddress: '0x8E00D5e02E65A19337Cdba98bbA9F84d4186a180',
              liquidationThreshold: 0.8,
              liquidationBonus: 0.05,
              minProfitThreshold: 10000000000000000n, // 0.01 ETH
            },
          ],
          healthFactorThresholds: {
            critical: 1.05,
            warning: 1.2,
            healthy: 1.5,
          },
          scanIntervalMs: 10000,
          maxPositionsPerScan: 10,
          minProfitThreshold: 10000000000000000n,
        },
        this.connectionManager
      );

      // Initialize liquidation calculator
      this.liquidationCalculator = new LiquidationProfitCalculator({
        maxSlippage: 0.01,
        gasPrice: 20000000000n, // 20 gwei
        flashLoanFeeRate: 0.0009,
        minProfitMargin: 0.1,
        riskToleranceScore: 70,
      });

      // Set up liquidation event handlers
      this.lendingMonitor.on('liquidationOpportunityDetected', async opportunity => {
        await this.handleLiquidationOpportunity(opportunity);
      });
    }

    // Phase 3: Stable Pool Rebalancing
    if (
      this.config.phases.stablePoolRebalancing.enabled &&
      this.config.featureFlags.enableStablePoolMonitoring
    ) {
      this.platformLogger.info('Initializing Phase 3: Stable pool rebalancing');

      // Initialize stable pool monitor with real connection manager
      this.stablePoolMonitor = new StablePoolMonitor(
        {
          pools: [
            {
              poolAddress: '0x1234567890123456789012345678901234567890',
              token0Symbol: 'USDC',
              token1Symbol: 'DAI',
              minImbalanceThreshold: 0.05,
              maxImbalanceThreshold: 0.2,
              minProfitThreshold: 5000000000000000n, // 0.005 ETH
              priority: 'high' as const,
              isActive: true,
            },
          ],
          scanIntervalMs: 15000,
          minImbalanceThreshold: 0.05,
          maxOpportunitiesPerScan: 5,
          minProfitThreshold: 5000000000000000n,
          gasPrice: 20000000000n,
        },
        this.connectionManager
      );

      // Initialize stable pool calculator
      this.stablePoolCalculator = new StablePoolRebalancingCalculator({
        maxSlippage: 0.005,
        gasPrice: 20000000000n,
        minProfitMargin: 0.05,
        maxPriceImpact: 0.01,
        incentiveMultiplier: 1.0,
      });

      // Set up stable pool event handlers
      this.stablePoolMonitor.on('stablePoolOpportunityDetected', async opportunity => {
        await this.handleStablePoolOpportunity(opportunity);
      });
    }

    // Initialize Execution Engine
    if (this.config.featureFlags.enableExecutionEngine && this.config.execution?.enabled) {
      this.platformLogger.info('Initializing Execution Engine');

      // Create signer from private key (in production, use secure key management)
      const privateKey = process.env['EXECUTION_PRIVATE_KEY'];
      if (!privateKey) {
        this.platformLogger.warn('No execution private key provided, execution engine disabled');
        return;
      }

      try {
        // Create provider and signer for execution
        const provider = this.connectionManager.getProvider();
        const signer = new ethers.Wallet(privateKey, provider);

        this.platformLogger.info('Execution signer initialized', {
          address: await signer.getAddress(),
        });

        // Initialize core execution components
        this.opportunityStateMachine = new OpportunityStateMachine();

        // Initialize private relay manager
        this.privateRelayManager = new PrivateRelayManager(provider, signer, {
          defaultRelay: PrivateRelayProvider.FLASHBOTS_PROTECT,
          enableFallback: true,
          maxConcurrentSubmissions: 5,
          selectionStrategy: 'balanced',
          enableMetrics: true,
          metricsRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
          enableBundles: true,
          maxBundleSize: 3,
          relayProviders: [
            {
              name: 'Flashbots Protect',
              provider: PrivateRelayProvider.FLASHBOTS_PROTECT,
              endpoint: process.env['FLASHBOTS_PROTECT_RPC'] || 'https://rpc.flashbots.net',
              authentication: {
                type: 'api-key',
                apiKey: process.env['FLASHBOTS_API_KEY'] || '',
              },
              capabilities: {
                supportsBundle: true,
                supportsCancellation: false,
                supportsReplacement: true,
                supportsSimulation: true,
                maxTransactionsPerBundle: 25,
                estimatedInclusionTime: 12000, // 12 seconds
                supportedChains: [8453], // Base mainnet
              },
              costs: {
                baseFee: BigInt(0),
                priorityFeeMultiplier: 1.0,
                bundleFee: BigInt(0),
              },
              enabled: true,
              priority: 1,
              maxRetries: 2,
              timeoutMs: 30000,
            },
            {
              name: 'bloXroute',
              provider: PrivateRelayProvider.BLOXROUTE,
              endpoint: process.env['BLOXROUTE_ENDPOINT'] || 'https://api.bloxroute.com',
              authentication: {
                type: 'api-key',
                apiKey: process.env['BLOXROUTE_API_KEY'] || '',
              },
              capabilities: {
                supportsBundle: false,
                supportsCancellation: true,
                supportsReplacement: true,
                supportsSimulation: false,
                maxTransactionsPerBundle: 1,
                estimatedInclusionTime: 8000, // 8 seconds
                supportedChains: [8453], // Base mainnet
              },
              costs: {
                baseFee: BigInt(1e15), // 0.001 ETH
                priorityFeeMultiplier: 1.1,
              },
              enabled: !!process.env['BLOXROUTE_API_KEY'], // Only enable if API key is provided
              priority: 2,
              maxRetries: 1,
              timeoutMs: 20000,
            },
            {
              name: 'Local Node Fallback',
              provider: PrivateRelayProvider.LOCAL_NODE,
              endpoint: process.env['BASE_RPC_URL'] || 'https://mainnet.base.org',
              authentication: { type: 'none' },
              capabilities: {
                supportsBundle: false,
                supportsCancellation: false,
                supportsReplacement: true,
                supportsSimulation: false,
                maxTransactionsPerBundle: 1,
                estimatedInclusionTime: 15000, // 15 seconds
                supportedChains: [8453], // Base mainnet
              },
              costs: {
                baseFee: BigInt(0),
                priorityFeeMultiplier: 1.0,
              },
              enabled: true,
              priority: 99, // Lowest priority (fallback)
              maxRetries: 0,
              timeoutMs: 10000,
            },
          ],
        });

        this.flashLoanManager = new FlashLoanManager({
          preferredProvider: 'uniswap-v3' as any,
          maxBorrowAmountUsd: 1000000, // $1M max
          enableSplitting: true,
          maxSplits: 3,
          feeThresholdBps: 50, // 0.5% max fee
          capacityRefreshIntervalMs: 30000,
          enableFallback: true,
          providers: {
            'uniswap-v3': {
              enabled: true,
              feeRate: 0.0005,
              factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as any,
              quoterAddress: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as any,
            },
            balancer: {
              enabled: true,
              feeRate: 0.0001,
              vaultAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as any,
            },
            aave: {
              enabled: true,
              feeRate: 0.0009,
              poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as any,
            },
          },
        });

        this.transactionLifecycleManager = new TransactionLifecycleManager(provider, signer, {
          maxSubmissionAttempts: 3,
          submissionRetryDelayMs: 5000,
          confirmationTimeoutMs: 60000,
          confirmationBlocks: 1,
          enableSimulation: true,
          enableReplacement: true,
          enableNonceManagement: true,
        });

        // Get Flash Executor contract address from environment or config
        const flashExecutorAddress =
          process.env['FLASH_EXECUTOR_ADDRESS'] ||
          (rawConfig as any).contracts?.flashExecutor?.address;

        if (!flashExecutorAddress) {
          throw new Error('Flash Executor contract address not configured');
        }

        // Initialize Flash Loan Arbitrage Engine
        this.flashLoanArbitrageEngine = new FlashLoanArbitrageEngine(
          this.opportunityStateMachine,
          this.flashLoanManager,
          this.transactionLifecycleManager,
          {
            flashExecutorAddress: flashExecutorAddress as any,
            maxSlippageBps: 250, // 2.5%
            minProfitThresholdUsd: 5.0,
            gasOptimizationEnabled: true,
            enableProfitValidation: true,
            maxRouteHops: 3,
            enableMultiDexRouting: true,
            supportedDexes: ['uniswap-v3', 'aerodrome'],
          }
        );

        // Initialize execution orchestrator
        this.executionOrchestrator = new ExecutionOrchestrator(
          {
            maxConcurrentExecutions: this.config.execution.maxConcurrentExecutions,
            enableCircuitBreaker: true,
            circuitBreakerThreshold: 3,
            circuitBreakerRecoveryTimeMs: 300000, // 5 minutes
            executionTimeoutMs: 45000,
            queueMaxSize: 100,
            enableGracefulShutdown: true,
            shutdownTimeoutMs: 30000,
          },
          this.opportunityStateMachine
        );

        // Register the Flash Loan Arbitrage Engine
        this.executionOrchestrator.registerExecutionEngine(
          OpportunityType.ARBITRAGE,
          this.flashLoanArbitrageEngine
        );

        this.platformLogger.info('Flash Loan Arbitrage Engine registered successfully');

        // Set up execution event handlers
        this.executionOrchestrator.on('executionSuccess', ({ opportunity, result }) => {
          this.platformLogger.info('Opportunity executed successfully', {
            opportunityId: opportunity.id,
            profit: result.profit?.toString(),
            gasUsed: result.gasUsed?.toString(),
            executionTime: result.executionTime,
          });

          // Update metrics
          if (result.profit && result.gasUsed) {
            this.metricsCollector.recordOpportunitySuccess(
              RelayProvider.FLASHBOTS_PROTECT,
              result.profit,
              result.gasUsed,
              0n, // bribe
              Date.now(),
              result.executionTime || 0
            );
          }
        });

        this.executionOrchestrator.on('executionFailure', ({ opportunity, result }) => {
          this.platformLogger.warn('Opportunity execution failed', {
            opportunityId: opportunity.id,
            reason: result.failureReason,
            gasUsed: result.gasUsed?.toString(),
          });

          // Update metrics
          this.metricsCollector.recordOpportunityFailure(
            RelayProvider.FLASHBOTS_PROTECT,
            result.failureReason || 'Unknown error',
            result.gasUsed || 0n
          );
        });

        // Set up circuit breaker events
        this.executionOrchestrator.on('circuitBreakerActivated', ({ reason }) => {
          this.platformLogger.error('Execution circuit breaker activated', { reason });
          // Emit event that AlertingSystem will pick up through its monitoring
          this.emit('executionCircuitBreakerActivated', { reason });
        });

        this.executionOrchestrator.on('circuitBreakerRecovered', () => {
          this.platformLogger.info('Execution circuit breaker recovered');
          // Emit event that AlertingSystem will pick up through its monitoring
          this.emit('executionCircuitBreakerRecovered');
        });

        this.platformLogger.info('Execution engine initialized successfully', {
          flashExecutorAddress,
          signerAddress: await signer.getAddress(),
          registeredEngines: ['arbitrage'],
          privateRelayEnabled: !!this.privateRelayManager,
          enabledRelays: this.privateRelayManager
            ? Object.keys(this.privateRelayManager.getRelayMetrics())
            : [],
        });

        // Set up private relay manager event handlers
        if (this.privateRelayManager) {
          this.privateRelayManager.on(
            'transactionSubmitted',
            ({ relayProvider, transactionHash, latency }) => {
              this.platformLogger.info('Transaction submitted via private relay', {
                relay: relayProvider,
                txHash: transactionHash,
                latency,
              });
            }
          );

          this.privateRelayManager.on(
            'transactionFailed',
            ({ relayProvider, reason, retryCount }) => {
              this.platformLogger.warn('Private relay transaction failed', {
                relay: relayProvider,
                reason,
                retryCount,
              });
            }
          );

          this.privateRelayManager.on('relayUnavailable', ({ relayProvider, reason }) => {
            this.platformLogger.error('Private relay unavailable', {
              relay: relayProvider,
              reason,
            });
          });

          this.privateRelayManager.on(
            'fallbackActivated',
            ({ originalRelay, fallbackRelay, reason }) => {
              this.platformLogger.warn('Private relay fallback activated', {
                originalRelay,
                fallbackRelay,
                reason,
              });
            }
          );
        }
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'execution-engine-initialization',
        });
        throw new Error(
          `Failed to initialize execution engine: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.platformLogger.warn('Platform is already running');
      return;
    }

    return globalPerformanceTracker.trackOperation('platform-startup', async () => {
      this.platformLogger.info('Starting Base MEV Platform...');

      // Start health check server
      try {
        await this.healthServer.start();
        this.platformLogger.info('Health check server started successfully');
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'health-server-startup',
        });
        // Don't throw - health server is optional
        this.platformLogger.warn('Continuing without health check server');
      }

      // Start phase-specific components
      await this.startPhaseComponents();

      // Update health check with active phases
      this.healthCheckSystem.updateActivePhases(this.getActivePhases());

      this.isRunning = true;
      this.platformLogger.info('Base MEV Platform started successfully', {
        activePhases: this.getActivePhases(),
        gracefulDegradation: this.config?.gracefulDegradation.enabled,
      });

      // Emit ready event
      this.emit('ready');

      // Start opportunity simulation for demonstration
      this.simulateMultiPhaseActivity();
    });
  }

  private async startPhaseComponents(): Promise<void> {
    if (!this.config) return;

    // Start Phase 1: Arbitrage scanning
    if (this.config.phases.arbitrage.enabled && this.arbitrageScanner) {
      this.platformLogger.info('Starting arbitrage scanning');
      try {
        await this.arbitrageScanner.startScanning();
        this.platformLogger.info('Arbitrage scanner started successfully');
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'arbitrage-scanner-startup',
        });
        throw error;
      }
    }

    // Start mempool monitoring
    if (this.config.phases.arbitrage.enabled && this.mempoolMonitor) {
      this.platformLogger.info('Starting mempool monitoring');
      try {
        await this.mempoolMonitor.startMonitoring();
        this.platformLogger.info('Mempool monitoring started successfully');
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'mempool-monitor-startup',
        });
        // Don't throw - mempool monitoring is optional
        this.platformLogger.warn('Continuing without mempool monitoring');
      }
    }

    // Start Phase 2: Liquidation monitoring
    if (this.config.phases.liquidations.enabled && this.lendingMonitor) {
      this.platformLogger.info('Starting liquidation monitoring');
      this.lendingMonitor.startScanning();
    }

    // Start Phase 3: Stable pool monitoring
    if (this.config.phases.stablePoolRebalancing.enabled && this.stablePoolMonitor) {
      this.platformLogger.info('Starting stable pool monitoring');
      this.stablePoolMonitor.startScanning();
    }

    // Start Execution Engine
    if (this.config.featureFlags.enableExecutionEngine && this.executionOrchestrator) {
      this.platformLogger.info('Starting execution engine');
      try {
        // Start private relay manager first
        if (this.privateRelayManager) {
          await this.privateRelayManager.start();
          this.platformLogger.info('Private relay manager started');
        }

        // Start transaction lifecycle manager
        if (this.transactionLifecycleManager) {
          await this.transactionLifecycleManager.start();
          this.platformLogger.info('Transaction lifecycle manager started');
        }

        // Start flash loan manager
        if (this.flashLoanManager) {
          await this.flashLoanManager.start();
          this.platformLogger.info('Flash loan manager started');
        }

        // Start execution orchestrator
        await this.executionOrchestrator.start();
        this.platformLogger.info('Execution orchestrator started successfully');

        this.platformLogger.info('Execution engine started successfully');
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'execution-engine-startup',
        });
        throw error;
      }
    }

    this.platformLogger.info('All enabled phase components started');
  }

  private async handleArbitrageOpportunity(opportunity: any): Promise<void> {
    try {
      const operationId = `arbitrage-${opportunity.id}`;
      this.platformLogger.startPerformanceTracking(operationId);

      // Check circuit breaker
      const canExecute = await new Promise<boolean>(resolve => {
        this.circuitBreaker
          .execute(async () => {
            resolve(true);
            return true;
          })
          .catch(() => resolve(false));
      });

      if (!canExecute) {
        this.platformLogger.warn('Circuit breaker open, skipping arbitrage opportunity', {
          opportunityId: opportunity.id,
        });
        return;
      }

      // Validate profit threshold (placeholder for now - will be enhanced in later tasks)
      const minProfitUSD = 15.0; // Updated threshold for Base L2
      if (opportunity.expectedProfitUSD && opportunity.expectedProfitUSD < minProfitUSD) {
        this.platformLogger.debug('Opportunity below profit threshold', {
          opportunityId: opportunity.id,
          expectedProfit: opportunity.expectedProfitUSD,
          minProfit: minProfitUSD,
        });
        return;
      }

      this.platformLogger.info('Profitable arbitrage opportunity found', {
        opportunityId: opportunity.id,
        route: opportunity.route,
        expectedProfit: opportunity.expectedProfitUSD,
        spread: opportunity.spread,
      });

      // Execute opportunity using execution engine
      if (this.executionOrchestrator && this.config?.execution?.enabled) {
        try {
          await this.executionOrchestrator.processOpportunity(opportunity);
          this.platformLogger.info('Arbitrage opportunity submitted for execution', {
            opportunityId: opportunity.id,
          });
        } catch (error) {
          this.platformLogger.warn('Failed to submit arbitrage opportunity for execution', {
            opportunityId: opportunity.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // Fallback: Record successful opportunity detection for metrics
        this.metricsCollector.recordOpportunitySuccess(
          RelayProvider.FLASHBOTS_PROTECT,
          BigInt(Math.floor((opportunity.expectedProfitUSD || 0) * 1e18)),
          BigInt(Math.floor((opportunity.estimatedGasCost || 0) * 1e18)),
          0n, // bribe
          Date.now(),
          2000 // latency
        );
      }

      this.platformLogger.endPerformanceTracking(operationId);
    } catch (error) {
      this.platformLogger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'arbitrage-processing',
      });
    }
  }

  private async handleMempoolOpportunity(opportunity: any): Promise<void> {
    try {
      const operationId = `mempool-${opportunity.id}`;
      this.platformLogger.startPerformanceTracking(operationId);

      // Check circuit breaker
      const canExecute = await new Promise<boolean>(resolve => {
        this.circuitBreaker
          .execute(async () => {
            resolve(true);
            return true;
          })
          .catch(() => resolve(false));
      });

      if (!canExecute) {
        this.platformLogger.warn('Circuit breaker open, skipping mempool opportunity', {
          opportunityId: opportunity.id,
        });
        return;
      }

      // Check if backrun is profitable
      if (opportunity.backrunProfit && opportunity.backrunProfit > 0n) {
        this.platformLogger.info('Profitable backrun opportunity detected', {
          opportunityId: opportunity.id,
          txHash: opportunity.txHash,
          protocol: opportunity.dexProtocol,
          backrunProfit: ethers.formatEther(opportunity.backrunProfit),
          gasPrice: ethers.formatUnits(opportunity.gasPrice, 'gwei'),
        });

        // Record opportunity
        this.metricsCollector.recordOpportunitySuccess(
          RelayProvider.FLASHBOTS_PROTECT,
          opportunity.backrunProfit,
          BigInt(Math.floor(Number(opportunity.gasPrice) * Number(opportunity.gasLimit))),
          0n, // bribe
          Date.now(),
          1000 // latency
        );
      }

      this.platformLogger.endPerformanceTracking(operationId);
    } catch (error) {
      this.platformLogger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'mempool-processing',
      });
    }
  }

  private async handleLiquidationOpportunity(opportunity: any): Promise<void> {
    if (!this.liquidationCalculator) return;

    try {
      const operationId = `liquidation-${opportunity.id}`;
      this.platformLogger.startPerformanceTracking(operationId);

      // Check circuit breaker
      const canExecute = await new Promise<boolean>(resolve => {
        this.circuitBreaker
          .execute(async () => {
            resolve(true);
            return true;
          })
          .catch(() => resolve(false));
      });

      if (!canExecute) {
        this.platformLogger.warn('Circuit breaker open, skipping liquidation opportunity', {
          opportunityId: opportunity.id,
        });
        return;
      }

      // Calculate profitability
      const calculation = await this.liquidationCalculator.calculateLiquidationProfit(opportunity);

      if (calculation.profitable) {
        this.platformLogger.info('Profitable liquidation opportunity found', {
          opportunityId: opportunity.id,
          protocol: opportunity.protocol,
          netProfit: calculation.netProfit.toString(),
          riskScore: calculation.riskScore,
        });

        // Record successful opportunity
        this.metricsCollector.recordOpportunitySuccess(
          RelayProvider.FLASHBOTS_PROTECT,
          calculation.netProfit,
          calculation.gasCost,
          0n, // bribe
          Date.now(),
          3000 // latency
        );
      }

      this.platformLogger.endPerformanceTracking(operationId);
    } catch (error) {
      this.platformLogger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'liquidation-processing',
      });
    }
  }

  private async handleStablePoolOpportunity(opportunity: any): Promise<void> {
    if (!this.stablePoolCalculator) return;

    try {
      const operationId = `stable-rebalance-${opportunity.id}`;
      this.platformLogger.startPerformanceTracking(operationId);

      // Check circuit breaker
      const canExecute = await new Promise<boolean>(resolve => {
        this.circuitBreaker
          .execute(async () => {
            resolve(true);
            return true;
          })
          .catch(() => resolve(false));
      });

      if (!canExecute) {
        this.platformLogger.warn('Circuit breaker open, skipping stable pool opportunity', {
          opportunityId: opportunity.id,
        });
        return;
      }

      // Calculate profitability
      const calculation = await this.stablePoolCalculator.calculateRebalancingProfit(opportunity);

      if (calculation.profitable) {
        this.platformLogger.info('Profitable stable pool rebalancing opportunity found', {
          opportunityId: opportunity.id,
          poolAddress: opportunity.poolAddress,
          netProfit: calculation.netProfit.toString(),
          priceImpact: `${(calculation.priceImpact * 100).toFixed(3)}%`,
          riskScore: calculation.riskScore,
        });

        // Record successful opportunity
        this.metricsCollector.recordOpportunitySuccess(
          RelayProvider.LOCAL_NODE,
          calculation.netProfit,
          calculation.gasCost,
          0n, // bribe
          Date.now(),
          2000 // latency
        );
      }

      this.platformLogger.endPerformanceTracking(operationId);
    } catch (error) {
      this.platformLogger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'stable-pool-processing',
      });
    }
  }

  private handleGracefulDegradation(): void {
    if (!this.config?.gracefulDegradation.enabled) return;

    this.platformLogger.warn('Initiating graceful degradation due to circuit breaker activation');

    if (this.config.gracefulDegradation.fallbackToArbitrageOnly) {
      // Disable Phase 2 and 3 temporarily
      if (this.lendingMonitor) {
        this.lendingMonitor.stopScanning();
        this.platformLogger.info('Disabled liquidation monitoring for graceful degradation');
      }

      if (this.stablePoolMonitor) {
        this.stablePoolMonitor.stopScanning();
        this.platformLogger.info('Disabled stable pool monitoring for graceful degradation');
      }

      // Continue with Phase 1 (arbitrage) only
      this.platformLogger.info('Platform operating in degraded mode: arbitrage only');
    }
  }

  private simulateMultiPhaseActivity(): void {
    // Simulate opportunities across all phases for demonstration
    let opportunityCounter = 0;

    setInterval(() => {
      opportunityCounter++;
      const phaseType = opportunityCounter % 3;

      if (phaseType === 0) {
        // Simulate Phase 1: Arbitrage opportunity
        this.simulateArbitrageOpportunity();
      } else if (phaseType === 1 && this.config?.phases.liquidations.enabled) {
        // Simulate Phase 2: Liquidation opportunity
        this.simulateLiquidationOpportunity();
      } else if (phaseType === 2 && this.config?.phases.stablePoolRebalancing.enabled) {
        // Simulate Phase 3: Stable pool opportunity
        this.simulateStablePoolOpportunity();
      }
    }, 8000); // Every 8 seconds
  }

  private simulateArbitrageOpportunity(): void {
    // In production, this would be triggered by real arbitrage scanner events
    // For now, we'll use the real arbitrage scanner to detect opportunities
    if (this.arbitrageScanner) {
      // The arbitrage scanner will emit real opportunities when pools are monitored
      this.platformLogger.debug(
        'Arbitrage scanner is active and monitoring for real opportunities'
      );
    } else {
      this.platformLogger.warn(
        'Arbitrage scanner not initialized - no opportunities will be detected'
      );
    }
  }

  private simulateLiquidationOpportunity(): void {
    // In production, this would be triggered by real lending monitor events
    // The lending monitor will emit real liquidation opportunities when detected
    if (this.lendingMonitor) {
      this.platformLogger.debug(
        'Lending monitor is active and scanning for real liquidation opportunities'
      );
    } else {
      this.platformLogger.warn(
        'Lending monitor not initialized - no liquidation opportunities will be detected'
      );
    }
  }

  private simulateStablePoolOpportunity(): void {
    // In production, this would be triggered by real stable pool monitor events
    // The stable pool monitor will emit real rebalancing opportunities when detected
    if (this.stablePoolMonitor) {
      this.platformLogger.debug(
        'Stable pool monitor is active and scanning for real rebalancing opportunities'
      );
    } else {
      this.platformLogger.warn(
        'Stable pool monitor not initialized - no rebalancing opportunities will be detected'
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.platformLogger.warn('Platform is not running');
      return;
    }

    return globalPerformanceTracker.trackOperation('platform-shutdown', async () => {
      this.platformLogger.info('Stopping Base MEV Platform...');

      // Stop Phase 1: Arbitrage scanner
      if (this.arbitrageScanner) {
        this.platformLogger.info('Stopping arbitrage scanner');
        await this.arbitrageScanner.stopScanning();
      }

      // Stop mempool monitoring
      if (this.mempoolMonitor) {
        this.platformLogger.info('Stopping mempool monitoring');
        this.mempoolMonitor.stopMonitoring();
      }

      // Stop Phase 2: Liquidation monitoring
      if (this.lendingMonitor) {
        this.lendingMonitor.stopScanning();
      }

      // Stop Phase 3: Stable pool monitoring
      if (this.stablePoolMonitor) {
        this.stablePoolMonitor.stopScanning();
      }

      // Stop Execution Engine
      if (this.executionOrchestrator) {
        this.platformLogger.info('Stopping execution engine');
        try {
          // Stop execution orchestrator first
          await this.executionOrchestrator.stop();
          this.platformLogger.info('Execution orchestrator stopped');

          // Stop transaction lifecycle manager
          if (this.transactionLifecycleManager) {
            await this.transactionLifecycleManager.stop();
            this.platformLogger.info('Transaction lifecycle manager stopped');
          }

          // Stop flash loan manager
          if (this.flashLoanManager) {
            await this.flashLoanManager.stop();
            this.platformLogger.info('Flash loan manager stopped');
          }

          // Stop private relay manager
          if (this.privateRelayManager) {
            await this.privateRelayManager.stop();
            this.platformLogger.info('Private relay manager stopped');
          }

          this.platformLogger.info('Execution engine stopped successfully');
        } catch (error) {
          this.platformLogger.logError(error as Error, {
            operation: 'execution-engine-shutdown',
          });
        }
      }

      // Stop health check system
      this.healthCheckSystem.stop();

      // Stop health check server
      try {
        await this.healthServer.stop();
        this.platformLogger.info('Health check server stopped');
      } catch (error) {
        this.platformLogger.logError(error as Error, {
          operation: 'health-server-shutdown',
        });
      }

      this.isRunning = false;
      this.platformLogger.info('Base MEV Platform stopped successfully');

      // Emit stopped event
      this.emit('stopped');
    });
  }

  getMetrics() {
    return {
      opportunities: this.metricsCollector.getOpportunityMetrics(),
      profit: this.metricsCollector.getProfitMetrics(),
      performance: this.metricsCollector.getPerformanceMetrics(),
      relays: this.metricsCollector.getRelayMetrics(),
      systemHealth: this.metricsCollector.getSystemHealthMetrics(),
    };
  }

  getActivePhases(): string[] {
    if (!this.config) return [];

    return Object.entries(this.config.phases)
      .filter(([name, phase]) => {
        // Use both name and phase in the filter logic
        this.platformLogger.debug(`Checking phase ${name}`, {
          enabled: phase.enabled,
          priority: phase.priority,
        });
        return phase.enabled;
      })
      .map(([name, phase]) => {
        // Use phase data for additional context
        return `${name}(priority:${phase.priority})`;
      });
  }

  isHealthy(): boolean {
    return this.isRunning;
  }

  // Configuration management
  async updatePhaseConfig(phase: keyof PlatformConfig['phases'], enabled: boolean): Promise<void> {
    if (!this.config) throw new Error('Platform not initialized');

    this.config.phases[phase].enabled = enabled;

    this.platformLogger.info('Phase configuration updated', {
      phase,
      enabled,
      activePhases: this.getActivePhases(),
    });

    // Restart components if needed
    if (this.isRunning) {
      await this.startPhaseComponents();
    }
  }

  getConfiguration(): PlatformConfig | undefined {
    return this.config;
  }
}

async function main(): Promise<void> {
  const platform = new BaseMEVPlatform();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await platform.stop();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Initialize and start the platform
    await platform.initialize();
    await platform.start();

    // Log periodic health status
    setInterval(() => {
      const metrics = platform.getMetrics();
      logger.info('Platform health check', {
        healthy: platform.isHealthy(),
        opportunities: metrics.opportunities.totalOpportunities,
        winRate: metrics.opportunities.winRate,
        totalProfit: metrics.profit.totalProfitUSD,
        activePhases: platform.getActivePhases(),
      });
    }, 60000); // Every minute
  } catch (error) {
    logger.error('Failed to start Base MEV Platform:', error);
    process.exit(1);
  }
}

// Start the application
main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});
