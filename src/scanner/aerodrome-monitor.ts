/**
 * Aerodrome Pool Monitor
 *
 * Monitors Aerodrome pools on Base for real-time state changes including reserves for both volatile and stable pools.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { AerodromeVolatilePoolState, AerodromeStablePoolState, PoolType } from '../types/pool';
import { PoolAllowlist } from '../types/config';
import { Address } from '../types/common';

// Aerodrome Pool ABI (minimal required functions)
const AERODROME_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function stable() external view returns (bool)',
  'function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
  'function totalSupply() external view returns (uint256)',
  'function decimals0() external view returns (uint8)',
  'function decimals1() external view returns (uint8)',
  'function kLast() external view returns (uint256)',
  'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
];

export interface AerodromeMonitorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlist[];
  readonly updateIntervalMs?: number;
  readonly maxRetries?: number;
}

export interface AerodromePoolUpdateEvent {
  readonly pool: Address;
  readonly oldState: AerodromeVolatilePoolState | AerodromeStablePoolState;
  readonly newState: AerodromeVolatilePoolState | AerodromeStablePoolState;
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionHash?: string;
}

export class AerodromeMonitor extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly allowedPools: Map<Address, PoolAllowlist>;
  private readonly updateIntervalMs: number;
  private readonly maxRetries: number;

  // Pool state tracking
  private poolStates: Map<Address, AerodromeVolatilePoolState | AerodromeStablePoolState> =
    new Map();
  private poolContracts: Map<Address, ethers.Contract> = new Map();
  private poolTypes: Map<Address, 'volatile' | 'stable'> = new Map();

  // Monitoring state
  private isMonitoring = false;
  private updateInterval?: ReturnType<typeof setInterval> | undefined;
  private wsSubscriptions: Set<string> = new Set();

  constructor(options: AerodromeMonitorOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.allowedPools = new Map(options.allowedPools.map(pool => [pool.address, pool]));
    this.updateIntervalMs = options.updateIntervalMs ?? 5000; // 5s default
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Start monitoring Aerodrome pools
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      throw new Error('Monitor is already running');
    }

    try {
      // Initialize pool contracts and states
      await this.initializePools();

      // Set up WebSocket subscriptions for real-time updates
      await this.setupWebSocketSubscriptions();

      // Start periodic state updates
      this.startPeriodicUpdates();

      this.isMonitoring = true;
      this.emit('monitoringStarted');
    } catch (error) {
      this.emit('monitoringError', error);
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  async stopMonitoring(): Promise<void> {
    this.isMonitoring = false;

    // Clear periodic updates
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    // Clear WebSocket subscriptions
    this.wsSubscriptions.clear();

    // Clear state
    this.poolStates.clear();
    this.poolContracts.clear();
    this.poolTypes.clear();

    this.emit('monitoringStopped');
  }

  /**
   * Get current state of a specific pool
   */
  getPoolState(
    poolAddress: Address
  ): AerodromeVolatilePoolState | AerodromeStablePoolState | undefined {
    return this.poolStates.get(poolAddress);
  }

  /**
   * Get all monitored pool states
   */
  getAllPoolStates(): Map<Address, AerodromeVolatilePoolState | AerodromeStablePoolState> {
    return new Map(this.poolStates);
  }

  /**
   * Get list of monitored pool addresses
   */
  getMonitoredPools(): Address[] {
    return Array.from(this.allowedPools.keys()).filter(
      address => this.allowedPools.get(address)?.enabled ?? false
    );
  }

  /**
   * Add a new pool to monitoring
   */
  async addPool(poolConfig: PoolAllowlist): Promise<void> {
    if (!poolConfig.enabled) {
      return;
    }

    this.allowedPools.set(poolConfig.address, poolConfig);

    if (this.isMonitoring) {
      await this.initializePool(poolConfig.address);
      await this.subscribeToPoolEvents(poolConfig.address);
    }
  }

  /**
   * Remove a pool from monitoring
   */
  removePool(poolAddress: Address): void {
    this.allowedPools.delete(poolAddress);
    this.poolStates.delete(poolAddress);
    this.poolContracts.delete(poolAddress);
    this.poolTypes.delete(poolAddress);

    // Remove WebSocket subscription
    this.wsSubscriptions.delete(poolAddress);
  }

  /**
   * Force update a specific pool's state
   */
  async updatePoolState(poolAddress: Address): Promise<void> {
    const contract = this.poolContracts.get(poolAddress);
    if (!contract) {
      throw new Error(`Pool ${poolAddress} is not being monitored`);
    }

    const oldState = this.poolStates.get(poolAddress);
    const newState = await this.fetchPoolState(contract, poolAddress);

    this.poolStates.set(poolAddress, newState);

    if (oldState && this.hasStateChanged(oldState, newState)) {
      this.emit('poolUpdated', {
        pool: poolAddress,
        oldState,
        newState,
        timestamp: Date.now(),
        blockNumber: newState.blockNumber,
      } as AerodromePoolUpdateEvent);
    }
  }

  /**
   * Initialize all enabled pools
   */
  private async initializePools(): Promise<void> {
    const enabledPools = Array.from(this.allowedPools.entries()).filter(
      ([, config]) => config.enabled
    );

    for (const [address] of enabledPools) {
      try {
        await this.initializePool(address);
      } catch (error) {
        this.emit('poolInitializationError', address, error);
      }
    }
  }

  /**
   * Initialize a specific pool
   */
  private async initializePool(poolAddress: Address): Promise<void> {
    const provider = this.connectionManager.getProvider();
    const contract = new ethers.Contract(poolAddress, AERODROME_POOL_ABI, provider);

    // Verify this is a valid Aerodrome pool and determine type
    let retries = 0;
    let isStable = false;

    while (retries < this.maxRetries) {
      try {
        const token0 = await contract.getFunction('token0')();
        const token1 = await contract.getFunction('token1')();
        isStable = await contract.getFunction('stable')();

        if (!token0 || !token1) {
          throw new Error('Invalid pool contract responses');
        }
        break; // Success, exit retry loop
      } catch (error: any) {
        retries++;
        if (error.code === 'CALL_EXCEPTION' && error.info?.error?.message?.includes('rate limit')) {
          if (retries < this.maxRetries) {
            // eslint-disable-next-line no-console
            console.warn(
              `Rate limited, retrying pool initialization for ${poolAddress} (attempt ${retries}/${this.maxRetries})`
            );
            await new Promise(resolve => setTimeout(resolve, 2000 * retries)); // Exponential backoff
            continue;
          }
        }
        throw new Error(`Invalid Aerodrome pool at ${poolAddress}: ${error}`);
      }
    }

    this.poolContracts.set(poolAddress, contract);
    this.poolTypes.set(poolAddress, isStable ? 'stable' : 'volatile');

    // Fetch initial state
    const initialState = await this.fetchPoolState(contract, poolAddress);
    this.poolStates.set(poolAddress, initialState);

    this.emit('poolInitialized', poolAddress, initialState);
  }

  /**
   * Fetch current pool state from blockchain
   */
  private async fetchPoolState(
    contract: ethers.Contract,
    poolAddress: Address
  ): Promise<AerodromeVolatilePoolState | AerodromeStablePoolState> {
    const provider = this.connectionManager.getProvider();
    const blockNumber = await provider.getBlockNumber();

    // Add small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));

    const poolType = this.poolTypes.get(poolAddress);
    const isStable = poolType === 'stable';

    if (isStable) {
      // Fetch stable pool data
      const results = await Promise.all([
        contract.getFunction('token0')(),
        contract.getFunction('token1')(),
        contract.getFunction('getReserves')(),
        contract.getFunction('totalSupply')(),
        contract.getFunction('decimals0')(),
        contract.getFunction('decimals1')(),
      ]);

      const [token0, token1, reserves, totalSupply, decimals0, decimals1] = results;

      if (
        !token0 ||
        !token1 ||
        !reserves ||
        totalSupply === undefined ||
        decimals0 === undefined ||
        decimals1 === undefined
      ) {
        throw new Error('Invalid stable pool contract responses');
      }

      return {
        address: poolAddress,
        type: PoolType.AERODROME_STABLE,
        token0,
        token1,
        fee: 0, // Aerodrome stable pools typically have dynamic fees
        reserve0: reserves._reserve0,
        reserve1: reserves._reserve1,
        totalSupply,
        decimals0: Number(decimals0),
        decimals1: Number(decimals1),
        stable: true,
        lastUpdated: Date.now(),
        blockNumber,
        isActive: true,
      } as AerodromeStablePoolState;
    } else {
      // Fetch volatile pool data
      const results = await Promise.all([
        contract.getFunction('token0')(),
        contract.getFunction('token1')(),
        contract.getFunction('getReserves')(),
        contract.getFunction('totalSupply')(),
        contract.getFunction('kLast')(),
      ]);

      const [token0, token1, reserves, totalSupply, kLast] = results;

      if (!token0 || !token1 || !reserves || totalSupply === undefined || kLast === undefined) {
        throw new Error('Invalid volatile pool contract responses');
      }

      return {
        address: poolAddress,
        type: PoolType.AERODROME_VOLATILE,
        token0,
        token1,
        fee: 0, // Aerodrome volatile pools typically have dynamic fees
        reserve0: reserves._reserve0,
        reserve1: reserves._reserve1,
        totalSupply,
        kLast,
        lastUpdated: Date.now(),
        blockNumber,
        isActive: true,
      } as AerodromeVolatilePoolState;
    }
  }

  /**
   * Set up WebSocket subscriptions for real-time updates
   */
  private async setupWebSocketSubscriptions(): Promise<void> {
    const ws = this.connectionManager.getWebSocket();
    if (!ws) {
      // eslint-disable-next-line no-console
      console.warn('WebSocket not available, using polling only');
      return;
    }

    // Subscribe to new blocks for state updates
    this.subscribeToNewBlocks(ws);

    // Subscribe to pool-specific events
    for (const poolAddress of this.getMonitoredPools()) {
      await this.subscribeToPoolEvents(poolAddress);
    }
  }

  /**
   * Subscribe to new block events
   */
  private subscribeToNewBlocks(ws: WebSocket): void {
    const subscription = {
      id: 1,
      method: 'eth_subscribe',
      params: ['newHeads'],
    };

    ws.send(JSON.stringify(subscription));
    this.wsSubscriptions.add('newHeads');

    // Listen for new blocks and update pool states
    this.connectionManager.on('websocketMessage', async (message: any) => {
      if (message.method === 'eth_subscription' && message.params?.subscription) {
        const blockData = message.params.result;
        if (blockData?.number) {
          await this.handleNewBlock(parseInt(blockData.number, 16));
        }
      }
    });
  }

  /**
   * Subscribe to pool-specific events
   */
  private async subscribeToPoolEvents(poolAddress: Address): Promise<void> {
    const ws = this.connectionManager.getWebSocket();
    if (!ws) return;

    // Subscribe to Swap events
    const swapSubscription = {
      id: Date.now(),
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: poolAddress,
          topics: [
            '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // Swap event signature for Aerodrome
          ],
        },
      ],
    };

    ws.send(JSON.stringify(swapSubscription));
    this.wsSubscriptions.add(`${poolAddress}-swap`);

    // Subscribe to Mint events
    const mintSubscription = {
      id: Date.now() + 1,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: poolAddress,
          topics: [
            '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f', // Mint event signature for Aerodrome
          ],
        },
      ],
    };

    ws.send(JSON.stringify(mintSubscription));
    this.wsSubscriptions.add(`${poolAddress}-mint`);

    // Subscribe to Burn events
    const burnSubscription = {
      id: Date.now() + 2,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: poolAddress,
          topics: [
            '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496', // Burn event signature for Aerodrome
          ],
        },
      ],
    };

    ws.send(JSON.stringify(burnSubscription));
    this.wsSubscriptions.add(`${poolAddress}-burn`);

    // Subscribe to Sync events (important for reserve updates)
    const syncSubscription = {
      id: Date.now() + 3,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: poolAddress,
          topics: [
            '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1', // Sync event signature
          ],
        },
      ],
    };

    ws.send(JSON.stringify(syncSubscription));
    this.wsSubscriptions.add(`${poolAddress}-sync`);
  }

  /**
   * Handle new block events
   */
  private async handleNewBlock(blockNumber: number): Promise<void> {
    // Update pool states that might have changed
    const updatePromises = this.getMonitoredPools().map(async poolAddress => {
      try {
        await this.updatePoolState(poolAddress);
      } catch (error) {
        this.emit('poolUpdateError', poolAddress, error);
      }
    });

    await Promise.allSettled(updatePromises);
    this.emit('blockProcessed', blockNumber);
  }

  /**
   * Start periodic state updates as fallback
   */
  private startPeriodicUpdates(): void {
    this.updateInterval = setInterval(async () => {
      if (!this.isMonitoring) return;

      const updatePromises = this.getMonitoredPools().map(async poolAddress => {
        try {
          await this.updatePoolState(poolAddress);
        } catch (error) {
          this.emit('poolUpdateError', poolAddress, error);
        }
      });

      await Promise.allSettled(updatePromises);
    }, this.updateIntervalMs);
  }

  /**
   * Check if pool state has meaningfully changed
   */
  private hasStateChanged(
    oldState: AerodromeVolatilePoolState | AerodromeStablePoolState,
    newState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): boolean {
    return (
      oldState.reserve0 !== newState.reserve0 ||
      oldState.reserve1 !== newState.reserve1 ||
      oldState.totalSupply !== newState.totalSupply ||
      oldState.blockNumber !== newState.blockNumber
    );
  }

  /**
   * Calculate current price for a pool (token0 in terms of token1)
   */
  getPoolPrice(poolAddress: Address): { token0Price: bigint; token1Price: bigint } | undefined {
    const state = this.poolStates.get(poolAddress);
    if (!state) return undefined;

    const reserve0 = BigInt(state.reserve0.toString());
    const reserve1 = BigInt(state.reserve1.toString());

    if (reserve0 === 0n || reserve1 === 0n) {
      return { token0Price: 0n, token1Price: 0n };
    }

    // For stable pools, we might need to adjust for decimals
    if (state.type === PoolType.AERODROME_STABLE) {
      const stableState = state as AerodromeStablePoolState;
      const decimals0 = BigInt(10 ** stableState.decimals0);
      const decimals1 = BigInt(10 ** stableState.decimals1);

      // Normalize reserves by decimals
      const normalizedReserve0 = reserve0 * decimals1;
      const normalizedReserve1 = reserve1 * decimals0;

      return {
        token0Price: normalizedReserve1 / reserve0, // Price of token0 in token1
        token1Price: normalizedReserve0 / reserve1, // Price of token1 in token0
      };
    } else {
      // For volatile pools, simple ratio
      return {
        token0Price: reserve1 / reserve0, // Price of token0 in token1
        token1Price: reserve0 / reserve1, // Price of token1 in token0
      };
    }
  }
}
