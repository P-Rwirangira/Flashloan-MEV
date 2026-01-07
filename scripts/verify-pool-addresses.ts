#!/usr/bin/env ts-node
/**
 * Pool Address Verification Script
 * 
 * Verifies that all configured pool addresses are valid and active on Base.
 * Run this before deploying with new pool configuration.
 * 
 * Usage: npx ts-node scripts/verify-pool-addresses.ts
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

// Minimal ABIs for verification
const UNISWAP_V3_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function liquidity() external view returns (uint128)',
];

const AERODROME_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function stable() external view returns (bool)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

interface PoolConfig {
  address: string;
  enabled: boolean;
  priority: number;
  minTvl: number;
  maxSlippage: number;
  fee?: number;
  tags?: string[];
  description?: string;
}

interface PoolVerificationResult {
  address: string;
  valid: boolean;
  token0?: string;
  token1?: string;
  liquidity?: string;
  error?: string;
}

async function verifyUniswapV3Pool(
  provider: ethers.Provider,
  poolConfig: PoolConfig
): Promise<PoolVerificationResult> {
  try {
    const contract = new ethers.Contract(poolConfig.address, UNISWAP_V3_POOL_ABI, provider);
    
    const [token0, token1, fee, liquidity] = await Promise.all([
      contract.token0(),
      contract.token1(),
      contract.fee(),
      contract.liquidity(),
    ]);

    return {
      address: poolConfig.address,
      valid: true,
      token0,
      token1,
      liquidity: liquidity.toString(),
    };
  } catch (error) {
    return {
      address: poolConfig.address,
      valid: false,
      error: (error as Error).message,
    };
  }
}

async function verifyAerodromePool(
  provider: ethers.Provider,
  poolConfig: PoolConfig
): Promise<PoolVerificationResult> {
  try {
    const contract = new ethers.Contract(poolConfig.address, AERODROME_POOL_ABI, provider);
    
    const [token0, token1, reserves] = await Promise.all([
      contract.token0(),
      contract.token1(),
      contract.getReserves(),
    ]);

    return {
      address: poolConfig.address,
      valid: true,
      token0,
      token1,
      liquidity: `${reserves.reserve0.toString()} / ${reserves.reserve1.toString()}`,
    };
  } catch (error) {
    return {
      address: poolConfig.address,
      valid: false,
      error: (error as Error).message,
    };
  }
}

async function main() {
  console.log(' Pool Address Verification Script\n');

  // Load configuration
  const configPath = process.argv[2] || path.join(__dirname, '..', 'config', 'pools-aggressive.yaml');
  console.log(` Loading config from: ${configPath}\n`);

  if (!fs.existsSync(configPath)) {
    console.error(` Configuration file not found: ${configPath}`);
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(configContent) as any;

  // Initialize provider
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  console.log(` Connecting to Base RPC: ${rpcUrl}\n`);
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Verify network
  try {
    const network = await provider.getNetwork();
    console.log(` Connected to network: ${network.name} (chainId: ${network.chainId})\n`);
    
    if (network.chainId !== 8453n) {
      console.error(' WARNING: Not connected to Base mainnet (chainId should be 8453)');
    }
  } catch (error) {
    console.error(' Failed to connect to RPC:', (error as Error).message);
    process.exit(1);
  }

  // Verify Uniswap V3 pools
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🦄 VERIFYING UNISWAP V3 POOLS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const uniV3Pools = config.allowedPools?.uniswapV3 || [];
  const uniV3Results: PoolVerificationResult[] = [];

  for (const pool of uniV3Pools) {
    process.stdout.write(`Verifying ${pool.address}... `);
    const result = await verifyUniswapV3Pool(provider, pool);
    uniV3Results.push(result);
    
    if (result.valid) {
      console.log(' VALID');
      console.log(`  Token0: ${result.token0}`);
      console.log(`  Token1: ${result.token1}`);
      console.log(`  Liquidity: ${result.liquidity}\n`);
    } else {
      console.log(' INVALID');
      console.log(`  Error: ${result.error}\n`);
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Verify Aerodrome pools
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VERIFYING AERODROME POOLS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const aeroPools = config.allowedPools?.aerodrome || [];
  const aeroResults: PoolVerificationResult[] = [];

  for (const pool of aeroPools) {
    process.stdout.write(`Verifying ${pool.address}... `);
    const result = await verifyAerodromePool(provider, pool);
    aeroResults.push(result);
    
    if (result.valid) {
      console.log(' VALID');
      console.log(`  Token0: ${result.token0}`);
      console.log(`  Token1: ${result.token1}`);
      console.log(`  Reserves: ${result.liquidity}\n`);
    } else {
      console.log(' INVALID');
      console.log(`  Error: ${result.error}\n`);
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' VERIFICATION SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  const uniV3Valid = uniV3Results.filter(r => r.valid).length;
  const uniV3Invalid = uniV3Results.filter(r => !r.valid).length;
  const aeroValid = aeroResults.filter(r => r.valid).length;
  const aeroInvalid = aeroResults.filter(r => !r.valid).length;

  console.log(`Uniswap V3 Pools: ${uniV3Valid} valid, ${uniV3Invalid} invalid`);
  console.log(`Aerodrome Pools: ${aeroValid} valid, ${aeroInvalid} invalid`);
  console.log(`Total: ${uniV3Valid + aeroValid} valid, ${uniV3Invalid + aeroInvalid} invalid\n`);

  if (uniV3Invalid > 0 || aeroInvalid > 0) {
    console.log(' INVALID POOLS FOUND:\n');
    
    [...uniV3Results, ...aeroResults]
      .filter(r => !r.valid)
      .forEach(r => {
        console.log(`  ${r.address}`);
        console.log(`    Error: ${r.error}\n`);
      });

    console.log('  Please update config/pools-aggressive.yaml with valid addresses.\n');
    process.exit(1);
  }

  console.log(' All pools verified successfully!');
  console.log(' Configuration is ready to use.\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
