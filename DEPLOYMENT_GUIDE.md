# 🚀 Base MEV Bot - Production Deployment Guide

## 📋 Pre-Deployment Checklist

### ✅ **Step 1: Deploy Flash Executor Contract**

#### **1.1 Compile Contracts**
```bash
npm run build:contracts
```

#### **1.2 Deploy to Base Sepolia (Testnet) First**
```bash
# Set your private key
export PRIVATE_KEY="your_private_key_here"
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"

# Deploy to testnet
npm run deploy:testnet
```

**Expected Output:**
```
Deploying contracts with the account: 0x...
FlashExecutor deployed to: 0x...
Deployment block: 12345678
Owner: 0x...
```

#### **1.3 Test on Sepolia**
```bash
# Update .env with testnet contract address
echo "FLASH_EXECUTOR_ADDRESS=0x..." >> .env

# Run bot in dry-run mode on testnet
npm run dev
```

#### **1.4 Deploy to Base Mainnet**
```bash
# CAUTION: This deploys to mainnet with real ETH
export BASE_RPC_URL="https://mainnet.base.org"
export BASESCAN_API_KEY="your_basescan_api_key"

# Deploy to mainnet
npm run deploy:mainnet

# Verify on BaseScan
npm run verify:mainnet
```

#### **1.5 Update Configuration**
```bash
# Update .env with mainnet contract address
FLASH_EXECUTOR_ADDRESS=0x_your_deployed_contract_address_here
```

---

### ✅ **Step 2: Configure Private Relays**

#### **2.1 Get bloXroute API Key**
1. Visit https://portal.blxrbdn.com/
2. Sign up for an account
3. Create API key for Base network
4. Add to `.env`:
```bash
BLOXROUTE_API_KEY=your_bloxroute_api_key_here
```

#### **2.2 Configure Flashbots Protect**
Flashbots Protect works without authentication on Base, but you can optionally set:
```bash
FLASHBOTS_AUTH_KEY=your_optional_auth_key
FLASHBOTS_PROTECT_URL=https://rpc.flashbots.net
```

#### **2.3 Test Relay Connectivity**
```bash
# Run the connectivity test script
npx tsx scripts/test-relay-connectivity.ts
```

**Expected Output:**
```
✅ Flashbots Protect
   Latency: 245ms
   Block Number: 12345678

✅ bloXroute BDN
   Latency: 187ms
   Block Number: 12345678

✅ Local/Public RPC
   Latency: 95ms
   Block Number: 12345678
```

---

### ✅ **Step 3: Configure Wallet and RPC**

#### **3.1 Setup Execution Wallet**
```bash
# Create a NEW dedicated wallet for MEV operations
# NEVER use your main wallet!

# Add to .env
EXECUTION_PRIVATE_KEY=your_dedicated_wallet_private_key
WALLET_ADDRESS=0x_your_wallet_address
```

#### **3.2 Fund Wallet**
- **Testnet**: Get free Sepolia ETH from faucet
- **Mainnet**: Start with **0.1-0.5 ETH only** for testing

#### **3.3 Configure RPC Providers**
```bash
# Get API keys from:
# - Alchemy: https://www.alchemy.com/
# - Infura: https://infura.io/

# Add to .env
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
INFURA_BASE_URL=https://base-mainnet.infura.io/v3/YOUR_PROJECT_ID
```

---

### ✅ **Step 4: Fix Configurations (CRITICAL)**

All critical configurations have been updated:

#### **✅ config/default.yaml**
- ✅ `minProfitUSD: 15.0` (conservative start)
- ✅ `maxGasPriceGwei: 0.1` (Base L2 appropriate)
- ✅ `maxSlippageBps: 100` (1% tight control)
- ✅ `dryRun: true` (safety: dry-run mode enabled)
- ✅ `paperTrading: true` (safety: paper trading enabled)
- ✅ Circuit breaker: `failureThreshold: 5` (more aggressive)
- ✅ Circuit breaker: `maxDailyLossUSD: 100` (limited exposure)

#### **✅ .env.example**
- ✅ RPC URLs updated with proper defaults
- ✅ Strategy parameters aligned with config
- ✅ Contract address placeholder added
- ✅ Security warnings added

---

## 🧪 Testing Phase

### **Phase 1: Dry-Run Testing (24-48 hours)**

```bash
# Ensure dry-run mode is enabled
# config/default.yaml:
dryRun: true
paperTrading: true

# Start the bot
npm run dev
```

**What to Monitor:**
- ✅ Opportunity detection frequency
- ✅ Profit calculations accuracy
- ✅ MEV protection triggers correctly
- ✅ No crashes or memory leaks
- ✅ RPC connection stability

**Success Criteria:**
- Bot runs stable for 24+ hours
- Detects 10+ opportunities per day
- No false positives (unprofitable flagged as profitable)
- Memory usage stays <500MB

---

### **Phase 2: Paper Trading (48 hours)**

```bash
# Enable paper trading, disable dry-run
# config/default.yaml:
dryRun: false
paperTrading: true

# Start the bot
npm run dev
```

**What Happens:**
- Bot simulates full execution flow
- Calculates gas costs with real estimates
- Tests transaction building (no signing)
- Validates profit after all costs

**Success Criteria:**
- Hypothetical P&L is positive
- Win rate >60%
- Average profit/trade >$15 after costs
- Risk circuit breakers activate correctly

---

### **Phase 3: Micro-Live Testing (24 hours)**

```bash
# CAUTION: This enables real trading!
# config/default.yaml:
dryRun: false
paperTrading: false

# Strategies -> arbitrage:
maxPositionSize: 100  # Limit to $100 per trade
minProfitUSD: 20.0    # Higher threshold for safety

# Start the bot (WATCH CLOSELY!)
npm run start
```

