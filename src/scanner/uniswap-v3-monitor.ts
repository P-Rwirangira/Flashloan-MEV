/**
 * Uniswap V3 Pool Monitor
 *
 * Monitors Uniswap V3 pools on Base for real-time state changes including reserves, ticks, and liquidity.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { UniswapV3PoolState, PoolType } from '../types/pool';
import { PoolAllowlist } from '../types/config';
import { Address } from '../types/common';

// Uniswap V3 Pool ABI (minimal required functions)
const UNISWAP_V3_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function tickSpacing() external view returns (int24)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
];

export interface UniswapV3MonitorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlist[];
  readonly updateIntervalMs?: number;
  readonly maxRetries?: number;
}

export interface PoolUpdateEvent {
  readonly pool: Address;
  readonly oldState: UniswapV3PoolState;
  readonly newState: UniswapV3PoolState;
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionHash?: string;
}

export class UniswapV3Monitor extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly allowedPools: Map<Address, PoolAllowlist>;
  private readonly updateIntervalMs: number;
  private readonly maxRetries: number;

  // Pool state tracking
  private poolStates: Map<Address, UniswapV3PoolState> = new Map();
  private poolContracts: Map<Address, ethers.Contract> = new Map();

  // Monitoring state
  private isMonitoring = false;
  private updateInterval?: ReturnType<typeof setInterval> | undefined;
  private wsSubscriptions: Set<string> = new Set();

  constructor(options: UniswapV3MonitorOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.allowedPools = new Map(options.allowedPools.map(pool => [pool.address, pool]));
    this.updateIntervalMs = options.updateIntervalMs ?? 5000; // 5s default
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Start monitoring Uniswap V3 pools
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

    this.emit('monitoringStopped');
  }

  /**
   * Get current state of a specific pool
   */
  getPoolState(poolAddress: Address): UniswapV3PoolState | undefined {
    return this.poolStates.get(poolAddress);
  }

  /**
   * Get all monitored pool states
   */
  getAllPoolStates(): Map<Address, UniswapV3PoolState> {
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
      } as PoolUpdateEvent);
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
    const contract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

    // Verify this is a valid Uniswap V3 pool with retry logic
    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        const token0 = await contract.getFunction('token0')();
        const token1 = await contract.getFunction('token1')();
        const fee = await contract.getFunction('fee')();

        if (!token0 || !token1 || fee === undefined) {
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
        throw new Error(`Invalid Uniswap V3 pool at ${poolAddress}: ${error}`);
      }
    }

    this.poolContracts.set(poolAddress, contract);

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
  ): Promise<UniswapV3PoolState> {
    const provider = this.connectionManager.getProvider();
    const blockNumber = await provider.getBlockNumber();

    // Add small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));

    const results = await Promise.all([
      contract.getFunction('token0')(),
      contract.getFunction('token1')(),
      contract.getFunction('fee')(),
      contract.getFunction('slot0')(),
      contract.getFunction('liquidity')(),
      contract.getFunction('tickSpacing')(),
    ]);

    const [token0, token1, fee, slot0, liquidity, tickSpacing] = results;

    if (
      !token0 ||
      !token1 ||
      fee === undefined ||
      !slot0 ||
      liquidity === undefined ||
      tickSpacing === undefined
    ) {
      throw new Error('Invalid contract responses');
    }

    return {
      address: poolAddress,
      type: PoolType.UNISWAP_V3,
      token0,
      token1,
      fee: Number(fee),
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: Number(slot0.tick),
      liquidity: liquidity,
      tickSpacing: Number(tickSpacing),
      lastUpdated: Date.now(),
      blockNumber,
      isActive: true,
    };
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
            '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // Swap event signature
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
            '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', // Mint event signature
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
            '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', // Burn event signature
          ],
        },
      ],
    };

    ws.send(JSON.stringify(burnSubscription));
    this.wsSubscriptions.add(`${poolAddress}-burn`);
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
  private hasStateChanged(oldState: UniswapV3PoolState, newState: UniswapV3PoolState): boolean {
    return (
      oldState.sqrtPriceX96 !== newState.sqrtPriceX96 ||
      oldState.tick !== newState.tick ||
      oldState.liquidity !== newState.liquidity ||
      oldState.blockNumber !== newState.blockNumber
    );
  }
}
