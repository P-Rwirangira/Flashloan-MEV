/**
 * Interactive Configuration Manager
 *
 * Manages configuration overrides from the interactive menu
 */

export interface InteractiveConfig {
  phases: {
    arbitrage: { enabled: boolean; priority: number };
    liquidations: { enabled: boolean; priority: number };
    stablePoolRebalancing: { enabled: boolean; priority: number };
  };
  execution: {
    enabled: boolean;
    mode: 'live' | 'paper' | 'dry-run';
    maxSlippage: number;
    maxGasPrice: string;
    dailyLossLimit: string;
  };
  featureFlags: {
    enableMempoolBackrun: boolean;
    enableLiquidationMonitoring: boolean;
    enableStablePoolMonitoring: boolean;
    enableExecutionEngine: boolean;
  };
}

export class InteractiveConfigManager {
  private static instance: InteractiveConfigManager;
  private config: InteractiveConfig | null = null;

  private constructor() {}

  static getInstance(): InteractiveConfigManager {
    if (!InteractiveConfigManager.instance) {
      InteractiveConfigManager.instance = new InteractiveConfigManager();
    }
    return InteractiveConfigManager.instance;
  }

  setConfig(config: InteractiveConfig): void {
    this.config = config;
  }

  getConfig(): InteractiveConfig | null {
    return this.config;
  }

  hasConfig(): boolean {
    return this.config !== null;
  }

  /**
   * Apply interactive configuration to the platform config
   */
  applyToEnvironment(): void {
    if (!this.config) return;

    // Set environment variables for execution mode
    process.env['MEV_DRY_RUN'] = (this.config.execution.mode === 'dry-run').toString();
    process.env['MEV_PAPER_TRADING'] = (this.config.execution.mode === 'paper').toString();

    // Set risk management environment variables
    process.env['MEV_MAX_SLIPPAGE'] = this.config.execution.maxSlippage.toString();
    process.env['MEV_MAX_GAS_PRICE'] = this.config.execution.maxGasPrice;
    process.env['MEV_DAILY_LOSS_LIMIT'] = this.config.execution.dailyLossLimit;

    // Set strategy flags
    process.env['MEV_ENABLE_ARBITRAGE'] = this.config.phases.arbitrage.enabled.toString();
    process.env['MEV_ENABLE_LIQUIDATIONS'] = this.config.phases.liquidations.enabled.toString();
    process.env['MEV_ENABLE_STABLE_POOLS'] =
      this.config.phases.stablePoolRebalancing.enabled.toString();
    process.env['MEV_ENABLE_MEMPOOL_BACKRUN'] =
      this.config.featureFlags.enableMempoolBackrun.toString();
  }

  /**
   * Get configuration summary for logging
   */
  getConfigSummary(): string {
    if (!this.config) return 'No interactive configuration set';

    const enabledStrategies = [];
    if (this.config.phases.arbitrage.enabled) enabledStrategies.push('Arbitrage');
    if (this.config.phases.liquidations.enabled) enabledStrategies.push('Liquidations');
    if (this.config.phases.stablePoolRebalancing.enabled) enabledStrategies.push('Stable Pools');
    if (this.config.featureFlags.enableMempoolBackrun) enabledStrategies.push('Mempool Backrun');

    return `Mode: ${this.config.execution.mode}, Strategies: [${enabledStrategies.join(', ')}], Max Slippage: ${this.config.execution.maxSlippage}%`;
  }
}
