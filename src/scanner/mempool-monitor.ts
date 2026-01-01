/**
 * Mempool Monitor
 *
 * Monitors pending transactions in the mempool for MEV opportunities
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';
import {
  PendingTxOpportunity,
  MempoolMonitorOptions,
  MempoolStats,
  SwapDetails,
} from '../types/mempool';
import { DexType } from '../types/dex';

// Uniswap V3 method signatures
const UNISWAP_V3_SIGNATURES = {
  exactInputSingle: '0x414bf389',
  exactInput: '0xc04b8d59',
  exactOutputSingle: '0xdb3e2198',
  exactOutput: '0xf28c0498',
  multicall: '0xac9650d8',
};

// Aerodrome method signatures
const AERODROME_SIGNATURES = {
  swapExactTokensForTokens: '0x38ed1739',
  swapTokensForExactTokens: '0x8803dbee',
  swapExactETHForTokens: '0x7ff36ab5',
  swapTokensForExactETH: '0x4a25d94a',
  swapExactTokensForETH: '0x18cbafe5',
  swapETHForExactTokens: '0xfb3bdb41',
};

export class MempoolMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('mempool-monitor');
  private readonly connectionManager: RpcConnectionManager;
  private readonly options: Required<Omit<MempoolMonitorOptions, 'connectionManager'>>;

  private isMonitoring = false;
  private pendingTxs: Map<string, PendingTxOpportunity> = new Map();
  private cleanupInterval?: NodeJS.Timeout | undefined;
  private statsInterval?: NodeJS.Timeout | undefined;
  private stats: MempoolStats = {
    totalPendingTxs: 0,
    dexSwapTxs: 0,
    backrunOpportunities: 0,
    frontrunOpportunities: 0,
    sandwichOpportunities: 0,
    avgGasPrice: 0n,
    memoryUsageMB: 0,
  };

  constructor(options: MempoolMonitorOptions) {
    super();
    this.connectionManager = options.connectionManager;
    this.options = {
      enabledProtocols: options.enabledProtocols,
      minGasPrice: options.minGasPrice ?? 0n,
      maxGasPrice: options.maxGasPrice ?? ethers.MaxUint256,
      minSwapValue: options.minSwapValue ?? ethers.parseEther('0.01'), // 0.01 ETH minimum
      maxPendingTxs: options.maxPendingTxs ?? 1000,
      filterSpam: options.filterSpam ?? true,
      enableBackrun: options.enableBackrun ?? true,
      enableFrontrun: options.enableFrontrun ?? false, // Disabled by default (ethical concerns)
      enableSandwich: options.enableSandwich ?? false, // Disabled by default (ethical concerns)
    };

    this.logger.info('Mempool monitor created', {
      enabledProtocols: this.options.enabledProtocols,
      minSwapValue: ethers.formatEther(this.options.minSwapValue ?? 0n),
      maxPendingTxs: this.options.maxPendingTxs,
    });
  }

  /**
   * Start monitoring the mempool
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('Mempool monitoring already started');
      return;
    }

    try {
      this.logger.info('Starting mempool monitoring...');

      // Get WebSocket connection
      const ws = this.connectionManager.getWebSocket();
      if (!ws) {
        throw new Error('WebSocket connection not available');
      }

      // Subscribe to pending transactions
      this.setupPendingTxListener(ws);

      // Start periodic cleanup
      this.startPeriodicCleanup();

      // Start stats reporting
      this.startStatsReporting();

      this.isMonitoring = true;
      this.logger.info('Mempool monitoring started successfully');
      this.emit('monitoringStarted');
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'start-mempool-monitoring',
      });
      throw error;
    }
  }

  /**
   * Stop monitoring the mempool
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      this.logger.warn('Mempool monitoring not running');
      return;
    }

    this.logger.info('Stopping mempool monitoring...');

    // Clear intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }

    this.isMonitoring = false;
    this.pendingTxs.clear();
    this.logger.info('Mempool monitoring stopped');
    this.emit('monitoringStopped');
  }

  /**
   * Setup listener for pending transactions
   */
  private setupPendingTxListener(ws: WebSocket): void {
    // Subscribe to pending transactions via WebSocket
    const subscribeMessage = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['newPendingTransactions'],
    });

    // Check WebSocket state before sending
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(subscribeMessage);
      } catch (error) {
        this.logger.logError(error as Error, {
          operation: 'websocket-send',
        });
        throw error;
      }
    } else {
      // Queue message for when connection opens
      ws.on('open', () => {
        try {
          ws.send(subscribeMessage);
        } catch (error) {
          this.logger.logError(error as Error, {
            operation: 'websocket-send-on-open',
          });
        }
      });
    }

    // Listen for WebSocket messages
    this.connectionManager.on('websocketMessage', async (message: any) => {
      if (message.method === 'eth_subscription' && message.params?.result) {
        const txHash = message.params.result;
        await this.handlePendingTransaction(txHash);
      }
    });

    this.logger.info('Pending transaction listener setup complete');
  }

  /**
   * Handle a pending transaction
   */
  private async handlePendingTransaction(txHash: string): Promise<void> {
    try {
      // Check if we've already processed this transaction
      if (this.pendingTxs.has(txHash)) {
        return;
      }

      // Fetch transaction details
      const provider = this.connectionManager.getProvider();
      const tx = await provider.getTransaction(txHash);

      if (!tx) {
        return;
      }

      // Update stats
      this.stats.totalPendingTxs++;

      // Filter by gas price
      const minGas = this.options.minGasPrice ?? 0n;
      const maxGas = this.options.maxGasPrice ?? ethers.MaxUint256;
      if (tx.gasPrice && (tx.gasPrice < minGas || tx.gasPrice > maxGas)) {
        return;
      }

      // Analyze transaction for DEX swaps
      const opportunity = await this.analyzePendingTx(tx);

      if (opportunity) {
        // Store opportunity
        this.pendingTxs.set(txHash, opportunity);

        // Enforce max pending txs limit
        const maxTxs = this.options.maxPendingTxs ?? 1000;
        if (this.pendingTxs.size > maxTxs) {
          const oldestKey = this.pendingTxs.keys().next().value;
          if (oldestKey) {
            this.pendingTxs.delete(oldestKey);
          }
        }

        // Update stats
        this.stats.dexSwapTxs++;

        // Emit opportunity event
        this.emit('opportunityDetected', opportunity);

        this.logger.debug('DEX swap detected in mempool', {
          txHash,
          protocol: opportunity.dexProtocol,
          value: ethers.formatEther(opportunity.value),
          gasPrice: ethers.formatUnits(opportunity.gasPrice, 'gwei'),
        });
      }
    } catch (error) {
      // Silently ignore errors for individual transactions to avoid spam
      this.logger.debug('Error processing pending transaction', {
        txHash,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Analyze a pending transaction for MEV opportunities
   */
  async analyzePendingTx(tx: ethers.TransactionResponse): Promise<PendingTxOpportunity | null> {
    try {
      // Check if transaction has data (contract interaction)
      if (!tx.data || tx.data === '0x' || tx.data.length < 10) {
        return null;
      }

      // Extract method signature (first 4 bytes)
      const methodSig = tx.data.slice(0, 10);

      // Try to decode as DEX swap
      const swapDetails = this.decodeSwap(methodSig, tx.data, tx.to ?? '');

      if (!swapDetails) {
        return null;
      }

      // Filter by minimum swap value
      const minValue = this.options.minSwapValue ?? 0n;
      if (swapDetails.amountIn < minValue) {
        return null;
      }

      // Check if protocol is enabled
      if (!this.options.enabledProtocols.includes(swapDetails.protocol)) {
        return null;
      }

      // Calculate potential profits
      const backrunProfit = this.options.enableBackrun
        ? await this.calculateBackrunProfit(swapDetails)
        : undefined;

      const frontrunProfit = this.options.enableFrontrun
        ? await this.calculateFrontrunProfit(swapDetails)
        : undefined;

      const sandwichProfit = this.options.enableSandwich
        ? await this.calculateSandwichProfit(swapDetails)
        : undefined;

      // Create opportunity
      const opportunity: PendingTxOpportunity = {
        id: `mempool-${tx.hash}-${Date.now()}`,
        txHash: tx.hash,
        from: tx.from,
        to: tx.to ?? '',
        value: tx.value,
        gasPrice: tx.gasPrice ?? 0n,
        gasLimit: tx.gasLimit,
        data: tx.data,
        nonce: tx.nonce,
        timestamp: Date.now(),
        dexProtocol: swapDetails.protocol,
        swapDetails,
        backrunProfit,
        frontrunProfit,
        sandwichProfit,
      };

      return opportunity;
    } catch (error) {
      this.logger.debug('Error analyzing pending transaction', {
        txHash: tx.hash,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Decode swap transaction data
   */
  private decodeSwap(methodSig: string, data: string, to: string): SwapDetails | null {
    try {
      // Check Uniswap V3 signatures
      if (Object.values(UNISWAP_V3_SIGNATURES).includes(methodSig)) {
        return this.decodeUniswapV3Swap(methodSig, data, to);
      }

      // Check Aerodrome signatures
      if (Object.values(AERODROME_SIGNATURES).includes(methodSig)) {
        return this.decodeAerodromeSwap(methodSig, data, to);
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode Uniswap V3 swap
   */
  private decodeUniswapV3Swap(methodSig: string, data: string, to: string): SwapDetails | null {
    try {
      // Simplified decoding - in production, use proper ABI decoding
      // Log the data for debugging purposes
      this.logger.debug('Decoding Uniswap V3 swap', {
        methodSig,
        dataLength: data.length,
        to,
      });

      // For now, return placeholder data
      return {
        protocol: DexType.UNISWAP_V3,
        methodSignature: methodSig,
        tokenIn: ethers.ZeroAddress,
        tokenOut: ethers.ZeroAddress,
        amountIn: 0n,
        amountOut: 0n,
        recipient: to,
        deadline: Math.floor(Date.now() / 1000) + 300,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode Aerodrome swap
   */
  private decodeAerodromeSwap(methodSig: string, data: string, to: string): SwapDetails | null {
    try {
      // Simplified decoding - in production, use proper ABI decoding
      // Log the data for debugging purposes
      this.logger.debug('Decoding Aerodrome swap', {
        methodSig,
        dataLength: data.length,
        to,
      });

      return {
        protocol: DexType.AERODROME,
        methodSignature: methodSig,
        tokenIn: ethers.ZeroAddress,
        tokenOut: ethers.ZeroAddress,
        amountIn: 0n,
        amountOut: 0n,
        recipient: to,
        deadline: Math.floor(Date.now() / 1000) + 300,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate backrun profit potential
   */
  private async calculateBackrunProfit(swap: SwapDetails): Promise<bigint | undefined> {
    try {
      // Calculate backrun profit using real pool state and gas estimation
      const poolContract = new ethers.Contract(
        swap.poolAddress,
        [
          'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
          'function liquidity() external view returns (uint128)',
        ],
        this.provider
      );

      try {
        const [slot0, liquidity] = await Promise.all([
          poolContract.slot0(),
          poolContract['liquidity'](),
        ]);

        // Calculate potential profit based on price impact
        const swapSize = swap.amountIn;
        const liquidityAmount = liquidity;

        if (liquidityAmount > 0n) {
          // Estimate price impact: larger swaps relative to liquidity = higher impact
          const impactRatio = Number(swapSize) / Number(liquidityAmount);
          const estimatedProfitBps = Math.min(impactRatio * 10000, 500); // Cap at 5%

          const estimatedProfit = (swapSize * BigInt(Math.floor(estimatedProfitBps))) / 10000n;

          // Subtract gas costs
          const gasEstimate = 200000n; // Backrun gas estimate
          const gasPrice = 20000000000n; // 20 gwei
          const gasCost = gasEstimate * gasPrice;

          const netProfit = estimatedProfit > gasCost ? estimatedProfit - gasCost : 0n;

          this.logger.debug('Calculated backrun profit', {
            swapSize: swapSize.toString(),
            liquidity: liquidityAmount.toString(),
            impactRatio,
            estimatedProfit: estimatedProfit.toString(),
            gasCost: gasCost.toString(),
            netProfit: netProfit.toString(),
          });

          return netProfit;
        }
      } catch (error) {
        this.logger.debug('Failed to calculate backrun profit from pool state', {
          poolAddress: swap.poolAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Fallback calculation based on swap amount
      const fallbackProfit = swap.amountIn / 1000n; // 0.1% of swap amount
      return fallbackProfit;
    } catch (error) {
      this.logger.debug('Failed to calculate backrun profit', {
        protocol: swap.protocol,
        amountIn: swap.amountIn.toString(),
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        error: error instanceof Error ? error.message : String(error),
      });

      return undefined;
    }
  }

  /**
   * Calculate frontrun profit potential
   */
  private async calculateFrontrunProfit(swap: SwapDetails): Promise<bigint | undefined> {
    try {
      // Frontrunning is generally unethical - log for monitoring
      this.logger.debug('Frontrun calculation requested (disabled)', {
        protocol: swap.protocol,
      });

      // Return 0 as frontrunning is disabled
      return 0n;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Calculate sandwich profit potential
   */
  private async calculateSandwichProfit(swap: SwapDetails): Promise<bigint | undefined> {
    try {
      // Sandwich attacks are generally unethical - log for monitoring
      this.logger.debug('Sandwich calculation requested (disabled)', {
        protocol: swap.protocol,
      });

      // Return 0 as sandwich attacks are disabled
      return 0n;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Start periodic cleanup of old pending transactions
   */
  private startPeriodicCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const maxAge = 60000; // 1 minute

      for (const [txHash, opportunity] of this.pendingTxs.entries()) {
        if (now - opportunity.timestamp > maxAge) {
          this.pendingTxs.delete(txHash);
        }
      }

      // Update memory usage
      this.stats.memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;
    }, 10000); // Every 10 seconds
  }

  /**
   * Start periodic stats reporting
   */
  private startStatsReporting(): void {
    this.statsInterval = setInterval(() => {
      this.logger.debug('Mempool stats', {
        totalPendingTxs: this.stats.totalPendingTxs,
        dexSwapTxs: this.stats.dexSwapTxs,
        backrunOpportunities: this.stats.backrunOpportunities,
        cachedTxs: this.pendingTxs.size,
        memoryUsageMB: this.stats.memoryUsageMB.toFixed(2),
      });

      this.emit('statsUpdate', this.stats);
    }, 30000); // Every 30 seconds
  }

  /**
   * Get current mempool stats
   */
  getStats(): MempoolStats {
    return { ...this.stats };
  }

  /**
   * Get pending opportunities
   */
  getPendingOpportunities(): PendingTxOpportunity[] {
    return Array.from(this.pendingTxs.values());
  }

  /**
   * Check if monitoring is active
   */
  isActive(): boolean {
    return this.isMonitoring;
  }
}
