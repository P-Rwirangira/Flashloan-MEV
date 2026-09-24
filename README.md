# Base MEV Platform

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?style=flat&logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.28-FFF100?style=flat&logo=hardhat&logoColor=black)](https://hardhat.org/)
[![ethers.js](https://img.shields.io/badge/ethers.js-6.8-2535A0?style=flat&logo=ethereum&logoColor=white)](https://docs.ethers.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![CI Pipeline](https://img.shields.io/badge/CI-Automated_Gates-brightgreen?style=flat&logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/Tests-50_Passed-success?style=flat&logo=jest&logoColor=white)](tests/)

[![Base](https://img.shields.io/badge/Base-Mainnet-0052FF?style=flat&logo=coinbase&logoColor=white)](https://base.org/)
[![Uniswap V3](https://img.shields.io/badge/Uniswap-V3-FF007A?style=flat&logo=uniswap&logoColor=white)](https://uniswap.org/)
[![Aerodrome](https://img.shields.io/badge/Aerodrome-DEX-00D4AA?style=flat)](https://aerodrome.finance/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)

A flash-loan-native MEV (Maximal Extractable Value) trading and simulation platform built for Base L2, engineering cross-DEX arbitrage (Uniswap V3 ↔ Aerodrome), lending liquidations, and stable pool rebalancing with atomic smart contract execution, pre-flight math simulation, and deterministic reliability guardrails.

---

## System Reliability & Safety Architecture

In autonomous on-chain trading systems, execution failures permanently burn network gas fees, while pricing inaccuracies and race conditions lead to front-running losses. The platform treats mathematical determinism, pre-execution simulation, and fail-closed circuit breakers as first-class architectural requirements:

```
[Mempool / DEX Ingestion]
           │
           ▼
[Pre-Flight AMM Simulation]  ──► (Q192 Fixed-Point Math, Slippage Bounds, Net Profit > Fee)
           │
           ▼
[Stateful Circuit Breaker]  ──► (Failure Thresholds, Consecutive Loss Limits, Health Probes)
           │
           ▼
[Private Relay Dispatch]    ──► (Flashbots / bloXroute MEV Protection, Dynamic Bribing)
           │
           ▼
[On-Chain Atomic Settlement] ──► (FlashExecutor.sol: Reentrancy-guarded, Revert-on-unprofitable)
```

### Core Reliability Invariants
1. **Mathematical Invariant Verification**: Prevents integer division truncation in concentrated liquidity pools (protecting against sub-1 price ratio failures) and preserves BigInt precision in route sorting beyond $2^{53} - 1$ wei.
2. **Multi-Layered Circuit Breaker**: Tracks consecutive failures across RPC, simulation, and execution stages. Automatically trips to `OPEN` to prevent cascading gas losses, intercepts subsequent requests, and safely probes recovery in `HALF_OPEN` state.
3. **Runtime Schema Validation**: Enforces configuration integrity using Zod schemas, verifying network parameters, address checksums, and strict business invariants (e.g. positive minimum profits, capped slippage).
4. **Graceful Platform Lifecycle**: Deterministic initialization and teardown ensuring all event listeners, cache intervals, and monitoring loops are unref'd or cleared cleanly without resource leakage.

### Engineering & Verification Documentation
- **[Test Strategy & Invariant Framework](docs/qa/TEST_STRATEGY.md)**: Testing philosophy, pyramid tiers, invariant modeling, and mock boundaries.
- **[Failure Mode & Defect Analysis](docs/qa/DEFECT_REPORTS.md)**: Root-cause investigations, reproduction steps, and fixes for platform defects.
- **[Regression Traceability Matrix](docs/qa/REGRESSION_MATRIX.md)**: Bidirectional map connecting architectural invariants and defects to automated test cases and CI gates.
- **[Release Criteria & Stage Gates](docs/qa/RELEASE_CRITERIA.md)**: Mandatory verification requirements for promotion from simulation to production.
- **[Live Trading Readiness Report](LIVE_TRADING_READINESS_REPORT.md)**: Evidence-based readiness evaluation matrix.

---

## Strategy Modules

### Phase 1: Cross-DEX Arbitrage ![Status](https://img.shields.io/badge/Status-Active-success)
- Real-time monitoring of Uniswap V3 and Aerodrome pools on Base L2.
- Pre-execution simulation using Q192 fixed-point concentrated liquidity and constant product math.
- Atomic flash loan execution via `FlashExecutor.sol` with multi-hop pool routing.
- Private bundle submission via Flashbots and bloXroute to neutralize front-running and sandwich attacks.

### Phase 2: Lending Protocol Liquidations ![Status](https://img.shields.io/badge/Status-In_Development-yellow)
- Continuous health factor monitoring on Moonwell, Aave V3, and Seamless protocols.
- Automated liquidation triggers with flash-borrowed debt repayment.
- Optimal collateral liquidation routing and slippage protection.

### Phase 3: Stable Pool Rebalancing ![Status](https://img.shields.io/badge/Status-Planned-blue)
- Aerodrome stable pool invariant calculation and deviation monitoring.
- Flash-borrowed rebalancing execution capturing protocol incentives.

---

## Architecture

- **Scanner** (`src/scanner/`): Real-time event ingestion and pool state tracking across Uniswap V3 and Aerodrome.
- **Simulator** (`src/utils/swap-simulation.ts`, `src/simulator/`): Off-chain mathematical execution simulation calculating exact price impact, fee deduction, and net profit.
- **Bundler & Relays** (`src/bundler/`): Private transaction routing to Flashbots builder and bloXroute BDN relays with adaptive gas pricing.
- **Flash Executor** (`contracts/FlashExecutor.sol`): Atomic on-chain settlement contract executing multi-DEX swaps, flash loan borrowing, and strict profit verification.
- **Monitoring & Health** (`src/monitoring/`): Prometheus metrics, circuit breakers, and HTTP health check server with Kubernetes liveness and readiness endpoints.

---

## Quick Start & Verification

### Prerequisites
- **Node.js 18+** (Node.js 20 LTS recommended)
- **npm 9+**
- **Git**

### Installation
```bash
# Clone the repository
git clone https://github.com/P-Rwirangira/Flashloan-MEV.git
cd Flashloan-MEV

# Install dependencies deterministically
npm ci

# Configure environment variables
cp .env.example .env
```

### Running Verification & Tests
```bash
# 1. Compile smart contracts and generate TypeChain bindings
npm run build:contracts

# 2. Run TypeScript static type check (strict mode)
npm run typecheck

# 3. Execute unit and regression test suite
npm test

# 4. Run specific test tiers
npx jest tests/unit/swap-simulation.test.ts   # AMM math and Q192 invariants
npx jest tests/unit/circuit-breaker.test.ts   # State machine transitions
npx jest tests/unit/config-validator.test.ts  # Zod schema validation
npx jest tests/unit/historical-defects.test.ts # Historical regression tests
```

### Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `build:contracts` | `hardhat compile` | Compiles Solidity contracts and generates TypeChain typings |
| `typecheck` | `tsc --noEmit` | Validates TypeScript types across the entire project |
| `build` | `tsc` | Transpiles TypeScript source code to `dist/` |
| `test` | `jest --forceExit` | Executes all unit and integration test suites |
| `test:watch` | `jest --watch` | Runs test runner in interactive watch mode |
| `relay:test` | `tsx scripts/test-relay-connectivity.ts` | Validates Flashbots and bloXroute endpoint connectivity |
| `dev` | `tsx src/dev-menu.ts` | Launches interactive strategy execution menu |
| `testing:dry-run` | `tsx scripts/dry-run-monitor.ts` | Runs real-time opportunity detection in zero-risk dry-run mode |

---

## Health Check & Observability Endpoints

When started, the platform serves operational health metrics on port `3002` (configurable via `HEALTH_PORT`):

| Endpoint | Method | Purpose | Kubernetes Support |
| :--- | :---: | :--- | :---: |
| `/health` | `GET` | Aggregated subsystem health, circuit breaker state, active phases | Probe |
| `/ready` | `GET` | Readiness probe (RPC connectivity and configuration status) | `readinessProbe` |
| `/live` | `GET` | Liveness probe (event loop responsiveness) | `livenessProbe` |
| `/metrics` | `GET` | Prometheus-formatted metrics (opportunities, win rate, P&L) | Prometheus Scrape |
| `/status` | `GET` | Lightweight JSON uptime check | Service Monitor |

---

## Technical Specifications & Stack

- **Runtime & Language**: Node.js, TypeScript 5.3 (Strict Mode)
- **Smart Contracts**: Solidity 0.8.20, Hardhat 2.28, OpenZeppelin Contracts
- **Blockchain Interface**: ethers.js v6, TypeChain
- **Test Framework**: Jest, ts-jest, fast-check (property testing)
- **Schema Validation**: Zod runtime parsing
- **MEV Protocols**: Flashbots Builder Relay, bloXroute BDN
- **Target Network**: Base L2 (Chain ID: 8453)
- **Supported DEXes**: Uniswap V3, Aerodrome Finance

---

## Security & Risk Controls

- **Private Mempool Routing**: Private bundle submission shields transactions from predatory front-running and sandwich attacks.
- **Atomic On-Chain Settlement**: Flash loans revert the entire transaction if the net output does not cover loan principal, fees, and required profit.
- **Fail-Closed Circuit Breakers**: Automatic execution shutdown upon exceeding consecutive failure limits or daily loss thresholds.
- **Separation of Keys**: Transaction execution uses dedicated hot wallets isolated from administrative ownership keys.

---

## License

This project is licensed under the **Apache-2.0 License** - see the [LICENSE](LICENSE) file for details.

---

## Disclaimer

This software is for educational and research purposes. Autonomous on-chain trading involves financial risk. Ensure proper testing in dry-run and paper-trading modes before deploying on-chain transactions.