**First 10 Trades Checklist:**
- [ ] Monitor each transaction on BaseScan
- [ ] Verify profit calculations match reality
- [ ] Check slippage is within bounds
- [ ] Confirm gas costs are reasonable
- [ ] Ensure MEV protection is working

**Kill Switch:**
```bash
# If anything goes wrong, immediately:
1. Stop the bot: Ctrl+C
2. Set dryRun: true in config
3. Investigate logs
```

---

## 📊 Monitoring & Alerts

### **Health Checks**
```bash
# Platform health
curl http://localhost:3002/health

# Metrics
curl http://localhost:3002/metrics

# Status
curl http://localhost:3002/status
```

### **Log Monitoring**
```bash
# Follow logs
npm run dev | tee logs/bot-$(date +%Y%m%d).log

# Search for errors
grep -i "error" logs/*.log

# Check profit
grep "Profitable.*opportunity" logs/*.log
```

---

## 🎯 Going Live: Day 1-7 Plan

### **Day 1: Cautious Start**
```yaml
minProfitUSD: 20.0
maxPositionSize: 200
maxGasPriceGwei: 0.1
```
- **Goal**: 1-3 profitable trades
- **Budget**: 0.1 ETH max exposure
- **Action**: Manual review of every trade

### **Day 2-3: Validation**
```yaml
minProfitUSD: 18.0
maxPositionSize: 500
```
- **Goal**: 5+ trades, >60% win rate
- **Budget**: 0.2 ETH max exposure
- **Action**: Monitor every 2 hours

### **Day 4-7: Scale Up**
```yaml
minProfitUSD: 15.0
maxPositionSize: 2000
```
- **Goal**: 10+ trades/day
- **Budget**: 0.5 ETH max exposure
- **Action**: Daily P&L review

### **Week 2+: Optimization**
- Tune profit thresholds based on data
- Add more DEX pairs if profitable
- Increase position sizing gradually
- Consider enabling Phase 2 (liquidations)

---

## 🚨 Emergency Procedures

### **Circuit Breaker Activated**
```
Alert: Circuit breaker activated - Risk score: 75
```
**Action:**
1. Bot automatically pauses execution
2. Review recent trades and failures
3. Check if market conditions changed
4. Wait for auto-recovery (5 minutes)
5. If persistent, investigate and tune thresholds

### **Daily Loss Limit Reached**
```
Alert: Daily loss limit reached - Loss: $100
```
**Action:**
1. Bot stops trading for 24 hours
2. Analyze losing trades
3. Check for:
   - MEV competition increased
   - Pool liquidity dried up
   - Gas price spikes
   - Slippage issues

### **Consecutive Failures**
```
Alert: 5 consecutive failed trades
```
**Action:**
1. Check RPC connection health
2. Verify contract is working
3. Confirm private relay is operational
4. Review opportunity detection logic

---

## 📈 Success Metrics

### **Week 1 Targets**
- **Trades**: 10-30 total
- **Win Rate**: >60%
- **Avg Profit**: >$15 per winning trade
- **Max Drawdown**: <$100
- **Uptime**: >95%

### **Month 1 Targets**
- **Trades**: 100-200 total
- **Win Rate**: >65%
- **Net Profit**: $500-$3,000
- **ROI on Gas**: 3x minimum

---

## 🔧 Troubleshooting

### **Problem: No opportunities detected**
**Causes:**
- Min profit threshold too high
- Pools have low liquidity
- High competition on Base

**Solutions:**
- Lower `minProfitUSD` to 12.0
- Add more pool pairs
- Check if competitors dominating

### **Problem: All trades reverting**
**Causes:**
- Slippage too tight
- Gas price too low
- Contract not authorized

**Solutions:**
- Increase `maxSlippageBps` to 150
- Check contract has pool authorizations
- Verify gas estimation is accurate

### **Problem: Transactions stuck pending**
**Causes:**
- Gas price too low
- RPC issues
- Network congestion

**Solutions:**
- Increase `maxGasPriceGwei` slightly
- Check RPC provider status
- Enable transaction replacement

---

## 📞 Quick Reference

### **Commands**
```bash
# Deploy contract
npm run deploy:mainnet

# Test relays
npx tsx scripts/test-relay-connectivity.ts

# Run bot (dry-run)
npm run dev

# Run bot (live)
npm run start

# Check health
curl http://localhost:3002/health

# View logs
tail -f logs/*.log
```

### **Configuration Files**
- `config/default.yaml` - Strategy settings
- `.env` - Secrets and API keys
- `config/contracts.yaml` - Contract addresses

### **Important Thresholds**
- **Min Profit**: $15 (start) → $8 (optimized)
- **Max Gas**: 0.1 Gwei (Base L2)
- **Max Slippage**: 1.0% (tight control)
- **Circuit Breaker**: 5 failures

---

## ✅ Final Pre-Launch Checklist

- [ ] FlashExecutor deployed and verified
- [ ] bloXroute API key configured
- [ ] Dedicated wallet funded (0.1-0.5 ETH)
- [ ] RPC provider configured (Alchemy/Infura)
- [ ] All config parameters reviewed
- [ ] Relay connectivity test passed
- [ ] 24h dry-run completed successfully
- [ ] 48h paper trading shows positive P&L
- [ ] Health monitoring endpoints working
- [ ] Emergency procedures understood
- [ ] Kill switch ready (set dryRun: true)

**🎉 You're ready to deploy!**

Remember: Start small, monitor closely, and scale gradually.
