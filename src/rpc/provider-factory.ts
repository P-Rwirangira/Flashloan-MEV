/**
 * Provider Factory
 *
 * Factory for creating and configuring ethers providers with Base-specific settings.
 */

import { ethers } from 'ethers';
import { NetworkConfig } from '../types/config';
import { RpcConnectionManager, RpcConnectionOptions } from './connection-manager';

export interface ProviderConfig {
  readonly network: NetworkConfig;
  readonly pollingInterval?: number;
  readonly maxRetries?: number;
  readonly quorum?: number;
}

export class ProviderFactory {
  /**
   * Create a connection manager with health monitoring and failover
   */
  static createConnectionManager(options: RpcConnectionOptions): RpcConnectionManager {
    return new RpcConnectionManager(options);
  }

  /**
   * Create a simple JSON RPC provider for basic operations
   */
  static createJsonRpcProvider(config: ProviderConfig): ethers.JsonRpcProvider {
    const provider = new ethers.JsonRpcProvider(config.network.rpcUrl, {
      chainId: config.network.chainId,
      name: config.network.name,
    });

    // Configure polling interval for real-time updates
    if (config.pollingInterval) {
      provider.pollingInterval = config.pollingInterval;
    }

    return provider;
  }

  /**
   * Create a fallback provider with multiple endpoints
   */
  static createFallbackProvider(config: ProviderConfig): ethers.FallbackProvider {
    const providers: { provider: ethers.JsonRpcProvider; priority: number; weight: number }[] = [
      {
        provider: new ethers.JsonRpcProvider(config.network.rpcUrl, {
          chainId: config.network.chainId,
          name: config.network.name,
        }),
        priority: 1,
        weight: 1,
      },
    ];

    // Add fallback providers
    config.network.fallbackRpcs.forEach((url: string, index: number) => {
      providers.push({
        provider: new ethers.JsonRpcProvider(url, {
          chainId: config.network.chainId,
          name: config.network.name,
        }),
        priority: index + 2,
        weight: 1,
      });
    });

    return new ethers.FallbackProvider(providers, config.network.chainId, {
      quorum: config.quorum ?? 1,
    });
  }

  /**
   * Create WebSocket provider for real-time events
   */
  static createWebSocketProvider(config: ProviderConfig): ethers.WebSocketProvider | null {
    if (!config.network.wsUrl) {
      return null;
    }

    return new ethers.WebSocketProvider(config.network.wsUrl, {
      chainId: config.network.chainId,
      name: config.network.name,
    });
  }

  /**
   * Create Base-specific provider with optimized settings
   */
  static createBaseProvider(config: ProviderConfig): ethers.JsonRpcProvider {
    const provider = this.createJsonRpcProvider({
      ...config,
      pollingInterval: config.pollingInterval ?? 1000, // 1s for Base L2
    });

    // Base-specific optimizations
    provider.pollingInterval = 1000; // Fast polling for L2

    return provider;
  }

  /**
   * Validate network configuration
   */
  static validateNetworkConfig(config: NetworkConfig): void {
    if (config.chainId !== 8453) {
      throw new Error(`Invalid chain ID for Base: expected 8453, got ${config.chainId}`);
    }

    if (!config.rpcUrl) {
      throw new Error('RPC URL is required');
    }

    try {
      new URL(config.rpcUrl);
    } catch {
      throw new Error(`Invalid RPC URL: ${config.rpcUrl}`);
    }

    if (config.wsUrl) {
      try {
        new URL(config.wsUrl);
      } catch {
        throw new Error(`Invalid WebSocket URL: ${config.wsUrl}`);
      }
    }

    for (const fallbackUrl of config.fallbackRpcs) {
      try {
        new URL(fallbackUrl);
      } catch {
        throw new Error(`Invalid fallback RPC URL: ${fallbackUrl}`);
      }
    }
  }
}
