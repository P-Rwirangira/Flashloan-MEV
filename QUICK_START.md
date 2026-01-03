# ⚡ Quick Start - Deploy in 30 Minutes

## 🎯 Objective
Get your Base MEV bot deployed and running in dry-run mode within 30 minutes.

---

## ✅ Prerequisites
- Node.js 18+
- 0.5 ETH on Base mainnet (or Sepolia ETH for testnet)
- API keys: Alchemy/Infura, bloXroute, BaseScan

---

## 📝 Step-by-Step (30 min)

### **Minute 0-5: Setup Project**

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

**Required .env values:**
```bash
EXECUTION_PRIVATE_KEY=your_private_key_here
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
BLOXROUTE_API_KEY=your_bloxroute_api_key_here
BASESCAN_API_KEY=your_basescan_api_key_here
```

---

### **Minute 5-10: Deploy Contract**

```bash
# Compile contracts
npm run build:contracts

# Deploy to Base Sepolia (testnet first!)
export PRIVATE_KEY="your_key"
npm run deploy:testnet

# Note the contract address from output
# Add to .env:
echo "FLASH_EXECUTOR_ADDRESS=0x..." >> .env
```

---

### **Minute 10-15: Test Infrastructure**

```bash
# Run relay connectivity test
npm run test:relay
```

**Expected output:**
```
✅ Flashbots Protect - Latency: 245ms
✅ bloXroute BDN - Latency: 187ms
✅ Local/Public RPC - Latency: 95ms
✅ FlashExecutor Contract: Deployed
✅ Wallet Balance: 0.5 ETH
```

---

### **Minute 15-20: Verify Configuration**

```bash
# Type check (should pass)
npm run typecheck

# Review config
cat config/default.yaml | grep -A5 "arbitrage:"
```

**Verify these settings:**
- ✅ `dryRun: true` (MUST be true for first run)
- ✅ `paperTrading: true` (MUST be true for first run)
- ✅ `minProfitUSD: 15.0` (conservative)
- ✅ `maxGasPriceGwei: 0.1` (Base L2 appropriate)

---

### **Minute 20-25: First Dry Run**

```bash
# Start bot in dry-run mode
npm run dev
```

**Watch for:**
```
[platform] Initializing Base MEV Platform...
[platform] 🔒 RUNNING IN DRY-RUN MODE
[platform] Base MEV Platform started successfully
[arbitrage] Phase 1 arbitrage scanner initialized
```

**Let it run for 5 minutes**, check logs for:
- Opportunity detection
- Profit calculations
- No crashes or errors

---

### **Minute 25-30: Health Check & Validation**

Open a new terminal:

```bash
# Check health
curl http://localhost:3002/health | jq

# Check metrics
curl http://localhost:3002/metrics | jq

# Watch logs for opportunities
tail -f logs/*.log | grep "Profitable.*opportunity"
```

---

## ✅ Success Criteria (30-min mark)

- ✅ Bot is running without crashes
- ✅ Health check returns `"healthy": true`
- ✅ RPC connections are stable
- ✅ Detecting 1+ opportunities per 10 minutes
- ✅ No type errors or compilation issues

---

## 🔧 Common Issues & Fixes

### **Issue: "No opportunities detected"**
```bash
# Lower profit threshold temporarily
# In config/default.yaml:
minProfitUSD: 10.0  # Was 15.0

# Restart
npm run dev
```

### **Issue: "RPC connection failed"**
```bash
# Check RPC URL is correct
echo $BASE_RPC_URL

# Try fallback provider
export BASE_RPC_URL="https://mainnet.base.org"
npm run dev
```

### **Issue: "bloXroute API key invalid"**
```bash
# Test API key manually
curl -H "Authorization: YOUR_API_KEY" https://base.bdn.blxrbdn.com

# If invalid, get new key from: https://portal.blxrbdn.com/
```

---

## 🎯 Next Steps (After 30 min)

### **Hour 1-24: Extended Dry-Run**
Keep bot running in dry-run mode for 24 hours:
```bash
# Run in background with logs
nohup npm run dev > logs/dry-run.log 2>&1 &

# Monitor
tail -f logs/dry-run.log
```

### **Day 2-3: Paper Trading**
```bash
# Edit config/default.yaml:
dryRun: false
paperTrading: true

# Restart and monitor for 48 hours
npm run dev
```

### **Day 4+: Micro-Live Testing**
See `DEPLOYMENT_GUIDE.md` for full launch plan.

---

## 📊 Quick Commands Reference

```bash
# Deploy
npm run deploy:testnet          # Deploy to Sepolia
npm run deploy:mainnet          # Deploy to Base mainnet

# Testing
npm run test:relay              # Test relay connectivity
npm run typecheck               # Check types

# Running
npm run dev                     # Development mode (with restart)
npm run start                   # Production mode (compiled)

# Monitoring
curl http://localhost:3002/health    # Health check
curl http://localhost:3002/metrics   # Metrics
curl http://localhost:3002/status    # Simple status
```

---

## 🚨 Safety Reminders

1. **ALWAYS** start with `dryRun: true`
2. **NEVER** use your main wallet
3. **TEST** on Sepolia first
4. **START** with small amounts (0.1 ETH)
5. **MONITOR** closely for first 10 trades

---

## 📞 Need Help?

- **Config issues**: Check `config/default.yaml`
- **Deployment issues**: See `DEPLOYMENT_GUIDE.md`
- **Type errors**: Run `npm run typecheck`
- **Relay issues**: Run `npm run test:relay`

---

## ✅ 30-Minute Checklist

- [ ] Dependencies installed
- [ ] `.env` configured with all API keys
- [ ] Contract deployed to testnet
- [ ] `FLASH_EXECUTOR_ADDRESS` in `.env`
- [ ] Relay connectivity test passed
- [ ] Type check passed
- [ ] Bot running in dry-run mode
- [ ] Health check returns healthy
- [ ] Detecting opportunities

**🎉 If all checked, you're ready for 24h dry-run testing!**
