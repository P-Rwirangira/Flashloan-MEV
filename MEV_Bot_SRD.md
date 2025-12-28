# Base-Chain Flash-Loan MEV Platform System Requirements Specification (SRS)

## 1. Purpose and Scope

### 1.1 Purpose
Build a flash-loan-native MEV platform dedicated to Base, targeting low-competition, low-capital strategies with maximal gas efficiency and atomic execution.

### 1.2 In-Scope Strategies (Phased)
- **Phase 1 (MVP)**: Cross-DEX arbitrage on Base (Uniswap v3 + Aerodrome)
- **Phase 2**: Long-tail liquidations on Base lending markets (Moonwell, Aave v3 Base, Seamless)
- **Phase 3**: Stable/meta-pool rebalancing on Base (Aerodrome stable pools)

### 1.3 Out-of-Scope Initially
Sandwiching, mainnet deployments, perps integration.

## 2. Base Ecosystem Overview (Targets)

### 2.1 DEXs
- **Uniswap v3**: Concentrated liquidity; fee tiers 0.01%, 0.05%, 0.3%
- **Aerodrome**: Solidly fork; volatile and stable pools, frequent incentives
- **Secondary DEXs**: PancakeSwap Base, BaseSwap (monitor for depth)

### 2.2 Flash Lenders
- **Uniswap v3 flash**: Preferred; pool-level flash for USDC/WETH pairs
- **Balancer flash**: Fallback when sufficient TVL available on Base

### 2.3 Lending Protocols
- **Moonwell**: Active on Base
- **Aave v3**: Base market
- **Seamless Protocol**: Aave fork on Base
- **Compound v3 Comet**: Verify Base market status before integration

### 2.4 Stablecoins and Assets
- **USDC (native)**: Primary quote asset
- **USDbC (legacy bridged USDC)**: Treat carefully in older pools
- **DAI, USDT (bridged)**: Verify availability
- **wETH (Base wrapped)**: Primary ETH variant
- **wstETH (bridged)**: Available LSTs
- **cbETH and other LRTs**: Verify TVL before use

## 3. Assumptions and Dependencies (Base)

### 3.1 Infrastructure Support
- Self-hosted Base node (OP Stack: op-geth + op-node) with WebSocket enabled; preferred source for newHeads and newPendingTransactions
- One paid L1 RPC (e.g., Alchemy/Infura) for op-node derivation; optional low-cost L2 RPC as backup
- Private orderflow support via builder relays and private RPC providers (Flashbots Protect RPC for Base and/or bloXroute private TX) when available and ROI-positive
- Provider abstraction with feature detection (private lanes, BDN, tx replacement APIs) and real-time scoring
- Reliable Base RPC endpoints with fallback providers (Alchemy, Infura, Ankr)
- Subgraphs for Uniswap v3 (Base) and Aerodrome; fallback to indexers/RPC snapshots
- Tenderly/Foundry simulations support Base fork/state

### 3.2 Local-First Preference Order
1) Local Base node WS for reads/streams (pending tx, newHeads)
2) Local Foundry fork for simulation (anvil)
3) Private submission lanes on Base (if available and ROI-positive)
4) Local node submission; if unavailable, fallback L2 RPC (within compliance guardrails)
5) Optional BDN/relay integrations only after measured ROI uplift

## 4. Constraints

### 4.1 Execution Requirements
- Always use private or protected submission to avoid mempool copycats
- Gas must be minimized; use direct pool calls, avoid routers
- Avoid toxic/abusive extraction; focus on arbitrage, liquidations, stable rebalances only
- Compliant backruns only: verify provider Terms of Service and legal constraints; disable when uncertain
- Do not interact with non-compliant orderflow sources; enforce strict separation between public/private flows
- Maintain auditable logs of routing, bids, and cancel/replace decisions

## 5. Architecture (Base-Specific)

### 5.1 Off-Chain Components
- **Scanner**:
  - Prefer local node WS for newHeads and newPendingTransactions to minimize latency and jitter
  - Uniswap v3: Track top pools by TVL on Base; include 0.01%/0.05%/0.3% tiers
  - Aerodrome: Index both volatile and stable pools; prioritize incentivized pairs
  - Lending: Poll Moonwell/Aave/Seamless for health factors and liquidation parameters
  - Pending tx stream: Subscribe to local node pending tx; fall back to provider WS/BDNs (e.g., bloXroute, Blocknative) only when ROI-positive
