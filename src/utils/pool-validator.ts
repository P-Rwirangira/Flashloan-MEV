/**
 * Pool Validation Utility
 * 
 * Validates pool addresses and configurations to ensure they're correct for Base mainnet.
 */

import { ethers } from 'ethers';
import { Address } from '../types/common';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface PoolValidationResult {
  readonly isValid: boolean;
  readonly poolAddress: Address;
  readonly token0?: Address;
  readonly token1?: Address;
  readonly fee?: number;
  readonly poolType: 'uniswap-v3' | 'aerodrome' | 'unknown';
  readonly error?: string;
  readonly warnings: string[];
}

export interface KnownToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly isStable?: boolean;
}

// Known Base mainnet tokens
export const KNOWN_BASE_TOKENS: Record<string, KnownToken> = {
  // Native and wrapped tokens
  'WETH': {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    decimals: 18,
  },
  'ETH': {
    address: '0x4200000000000000000000000000000000000006', // Same as WETH
    symbol: 'ETH',
    decimals: 18,
  },
  
  // Stablecoins
  'USDC': {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    decimals: 6,
    isStable: true,
  },
  'USDbC': {
    address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    symbol: 'USDbC',
    decimals: 6,
    isStable: true,
  },
  'DAI': {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    symbol: 'DAI',
    decimals: 18,
    isStable: true,
  },
  
  // Other major tokens
  'cbETH': {
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    symbol: 'cbETH',
    decimals: 18,
  },
  'wstETH': {
    address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    symbol: 'wstETH',
    decimals: 18,
  },
};

// Known Base mainnet pool addresses (verified)
export const KNOWN_BASE_POOLS: Record<Address, {
  token0: Address;
  token1: Address;
  fee?: number;
  dex: 'uniswap-v3' | 'aerodrome';
  verified: boolean;
}> = {
  // Uniswap V3 pools
  '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18': {
    token0: KNOWN_BASE_TOKENS['WETH']!.address,
    token1: KNOWN_BASE_TOKENS['USDC']!.address,
    fee: 500, // 0.05%
    dex: 'uniswap-v3',
    verified: true,
  },
  '0xd0b53D9277642d899DF5C87A3966A349A798F224': {
    token0: KNOWN_BASE_TOKENS['WETH']!.address,
    token1: KNOWN_BASE_TOKENS['USDC']!.address,
    fee: 3000, // 0.3%
    dex: 'uniswap-v3',
    verified: true,
  },
  '0x7B73644935b8e68019ac6356c40661E1bc315860': {
    token0: KNOWN_BASE_TOKENS['WETH']!.address,
    token1: KNOWN_BASE_TOKENS['cbETH']!.address,
    fee: 500, // 0.05%
    dex: 'uniswap-v3',
    verified: true,
  },
  '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b': {
    token0: KNOWN_BASE_TOKENS['USDC']!.address,
    token1: KNOWN_BASE_TOKENS['USDbC']!.address,
    fee: 100, // 0.01%
    dex: 'uniswap-v3',
    verified: true,
  },
  
  // Aerodrome pools
  '0xcDAC0d6c6C59727a65F871236188350531885C43': {
    token0: KNOWN_BASE_TOKENS['WETH']!.address,
    token1: KNOWN_BASE_TOKENS['USDC']!.address,
    dex: 'aerodrome',
    verified: true,
  },
};

const UNISWAP_V3_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function liquidity() external view returns (uint128)',
];

export class PoolValidator {
  private readonly connectionManager: RpcConnectionManager;

