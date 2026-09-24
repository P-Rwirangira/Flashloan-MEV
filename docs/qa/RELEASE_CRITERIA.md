# MEV Platform Release Criteria & Deployment Gates

This document defines the formal gating criteria and quality standards required before any code modification can be merged, promoted to paper trading, or cleared for live on-chain execution.

---

## 1. Stage Gate Architecture

```
[ Gate 1: Merge Clearance ]
  ├── Hardhat Solidity compilation succeeds with 0 warnings
  ├── TypeScript typecheck passes with 0 errors (strict mode)
  ├── 100% of automated unit & integration tests pass (50/50)
  └── Configuration validates against Zod schemas
            │
            ▼
[ Gate 2: Dry-Run Clearance (Simulation) ]
  ├── Validated RPC endpoints with < 50ms latency
  ├── dryRun: true and paperTrading: true enabled
  ├── Ingestion of DEX pool updates without unhandled exceptions
  └── Continuous 24h soak test with stable memory footprint (< 256MB heap)
            │
            ▼
[ Gate 3: Paper Trading Clearance (Execution Simulation) ]
  ├── dryRun: false and paperTrading: true
  ├── Accurate transaction calldata assembly and gas estimation
  ├── Pre-trade simulation verifies positive net profit after fees
  └── Zero circuit breaker trip events across 48-hour continuous run
            │
            ▼
[ Gate 4: Micro-Live Production Clearance ]
  ├── FlashExecutor.sol deployed and verified on Base mainnet
  ├── BLOXROUTE_API_KEY and FLASH_EXECUTOR_ADDRESS configured
  ├── Initial wallet funding capped at 0.05 - 0.1 ETH
  ├── Hard risk limit: $100 max daily loss circuit breaker
  └── Emergency kill switch verified (SIGINT/SIGTERM graceful shutdown)
```

---

## 2. Gate 1: Code Merge & CI Clearance

Every pull request must pass the automated CI pipeline without exception:

| Criterion | Requirement | Verification Command | Gate Status |
| :--- | :--- | :--- | :---: |
| **Smart Contract Build** | All Solidity contracts compile cleanly; TypeChain artifacts generated | `npm run build:contracts` | **MANDATORY** |
| **Type Integrity** | TypeScript strict mode passes with zero errors | `npm run typecheck` | **MANDATORY** |
| **Automated Tests** | All 7 test suites pass in Jest | `npm test` | **MANDATORY** |
| **Regression Protection** | New defect fixes must include explicit test cases in `tests/unit/` | Code review + matrix check | **MANDATORY** |
| **Config Schema** | Default YAML configuration conforms to Zod schemas | `tests/unit/config-validator.test.ts` | **MANDATORY** |

---

## 3. Gate 2: Dry-Run Ingestion Clearance

Before running against real-time mempool feeds:
1. **RPC Connection Quality**: Primary RPC endpoint must demonstrate latency under 50ms on Base mainnet. Backup RPC endpoints must be configured for automatic failover.
2. **Configuration Mode**:
   ```yaml
   dryRun: true
   paperTrading: true
   ```
3. **Mempool Ingestion Stability**: Minimum 24-hour continuous run logging pool reserves, block propagation delays, and opportunity candidate counts without process restarts.

---

## 4. Gate 3: Paper Trading Simulation Clearance

Before generating transactions with production wallet credentials:
1. **Simulation Verification**: Every opportunity route must be simulated via exact AMM math (`simulateArbitrageRoute`) or Foundry state-fork simulation before recording theoretical profit.
2. **Net Profit Invariant**: Gross profit must exceed all operational costs:
   $$\text{Net Profit} = \text{Gross Profit} - \text{DEX Fees} - \text{Flash Loan Fee} - \text{Gas Cost} > \text{minProfitUSD} (\$15.00)$$
3. **Slippage Bounds**: Max slippage strictly capped at 100 bps (1.0%). Any simulated route exceeding this threshold must be discarded.
4. **Execution Log Audit**: Zero uncaught exceptions, division-by-zero crashes, or unbounded memory growth over 48 hours.

---

## 5. Gate 4: Live Production Clearance

Live trading involves real capital and on-chain execution. The following requirements must be verified and signed off before switching `paperTrading: false`:

### 5.1 Infrastructure Prerequisites
- [ ] **Smart Contract**: `FlashExecutor.sol` deployed on Base mainnet (Chain ID 8453) and verified on BaseScan.
- [ ] **Contract Address Configured**: `FLASH_EXECUTOR_ADDRESS` populated in `.env`.
- [ ] **MEV Protection**: bloXroute BDN API key acquired and tested (`npm run relay:test`). Flashbots builder relay endpoint active.
- [ ] **Gas Wallet**: Separate dedicated hot wallet holding no more than 0.1 ETH operational gas funds. Never store primary treasury funds in execution wallet.

### 5.2 Circuit Breakers & Risk Caps
- [ ] `failureThreshold` configured at 5 consecutive failed transactions.
- [ ] `dailyLossLimit` configured at $100 USD.
- [ ] `maxGasPriceGwei` capped at 0.1 Gwei.
- [ ] `maxPositionSize` capped at $100 USD during initial micro-live phase.

### 5.3 Rollback & Kill Switch Procedures
- [ ] Graceful termination verified: Platform intercepts `SIGINT` / `SIGTERM`, flushes metrics, cancels pending relay bundles, clears all timers, and exits within 2 seconds.
- [ ] Manual kill switch: Operator has access to kill process or trigger circuit breaker trip via health server API (`POST /circuit-breaker/trip`).

---

## 6. Defect Severity & Escalation SLAs

| Severity | Definition | Resolution Action | SLA to Fix |
| :---: | :--- | :--- | :---: |
| **P0 (Blocker)** | Math truncation, division-by-zero, capital loss, or silent execution failure. | Immediate rollback to dry-run; halt all execution. | $< 4$ hours |
| **P1 (Critical)** | Relay communication loss, circuit breaker malfunction, or memory leak. | Fallback to paper trading; investigate. | $< 12$ hours |
| **P2 (Major)** | Non-critical configuration mismatch, suboptimal route sorting, or telemetry gap. | Fix in development branch; deploy via standard CI. | $< 48$ hours |
| **P3 (Minor)** | Cosmetic log truncation, documentation typo, or non-blocking metrics issue. | Normal release cycle. | Next sprint |