- **Simulator**: Foundry (anvil) forked from local node; Tenderly optional for deep debugging; includes gas, bribe, and fee modeling; supports backrun simulation against observed pending tx
- **Bundler/Submitter**: Prefer Base private lanes when available; otherwise submit via local node with minimal exposure windows; dynamic bribe budgets with ROI-aware caps and inclusion probability modeling; fast cancel/edit on state drift
- **Orderflow**: Optional partnerships for direct orderflow where compliant (e.g., wallet/RPC partners) to reduce competition
- **Latency/Infra**: Co-locate near Base sequencer ingress and RPC providers; WebSocket/QUIC; kernel/bpf tuning; pre-warmed connections; batching; zero-copy data paths
- **Config Store**: YAML/JSON per chain (Base only); pools, tokens, thresholds

### 5.2 On-Chain Executor (Single Contract, Modular)
- Uniswap v3 flash receiver (primary)
- Direct Uniswap v3 pool swaps via callback
- Aerodrome pair swaps via direct pair.swap
- Min-profit guard and fallback routes
- Liquidation adapter for Moonwell/Aave/Seamless (Phase 2)
- Stable pool adapter for Aerodrome stables (Phase 3)

## 6. Functional Requirements (MVP Emphasis)

### 6.1 Phase 1 Requirements
- **FR-1**: Detect Uniswap v3 ↔ Aerodrome spreads on wETH/USDC, wstETH/ETH, USDC/stable variants
- **FR-2**: Compute optimal flash-borrow size accounting for pool depth, fee tiers, and slippage
- **FR-3**: Execute Uniswap v3 flash to borrow USDC or WETH
- **FR-4**: Perform 1–2 direct pool swaps across venues; avoid routers
- **FR-5**: Enforce minProfit on-chain: endBalance − startBalance − flashFee − gasEst*gasPrice − bribe ≥ threshold
- **FR-6**: Attempt up to 3 fallback routes within one call; revert if all sub-threshold
- **FR-7**: Submit via private relay; cancel if state drift exceeds tolerance

### 6.2 Phase 2 Requirements (Liquidations on Base)
- **FR-8**: Monitor borrower health HF < 1.0 for Moonwell/Aave/Seamless
- **FR-9**: Compute repay per close factor; estimate seized collateral and exit route

### 6.3 Phase 3 Requirements (Stable/meta-pool rebalancing)
- **FR-11**: Detect Aerodrome stable pool imbalance and pricing deviations
- **FR-12**: Execute rebalances using flash-borrowed stable to push pool toward equilibrium

### 6.4 Profitability Enhancements (Cross-cutting)
- **FR-13**: Subscribe to pending tx streams/BDN on Base-supported providers and identify safe, compliant backrun opportunities
- **FR-14**: Implement dynamic bribe optimization to minimize tip for target inclusion probability; expose per-venue caps
- **FR-15**: Enforce latency SLOs (P50/P95) for detection→submit and cancel flows; degrade gracefully on provider issues
- **FR-16**: Implement fast cancel/replace heuristics when profit falls below threshold or better route emerges
- **FR-18**: Maintain an orderflow integration module (optional) to ingest private intents where compliant

## 7. Non-Functional Requirements

### 7.1 Performance
- Detection-to-submission P50 < 150ms, P95 < 300ms from quote tick or pending-tx receipt
- Cancel/update latency P50 < 50ms on drift beyond tolerance
- Scanner data staleness P95 < 200ms; avoid subgraph-only paths for live quoting
- Keep contract execution gas as low as possible (Base L2)

### 7.2 Reliability
99%+ scanner uptime; multiple RPCs and relays.

### 7.3 Security
Reentrancy-safe callbacks; strict pool/token allowlists; validate callback callers.

### 7.4 Maintainability
Strategy modules isolated; config-driven lists for pools/tokens.

### 7.5 Compliance
No sandwiches/oracle manipulation.

## 8. Lowest-Gas Executor Design (Base)

### 8.1 Selected Skeleton
Cross-DEX arbitrage using Uniswap v3 flash + direct pool swaps.

### 8.2 Gas-Saving Techniques
- Direct IUniswapV3Pool.swap with IUniswapV3SwapCallback; avoid SwapRouter
- Direct Aerodrome pair.swap (volatile/stable)
- Immutable addresses for core tokens/pools when feasible; minimize storage writes
- Unchecked arithmetic where safe; use memory over storage; avoid tight loops
- Permit2 optional for approvals off-chain; minimize approvals via WETH/USDC only

### 8.3 Route Policy
- Prefer single-hop same-asset paths; allow one 2-hop if depth requires
- Restrict pools to allowlisted set with configured fee tiers/addresses

### 8.4 Profit Gating
Off-chain simulation computes minProfit that includes:
- Flash fee (Uniswap v3 pool rate)
- Gas budget at ceiling (Base gas price buffer)
- Bribe budget (relay/builder tip)
- On-chain enforces minProfit via end-of-call balance delta check

