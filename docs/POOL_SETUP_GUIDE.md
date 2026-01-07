# Pool Setup Guide - Aggressive Configuration

This guide walks you through setting up 20+ pools for maximum arbitrage opportunities.

## Quick Start

### Option 1: Auto-Discover Pools (Recommended)

```bash
# Install dependencies
npm install

# Fetch real pool addresses from Base
npx ts-node scripts/fetch-base-pools.ts > config/pools-discovered.yaml

# Verify the addresses
npx ts-node scripts/verify-pool-addresses.ts config/pools-discovered.yaml

# Update your main config to use discovered pools
cp config/pools-discovered.yaml config/default.yaml
```

### Option 2: Manual Pool Research

Visit these sites to find pool addresses:

**Uniswap V3 on Base:**
- https://info.uniswap.org/#/base/pools
- Sort by TVL (highest first)
- Copy addresses of top 10-15 pools

**Aerodrome on Base:**
- https://aerodrome.finance/liquidity
- Filter for Volatile + Stable pools
- Match token pairs with your UniV3 pools

## Pool Selection Criteria

###  Good Pools
- **TVL > $500K** for volatile pairs
- **TVL > $1M** for stablecoin pairs
- **24h volume > $100K**
- Exists on BOTH Uniswap V3 and Aerodrome
- Token pair makes sense (e.g., WETH/USDC, not obscure tokens)

###  Avoid These
- TVL < $100K (too illiquid)
- No matching pair on other DEX
- Exotic/low-volume tokens
- Pools with < 10 swaps/day
- Meme coins or highly volatile assets

## Recommended Token Pairs (Priority Order)

### Tier 1: Must-Have (WETH pairs)
1. **WETH/USDC** - Highest volume, most arbitrage opportunities
2. **WETH/USDbC** - Bridged USDC, often price differences
3. **WETH/cbETH** - ETH derivative arbitrage
4. **WETH/DAI** - Alternative stablecoin

### Tier 2: High Value (Stablecoins)
5. **USDC/USDbC** - Tight spreads, high frequency
6. **USDC/DAI** - Classic stable pair
7. **USDbC/DAI** - Bridged arbitrage

### Tier 3: Bitcoin Exposure
8. **WETH/cbBTC** - BTC/ETH ratio arbs
9. **cbBTC/USDC** - BTC/USD arbs
10. **cbBTC/USDbC** - Alternative liquidity

### Tier 4: Liquid Staking
11. **cbETH/USDC** - LST arbitrage
12. **cbETH/USDbC** - Alternative LST liquidity

## Configuration Template

For each pool, use this structure:

```yaml
- address: "0xYOUR_POOL_ADDRESS_HERE"
  enabled: true
  priority: 1        # 1=highest, 3=lowest
  minTvl: 500000     # Minimum $500K TVL
  maxSlippage: 0.02  # 2% max slippage
  fee: 500           # Fee tier (100=0.01%, 500=0.05%, 3000=0.3%)
  tags: ["weth", "usdc", "tier1"]
  description: "WETH/USDC 0.05%"
```

## Finding Pool Addresses

### Method 1: Uniswap V3 Factory (On-Chain)

```typescript
// Using ethers.js
const factory = new ethers.Contract(
  '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // UniV3 Factory on Base
  ['function getPool(address,address,uint24) view returns (address)'],
  provider
);

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Get pool for WETH/USDC 0.05% fee tier
const pool = await factory.getPool(WETH, USDC, 500);
console.log('Pool address:', pool);
```

### Method 2: Block Explorers

1. Go to https://basescan.org
2. Search for Uniswap V3 Factory: `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`
3. Go to "Read Contract"
4. Call `getPool()` with token addresses and fee tier

### Method 3: DeFi Analytics Sites

- **DeBank:** https://debank.com/protocols/base_uniswap3
- **DeFiLlama:** https://defillama.com/protocol/uniswap-v3
- **Dune Analytics:** Search for "Base Uniswap pools"

## Verification Checklist

Before deploying your config:

- [ ] All pool addresses are valid (40 characters starting with 0x)
- [ ] Each pool exists on-chain (verified via script)
- [ ] Token pairs match between UniV3 and Aerodrome
- [ ] TVL meets minimum requirements
- [ ] No duplicate pool addresses
- [ ] Fee tiers are correct (100, 500, 3000, or 10000)
- [ ] Slippage tolerances are reasonable (< 5%)

## Testing Your Configuration

```bash
# Dry run test
npm start

# Watch the logs for:
#  "Aerodrome monitor initialized {"poolCount": 10}"
#  "Pool state manager started"
#  "Arbitrage scanner started successfully"

# Should see in ~30 seconds:
# "Updating pool pairings" with totalPools > 0
# "Monitored pairs" with pairsScanned > 0
```

## Performance Expectations

| Pools | Memory | CPU | Scan Time | Opps/Hour |
|-------|--------|-----|-----------|-----------|
| 3     | 20MB   | 10% | 50ms      | 0-2       |
| 10    | 40MB   | 30% | 150ms     | 5-20      |
| 20    | 80MB   | 50% | 300ms     | 15-50     |
| 30    | 120MB  | 70% | 500ms     | 30-100    |

## Common Issues

### "Pool count: 0" in logs
- **Cause:** Invalid addresses or wrong network
- **Fix:** Run verification script, check RPC connection

### High CPU usage (>80%)
- **Cause:** Too many pools or short scan interval
- **Fix:** Reduce pools or increase `scanIntervalMs` to 3000-5000

### No opportunities detected
- **Cause:** Pools not paired correctly
- **Fix:** Ensure same token pairs exist on both DEXs

### Memory leaks
- **Cause:** Old opportunities not cleaned up
- **Fix:** Already fixed in recent patch (opportunity limit: 100)

## Need Help?

Run diagnostics:

```bash
# Check pool health
npx ts-node scripts/verify-pool-addresses.ts

# View current metrics
curl http://localhost:3002/health

# Enable debug logging
export LOG_LEVEL=debug
npm start
```

## Next Steps

Once pools are configured:

1. **Start in paper trading mode** (dryRun: true)
2. **Monitor for 24 hours** to verify opportunities
3. **Check profitability thresholds** in logs
4. **Adjust minSpreadBps** if too many false positives
5. **Enable live trading** when confident
