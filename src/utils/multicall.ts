/**
 * Multicall Utility
 * 
 * Batches multiple contract calls into a single RPC request to reduce rate limiting.
 */

import { ethers } from 'ethers';
import { Address } from '../types/common';

// Multicall3 contract ABI (deployed on Base at 0xcA11bde05977b3631167028862bE2a173976CA11)
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)',
  'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)',
];

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'; // Base mainnet

export interface MulticallRequest {
  target: Address;
  callData: string;
  allowFailure?: boolean;
}

export interface MulticallResult {
  success: boolean;
  returnData: string;
}

export class MulticallManager {
  private readonly provider: ethers.Provider;
  private multicallContract: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.multicallContract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  /**
   * Execute multiple contract calls in a single transaction
   */
  async multicall(requests: MulticallRequest[]): Promise<MulticallResult[]> {
    if (requests.length === 0) {
      return [];
    }

    try {
      // Prepare calls for multicall
      const calls = requests.map(req => ({
        target: req.target,
        allowFailure: req.allowFailure ?? true,
        callData: req.callData,
      }));

      // Execute multicall
      if (!this.multicallContract) {
        throw new Error('Multicall contract not initialized');
      }
      
      const aggregate3Fn = this.multicallContract['aggregate3'];
      if (!aggregate3Fn) {
        throw new Error('aggregate3 function not found on multicall contract');
      }
      
      const results = await aggregate3Fn(calls);

      return results.map((result: any) => ({
        success: result.success,
        returnData: result.returnData,
      }));

    } catch (error) {
      console.warn('Multicall failed, falling back to individual calls:', error);
      
      // Fallback to individual calls
      return await this.fallbackIndividualCalls(requests);
    }
  }

  /**
   * Fallback to individual contract calls if multicall fails
   */
  private async fallbackIndividualCalls(requests: MulticallRequest[]): Promise<MulticallResult[]> {
    const results: MulticallResult[] = [];

    for (const request of requests) {
      try {
        const result = await this.provider.call({
          to: request.target,
          data: request.callData,
        });

        results.push({
          success: true,
          returnData: result,
        });

        // Add small delay between calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (error) {
        if (request.allowFailure) {
          results.push({
            success: false,
            returnData: '0x',
          });
        } else {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Helper to create contract call data
   */
  static encodeCall(contractInterface: ethers.Interface, functionName: string, params: any[] = []): string {
    return contractInterface.encodeFunctionData(functionName, params);
  }

  /**
   * Helper to decode contract call result
   */
  static decodeResult(contractInterface: ethers.Interface, functionName: string, data: string): any {
    if (data === '0x' || data.length <= 2) {
      return null;
    }
    
    try {
      return contractInterface.decodeFunctionResult(functionName, data);
    } catch (error) {
      console.warn(`Failed to decode result for ${functionName}:`, error);
      return null;
    }
  }
}

/**
 * Pool State Multicall Helper
 * 
 * Specialized helper for fetching pool states efficiently.
 */
export class PoolStateMulticall {
  private readonly multicallManager: MulticallManager;
  private readonly poolInterface: ethers.Interface;

  constructor(provider: ethers.Provider) {
    this.multicallManager = new MulticallManager(provider);
    
    // Uniswap V3 Pool interface
    this.poolInterface = new ethers.Interface([
      'function token0() external view returns (address)',
      'function token1() external view returns (address)',
      'function fee() external view returns (uint24)',
      'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      'function liquidity() external view returns (uint128)',
      'function tickSpacing() external view returns (int24)',
    ]);
  }

  /**
   * Fetch multiple pool states in a single multicall
   */
  async fetchPoolStates(poolAddresses: Address[]): Promise<Map<Address, any>> {
    const results = new Map<Address, any>();

    if (poolAddresses.length === 0) {
      return results;
    }

    try {
      // Prepare multicall requests for all pools
      const requests: MulticallRequest[] = [];
      
      for (const poolAddress of poolAddresses) {
        // Add all required calls for each pool
        requests.push(
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'token0'),
            allowFailure: true,
          },
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'token1'),
            allowFailure: true,
          },
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'fee'),
            allowFailure: true,
          },
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'slot0'),
            allowFailure: true,
          },
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'liquidity'),
            allowFailure: true,
          },
          {
            target: poolAddress,
            callData: MulticallManager.encodeCall(this.poolInterface, 'tickSpacing'),
            allowFailure: true,
          }
        );
      }

      // Execute multicall
      const multicallResults = await this.multicallManager.multicall(requests);

      // Process results (6 calls per pool)
      const callsPerPool = 6;
      for (let i = 0; i < poolAddresses.length; i++) {
        const poolAddress = poolAddresses[i];
        const startIndex = i * callsPerPool;
        
        const poolResults = multicallResults.slice(startIndex, startIndex + callsPerPool);
        
        // Decode results with proper null checks
        const token0 = poolResults[0]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'token0', poolResults[0].returnData)?.[0] : null;
        const token1 = poolResults[1]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'token1', poolResults[1].returnData)?.[0] : null;
        const fee = poolResults[2]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'fee', poolResults[2].returnData)?.[0] : null;
        const slot0 = poolResults[3]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'slot0', poolResults[3].returnData) : null;
        const liquidity = poolResults[4]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'liquidity', poolResults[4].returnData)?.[0] : null;
        const tickSpacing = poolResults[5]?.success ? 
          MulticallManager.decodeResult(this.poolInterface, 'tickSpacing', poolResults[5].returnData)?.[0] : null;

        // Only include pools with complete data
        if (token0 && token1 && fee !== null && slot0 && liquidity !== null && tickSpacing !== null) {
          results.set(poolAddress as Address, {
            address: poolAddress,
            token0,
            token1,
            fee: Number(fee),
            sqrtPriceX96: slot0[0],
            tick: Number(slot0[1]),
            liquidity,
            tickSpacing: Number(tickSpacing),
            lastUpdated: Date.now(),
            isActive: true,
          });
        } else {
          console.warn(`Incomplete data for pool ${poolAddress}:`, {
            token0: !!token0,
            token1: !!token1,
            fee: fee !== null,
            slot0: !!slot0,
            liquidity: liquidity !== null,
            tickSpacing: tickSpacing !== null,
          });
        }
      }

      console.log(`✅ Multicall fetched ${results.size}/${poolAddresses.length} pool states successfully`);

    } catch (error) {
      console.error('Failed to fetch pool states via multicall:', error);
    }

    return results;
  }
}