## 9. Base Targets and Heuristics

### 9.1 Primary Pairs
- wETH/USDC (native USDC only; treat USDbC pools separately)
- wstETH/ETH (bridged wstETH)
- USDC/DAI, USDC/USDbC (legacy skew opportunities), USDC/USDT (verify depth)

### 9.2 DEX Routing Heuristics
- **Uniswap v3**: Prioritize 0.05% and 0.3% tiers (0.01% for stables if deep)
- **Aerodrome**: Check both volatile and stable pool formulas; account for emissions windows

### 9.3 Detection Thresholds
- Initial target spread (post-fee/slippage/gas): ≥ 0.25–0.5%
- Min profit per execution: configurable, e.g., ≥ $20–$50 equivalent on Base

## 10. External Interfaces (Base)

### 10.1 Protocol Interfaces
- **Uniswap v3 pools**: swap, flash; QuoterV2 off-chain
- **Aerodrome pairs**: getReserves, swap; factory to discover pairs
- **Lending (Phase 2)**: Moonwell/Aave/Seamless liquidation functions

### 10.2 Submission and Transport (Local-First)
- Preference order:
  1) Base private lanes (Protect-like) where available and empirically ROI-positive
  2) Local node sendRawTransaction with minimal exposure windows and strict ROI/tip caps
  3) Provider BDN/relays (bloXroute/Blocknative) when measured inclusion uplift > incremental cost
- Provider abstraction with capability matrix (tx replacement, inclusion feedback, latency); adaptive weights from live metrics
- Always enforce compliance guardrails; avoid public mempool exposure when a private path exists; support cancel/replace where providers allow

### 10.3 Simulation
- Foundry (anvil fork Base)
- Tenderly Base

## 11. Data and Storage

### 11.1 Off-Chain Storage
- Indexed pool snapshots, fee tiers, reserves, ticks
- Lending parameters: close factor, liquidation bonus, collateral factors
- Strategy config per pair (slippage caps, profit min, bribe cap)

### 11.2 On-Chain Storage
- Ephemeral per tx: encoded routes, borrow amounts, minProfit

## 12. Algorithms

### 12.1 Core Algorithms
- **Arbitrage sizing**: Maximize expected profit subject to slippage caps and route depth
- **Uniswap v3 math**: Rely on pool price ticks; validate quotes against QuoterV2
- **Aerodrome stables**: Apply stable formula output with fee and imbalance
- **Profit calculation**: profit = endBalance − startBalance − flashFee − estGas*gasPrice − bribe
- **Bribe optimizer**: Model inclusion probability vs tip; choose minimal tip to meet target inclusion SLO; fall back to retry/cancel
- **Gas market model**: Predict Base L2 gas spikes; cap gas*limit*price to maintain target ROI
- **Backrun selector**: Score pending tx candidates by expected slippage impact and inclusion timing; simulate with flash+route to pick top-K

## 13. Security and Threat Model

### 13.1 Security Measures
- Validate callback senders (only known v3 pools)
- Allowlist pools/tokens; reject unknown addresses
- Reentrancy guard around external calls; checks-effects-interactions discipline
- Strict revert on any underfill; no partial inventory

## 14. Ops and Observability

### 14.1 Metrics (Base)
- Opportunity rate/hour, sim win rate, realized win rate, revert rate
- Net PnL (USDC), median profit per success, average gas, bribe %, ROI per strategy
- Inclusion rate by provider, outbid/raced %, cancel/replace rate
- Latency: tick-to-decision, decision-to-submit, submit-to-inclusion
- Backrun-specific: candidate count, sim win rate, realized win rate

### 14.2 Alerts
- Consecutive reverts, reserve drift > X%, missed profitable events
- Inclusion rate drop by provider/relay beyond threshold; racing cost spikes
- Latency SLO breaches (detection→submit, cancel)
- Provider RPC/relay degradation or outage detection via health checks
- Post-mortem simulation shows > threshold

### 14.3 Circuit Breakers
- Pause after N reverts or price drift beyond tolerance

## 15. Test Plan (Base)

### 15.1 Testing Strategy
- **Unit**: v3 callback flow, flash repayment math, Aerodrome volatile/stable math, minProfit guard
- **Integration**: Foundry fork of Base, real pool addresses for wETH/USDC, wstETH/ETH, USDC/stables
- **Chaos**: Simulate reserve/tick changes between sim and inclusion; confirm safe revert/fallback

## 16. Deployment and Environments

