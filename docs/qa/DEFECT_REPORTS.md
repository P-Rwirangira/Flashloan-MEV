# Repository Defect Reports & Failure Analysis

This document catalogs critical software defects, historical regressions, and configuration vulnerabilities identified and remediated in the `Flashloan-MEV` platform. Each defect is documented with full root-cause analysis, reproduction procedures, remediation details, and automated regression test coverage.

---

## Defect Summary Matrix

| Defect ID | Severity | Component | Category | Status | Regression Test |
| :--- | :---: | :--- | :--- | :---: | :--- |
| **DEF-001** | `Critical (P0)` | `src/utils/swap-simulation.ts` | AMM Math / Integer Truncation | **RESOLVED** | `tests/unit/swap-simulation.test.ts` |
| **DEF-002** | `High (P1)` | `src/config/loader.ts` | String Parsing / URL Corruption | **RESOLVED** | `tests/unit/config-validator.test.ts` |
| **DEF-003** | `High (P1)` | `src/scanner/arbitrage-scanner.ts` | BigInt Precision / Sorting | **RESOLVED** | `tests/unit/historical-defects.test.ts` |
| **DEF-004** | `Medium (P2)` | `src/execution/competition-tracker.ts` | Arithmetic / Division by Zero | **RESOLVED** | `tests/unit/historical-defects.test.ts` |
| **DEF-005** | `Low (P3)` | `src/execution/competition-tracker.ts` | Numeric Precision / Decimals | **RESOLVED** | `tests/unit/historical-defects.test.ts` |
| **DEF-006** | `Medium (P2)` | `config/default.yaml` | Configuration Schema Compliance | **RESOLVED** | `tests/unit/config-validator.test.ts` |
| **DEF-007** | `High (P1)` | `src/index.ts` | Lifecycle / Timer Leakage | **RESOLVED** | `tests/integration/live-trading-readiness.test.ts` |

---

## Detailed Defect Reports

### DEF-001: Integer Division Truncation in Uniswap V3 Swap Simulation

