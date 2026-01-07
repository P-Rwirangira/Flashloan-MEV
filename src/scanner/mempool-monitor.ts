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

// Uniswap V3 method signatures (router)
const UNISWAP_V3_SIGNATURES = {
  exactInputSingle: '0x04e45aaf',
  exactInput: '0x472b43f3',
  exactOutputSingle: '0x5023b4df',
  exactOutput: '0x09b81346',
  multicall: '0x5ae401dc',
};

// Aerodrome router method signatures (Velodrome v2 style)
const AERODROME_SIGNATURES = {
  swapExactTokensForTokens: '0x38ed1739',
  swapTokensForExactTokens: '0x8803dbee',
  swapExactETHForTokens: '0x7ff36ab5',
  swapTokensForExactETH: '0x4a25d94a',
  swapExactTokensForETH: '0x18cbafe5',
  swapETHForExactTokens: '0xfb3bdb41',
  swapExactTokensForTokensSupportingFeeOnTransferTokens: '0x5c11d795',
  swapExactETHForTokensSupportingFeeOnTransferTokens: '0xb6f9de95',
  swapExactTokensForETHSupportingFeeOnTransferTokens: '0x791ac947',
};

// Common multicall signatures (Uniswap V3 periphery)
const MULTICALL_SIGNATURES = new Set<string>([
  '0x5ae401dc', // multicall(bytes[] data)
  '0xac9650d8', // multicall(uint256 deadline, bytes[] data)
]);

