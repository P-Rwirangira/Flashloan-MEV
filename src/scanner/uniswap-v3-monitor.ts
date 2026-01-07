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
import type { DiscoveredPool } from './pool-discovery.js';

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
   * Add discovered pool dynamically
   */
  async addDiscoveredPool(pool: DiscoveredPool): Promise<void> {
    if (pool.dex !== 'uniswap-v3') {
      return;
    }

    const poolConfig: PoolAllowlist = {
      address: pool.address,
      dex: 'uniswap-v3',
      enabled: true,
      priority: Math.floor(pool.score / 20), // Score 0-100 -> Priority 0-5
      tags: [
        `fee-${pool.fee}`,
        pool.tvl >= 1000000 ? 'high-tvl' : 'medium-tvl',
        'auto-discovered',
      ],
      minTvl: 10000,
      maxSlippage: 0.02,
    };

    await this.addPool(poolConfig);

    // Create contract instance
    const provider = this.connectionManager.getProvider();
    const contract = new ethers.Contract(pool.address, UNISWAP_V3_POOL_ABI, provider);
    this.poolContracts.set(pool.address, contract);
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
   * Initialize all enabled pools using multicall for efficiency
   */
  private async initializePools(): Promise<void> {
    const enabledPools = Array.from(this.allowedPools.entries()).filter(
      ([, config]) => config.enabled
    );

    if (enabledPools.length === 0) {
      console.log('No enabled pools to initialize');
      return;
    }

    console.log(`🔄 Initializing ${enabledPools.length} pools using multicall...`);

    // Try multicall first for efficiency
    try {
      const { PoolStateMulticall } = await import('../utils/multicall');
      const multicall = new PoolStateMulticall(this.connectionManager.getProvider());
      
      const poolAddresses = enabledPools.map(([address]) => address);
      const poolStates = await multicall.fetchPoolStates(poolAddresses);

      // Process successful multicall results
      for (const [address, poolState] of poolStates) {
        const provider = this.connectionManager.getProvider();
        const contract = new ethers.Contract(address, UNISWAP_V3_POOL_ABI, provider);
        
        this.poolContracts.set(address, contract);
        this.poolStates.set(address, {
          ...poolState,
          type: PoolType.UNISWAP_V3,
          blockNumber: await provider.getBlockNumber().catch(() => 0),
        });

        console.log(` Pool ${address} initialized via multicall:`, {
          token0: poolState.token0,
          token1: poolState.token1,
          fee: poolState.fee,
          liquidity: poolState.liquidity.toString(),
        });

        this.emit('poolInitialized', address, poolState);
      }

      // Initialize remaining pools individually if multicall missed some
      const remainingPools = enabledPools.filter(([address]) => !poolStates.has(address));
      
      if (remainingPools.length > 0) {
        console.log(`🔄 Initializing ${remainingPools.length} remaining pools individually...`);
        
        for (const [address] of remainingPools) {
          try {
            await this.initializePool(address);
          } catch (error) {
            console.warn(`Failed to initialize pool ${address}:`, error);
            this.emit('poolInitializationError', address, error);
          }
        }
      }

    } catch (error) {
      console.warn('Multicall initialization failed, falling back to individual initialization:', error);
      
      // Fallback to individual initialization
      for (const [address] of enabledPools) {
        try {
          await this.initializePool(address);
        } catch (error) {
          console.warn(`Failed to initialize pool ${address}:`, error);
          this.emit('poolInitializationError', address, error);
        }
      }
    }

    console.log(` Pool initialization completed: ${this.poolStates.size}/${enabledPools.length} pools ready`);
  }

  /**
   * Initialize a specific pool with enhanced error handling and rate limiting
   */
  private async initializePool(poolAddress: Address): Promise<void> {
    // Use provider rotation to avoid rate limits
    const provider = (this.connectionManager as any).getProviderWithRotation?.() || this.connectionManager.getProvider();
    let contract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

    // Enhanced retry logic with exponential backoff and provider rotation
    let retries = 0;
    const maxRetries = 5;
    let lastError: Error | null = null;

    while (retries < maxRetries) {
      try {
        // Add progressive delay to avoid rate limiting
        if (retries > 0) {
          const delay = Math.min(1000 * Math.pow(1.5, retries), 8000); // Max 8s delay
          console.warn(
            `Rate limited, retrying pool initialization for ${poolAddress} (attempt ${retries}/${maxRetries}) - waiting ${delay}ms`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Try a different provider on retry
          const rotatedProvider = (this.connectionManager as any).getProviderWithRotation?.() || this.connectionManager.getProvider();
          contract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, rotatedProvider);
        }

        // Use multicall-style batching to reduce RPC calls
        const batchResults = await this.batchContractCalls(contract, [
          'token0',
          'token1', 
          'fee'
        ]);

        const [token0, token1, fee] = batchResults;

        if (!token0 || !token1 || fee === undefined) {
          throw new Error('Invalid pool contract responses - missing token data');
        }

        // Validate this is a real Uniswap V3 pool
        if (!ethers.isAddress(token0) || !ethers.isAddress(token1)) {
          throw new Error('Invalid token addresses returned from pool contract');
        }

        // Success - store contract and continue
        this.poolContracts.set(poolAddress, contract);
        break;

      } catch (error: any) {
        lastError = error;
        retries++;

        // Check for specific rate limiting errors
        const isRateLimit = 
          error.code === 'CALL_EXCEPTION' ||
          error.message?.includes('rate limit') ||
          error.message?.includes('too many requests') ||
          error.message?.includes('429') ||
          error.status === 429;

        if (isRateLimit && retries < maxRetries) {
          continue; // Retry with backoff and provider rotation
        }

        // Check for invalid contract (not a Uniswap V3 pool)
        if (error.code === 'CALL_EXCEPTION' && retries >= 2) {
          console.error(`Pool ${poolAddress} appears to be invalid or not a Uniswap V3 pool:`, error.message);
          throw new Error(`Invalid Uniswap V3 pool at ${poolAddress}: ${error.message}`);
        }

        // Other errors - retry up to limit
        if (retries >= maxRetries) {
          break;
        }
      }
    }

    // If we exhausted retries, throw the last error
    if (retries >= maxRetries && lastError) {
      console.error(`Failed to initialize pool ${poolAddress} after ${maxRetries} attempts:`, lastError.message);
      throw new Error(`Pool initialization failed after ${maxRetries} attempts: ${lastError.message}`);
    }

    // Fetch initial state with retry logic
    try {
      const initialState = await this.fetchPoolStateWithRetry(contract, poolAddress);
      this.poolStates.set(poolAddress, initialState);
      
      console.log(` Pool ${poolAddress} initialized successfully:`, {
        token0: initialState.token0,
        token1: initialState.token1,
        fee: initialState.fee,
        liquidity: initialState.liquidity.toString(),
      });

      this.emit('poolInitialized', poolAddress, initialState);
    } catch (error) {
      console.error(`Failed to fetch initial state for pool ${poolAddress}:`, error);
      throw error;
    }
  }

  /**
   * Batch multiple contract calls to reduce RPC requests
   */
  private async batchContractCalls(contract: ethers.Contract, methods: string[]): Promise<any[]> {
    // Add small delay between batched calls to avoid overwhelming the RPC
    await new Promise(resolve => setTimeout(resolve, 100));

    // Execute calls with individual error handling
    const results = await Promise.all(
      methods.map(async (method) => {
        try {
          return await contract.getFunction(method)();
        } catch (error) {
          console.warn(`Failed to call ${method} on contract:`, error);
          return null;
        }
      })
    );

    return results;
  }

  /**
   * Fetch current pool state from blockchain with retry logic
   */
  private async fetchPoolState(
    contract: ethers.Contract,
    poolAddress: Address
  ): Promise<UniswapV3PoolState> {
    return this.fetchPoolStateWithRetry(contract, poolAddress);
  }

  /**
   * Fetch pool state with enhanced retry logic and rate limiting protection
   */
  private async fetchPoolStateWithRetry(
    contract: ethers.Contract,
    poolAddress: Address
  ): Promise<UniswapV3PoolState> {
    const provider = this.connectionManager.getProvider();
    let blockNumber: number;
    
    try {
      blockNumber = await provider.getBlockNumber();
    } catch (error) {
      console.warn(`Failed to get block number, using 0:`, error);
      blockNumber = 0;
    }

    let retries = 0;
    const maxRetries = 3;
    let lastError: Error | null = null;

    while (retries < maxRetries) {
      try {
        // Progressive delay and provider rotation to avoid rate limiting
        if (retries > 0) {
          const delay = 500 * Math.pow(1.5, retries); // 500ms, 750ms, 1125ms
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Try different provider on retry
          const rotatedProvider = (this.connectionManager as any).getProviderWithRotation?.() || this.connectionManager.getProvider();
          contract = new ethers.Contract(contract.target, UNISWAP_V3_POOL_ABI, rotatedProvider);
        }

        // Batch all contract calls with staggered timing to minimize RPC load
        const callPromises = [
          this.delayedContractCall(contract, 'token0', 0),
          this.delayedContractCall(contract, 'token1', 50),
          this.delayedContractCall(contract, 'fee', 100),
          this.delayedContractCall(contract, 'slot0', 150),
          this.delayedContractCall(contract, 'liquidity', 200),
          this.delayedContractCall(contract, 'tickSpacing', 250),
        ];

        const results = await Promise.all(callPromises);
        const [token0, token1, fee, slot0, liquidity, tickSpacing] = results;

        // Validate all required data is present
        if (
          !token0 ||
          !token1 ||
          fee === undefined ||
          !slot0 ||
          liquidity === undefined ||
          tickSpacing === undefined
        ) {
          throw new Error(`Incomplete contract responses: ${results.map((r) => r ? '' : '').join(' ')}`);
        }

        // Validate slot0 structure
        if (!slot0.sqrtPriceX96 || slot0.tick === undefined) {
          throw new Error('Invalid slot0 data structure');
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

      } catch (error: any) {
        lastError = error;
        retries++;

        const isRateLimit = 
          error.message?.includes('rate limit') ||
          error.message?.includes('too many requests') ||
          error.status === 429;

        if (isRateLimit && retries < maxRetries) {
          console.warn(`Rate limited fetching pool state for ${poolAddress}, retrying (${retries}/${maxRetries})`);
          continue;
        }

        if (retries >= maxRetries) {
          break;
        }
      }
    }

    // If we exhausted retries, throw the last error
    if (lastError) {
      console.error(`Failed to fetch pool state for ${poolAddress} after ${maxRetries} attempts:`, lastError.message);
      throw new Error(`Pool state fetch failed: ${lastError.message}`);
    }

    throw new Error('Unexpected error in fetchPoolStateWithRetry');
  }

  /**
   * Make a delayed contract call to spread out RPC requests
   */
  private async delayedContractCall(contract: ethers.Contract, method: string, delayMs: number): Promise<any> {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    try {
      return await contract.getFunction(method)();
    } catch (error) {
      console.warn(`Contract call ${method} failed:`, error);
      return null;
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