- **Component**: [`src/utils/swap-simulation.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/src/utils/swap-simulation.ts#L45-L68)
- **Severity**: `Critical (P0)`
- **Discovered During**: Deep-dive codebase audit and math verification.
- **Symptom**:
  Any Uniswap V3 pool where the price ratio of token0 to token1 is less than 1 (i.e. $\text{sqrtPriceX96} < 2^{96}$) suffered catastrophic math failure:
  - When swapping `zeroForOne = true`: Output amount evaluated to `0n` (100% loss).
  - When swapping `zeroForOne = false`: Threw an uncaught `RangeError: Division by zero`.
- **Root Cause**:
  The price calculation was written as:
  ```typescript
  const currentPrice = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
  ```
  In BigInt integer arithmetic, when `sqrtPriceX96 < Q96`, the numerator is strictly less than the denominator. The division operator `/` performs integer truncation toward zero, evaluating `currentPrice` to `0n`. When `zeroForOne = false`, the subsequent line `(amountInAfterFee * (Q96 * Q96)) / currentPrice` attempted division by `0n`.
- **Remediation**:
  Replaced with exact Q192 fixed-point BigInt scaling:
  ```typescript
  const Q192 = 2n ** 192n;
  const priceX192 = (sqrtPriceX96 * sqrtPriceX96 * Q192) / (Q96 * Q96);
  if (zeroForOne) {
    amountOutBeforeFee = (amountIn * priceX192) / Q192;
  } else {
    amountOutBeforeFee = (amountIn * Q192) / priceX192;
  }
  ```
- **Automated Regression Test**:
  [`tests/unit/swap-simulation.test.ts:74`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/swap-simulation.test.ts#L74-L114): `should prevent integer truncation when price ratio is sub-1 (DEF-001 regression)`.

---

### DEF-002: Default Environment Variable Split Truncating URLs

- **Component**: [`src/config/loader.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/src/config/loader.ts#L104-L116)
- **Severity**: `High (P1)`
- **Discovered During**: Configuration loader inspection and unit test verification.
- **Symptom**:
  When environment variables with fallback default URLs (e.g. `${BASE_RPC_URL:https://mainnet.base.org}`) were evaluated without the environment variable set, the configuration resolved to `"https"` instead of the full URL, causing connection failures upon startup.
- **Root Cause**:
  `ConfigLoader.substituteEnvironmentVariables` used `.split(':')` to separate the variable name from its default value:
  ```typescript
  const [varName, defaultValue] = match.slice(2, -1).split(':');
  ```
  For any URL containing a scheme colon (`https://...`), the string was split into three fragments: `["BASE_RPC_URL", "https", "//mainnet.base.org"]`. `defaultValue` received only `"https"`.
- **Remediation**:
  Updated the parser to split only on the *first* colon:
  ```typescript
  const colonIndex = expr.indexOf(':');
  const varName = colonIndex === -1 ? expr : expr.slice(0, colonIndex);
  const defaultValue = colonIndex === -1 ? '' : expr.slice(colonIndex + 1);
  ```
- **Automated Regression Test**:
  Verified via [`tests/unit/config-validator.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/config-validator.test.ts) and [`tests/integration/live-trading-readiness.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/integration/live-trading-readiness.test.ts).

---

### DEF-003: BigInt Route Sorting Precision Loss

- **Component**: `src/scanner/arbitrage-scanner.ts`
- **Severity**: `High (P1)`
- **Discovered In**: Historical Git commit `4d24a31`.
- **Symptom**:
  When sorting arbitrage routes by expected profit in wei, routes with large profit margins ($> 2^{53} - 1$ wei, or $\approx 0.009$ ETH) suffered precision loss or overflow, causing the scanner to prioritize suboptimal routes or produce non-deterministic sort orders.
- **Root Cause**:
  Route sorting subtracted two BigInt profits and cast the result directly to a JavaScript `Number`:
  ```typescript
  routes.sort((a, b) => Number(b.expectedProfit - a.expectedProfit));
  ```
- **Remediation**:
  Replaced with standard three-way BigInt comparison:
  ```typescript
  routes.sort((a, b) =>
    b.expectedProfit > a.expectedProfit ? 1 : b.expectedProfit < a.expectedProfit ? -1 : 0
  );
  ```
- **Automated Regression Test**:
  [`tests/unit/historical-defects.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/historical-defects.test.ts): `should maintain strict sort order for profits exceeding Number.MAX_SAFE_INTEGER`.

---

### DEF-004: Division by Zero in Competition Tracking

- **Component**: `src/execution/competition-tracker.ts`
- **Severity**: `Medium (P2)`
- **Discovered In**: Historical Git commit `6b20053`.
- **Symptom**:
  In competitive gas analysis, when competitor bids array contained a lowest bid of `0n` (e.g. unpriced transactions or legacy transactions in mempool), the platform crashed with an unhandled `RangeError: Division by zero`.
- **Root Cause**:
  ```typescript
  const bidSpread = ((highestBid - lowestBid) * 10000n) / lowestBid;
  ```
  No validation was performed on `lowestBid` before division.
- **Remediation**:
  Added guard check ensuring `lowestBid > 0n` before attempting division, returning `0` spread when undefined or zero.
- **Automated Regression Test**:
  [`tests/unit/historical-defects.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/historical-defects.test.ts): `should safely handle zero or empty competitor bids in bid spread calculation`.

---

### DEF-005: Profit Margin Decimal Precision Truncation

- **Component**: `src/execution/competition-tracker.ts`
- **Severity**: `Low (P3)`
- **Discovered In**: Historical Git commit `6b20053`.
- **Symptom**:
  Trades with profit margins below 1.0% (e.g. 0.45%) were logged and reported as `0%` margin, corrupting risk-adjusted profitability metrics.
- **Root Cause**:
  The calculation multiplied by `100n` before integer division:
  ```typescript
  const profitMarginPercent = Number((netProfit * 100n) / amountIn);
  ```
  Any value where `netProfit * 100n < amountIn` truncated to `0n`.
- **Remediation**:
  Scaled by basis points (`10000n`) and converted to floating point percentage:
  ```typescript
  const profitMarginPercent = Number((netProfit * 10000n) / amountIn) / 100;
  ```
- **Automated Regression Test**:
  [`tests/unit/historical-defects.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/historical-defects.test.ts): `should preserve basis point precision in profit margin calculations`.

---

### DEF-006: Invalid 66-Character Address in Default Configuration

- **Component**: [`config/default.yaml`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/config/default.yaml#L240)
- **Severity**: `Medium (P2)`
- **Discovered During**: Configuration schema validation testing.
- **Symptom**:
  Configuration loader threw schema validation error on startup: `Invalid address format for USDC/USDbC pool: Expected 42-character hex address, received 66 characters`.
- **Root Cause**:
  Line 240 contained a 32-byte transaction hash or salt string (`0x0000...`) instead of the checksummed 20-byte contract address.
- **Remediation**:
  Replaced the invalid entry with the genuine Uniswap V3 USDC/USDbC pool address on Base: `0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C`.
- **Automated Regression Test**:
  [`tests/unit/config-validator.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/unit/config-validator.test.ts): `should validate the repository default configuration successfully`.

---

### DEF-007: Lifecycle Auto-Start and Asynchronous Timer Leaks

- **Component**: [`src/index.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/src/index.ts)
- **Severity**: `High (P1)`
- **Discovered During**: Test suite integration and Jest open-handle analysis.
- **Symptom**:
  Importing `BaseMEVPlatform` in unit or integration tests triggered `main()` execution, opening real network connections and spawning unmanaged `setInterval` loops (`metricsLogInterval`, `perfOptInterval`) that prevented Jest from exiting cleanly.
- **Root Cause**:
  1. `main()` was called unconditionally at the bottom of `src/index.ts`.
  2. Timer intervals created in `setupEventHandlers()` were not cleared if `stop()` was invoked when `isRunning` was `false`.
- **Remediation**:
  1. Added `if (process.env['NODE_ENV'] !== 'test')` guard around `main()`.
  2. Stored interval handles as class properties and cleared them unconditionally in `stop()`.
- **Automated Regression Test**:
  [`tests/integration/live-trading-readiness.test.ts`](file:///c:/Users/The-great/Documents/GitHub/Flashloan-MEV/tests/integration/live-trading-readiness.test.ts): Verifies complete platform lifecycle and clean teardown.