export class MempoolMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('mempool-monitor');
  private readonly connectionManager: RpcConnectionManager;
  private readonly options: Required<Omit<MempoolMonitorOptions, 'connectionManager'>>;
  private readonly uniswapV3FactoryAddress?: string | undefined;
  private readonly aerodromeFactoryAddress?: string | undefined;
  private readonly uniswapV3QuoterAddress?: string | undefined;
  private readonly aerodromeRouterAddress?: string | undefined;
  private readonly backrunRecipient?: string | undefined;
  private readonly allowedTokens?: Set<string> | undefined;
  private readonly allowedPools?: Set<string> | undefined;
  private externalWsClients: { name: string; ws: WebSocket; url: string }[] = [];

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
    decodeSuccess: 0,
    decodeFailure: 0,
    quoteSuccess: 0,
    quoteFailure: 0,
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
      uniswapV3FactoryAddress:
        options.uniswapV3FactoryAddress ?? '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      aerodromeFactoryAddress:
        options.aerodromeFactoryAddress ?? '0xBE1a33519B2b1E3540D92724E2Ab84f0D9E8b872',
      uniswapV3QuoterAddress:
        options.uniswapV3QuoterAddress ?? '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      aerodromeRouterAddress:
        options.aerodromeRouterAddress ?? '0xE34b803C5274F4170Dc57cf021A37F16C6425a3F',
    } as Required<Omit<MempoolMonitorOptions, 'connectionManager'>>;
    this.uniswapV3FactoryAddress = this.options.uniswapV3FactoryAddress;
    this.aerodromeFactoryAddress = this.options.aerodromeFactoryAddress;
    this.uniswapV3QuoterAddress = this.options.uniswapV3QuoterAddress;
    this.aerodromeRouterAddress = this.options.aerodromeRouterAddress;
    this.backrunRecipient =
      options.backrunRecipient || (process.env['EXECUTION_WALLET_ADDRESS'] as string | undefined);
    this.allowedTokens = options.allowedTokens
      ? new Set(options.allowedTokens.map(t => t.toLowerCase()))
      : undefined;
    this.allowedPools = options.allowedPools
      ? new Set(options.allowedPools.map(p => p.toLowerCase()))
      : undefined;

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

      // If WebSocket subscription not supported or external streams enabled, start fallback streams
      if (this.options.enableBackrun && (this.options as any).enableExternalStreams) {
        await this.startExternalStreams();
      }

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

    // Close external stream clients
    for (const c of this.externalWsClients) {
      try {
        c.ws.close();
      } catch {}
    }
    this.externalWsClients = [];

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
      const swapDetails = await this.decodeSwap(methodSig, tx.data, tx.to ?? '');

      if (!swapDetails) {
        this.stats.decodeFailure++;
        this.emit('decodeStats', { success: false, protocol: 'unknown' });
        return null;
      }
      this.stats.decodeSuccess++;
      this.emit('decodeStats', { success: true, protocol: swapDetails.protocol });

      // Allowlist filtering
      if (this.allowedTokens) {
        const tokenInOk = this.allowedTokens.has(swapDetails.tokenIn.toLowerCase());
        const tokenOutOk = this.allowedTokens.has(swapDetails.tokenOut.toLowerCase());
        if (!tokenInOk || !tokenOutOk) {
          return null;
        }
      }
      if (this.allowedPools && swapDetails.poolAddress) {
        if (!this.allowedPools.has(swapDetails.poolAddress.toLowerCase())) {
          return null;
        }
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
  private async decodeSwap(
    methodSig: string,
    data: string,
    to: string
  ): Promise<SwapDetails | null> {
    try {
      // Handle multicall by unpacking inner calls and finding the first swap
      if (MULTICALL_SIGNATURES.has(methodSig)) {
        const swaps = await this.decodeFromMulticall(data);
        return swaps[0] || null;
      }

      // Check Uniswap V3 signatures
      if (Object.values(UNISWAP_V3_SIGNATURES).includes(methodSig)) {
        return await this.decodeUniswapV3Swap(methodSig, data, to);
      }

      // Check Aerodrome signatures
      if (Object.values(AERODROME_SIGNATURES).includes(methodSig)) {
        return await this.decodeAerodromeSwap(methodSig, data, to);
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode Uniswap V3 swap
   */
  private async decodeUniswapV3Swap(
    methodSig: string,
    data: string,
    _to: string
  ): Promise<SwapDetails | null> {
    try {
      // Router interfaces for exactInputSingle/exactOutputSingle and exactInput/exactOutput
      const routerIface = new ethers.Interface([
        'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
        'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)',
        'function exactInput(bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) external payable returns (uint256 amountOut)',
        'function exactOutput(bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum) external payable returns (uint256 amountIn)',
      ]);

      const factory = new ethers.Contract(
        this.uniswapV3FactoryAddress as string,
        ['function getPool(address,address,uint24) view returns (address)'],
        this.connectionManager.getProvider()
      );

      if (methodSig === UNISWAP_V3_SIGNATURES.exactInputSingle) {
        const decoded = routerIface.decodeFunctionData('exactInputSingle', data);
        const params = decoded[0] as any;
        const tokenIn = params.tokenIn as string;
        const tokenOut = params.tokenOut as string;
        const fee = Number(params.fee);
        const amountIn = BigInt(params.amountIn.toString());
        const poolAddr = await (factory as any).getPool(tokenIn, tokenOut, fee);
        return {
          protocol: DexType.UNISWAP_V3,
          methodSignature: methodSig,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut: 0n,
          recipient: params.recipient,
          deadline: Number(params.deadline),
          poolAddress: poolAddr,
          fee,
        };
      }

      if (methodSig === UNISWAP_V3_SIGNATURES.exactOutputSingle) {
        const decoded = routerIface.decodeFunctionData('exactOutputSingle', data);
        const params = decoded[0] as any;
        const tokenIn = params.tokenIn as string;
        const tokenOut = params.tokenOut as string;
        const fee = Number(params.fee);
        const amountOut = BigInt(params.amountOut.toString());
        const poolAddr = await (factory as any).getPool(tokenIn, tokenOut, fee);
        return {
          protocol: DexType.UNISWAP_V3,
          methodSignature: methodSig,
          tokenIn,
          tokenOut,
          amountIn: 0n,
          amountOut,
          recipient: params.recipient,
          deadline: Number(params.deadline),
          poolAddress: poolAddr,
          fee,
        };
      }

      if (
        methodSig === UNISWAP_V3_SIGNATURES.exactInput ||
        methodSig === UNISWAP_V3_SIGNATURES.exactOutput
      ) {
        // For path-based, parse first hop to extract tokenIn/tokenOut/fee of first pool
        const fn = methodSig === UNISWAP_V3_SIGNATURES.exactInput ? 'exactInput' : 'exactOutput';
        const decoded = routerIface.decodeFunctionData(fn, data);
        const path: string = decoded[0];
        if (!path || path.length < 2 + (20 + 3 + 20) * 2) {
          return null;
        }
        // Decode first hop: tokenIn(20) | fee(3) | tokenOut(20) (packed)
        const tokenIn = '0x' + path.slice(2, 42);
        const feeHex = path.slice(42, 48);
        const fee = parseInt(feeHex, 16);
        const tokenOut = '0x' + path.slice(48, 88);
        const poolAddr = await (factory as any).getPool(tokenIn, tokenOut, fee);
        const amountIn =
          methodSig === UNISWAP_V3_SIGNATURES.exactInput ? BigInt(decoded[3].toString()) : 0n;
        const amountOut =
          methodSig === UNISWAP_V3_SIGNATURES.exactOutput ? BigInt(decoded[3].toString()) : 0n;
        const recipient = decoded[1] as string;
        const deadline = Number(decoded[2]);
        return {
          protocol: DexType.UNISWAP_V3,
          methodSignature: methodSig,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          recipient,
          deadline,
          poolAddress: poolAddr,
          fee,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode multicall and extract inner swaps
   */
  private async decodeFromMulticall(data: string): Promise<SwapDetails[]> {
    try {
      // Try both multicall variants
      const iface1 = new ethers.Interface(['function multicall(bytes[] data)']);
      const iface2 = new ethers.Interface(['function multicall(uint256 deadline, bytes[] data)']);
      let inner: string[] | null = null;
      try {
        const d = iface1.decodeFunctionData('multicall', data);
        inner = d?.[0] as string[];
      } catch {}
      if (!inner) {
        try {
          const d2 = iface2.decodeFunctionData('multicall', data);
          inner = d2?.[1] as string[];
        } catch {}
      }
      if (!inner || inner.length === 0) return [];

      const swaps: SwapDetails[] = [];
      for (const callData of inner) {
        const sig = callData.slice(0, 10);
        // Attempt Uniswap V3 decode first
        if (Object.values(UNISWAP_V3_SIGNATURES).includes(sig)) {
          const s = await this.decodeUniswapV3Swap(sig, callData, '');
          if (s) swaps.push(s);
          continue;
        }
        // Then Aerodrome
        if (Object.values(AERODROME_SIGNATURES).includes(sig)) {
          const s = await this.decodeAerodromeSwap(sig, callData, '');
          if (s) swaps.push(s);
          continue;
        }
        // Nested multicall (rare): recurse defensively
        if (MULTICALL_SIGNATURES.has(sig)) {
          const nested = await this.decodeFromMulticall(callData);
          swaps.push(...nested);
        }
      }
      return swaps;
    } catch {
      return [];
    }
  }

  /**
   * Decode Aerodrome swap
   */
  private async decodeAerodromeSwap(
    methodSig: string,
    data: string,
    _to: string
  ): Promise<SwapDetails | null> {
    try {
      // Aerodrome/Velodrome v2 routers vary: routes can be address[] or struct Route[] {address from; address to; bool stable}
      const routerIfaceAddr = new ethers.Interface([
        'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,address[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapExactETHForTokens(uint256 amountOutMin,address[] calldata routes,address to,uint256 deadline) external payable returns (uint256[] memory amounts)',
        'function swapETHForExactTokens(uint256 amountOut,address[] calldata routes,address to,uint256 deadline) external payable returns (uint256[] memory amounts)',
      ]);
      const routerIfaceStruct = new ethers.Interface([
        'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external returns (uint256[] memory amounts)',
        'function swapExactETHForTokens(uint256 amountOutMin,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external payable returns (uint256[] memory amounts)',
        'function swapETHForExactTokens(uint256 amountOut,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline) external payable returns (uint256[] memory amounts)',
      ]);

      // Aerodrome factory for pair resolution
      const factory = new ethers.Contract(
        this.aerodromeFactoryAddress as string,
        [
          'function getPair(address tokenA,address tokenB,bool stable) external view returns (address pair)',
        ],
        this.connectionManager.getProvider()
      );

      const decodeAddr = (fn: string) => {
        try {
          return routerIfaceAddr.decodeFunctionData(fn, data);
        } catch {
          return null;
        }
      };
      const decodeStruct = (fn: string) => {
        try {
          return routerIfaceStruct.decodeFunctionData(fn, data);
        } catch {
          return null;
        }
      };

      // Try each router function signature against both ABI variants
      const exactIn =
        decodeAddr('swapExactTokensForTokens') ||
        decodeStruct('swapExactTokensForTokens') ||
        decodeAddr('swapExactTokensForETH') ||
        decodeStruct('swapExactTokensForETH') ||
        decodeAddr('swapExactETHForTokens') ||
        decodeStruct('swapExactETHForTokens');
      const exactOut =
        decodeAddr('swapTokensForExactTokens') ||
        decodeStruct('swapTokensForExactTokens') ||
        decodeAddr('swapTokensForExactETH') ||
        decodeStruct('swapTokensForExactETH') ||
        decodeAddr('swapETHForExactTokens') ||
        decodeStruct('swapETHForExactTokens');

      if (!exactIn && !exactOut) {
        return null;
      }

      // Extract routes parameter (address[] or struct[])
      const params = (exactIn || exactOut) as any[];
      let routes: any[] | undefined;
      for (const p of params) {
        if (Array.isArray(p) && p.length > 0) {
          routes = p;
          break;
        }
      }
      if (!routes || routes.length === 0) {
        return null;
      }
      const first = routes[0];
      const tokenIn = (first.from || first.tokenIn || first[0]) as string;
      const tokenOut = (first.to || first.tokenOut || first[1]) as string;
      const stable = Boolean(first.stable ?? first[2]);
      const poolAddr = await (factory as any).getPair(tokenIn, tokenOut, stable);

      // Amounts/recipient/deadline extraction tolerant to param order differences
      const amountIn = exactIn ? BigInt((params[0] ?? params[3])?.toString?.() || '0') : 0n;
      const amountOut = exactOut ? BigInt(params[0]?.toString?.() || '0') : 0n;
      let recipient: string = '';
      let deadline: number = Math.floor(Date.now() / 1000) + 300;
      for (const p of params) {
        if (typeof p === 'string' && p.length === 42) recipient = p;
        if (typeof p === 'bigint' || typeof p === 'number') deadline = Number(p);
      }

      return {
        protocol: DexType.AERODROME,
        methodSignature: methodSig,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        recipient,
        deadline,
        poolAddress: poolAddr,
        stable,
        routeStructPreferred: typeof first === 'object' && ('from' in first || 'tokenIn' in first),
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
      // Calculate backrun profit using on-chain quotes and realistic gas estimation
      const provider = this.connectionManager.getProvider();
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;

      // Attempt protocol-specific quote for backrun leg
      let expectedOut: bigint = 0n;

      if (swap.protocol === DexType.UNISWAP_V3) {
        // Use QuoterV2 exactInputSingle for a small backrun in opposite direction
        const quoter = new ethers.Contract(
          this.uniswapV3QuoterAddress as string,
          [
            'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
          ],
          provider
        );
        const tokenIn = swap.tokenOut;
        const tokenOut = swap.tokenIn;
        const fee = BigInt((swap as any).fee ?? 3000);
        const amountIn = (swap.amountIn > 0n ? swap.amountIn : swap.amountOut) / 100n || 0n; // 1% of observed size
        if (amountIn > 0n) {
          try {
            const res = await (quoter as any).quoteExactInputSingle({
              tokenIn,
              tokenOut,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0,
            });
            expectedOut = BigInt(res[0].toString());
          } catch {}
        }
      } else if (swap.protocol === DexType.AERODROME) {
        // Use router getAmountsOut for a small backrun in opposite direction
        const router = new ethers.Contract(
          this.aerodromeRouterAddress as string,
          [
            'function getAmountsOut(uint amountIn, address[] memory routes) public view returns (uint[] memory amounts)',
          ],
          provider
        );
        const amountIn = (swap.amountIn > 0n ? swap.amountIn : swap.amountOut) / 100n || 0n; // 1% of observed size
        if (amountIn > 0n) {
          try {
            // routes param varies by router; for simplicity use [tokenIn, tokenOut] linear path
            const res = await (router as any).getAmountsOut(amountIn, [
              swap.tokenOut,
              swap.tokenIn,
            ]);
            if (Array.isArray(res) && res.length > 1) {
              expectedOut = BigInt(res[res.length - 1].toString());
            }
          } catch {}
        }
      }

      if (expectedOut === 0n) {
        this.stats.quoteFailure++;
        this.emit('quoteStats', { success: false, protocol: swap.protocol });
        return undefined; // Unable to quote
      }
      this.stats.quoteSuccess++;
      this.emit('quoteStats', { success: true, protocol: swap.protocol });

      // Build actual calldata for a minimal backrun and estimate gas precisely
      let gasEstimate = 200000n;
      try {
        let txData: string | null = null;
        let toAddr: string | undefined;
        if (swap.protocol === DexType.UNISWAP_V3) {
          const iface = new ethers.Interface([
            'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
          ]);
          const params = {
            tokenIn: swap.tokenOut,
            tokenOut: swap.tokenIn,
            fee: BigInt((swap as any).fee ?? 3000),
            recipient: (this as any).backrunRecipient || ethers.ZeroAddress,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
            amountIn: (swap.amountIn > 0n ? swap.amountIn : swap.amountOut) / 100n || 0n,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          };
          txData = iface.encodeFunctionData('exactInputSingle', [params]);
          toAddr =
            (this as any).uniswapV3RouterAddress || '0xE592427A0AEce92De3Edee1F18E0157C05861564';
        } else if (swap.protocol === DexType.AERODROME) {
          const toAddrResolved = this.aerodromeRouterAddress as string;
          const amountIn = (swap.amountIn > 0n ? swap.amountIn : swap.amountOut) / 100n || 0n;
          const to = (this as any).backrunRecipient || ethers.ZeroAddress;
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
          // Prefer encoding matching the observed route type
          const tryStructFirst = !!(swap as any).routeStructPreferred;
          const stable = (swap as any).stable ?? false;
          const encodeAddrVariant = () => {
            const iface = new ethers.Interface([
              'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata routes,address to,uint256 deadline)',
            ]);
            const routes = [swap.tokenOut, swap.tokenIn];
            return iface.encodeFunctionData('swapExactTokensForTokens', [
              amountIn,
              0n,
              routes,
              to,
              deadline,
            ]);
          };
          const encodeStructVariant = () => {
            const iface = new ethers.Interface([
              'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable)[] calldata routes,address to,uint256 deadline)',
            ]);
            const routes = [{ from: swap.tokenOut, to: swap.tokenIn, stable }];
            return iface.encodeFunctionData('swapExactTokensForTokens', [
              amountIn,
              0n,
              routes,
              to,
              deadline,
            ]);
          };
          toAddr = toAddrResolved;
          // Attempt preferred variant then fallback
          const variants = tryStructFirst
            ? [encodeStructVariant, encodeAddrVariant]
            : [encodeAddrVariant, encodeStructVariant];
          for (const enc of variants) {
            try {
              txData = enc();
              const gasReq: any = { to: toAddrResolved, data: txData };
              if (this.backrunRecipient) gasReq.from = this.backrunRecipient;
              const est = await provider.estimateGas(gasReq);
              gasEstimate = BigInt(est.toString());
              break;
            } catch {
              txData = null;
              continue;
            }
          }
        }
        if (txData && toAddr) {
          const gasReq2: any = { to: toAddr, data: txData };
          if (this.backrunRecipient) gasReq2.from = this.backrunRecipient;
          const est = await provider.estimateGas(gasReq2);
          gasEstimate = BigInt(est.toString());
        }
      } catch {}

      const gasCost = gasEstimate * gasPrice;
      const profit = expectedOut > gasCost ? expectedOut - gasCost : 0n;

      return profit;
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
  private async startExternalStreams(): Promise<void> {
    const urls: { name: string; url?: string; auth?: string }[] = [
      {
        name: 'flashbots',
        url: (this.options as any).flashbotsStreamUrl,
        auth: (this.options as any).flashbotsAuth,
      },
      {
        name: 'bloxroute',
        url: (this.options as any).bloxrouteStreamUrl,
        auth: (this.options as any).bloxrouteAuth,
      },
    ];

    for (const cfg of urls) {
      if (!cfg.url) continue;
      await this.connectExternalStream(cfg.name, cfg.url, cfg.auth);
    }
  }

  private async connectExternalStream(name: string, url: string, auth?: string): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (auth) headers['Authorization'] = auth;
      const ws = new WebSocket(url, { headers });

      const client = { name, ws, url };
      this.externalWsClients.push(client);

      ws.on('open', () => {
        this.logger.info(`External mempool stream connected: ${name}`, { url });
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const text = typeof data === 'string' ? data : data.toString();
          const msg = JSON.parse(text);
          const hashes = this.normalizeExternalMessage(name, msg);
          for (const h of hashes) {
            await this.handlePendingTransaction(h);
          }
        } catch (error) {
          this.logger.debug('External stream message parse error', {
            name,
            error: (error as Error).message,
          });
        }
      });

      ws.on('close', (_code, _reason) => {
        this.logger.warn(`External mempool stream closed: ${name}`, { url });
        // Attempt reconnect after delay
        setTimeout(() => {
          if (this.isMonitoring) this.connectExternalStream(name, url, auth).catch(() => {});
        }, 5000);
      });

      ws.on('error', (error: Error) => {
        this.logger.debug('External stream error', { name, error: error.message });
      });
    } catch (error) {
      this.logger.warn('Failed to connect external mempool stream', {
        name,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private normalizeExternalMessage(_provider: string, msg: any): string[] {
    // Try common fields
    const hashes: string[] = [];
    const push = (v: any) => {
      if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) hashes.push(v);
    };

    // Generic JSON-RPC subscription
    if (msg?.method === 'eth_subscription' && msg?.params?.result) {
      push(msg.params.result);
    }

    // Flashbots/bloXroute common patterns
    push(msg?.txHash);
    push(msg?.hash);
    push(msg?.transactionHash);
    push(msg?.result);

    // Nested
    if (Array.isArray(msg?.transactions)) {
      for (const t of msg.transactions) push(t?.hash || t?.txHash || t?.transactionHash);
    }

    // String payload
    if (typeof msg === 'string') push(msg);

    // Dedup
    return Array.from(new Set(hashes));
  }

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
