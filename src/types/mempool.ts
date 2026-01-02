/**
 * Mempool Monitoring Types
 *
 * Types for monitoring pending transactions and detecting MEV opportunities
 */

import { DexType } from './dex';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface PendingTxOpportunity {
  readonly id: string;
  readonly txHash: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly gasPrice: bigint;
  readonly gasLimit: bigint;
  readonly data: string;
  readonly nonce: number;
  readonly timestamp: number;
  readonly dexProtocol?: DexType | undefined;
  readonly swapDetails?: SwapDetails | undefined;
  readonly backrunProfit?: bigint | undefined;
  readonly frontrunProfit?: bigint | undefined;
  readonly sandwichProfit?: bigint | undefined;
}

export interface SwapDetails {
  readonly protocol: DexType;
  readonly methodSignature: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly recipient: string;
  readonly deadline: number;
  readonly poolAddress?: string | undefined;
  readonly fee?: number | undefined;
  readonly stable?: boolean | undefined; // Aerodrome stable/volatile
  readonly routeStructPreferred?: boolean | undefined; // Aerodrome: struct[] vs address[]
}

export interface MempoolMonitorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly enabledProtocols: DexType[];
  readonly minGasPrice?: bigint | undefined;
  readonly maxGasPrice?: bigint | undefined;
  readonly minSwapValue?: bigint | undefined;
  readonly maxPendingTxs?: number | undefined;
  readonly filterSpam?: boolean | undefined;
  readonly enableBackrun?: boolean | undefined;
  readonly enableFrontrun?: boolean | undefined;
  readonly enableSandwich?: boolean | undefined;
  readonly uniswapV3FactoryAddress?: string | undefined;
  readonly aerodromeFactoryAddress?: string | undefined;
  readonly uniswapV3QuoterAddress?: string | undefined;
  readonly aerodromeRouterAddress?: string | undefined;
  readonly backrunRecipient?: string | undefined;
}

export interface MempoolStats {
  totalPendingTxs: number;
  dexSwapTxs: number;
  backrunOpportunities: number;
  frontrunOpportunities: number;
  sandwichOpportunities: number;
  avgGasPrice: bigint;
  memoryUsageMB: number;
}

export interface DecodedSwap {
  readonly protocol: DexType;
  readonly methodName: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly recipient: string;
  readonly deadline: number;
  readonly poolAddress?: string | undefined;
  readonly fee?: number | undefined;
}
