/**
 * RPC Connection Manager
 *
 * Manages WebSocket and HTTP RPC connections to Base blockchain with automatic failover.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { NetworkConfig } from '../types/common';

export interface ConnectionHealth {
  readonly endpoint: string;
  readonly type: 'websocket' | 'http';
  readonly connected: boolean;
  readonly latencyMs: number;
  readonly lastError?: string | undefined;
  readonly lastSuccessfulRequest: number;
  readonly consecutiveFailures: number;
}

export interface RpcConnectionOptions {
  readonly network: NetworkConfig;
  readonly healthCheckIntervalMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly connectionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export class RpcConnectionManager extends EventEmitter {
  private readonly network: NetworkConfig;
  private readonly healthCheckIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  // Connection state
  private primaryWs?: WebSocket | undefined;
  private primaryProvider?: ethers.JsonRpcProvider | undefined;
  private fallbackProviders: ethers.JsonRpcProvider[] = [];
  private currentProvider?: ethers.JsonRpcProvider | undefined;

  // Health monitoring
  private healthCheckInterval?: ReturnType<typeof setInterval> | undefined;
  private connectionHealth: Map<string, ConnectionHealth> = new Map();
  private isShuttingDown = false;

  constructor(options: RpcConnectionOptions) {
    super();

    this.network = options.network;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30000; // 30s
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10000; // 10s
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000; // 5s
  }

  /**
   * Initialize all connections
   */
  async initialize(): Promise<void> {
    try {
      // Initialize primary HTTP provider
      await this.initializePrimaryProvider();

      // Initialize WebSocket connection if configured
      if (this.network.wsUrl) {
        await this.initializeWebSocketConnection();
      }

      // Initialize fallback providers
      await this.initializeFallbackProviders();

      // Start health monitoring
      this.startHealthMonitoring();

      this.emit('initialized');
    } catch (error) {
      this.emit('initializationError', error);
      throw error;
    }
  }

  /**
   * Get the current active provider
   */
  getProvider(): ethers.JsonRpcProvider {
    if (!this.currentProvider) {
      throw new Error('No active RPC provider available');
    }
    return this.currentProvider;
  }

  /**
   * Get primary RPC URL
   */
  getPrimaryRpcUrl(): string {
    return this.network.rpcUrl;
  }

  /**
   * Get WebSocket connection for real-time data
   */
  getWebSocket(): WebSocket | undefined {
    return this.primaryWs;
  }

  /**
   * Get connection health status for all endpoints
   */
  getConnectionHealth(): ConnectionHealth[] {
    return Array.from(this.connectionHealth.values());
  }

  /**
   * Get provider URL from ethers provider
   */
  private getProviderUrl(provider: ethers.JsonRpcProvider): string {
    // Access the internal connection URL
    return (provider as any)._getConnection().url;
  }

  /**
   * Manually trigger failover to next available provider
   */
  async triggerFailover(): Promise<void> {
    const healthyProviders = this.fallbackProviders.filter(provider => {
      const health = this.connectionHealth.get(this.getProviderUrl(provider));
      return health && health.connected && health.consecutiveFailures < this.maxConsecutiveFailures;
    });

    if (healthyProviders.length === 0) {
      throw new Error('No healthy fallback providers available');
    }

    const newProvider = healthyProviders[0];
    const oldProvider = this.currentProvider;

    this.currentProvider = newProvider;
    this.emit('providerChanged', newProvider, oldProvider);
  }

  /**
   * Shutdown all connections
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Close WebSocket connection
    if (this.primaryWs) {
      this.primaryWs.close();
    }

    // Cleanup providers
    this.primaryProvider = undefined;
    this.currentProvider = undefined;
    this.fallbackProviders.length = 0;
    this.connectionHealth.clear();

    this.emit('shutdown');
  }

  /**
   * Initialize primary HTTP provider
   */
  private async initializePrimaryProvider(): Promise<void> {
    const provider = new ethers.JsonRpcProvider(this.network.rpcUrl, {
      chainId: this.network.chainId,
      name: this.network.name,
    });

    // Test connection
    await this.testProviderConnection(provider, this.network.rpcUrl);

    this.primaryProvider = provider;
    this.currentProvider = provider;

    this.updateConnectionHealth(this.network.rpcUrl, 'http', true, 0);
  }

  /**
   * Initialize WebSocket connection
   */
  private async initializeWebSocketConnection(): Promise<void> {
    if (!this.network.wsUrl) return;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.network.wsUrl!, {
        handshakeTimeout: this.connectionTimeoutMs,
      });

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, this.connectionTimeoutMs);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.primaryWs = ws;
        this.setupWebSocketHandlers(ws);
        this.updateConnectionHealth(this.network.wsUrl!, 'websocket', true, 0);
        this.emit('websocketConnected');
        resolve();
      });

      ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.updateConnectionHealth(this.network.wsUrl!, 'websocket', false, 0, error.message);
        reject(error);
      });
    });
  }

  /**
   * Initialize fallback providers
   */
  private async initializeFallbackProviders(): Promise<void> {
    for (const fallbackUrl of this.network.fallbackRpcs) {
      try {
        const provider = new ethers.JsonRpcProvider(fallbackUrl, {
          chainId: this.network.chainId,
          name: this.network.name,
        });

        await this.testProviderConnection(provider, fallbackUrl);
        this.fallbackProviders.push(provider);
        this.updateConnectionHealth(fallbackUrl, 'http', true, 0);
      } catch (error) {
        this.updateConnectionHealth(
          fallbackUrl,
          'http',
          false,
          0,
          error instanceof Error ? error.message : 'Unknown error'
        );
        this.emit('fallbackProviderError', fallbackUrl, error);
      }
    }
  }

  /**
   * Test provider connection
   */
  private async testProviderConnection(
    provider: ethers.JsonRpcProvider,
    url: string
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const network = (await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Request timeout')), this.requestTimeoutMs)
        ),
      ])) as ethers.Network;

      const latency = Date.now() - startTime;

      if (Number(network.chainId) !== this.network.chainId) {
        throw new Error(
          `Chain ID mismatch: expected ${this.network.chainId}, got ${network.chainId}`
        );
      }

      this.updateConnectionHealth(url, 'http', true, latency);
    } catch (error) {
      const latency = Date.now() - startTime;
      this.updateConnectionHealth(
        url,
        'http',
        false,
        latency,
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.emit('websocketMessage', message);
      } catch (error) {
        this.emit('websocketError', error);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (!this.isShuttingDown) {
        this.updateConnectionHealth(
          this.network.wsUrl!,
          'websocket',
          false,
          0,
          `Connection closed: ${code} ${reason.toString()}`
        );
        this.emit('websocketDisconnected', code, reason);

        // Attempt to reconnect after delay
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.initializeWebSocketConnection().catch(error => {
              this.emit('websocketReconnectError', error);
            });
          }
        }, 5000);
      }
    });

    ws.on('error', (error: Error) => {
      this.updateConnectionHealth(this.network.wsUrl!, 'websocket', false, 0, error.message);
      this.emit('websocketError', error);
    });

    // Send ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('pong', () => {
      this.updateConnectionHealth(this.network.wsUrl!, 'websocket', true, 0);
    });
  }

  /**
   * Start health monitoring for all connections
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.healthCheckIntervalMs);
  }

  /**
   * Perform health checks on all providers
   */
  private async performHealthChecks(): Promise<void> {
    // Check primary provider
    if (this.primaryProvider) {
      await this.checkProviderHealth(this.primaryProvider, this.network.rpcUrl);
    }

    // Check fallback providers
    for (const provider of this.fallbackProviders) {
      await this.checkProviderHealth(provider, this.getProviderUrl(provider));
    }

    // Check if current provider is unhealthy and failover is needed
    if (this.currentProvider) {
      const health = this.connectionHealth.get(this.getProviderUrl(this.currentProvider));
      if (
        health &&
        (!health.connected || health.consecutiveFailures >= this.maxConsecutiveFailures)
      ) {
        try {
          await this.triggerFailover();
        } catch (error) {
          this.emit('failoverError', error);
        }
      }
    }
  }

  /**
   * Check health of a specific provider
   */
  private async checkProviderHealth(provider: ethers.JsonRpcProvider, url: string): Promise<void> {
    try {
      await this.testProviderConnection(provider, url);
    } catch (error) {
      const health = this.connectionHealth.get(url);
      if (health) {
        this.updateConnectionHealth(
          url,
          health.type,
          false,
          0,
          error instanceof Error ? error.message : 'Unknown error',
          health.consecutiveFailures + 1
        );
      }
    }
  }

  /**
   * Update connection health status
   */
  private updateConnectionHealth(
    endpoint: string,
    type: 'websocket' | 'http',
    connected: boolean,
    latencyMs: number,
    error?: string | undefined,
    consecutiveFailures?: number
  ): void {
    const existing = this.connectionHealth.get(endpoint);

    this.connectionHealth.set(endpoint, {
      endpoint,
      type,
      connected,
      latencyMs,
      lastError: error,
      lastSuccessfulRequest: connected ? Date.now() : (existing?.lastSuccessfulRequest ?? 0),
      consecutiveFailures: connected
        ? 0
        : (consecutiveFailures ?? (existing?.consecutiveFailures ?? 0) + 1),
    });

    this.emit('healthUpdate', this.connectionHealth.get(endpoint));
  }
}
