#!/usr/bin/env ts-node
/**
 * Fetch Top Pools from Base
 * 
 * Automatically fetches the top liquidity pools from:
 * - Uniswap V3 Factory on Base
 * - Aerodrome Factory on Base
 * 
 * Usage: npx ts-node scripts/fetch-base-pools.ts > config/pools-discovered.yaml
 */

import { ethers } from 'ethers';

// Base mainnet addresses
const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

// Common token addresses on Base
const TOKENS = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // Bridged USDC
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
};

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function liquidity() external view returns (uint128)',
];

interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  liquidity: string;
  dex: 'uniswap-v3' | 'aerodrome';
}

const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

async function getTokenSymbol(provider: ethers.Provider, address: string): Promise<string> {
  const entries = Object.entries(TOKENS);
  for (const [symbol, addr] of entries) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return symbol;
    }
  }
  return address.slice(0, 8);
}

async function fetchUniswapV3Pools(provider: ethers.Provider): Promise<PoolInfo[]> {
  console.error('🦄 Fetching Uniswap V3 pools...\n');
  
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);
  const pools: PoolInfo[] = [];
  
  const tokenList = Object.values(TOKENS);
  
  for (let i = 0; i < tokenList.length; i++) {
    for (let j = i + 1; j < tokenList.length; j++) {
      const token0 = tokenList[i];
      const token1 = tokenList[j];
      
      for (const fee of FEE_TIERS) {
        try {
          const poolAddress = await factory.getPool(token0, token1, fee);
          
          if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
            const liquidity = await pool.liquidity();
            
            if (liquidity > 0n) {
              const t0 = await pool.token0();
              const t1 = await pool.token1();
              
              pools.push({
                address: poolAddress,
                token0: t0,
                token1: t1,
                token0Symbol: await getTokenSymbol(provider, t0),
                token1Symbol: await getTokenSymbol(provider, t1),
                fee: fee,
                liquidity: liquidity.toString(),
                dex: 'uniswap-v3',
              });
              
              console.error(`   Found: ${await getTokenSymbol(provider, t0)}/${await getTokenSymbol(provider, t1)} ${fee/10000}%`);
            }
          }
        } catch (error) {
          // Pool doesn't exist, continue
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  
  return pools;
}

function generateYamlConfig(pools: PoolInfo[]): string {
  const yaml: string[] = [];
  
  yaml.push('# Auto-discovered Base Pools');
  yaml.push(`# Generated: ${new Date().toISOString()}`);
  yaml.push('# Total pools found: ' + pools.length);
  yaml.push('');
  yaml.push('allowedPools:');
  
  // Uniswap V3 pools
  const uniPools = pools.filter(p => p.dex === 'uniswap-v3');
  yaml.push('  uniswapV3:');
  
  for (const pool of uniPools) {
    yaml.push(`    - address: "${pool.address}"`);
    yaml.push('      enabled: true');
    yaml.push('      priority: 1');
    yaml.push('      minTvl: 100000');
    yaml.push('      maxSlippage: 0.02');
    yaml.push(`      fee: ${pool.fee}`);
    yaml.push(`      tags: ["${pool.token0Symbol.toLowerCase()}", "${pool.token1Symbol.toLowerCase()}"]`);
    yaml.push(`      description: "${pool.token0Symbol}/${pool.token1Symbol} ${pool.fee/10000}%"`);
    yaml.push('');
  }
  
  // Aerodrome pools (would need similar logic)
  yaml.push('  aerodrome: []');
  yaml.push('  # Note: Aerodrome pool discovery requires custom factory interface');
  
  return yaml.join('\n');
}

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  console.error(` Connecting to: ${rpcUrl}\n`);
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  try {
    const network = await provider.getNetwork();
    console.error(` Connected to: ${network.name} (${network.chainId})\n`);
    
    if (network.chainId !== 8453n) {
      console.error('  WARNING: Not on Base mainnet!');
    }
  } catch (error) {
    console.error(' Failed to connect:', (error as Error).message);
    process.exit(1);
  }
  
  const pools = await fetchUniswapV3Pools(provider);
  
  console.error('\n' + '═'.repeat(60));
  console.error(` Summary: Found ${pools.length} active pools`);
  console.error('═'.repeat(60) + '\n');
  
  // Output YAML to stdout
  console.log(generateYamlConfig(pools));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