  constructor(connectionManager: RpcConnectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Validate a single pool address
   */
  async validatePool(poolAddress: Address): Promise<PoolValidationResult> {
    const warnings: string[] = [];
    
    try {
      // Check if it's a known pool first
      const knownPool = KNOWN_BASE_POOLS[poolAddress];
      if (knownPool) {
        return {
          isValid: true,
          poolAddress,
          token0: knownPool.token0,
          token1: knownPool.token1,
          fee: knownPool.fee,
          poolType: knownPool.dex,
          warnings: knownPool.verified ? [] : ['Pool not verified on-chain'],
        } as PoolValidationResult;
      }

      // Validate address format
      if (!ethers.isAddress(poolAddress)) {
        return {
          isValid: false,
          poolAddress,
          poolType: 'unknown',
          error: 'Invalid address format',
          warnings,
        };
      }

      // Try to validate as Uniswap V3 pool
      const uniV3Result = await this.validateUniswapV3Pool(poolAddress);
      if (uniV3Result.isValid) {
        return uniV3Result;
      }

      // Try to validate as Aerodrome pool
      const aeroResult = await this.validateAerodromePool(poolAddress);
      if (aeroResult.isValid) {
        return aeroResult;
      }

      return {
        isValid: false,
        poolAddress,
        poolType: 'unknown',
        error: 'Pool does not match any known DEX interface',
        warnings,
      };

    } catch (error) {
      return {
        isValid: false,
        poolAddress,
        poolType: 'unknown',
        error: error instanceof Error ? error.message : String(error),
        warnings,
      };
    }
  }

  /**
   * Validate multiple pools
   */
  async validatePools(poolAddresses: Address[]): Promise<PoolValidationResult[]> {
    const results: PoolValidationResult[] = [];
    
    for (const address of poolAddresses) {
      try {
        const result = await this.validatePool(address);
        results.push(result);
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        results.push({
          isValid: false,
          poolAddress: address,
          poolType: 'unknown',
          error: error instanceof Error ? error.message : String(error),
          warnings: [],
        });
      }
    }

    return results;
  }

  /**
   * Validate as Uniswap V3 pool
   */
  private async validateUniswapV3Pool(poolAddress: Address): Promise<PoolValidationResult> {
    const warnings: string[] = [];
    
    try {
      const provider = this.connectionManager.getProvider();
      const contract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

      // Try to call Uniswap V3 specific functions
      const [token0, token1, fee, liquidity] = await Promise.all([
        contract.getFunction('token0')().catch(() => null),
        contract.getFunction('token1')().catch(() => null),
        contract.getFunction('fee')().catch(() => null),
        contract.getFunction('liquidity')().catch(() => null),
      ]);

      if (!token0 || !token1 || fee === null || liquidity === null) {
        return {
          isValid: false,
          poolAddress,
          poolType: 'unknown',
          error: 'Missing required Uniswap V3 pool functions',
          warnings,
        };
      }

      // Validate token addresses
      if (!ethers.isAddress(token0) || !ethers.isAddress(token1)) {
        warnings.push('Invalid token addresses returned from pool');
      }

      // Check if tokens are known
      const token0Info = this.getTokenInfo(token0);
      const token1Info = this.getTokenInfo(token1);

      if (!token0Info) {
        warnings.push(`Unknown token0: ${token0}`);
      }
      if (!token1Info) {
        warnings.push(`Unknown token1: ${token1}`);
      }

      // Check liquidity
      if (liquidity === 0n) {
        warnings.push('Pool has zero liquidity');
      }

      return {
        isValid: true,
        poolAddress,
        token0,
        token1,
        fee: Number(fee),
        poolType: 'uniswap-v3',
        warnings,
      };

    } catch (error) {
      return {
        isValid: false,
        poolAddress,
        poolType: 'unknown',
        error: `Uniswap V3 validation failed: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
      };
    }
  }

  /**
   * Validate as Aerodrome pool
   */
  private async validateAerodromePool(poolAddress: Address): Promise<PoolValidationResult> {
    const warnings: string[] = [];
    
    try {
      // Aerodrome pools have different ABI - this is a simplified check
      const provider = this.connectionManager.getProvider();
      const code = await provider.getCode(poolAddress);
      
      if (code === '0x') {
        return {
          isValid: false,
          poolAddress,
          poolType: 'unknown',
          error: 'No contract code at address',
          warnings,
        };
      }

      // For now, assume it's a valid Aerodrome pool if it has code
      // In a real implementation, you'd check for Aerodrome-specific functions
      warnings.push('Aerodrome pool validation is simplified - manual verification recommended');

      return {
        isValid: true,
        poolAddress,
        poolType: 'aerodrome',
        warnings,
      };

    } catch (error) {
      return {
        isValid: false,
        poolAddress,
        poolType: 'unknown',
        error: `Aerodrome validation failed: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
      };
    }
  }

  /**
   * Get token info from known tokens
   */
  private getTokenInfo(tokenAddress: Address): KnownToken | undefined {
    return Object.values(KNOWN_BASE_TOKENS).find(
      token => token.address.toLowerCase() === tokenAddress.toLowerCase()
    );
  }

  /**
   * Generate validation report
   */
  generateValidationReport(results: PoolValidationResult[]): string {
    const valid = results.filter(r => r.isValid);
    const invalid = results.filter(r => !r.isValid);
    const withWarnings = results.filter(r => r.warnings.length > 0);

    let report = `Pool Validation Report\n`;
    report += `======================\n\n`;
    report += `Total pools: ${results.length}\n`;
    report += `Valid pools: ${valid.length}\n`;
    report += `Invalid pools: ${invalid.length}\n`;
    report += `Pools with warnings: ${withWarnings.length}\n\n`;

    if (valid.length > 0) {
      report += `Valid Pools:\n`;
      report += `------------\n`;
      for (const result of valid) {
        report += `✅ ${result.poolAddress} (${result.poolType})\n`;
        if (result.token0 && result.token1) {
          const token0Info = this.getTokenInfo(result.token0);
          const token1Info = this.getTokenInfo(result.token1);
          report += `   ${token0Info?.symbol || result.token0}/${token1Info?.symbol || result.token1}`;
          if (result.fee) {
            report += ` (${result.fee / 100}%)`;
          }
          report += `\n`;
        }
        if (result.warnings.length > 0) {
          report += `   Warnings: ${result.warnings.join(', ')}\n`;
        }
        report += `\n`;
      }
    }

    if (invalid.length > 0) {
      report += `Invalid Pools:\n`;
      report += `--------------\n`;
      for (const result of invalid) {
        report += `❌ ${result.poolAddress}\n`;
        report += `   Error: ${result.error}\n\n`;
      }
    }

    return report;
  }
}