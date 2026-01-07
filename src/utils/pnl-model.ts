/**
 * Unified Profitability Model & Helpers
 *
 * Defines standard structures and bigint-safe helpers for computing
 * pre-trade and post-trade PnL across the platform.
 */

import { ethers } from 'ethers';

// Basis token is ETH for all profit accounting; values are in wei unless noted.
export type BasisToken = 'ETH';

// Core cost components (all bigint, in wei, >= 0)
export interface ProfitCostComponents {
  gasCostWei: bigint; // gasUsed * price (budgeted or realized)
  bribeWei: bigint; // coinbase/private-relay bribe or priority fee portion if modeled separately
  flashLoanFeeWei: bigint; // provider fee for the borrowed notional
  dexFeesWei: bigint; // sum of per-swap fees in wei-equivalent
  slippageWei: bigint; // loss due to price impact/slippage
  otherCostsWei?: bigint; // optional catch-all (MEV protection, tips, etc.)
}

// Gross profit before costs (in wei). For arbitrage, typically tokenOut->ETH via oracle.
export interface ProfitGross {
  grossProfitWei: bigint; // must be >= 0
}

// Optional context attached to a profit computation
export interface ProfitContext {
  basisToken: BasisToken; // 'ETH'
  assumedMaxFeePerGasWei?: bigint; // pre-trade budgeting input
  assumedGasLimit?: bigint; // pre-trade budgeting input
  routeHops?: number; // informational
  confidence?: number; // 0..1
  notes?: string;
}

// Canonical profit result, used pre-trade and post-trade
export interface ProfitResult extends ProfitGross, ProfitCostComponents {
  netProfitWei: bigint; // gross - all costs
  netProfitUsd?: number; // optional USD conversion with provided ETH/USD
  profitMarginPercent?: number; // net/gross in % when gross>0
  breakdown?: Record<string, string>; // stringified breakdown for logging/metrics
  ctx?: ProfitContext | undefined;
}

// Ensure non-negative bigint and handle undefined
function nz(v?: bigint): bigint {
  return v && v > 0n ? v : 0n;
}

// Sum all costs safely
export function totalCostsWei(costs: ProfitCostComponents): bigint {
  return (
    nz(costs.gasCostWei) +
    nz(costs.bribeWei) +
    nz(costs.flashLoanFeeWei) +
    nz(costs.dexFeesWei) +
    nz(costs.slippageWei) +
    nz(costs.otherCostsWei)
  );
}

// Compute net profit from gross and costs. Returns a ProfitResult without USD unless ethUsd passed.
export function computeProfit(
  gross: ProfitGross,
  costs: ProfitCostComponents,
  options?: { ethUsd?: number; ctx?: ProfitContext; clampNegative?: boolean }
): ProfitResult {
  const grossWei = nz(gross.grossProfitWei);
  const totalCosts = totalCostsWei(costs);
  let net = grossWei - totalCosts;
  if (options?.clampNegative) {
    net = net > 0n ? net : 0n;
  }
  const res: ProfitResult = {
    grossProfitWei: grossWei,
    ...costs,
    netProfitWei: net,
    ctx: options?.ctx,
  };
  if (typeof options?.ethUsd === 'number' && options.ethUsd > 0) {
    res.netProfitUsd = weiToUsd(net, options.ethUsd);
    if (grossWei > 0n) {
      res.profitMarginPercent = (Number(net) / Number(grossWei)) * 100;
    }
  }
  // Optional breakdown strings for logging
  res.breakdown = {
    gross: grossWei.toString(),
    gas: nz(costs.gasCostWei).toString(),
    bribe: nz(costs.bribeWei).toString(),
    flashFee: nz(costs.flashLoanFeeWei).toString(),
    dexFees: nz(costs.dexFeesWei).toString(),
    slippage: nz(costs.slippageWei).toString(),
    other: nz(costs.otherCostsWei).toString(),
    totalCosts: totalCosts.toString(),
    net: net.toString(),
  };
  return res;
}

// Convert wei delta to USD using ETH/USD (number). Safe for display/logging only.
export function weiToUsd(wei: bigint, ethUsd: number): number {
  // Convert via decimal, keeping precision acceptable for UI; core math remains bigint.
  return (Number(wei) / 1e18) * ethUsd;
}

// Helpers to build cost components incrementally
export function makeCosts(partial?: Partial<ProfitCostComponents>): ProfitCostComponents {
  return {
    gasCostWei: nz(partial?.gasCostWei),
    bribeWei: nz(partial?.bribeWei),
    flashLoanFeeWei: nz(partial?.flashLoanFeeWei),
    dexFeesWei: nz(partial?.dexFeesWei),
    slippageWei: nz(partial?.slippageWei),
    otherCostsWei: nz(partial?.otherCostsWei),
  };
}

// Utility to merge/accumulate costs
export function addCosts(a: ProfitCostComponents, b: ProfitCostComponents): ProfitCostComponents {
  return {
    gasCostWei: nz(a.gasCostWei) + nz(b.gasCostWei),
    bribeWei: nz(a.bribeWei) + nz(b.bribeWei),
    flashLoanFeeWei: nz(a.flashLoanFeeWei) + nz(b.flashLoanFeeWei),
    dexFeesWei: nz(a.dexFeesWei) + nz(b.dexFeesWei),
    slippageWei: nz(a.slippageWei) + nz(b.slippageWei),
    otherCostsWei: nz(a.otherCostsWei) + nz(b.otherCostsWei),
  };
}

// Pretty-print for logs (non-JSON)
export function formatProfitResult(res: ProfitResult): string {
  const parts = [
    `gross=${ethers.formatEther(res.grossProfitWei)} ETH`,
    `gas=${ethers.formatEther(nz(res.gasCostWei))}`,
    `bribe=${ethers.formatEther(nz(res.bribeWei))}`,
    `flashFee=${ethers.formatEther(nz(res.flashLoanFeeWei))}`,
    `dexFees=${ethers.formatEther(nz(res.dexFeesWei))}`,
    `slippage=${ethers.formatEther(nz(res.slippageWei))}`,
    `other=${ethers.formatEther(nz(res.otherCostsWei))}`,
    `net=${ethers.formatEther(res.netProfitWei)} ETH`,
  ];
  if (typeof res.netProfitUsd === 'number') parts.push(`netUsd=$${res.netProfitUsd.toFixed(2)}`);
  if (typeof res.profitMarginPercent === 'number')
    parts.push(`margin=${res.profitMarginPercent.toFixed(2)}%`);
  return parts.join(' | ');
}
