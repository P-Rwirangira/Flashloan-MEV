# Automated Quality Assurance & Regression Matrix

This matrix establishes a bidirectional traceability map connecting software defects, architectural invariants, automated regression tests, and continuous integration release gates.

---

## 1. Traceability Matrix: Defects & Invariants to Automated Tests

| ID | Title / Target Invariant | Target File | Automated Test Suite | Test Case Name | CI Gate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-001** | Q192 AMM math prevents sub-1 price truncation | `src/utils/swap-simulation.ts` | `tests/unit/swap-simulation.test.ts` | `should prevent integer truncation when price ratio is sub-1 (DEF-001 regression)` | `npm test` |
| **DEF-002** | URL default environment variable parsing | `src/config/loader.ts` | `tests/unit/config-validator.test.ts` | `should validate the repository default configuration successfully` | `npm test` |
| **DEF-003** | BigInt precision preservation in route sorting | `src/scanner/arbitrage-scanner.ts` | `tests/unit/historical-defects.test.ts` | `should maintain strict sort order for profits exceeding Number.MAX_SAFE_INTEGER` | `npm test` |
| **DEF-004** | Zero-bid divide-by-zero prevention in competition tracking | `src/execution/competition-tracker.ts` | `tests/unit/historical-defects.test.ts` | `should safely handle zero or empty competitor bids in bid spread calculation` | `npm test` |
| **DEF-005** | Basis point scaling for sub-1% profit margins | `src/execution/competition-tracker.ts` | `tests/unit/historical-defects.test.ts` | `should preserve basis point precision in profit margin calculations` | `npm test` |
| **DEF-006** | Ethereum address schema compliance in config | `config/default.yaml` | `tests/unit/config-validator.test.ts` | `should reject malformed or missing required sections` | `npm test` |
| **DEF-007** | Clean process lifecycle and timer teardown | `src/index.ts` | `tests/integration/live-trading-readiness.test.ts` | `should handle complete platform lifecycle` | `npm test` |
| **INV-001** | Circuit breaker trips to OPEN on consecutive failures | `src/monitoring/circuit-breaker.ts` | `tests/unit/circuit-breaker.test.ts` | `should trip to OPEN when failure threshold and minimum requests are met` | `npm test` |
| **INV-002** | Circuit breaker rejects requests while OPEN | `src/monitoring/circuit-breaker.ts` | `tests/unit/circuit-breaker.test.ts` | `should trip to OPEN on failure during HALF_OPEN state` | `npm test` |
| **INV-003** | Circuit breaker probe & recovery via HALF_OPEN | `src/monitoring/circuit-breaker.ts` | `tests/unit/circuit-breaker.test.ts` | `should support half-open probe and close on consecutive successes` | `npm test` |
| **INV-004** | Price impact capped at maximum tolerance | `src/utils/swap-simulation.ts` | `tests/unit/swap-simulation.test.ts` | `should cap price impact at 10% (1000 bps) for high volume swaps` | `npm test` |
| **INV-005** | Safe division with custom zero fallback | `src/utils/math.ts` | `tests/unit/math-extended.test.ts` | `should return fallback when denominator is 0` | `npm test` |
| **INV-006** | Liquidation health factor strictly < 1.0 | `src/config/validator.ts` | `tests/unit/config-validator.test.ts` | `should reject liquidation strategy with health factor >= 1.0` | `npm test` |
| **INV-007** | Arbitrage minimum profit strictly > 0 | `src/config/validator.ts` | `tests/unit/config-validator.test.ts` | `should reject non-positive minimum profit for arbitrage strategy` | `npm test` |
| **INV-008** | TypeScript strict mode compliance | All `.ts` files | Standalone compiler gate | `npm run typecheck` | `CI Step` |
| **INV-009** | Solidity smart contract compilation & type generation | `contracts/*.sol` | Hardhat compiler gate | `npm run build:contracts` | `CI Step` |

---

## 2. Test Execution Commands & Run Profiles

### Rapid Developer Verification (Pre-Commit)
```bash
# Execute fast mathematical & unit regressions (~15 seconds)
npx jest tests/unit/

# Run TypeScript static analysis
npm run typecheck
```

### Full Integration & Regression Suite
```bash
# Compile contracts, verify types, and execute all 7 test suites (50 tests)
npm run build:contracts
npm run typecheck
npm test
```

### Continuous Integration Pipeline (`.github/workflows/ci.yml`)
The GitHub Actions workflow executes on all pushes to `main` and `develop` and on pull requests targeting `main`:
1. `npm ci` (Deterministic dependency installation)
2. `npm run build:contracts` (Solidity compilation via Hardhat)
3. `npm run typecheck` (Full project typecheck via `tsc --noEmit`)
4. `npm run build` (TypeScript bundle compilation)
5. `npm test` (Execution of all 50 automated tests in Jest)

---

## 3. Verification Evidence Record

| Date | Environment | Node Version | Test Suites | Tests | Result |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **2026-09-24** | Windows (PowerShell) | `v23.4.0` | 7 passed / 7 total | 50 passed / 50 total | **PASS (Code 0)** |
| **2026-09-24** | Ubuntu CI (`ci.yml`) | `20.x` | 7 passed / 7 total | 50 passed / 50 total | **PASS** |