### 16.1 Environments
- **Dev**: Local Foundry fork of Base (fork from your local node)
- **Staging**: Base Sepolia (if supported by targets), or shadow mainnet with guards
- **Prod**: Base mainnet with a self-hosted local Base node (op-geth + op-node) as the primary read/stream and preferred submit endpoint

### 16.2 Security
- Store keys in HSM/KMS; separate signer per environment
- Relay API keys managed securely

## 17. Milestones (Base-Only)

### 17.1 Development Timeline
- **Week 1–2**: MVP cross-DEX arb (Uniswap v3 + Aerodrome), scanner/sim/bundler, initial pairs
- **Week 3**: Harden fallback routing, add more pairs; tune thresholds; dashboards/alerts
- **Week 4–6**: Liquidation module (Moonwell/Aave/Seamless); staged rollout
- **Week 7–8**: Stable/meta-pool rebalancing on Aerodrome stable pools

## 18. Acceptance Criteria (Base MVP)

### 18.1 Performance Targets
- Achieve >60% realized win rate over a rolling 7-day window
- Median net profit ≥ $20 per success (configurable), revert rate <15%
- Verified private submission when available; otherwise demonstrate ROI-positive inclusion via local node with tip/gas caps
- Latency SLOs met (P50/P95)
- Infra spend within budget (e.g., L1 RPC + optional backups); no paid BDN/relays required for MVP profitability
- Full test suite passes; runbook + dashboards active

## 19. Recommended MVP Skeleton for Base (Lowest Gas)

### 19.1 On-Chain Components
- **ArbExecutor**: Uniswap v3 flash + v3 swap callback and Aerodrome pair.swap
- Pool/token allowlists; minProfit guard; 1–2 hop max; up to 3 fallback routes

### 19.2 Off-Chain Components
- TypeScript or Python scanner pulling Uniswap v3 (Base) and Aerodrome data
- Foundry/Tenderly sim; private relay bundler with dynamic bribe

## 20. Profitability Enhancements Playbook

### 20.1 Block Streaming and Pending-Transaction Backruns
- Prefer local node mempool streams (pending tx WS) and newHeads for lowest latency; fall back to provider WS/BDNs only when ROI-positive
- Subscribe to BDN/mempool streams (bloXroute, Blocknative, provider pending WS) to detect price-impacting swaps and liquidations before they land
- Maintain a backrun candidate queue scored by expected post-trade slippage and path profitability
- Simulate backruns against observed calldata (amountIn/amountOutMin, pool addresses) and only submit if post-fee net profit exceeds minProfit+buffer
- Use private lanes for same-block inclusion; support replace-by-fee/tip escalation within configured caps

### 20.2 Dynamic Bribe and Inclusion Management
- Fit an inclusion probability curve per relay/provider vs tip and time-to-next-block; minimize expected tip for target inclusion SLO
- Multi-provider racing with capped tip deltas; cancel losers quickly to avoid unnecessary spend
- Record per-relay success rate and adapt weights in real time

### 20.3 Latency Engineering
- Co-locate POPs near Base sequencer ingress and top RPCs; measure RTT continuously and switch POP on degradation
- Prefer WS/QUIC, pre-warmed connections, kernel/bpf tuning, CPU pinning, and zero-copy data paths in hot loops
- Pre-build signed transactions and only fill dynamic fields (nonce, tip) at the last microsecond

### 20.4 Route and Slippage Optimization
- Maintain micro-price models for v3 ticks and Aerodrome stable invariant to size borrows precisely
- Avoid routers; favor single-hop pool-to-pool execution; allow a second hop only if profitability remains above threshold
- Adaptive slippage: tighter during calm periods, wider when chasing backruns

### 20.5 Flash vs. Temporary Inventory
- Default to flash-only; allow optional tiny inventory buffers for rapid re-entry when profitable and safe (config gated)
- Inventory guardrails: max notional, max hold time (< minutes), auto-unwind routes, kill-switch

### 20.6 RFQ/Intent Ingestion (Optional)
- Integrate compliant private orderflow (wallet/RPC partners) when available to access less competitive flow
- Enforce strict separation between public and private flows to prevent leakage

### 20.7 Cancellation and Replacement Policy
- Cancel on-profit-fall: if expected profit falls below minProfit+buffer or better route appears
- Replace escalation: increase tip within cap when inclusion probability below target and opportunity still live
- Anti-storming: jitter cancel/replace to avoid provider rate limits

### 20.8 Gas Market and Limits
- Predict Base L2 gas spikes from recent blocks; cap gas*limit*price to preserve ROI
- Track average gas per strategy and adjust route selection to keep within budget

### 20.9 Capital Efficiency
- Reuse approvals via Permit2 where safe; minimize allowance churn
- Parallel simulate multiple sizes and pick argmax profit under constraints

