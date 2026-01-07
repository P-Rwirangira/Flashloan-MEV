/**
 * DexScreener Runner
 * Standalone runner for DexScreener integration
 */

import { config } from 'dotenv';
config(); // Load environment variables from .env file

import { createDexScreenerIntegration } from './scanner/dexscreener-integration.js';
import { ConfigLoader } from './config/loader.js';
import { RpcConnectionManager } from './rpc/connection-manager.js';
import { logger } from './utils/logger.js';

export class DexScreenerRunner {
  private integration?: any;
  private connectionManager?: RpcConnectionManager;

  async start() {
    try {
      logger.info('Starting DexScreener runner');

      // Load configuration
      const configLoader = new ConfigLoader({
        configPath: 'config/default.yaml',
        envPrefix: '' // No prefix - use BASE_RPC_URL directly
      });
      const config = await configLoader.load();

      // Initialize RPC connection (for validation and execution only)
      this.connectionManager = new RpcConnectionManager({
        network: config.network,
        healthCheckIntervalMs: 30000,
        maxConsecutiveFailures: 3,
        requestTimeoutMs: 10000
      });

      await this.connectionManager.initialize();
      const provider = this.connectionManager.getProvider();

      // Create DexScreener integration
      logger.info('Initializing DexScreener integration');
      this.integration = createDexScreenerIntegration(config, provider);

      // Start monitoring
      logger.info('Starting DexScreener monitoring');
      await this.integration.start();

      // Log statistics periodically
      setInterval(() => {
        const stats = this.integration.getStats();
        logger.info('DexScreener statistics', {
          running: stats.isRunning,
          detected: stats.opportunitiesDetected,
          validated: stats.opportunitiesValidated,
          rejected: stats.opportunitiesRejected,
          executed: stats.opportunitiesExecuted,
          activePools: stats.monitorStats.activePools,
          avgLiquidity: stats.monitorStats.avgLiquidity.toFixed(0)
        });

        if (stats.crossDexStats) {
          logger.info('Cross-DEX scanner active', {
            scanning: stats.crossDexStats.isScanning,
            found: stats.crossDexStats.opportunitiesFound
          });
        }

        if (stats.multiHopStats) {
          logger.info('Multi-hop scanner active', {
            scanning: stats.multiHopStats.isScanning,
            found: stats.multiHopStats.opportunitiesFound
          });
        }

        if (stats.discoveryStats) {
          logger.info('Discovery active', {
            discovering: stats.discoveryStats.isDiscovering,
            totalDiscovered: stats.discoveryStats.totalDiscovered,
            topScore: stats.discoveryStats.topScore
          });
        }
      }, 30000); // Every 30 seconds

      logger.info('DexScreener runner started successfully');
      logger.info('Monitoring for arbitrage opportunities with ZERO RPC polling!');
      logger.info('Press Ctrl+C to stop');

    } catch (error) {
      logger.error('Failed to start DexScreener runner', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async stop() {
    logger.info('Stopping DexScreener runner');
    
    if (this.integration) {
      this.integration.stop();
    }

    if (this.connectionManager) {
      await this.connectionManager.shutdown();
    }

    logger.info('DexScreener runner stopped');
  }
}

// Run if executed directly
const runner = new DexScreenerRunner();

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await runner.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await runner.stop();
    process.exit(0);
  });

runner.start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
