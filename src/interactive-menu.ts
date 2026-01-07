/* eslint-disable no-console, no-constant-condition, no-case-declarations */
/**
 * Interactive Menu System for Base MEV Platform
 *
 * Allows users to select which strategies to run via CLI interface
 * Perfect for focusing on specific strategies like arbitrage
 */

import readline from 'readline';
import chalk from 'chalk';
import { BaseMEVPlatform } from './index';
import { logger } from './utils/logger';
import { InteractiveConfigManager, InteractiveConfig } from './config/interactive-config';

interface StrategyOption {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  capitalRequired: string;
  riskLevel: 'Low' | 'Medium' | 'High';
  avgProfit: string;
}

interface MenuConfig {
  strategies: StrategyOption[];
  executionMode: 'live' | 'paper' | 'dry-run';
  riskSettings: {
    maxSlippage: number;
    maxGasPrice: string;
    dailyLossLimit: string;
  };
}

export class InteractiveMenu {
  private rl: readline.Interface;
  private config: MenuConfig;
  private platform?: BaseMEVPlatform;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.config = {
      strategies: [
        {
          key: 'arbitrage',
          name: 'Cross-DEX Arbitrage',
          description: 'Flash loan arbitrage between Uniswap V3 and Aerodrome',
          enabled: true,
          capitalRequired: '0 ETH (Flash loans only)',
          riskLevel: 'Low',
          avgProfit: '$15-50 per trade',
        },
        {
          key: 'liquidations',
          name: 'Lending Liquidations',
          description: 'Liquidate unhealthy positions on Moonwell, Aave V3, Seamless',
          enabled: false,
          capitalRequired: '0 ETH (Flash loans only)',
          riskLevel: 'Medium',
          avgProfit: '$25-100 per trade',
        },
        {
          key: 'stablePoolRebalancing',
          name: 'Stable Pool Rebalancing',
          description: 'Rebalance imbalanced stable pools on Aerodrome',
          enabled: false,
          capitalRequired: '0 ETH (Flash loans only)',
          riskLevel: 'Low',
          avgProfit: '$10-30 per trade',
        },
        {
          key: 'mempoolBackrun',
          name: 'Mempool Backruns',
          description: 'Ethical backrun opportunities from pending transactions',
          enabled: false,
          capitalRequired: '0 ETH (Flash loans only)',
          riskLevel: 'Medium',
          avgProfit: '$20-80 per trade',
        },
      ],
      executionMode: 'paper', // Default to paper trading for safety
      riskSettings: {
        maxSlippage: 2.5, // 2.5%
        maxGasPrice: '50 gwei',
        dailyLossLimit: '0.1 ETH',
      },
    };
  }

  async start(): Promise<void> {
    console.clear();
    this.printHeader();

    await this.showMainMenu();
  }

  private printHeader(): void {
    console.log(
      chalk.cyan.bold('╔══════════════════════════════════════════════════════════════╗')
    );
    console.log(
      chalk.cyan.bold('║                    Base MEV Platform                         ║')
    );
    console.log(
      chalk.cyan.bold('║                  Interactive Strategy Menu                   ║')
    );
    console.log(
      chalk.cyan.bold('╚══════════════════════════════════════════════════════════════╝')
    );
    console.log();
    console.log(
      chalk.yellow('Focus Mode: Perfect for testing arbitrage with zero capital requirements')
    );
    console.log(chalk.gray('   All strategies use flash loans - no upfront capital needed!'));
    console.log();
  }

  private async showMainMenu(): Promise<void> {
    while (true) {
      console.log(chalk.blue.bold('MAIN MENU'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log('1. Configure Strategies');
      console.log('2. Execution Mode Settings');
      console.log('3. Risk Management Settings');
      console.log('4. View Current Configuration');
      console.log('5. Start Platform');
      console.log('6. Exit');
      console.log();

      const choice = await this.prompt(chalk.cyan('Select option (1-6): '));

      switch (choice.trim()) {
        case '1':
          await this.configureStrategies();
          break;
        case '2':
          await this.configureExecutionMode();
          break;
        case '3':
          await this.configureRiskSettings();
          break;
        case '4':
          this.showCurrentConfig();
          break;
        case '5':
          await this.startPlatform();
          return;
        case '6':
          console.log(chalk.yellow('Goodbye!'));
          process.exit(0);
          break;
        default:
          console.log(chalk.red('Invalid option. Please try again.'));
          break;
      }

      console.log();
    }
  }

  private async configureStrategies(): Promise<void> {
    console.clear();
    this.printHeader();

    console.log(chalk.blue.bold('STRATEGY CONFIGURATION'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.yellow('All strategies use flash loans - no capital required!'));
    console.log();

    // Show current strategy status
    this.config.strategies.forEach((strategy, index) => {
      const status = strategy.enabled ? chalk.green('ENABLED') : chalk.red('DISABLED');
      const risk = this.getRiskColor(strategy.riskLevel);

      console.log(`${index + 1}. ${chalk.bold(strategy.name)} ${status}`);
      console.log(`   ${chalk.gray(strategy.description)}`);
      console.log(
        `   Capital: ${chalk.cyan(strategy.capitalRequired)} | Risk: ${risk} | Profit: ${chalk.green(strategy.avgProfit)}`
      );
      console.log();
    });

    console.log(chalk.yellow('Options:'));
    console.log('• Enter strategy number (1-4) to toggle');
    console.log('• Type "all" to enable all strategies');
    console.log('• Type "none" to disable all strategies');
    console.log('• Type "arbitrage-only" for arbitrage focus mode');
    console.log('• Type "back" to return to main menu');
    console.log();

    const choice = await this.prompt(chalk.cyan('Your choice: '));

    switch (choice.trim().toLowerCase()) {
      case 'back':
        return;
      case 'all':
        this.config.strategies.forEach(s => (s.enabled = true));
        console.log(chalk.green('All strategies enabled'));
        break;
      case 'none':
        this.config.strategies.forEach(s => (s.enabled = false));
        console.log(chalk.yellow('All strategies disabled'));
        break;
      case 'arbitrage-only':
        this.config.strategies.forEach(s => (s.enabled = s.key === 'arbitrage'));
        console.log(chalk.green('Arbitrage-only mode activated (recommended for beginners)'));
        break;
      default:
        const strategyIndex = parseInt(choice) - 1;
        if (strategyIndex >= 0 && strategyIndex < this.config.strategies.length) {
          const strategy = this.config.strategies[strategyIndex];
          if (strategy) {
            strategy.enabled = !strategy.enabled;
            const status = strategy.enabled ? 'enabled' : 'disabled';
            console.log(chalk.green(`${strategy.name} ${status}`));
          }
        } else {
          console.log(chalk.red('Invalid strategy number'));
        }
    }

    await this.prompt(chalk.gray('Press Enter to continue...'));
  }

  private async configureExecutionMode(): Promise<void> {
    console.clear();
    this.printHeader();

    console.log(chalk.blue.bold('EXECUTION MODE SETTINGS'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    console.log('1. Dry Run Mode - Detection only, no transactions');
    console.log('2. Paper Trading - Simulate execution without signing');
    console.log('3. Live Trading - Real transactions with real money');
    console.log();

    console.log(chalk.yellow('Current mode:'), this.getExecutionModeDisplay());
    console.log();

    const choice = await this.prompt(chalk.cyan('Select mode (1-3) or "back": '));

    switch (choice.trim()) {
      case '1':
        this.config.executionMode = 'dry-run';
        console.log(chalk.green('Dry run mode selected - Safe for testing'));
        break;
      case '2':
        this.config.executionMode = 'paper';
        console.log(chalk.green('Paper trading mode selected - Simulation only'));
        break;
      case '3':
        console.log(chalk.red.bold('WARNING: Live trading mode selected!'));
        console.log(chalk.red('This will execute real transactions with real money.'));
        const confirm = await this.prompt(chalk.yellow('Type "CONFIRM" to proceed: '));
        if (confirm.trim() === 'CONFIRM') {
          this.config.executionMode = 'live';
          console.log(chalk.red('Live trading mode activated'));
        } else {
          console.log(chalk.yellow('Live trading cancelled'));
        }
        break;
      case 'back':
        return;
      default:
        console.log(chalk.red('Invalid option'));
    }

    await this.prompt(chalk.gray('Press Enter to continue...'));
  }

  private async configureRiskSettings(): Promise<void> {
    console.clear();
    this.printHeader();

    console.log(chalk.blue.bold('RISK MANAGEMENT SETTINGS'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    console.log('Current settings:');
    console.log(`• Max Slippage: ${chalk.cyan(this.config.riskSettings.maxSlippage + '%')}`);
    console.log(`• Max Gas Price: ${chalk.cyan(this.config.riskSettings.maxGasPrice)}`);
    console.log(`• Daily Loss Limit: ${chalk.cyan(this.config.riskSettings.dailyLossLimit)}`);
    console.log();

    console.log('1. Modify Max Slippage');
    console.log('2. Modify Max Gas Price');
    console.log('3. Modify Daily Loss Limit');
    console.log('4. Reset to Conservative Defaults');
    console.log('5. Back to Main Menu');
    console.log();

    const choice = await this.prompt(chalk.cyan('Select option (1-5): '));

    switch (choice.trim()) {
      case '1':
        const slippage = await this.prompt('Enter max slippage % (0.1-10): ');
        const slippageNum = parseFloat(slippage);
        if (slippageNum >= 0.1 && slippageNum <= 10) {
          this.config.riskSettings.maxSlippage = slippageNum;
          console.log(chalk.green(`Max slippage set to ${slippageNum}%`));
        } else {
          console.log(chalk.red('Invalid slippage value'));
        }
        break;
      case '2':
        const gasPrice = await this.prompt('Enter max gas price (e.g., "50 gwei"): ');
        if (gasPrice.includes('gwei') || gasPrice.includes('wei')) {
          this.config.riskSettings.maxGasPrice = gasPrice;
          console.log(chalk.green(`Max gas price set to ${gasPrice}`));
        } else {
          console.log(chalk.red('Invalid gas price format'));
        }
        break;
      case '3':
        const lossLimit = await this.prompt('Enter daily loss limit (e.g., "0.1 ETH"): ');
        if (lossLimit.includes('ETH')) {
          this.config.riskSettings.dailyLossLimit = lossLimit;
          console.log(chalk.green(`Daily loss limit set to ${lossLimit}`));
        } else {
          console.log(chalk.red('Invalid loss limit format'));
        }
        break;
      case '4':
        this.config.riskSettings = {
          maxSlippage: 1.0,
          maxGasPrice: '30 gwei',
          dailyLossLimit: '0.05 ETH',
        };
        console.log(chalk.green('Risk settings reset to conservative defaults'));
        break;
      case '5':
        return;
      default:
        console.log(chalk.red('Invalid option'));
    }

    await this.prompt(chalk.gray('Press Enter to continue...'));
  }

  private showCurrentConfig(): void {
    console.clear();
    this.printHeader();

    console.log(chalk.blue.bold('CURRENT CONFIGURATION'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    // Enabled strategies
    const enabledStrategies = this.config.strategies.filter(s => s.enabled);
    console.log(chalk.green.bold('ENABLED STRATEGIES:'));
    if (enabledStrategies.length === 0) {
      console.log(chalk.red('   No strategies enabled!'));
    } else {
      enabledStrategies.forEach(strategy => {
        console.log(`   • ${strategy.name} (${this.getRiskColor(strategy.riskLevel)})`);
      });
    }
    console.log();

    // Execution mode
    console.log(chalk.blue.bold('EXECUTION MODE:'));
    console.log(`   ${this.getExecutionModeDisplay()}`);
    console.log();

    // Risk settings
    console.log(chalk.yellow.bold('RISK SETTINGS:'));
    console.log(`   • Max Slippage: ${this.config.riskSettings.maxSlippage}%`);
    console.log(`   • Max Gas Price: ${this.config.riskSettings.maxGasPrice}`);
    console.log(`   • Daily Loss Limit: ${this.config.riskSettings.dailyLossLimit}`);
    console.log();

    // Capital requirements summary
    console.log(chalk.cyan.bold('CAPITAL REQUIREMENTS:'));
    console.log('   • Flash Loan Fees: ~0.05% per trade');
    console.log('   • Gas Costs: ~$2-5 per transaction on Base');
    console.log('   • No upfront capital needed!');
    console.log();

    this.prompt(chalk.gray('Press Enter to continue...'));
  }

  private async startPlatform(): Promise<void> {
    console.clear();
    this.printHeader();

    console.log(chalk.green.bold('STARTING BASE MEV PLATFORM'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    // Show final configuration
    const enabledStrategies = this.config.strategies.filter(s => s.enabled);
    console.log('Starting with configuration:');
    console.log(`• Strategies: ${enabledStrategies.map(s => s.name).join(', ')}`);
    console.log(`• Mode: ${this.getExecutionModeDisplay()}`);
    console.log(`• Max Slippage: ${this.config.riskSettings.maxSlippage}%`);
    console.log();

    if (enabledStrategies.length === 0) {
      console.log(chalk.red('No strategies enabled! Please configure strategies first.'));
      await this.prompt(chalk.gray('Press Enter to return to menu...'));
      return;
    }

    // Confirmation for live trading
    if (this.config.executionMode === 'live') {
      console.log(chalk.red.bold('FINAL WARNING: LIVE TRADING MODE'));
      console.log(chalk.red('This will execute real transactions with real money!'));
      const confirm = await this.prompt(chalk.yellow('Type "START LIVE TRADING" to proceed: '));
      if (confirm.trim() !== 'START LIVE TRADING') {
        console.log(chalk.yellow('Platform start cancelled'));
        await this.prompt(chalk.gray('Press Enter to return to menu...'));
        return;
      }
    }

    console.log(chalk.green('Configuration validated, starting platform...'));
    console.log();

    // Close readline interface
    this.rl.close();

    // Apply configuration and start platform
    await this.applyConfigurationAndStart();
  }

  private async applyConfigurationAndStart(): Promise<void> {
    try {
      // Create interactive configuration
      const interactiveConfig: InteractiveConfig = {
        phases: {
          arbitrage: {
            enabled: this.config.strategies.find(s => s.key === 'arbitrage')?.enabled || false,
            priority: 1,
          },
          liquidations: {
            enabled: this.config.strategies.find(s => s.key === 'liquidations')?.enabled || false,
            priority: 2,
          },
          stablePoolRebalancing: {
            enabled:
              this.config.strategies.find(s => s.key === 'stablePoolRebalancing')?.enabled || false,
            priority: 3,
          },
        },
        execution: {
          enabled: this.config.executionMode !== 'dry-run',
          mode: this.config.executionMode,
          maxSlippage: this.config.riskSettings.maxSlippage,
          maxGasPrice: this.config.riskSettings.maxGasPrice,
          dailyLossLimit: this.config.riskSettings.dailyLossLimit,
        },
        featureFlags: {
          enableMempoolBackrun:
            this.config.strategies.find(s => s.key === 'mempoolBackrun')?.enabled || false,
          enableLiquidationMonitoring:
            this.config.strategies.find(s => s.key === 'liquidations')?.enabled || false,
          enableStablePoolMonitoring:
            this.config.strategies.find(s => s.key === 'stablePoolRebalancing')?.enabled || false,
          enableExecutionEngine: this.config.executionMode !== 'dry-run',
        },
      };

      // Set configuration in manager and apply to environment
      const configManager = InteractiveConfigManager.getInstance();
      configManager.setConfig(interactiveConfig);
      configManager.applyToEnvironment();

      // Log startup information with configuration summary
      logger.info('Starting Base MEV Platform with interactive configuration', {
        configSummary: configManager.getConfigSummary(),
        enabledStrategies: this.config.strategies.filter(s => s.enabled).map(s => s.name),
        executionMode: this.config.executionMode,
        riskSettings: this.config.riskSettings,
      });

      // Import and start the main platform
      const { BaseMEVPlatform } = await import('./index');
      this.platform = new BaseMEVPlatform();

      await this.platform.initialize();
      await this.platform.start();

      console.log(chalk.green.bold('Platform started successfully!'));
      console.log(chalk.cyan('Monitor logs for opportunity detection and execution'));
      console.log(chalk.gray('Press Ctrl+C to stop the platform'));
    } catch (error) {
      console.error(chalk.red('Failed to start platform:'), error);
      process.exit(1);
    }
  }

  private getRiskColor(riskLevel: string): string {
    switch (riskLevel) {
      case 'Low':
        return chalk.green(riskLevel);
      case 'Medium':
        return chalk.yellow(riskLevel);
      case 'High':
        return chalk.red(riskLevel);
      default:
        return chalk.gray(riskLevel);
    }
  }

  private getExecutionModeDisplay(): string {
    switch (this.config.executionMode) {
      case 'dry-run':
        return chalk.blue('Dry Run (Detection only)');
      case 'paper':
        return chalk.yellow('Paper Trading (Simulation)');
      case 'live':
        return chalk.red('Live Trading (Real money)');
      default:
        return chalk.gray('Unknown');
    }
  }

  private prompt(question: string): Promise<string> {
    return new Promise(resolve => {
      this.rl.question(question, resolve);
    });
  }

  async cleanup(): Promise<void> {
    this.rl.close();
    if (this.platform) {
      await this.platform.stop();
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\nShutting down gracefully...'));
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(chalk.yellow('\nShutting down gracefully...'));
  process.exit(0);
});
