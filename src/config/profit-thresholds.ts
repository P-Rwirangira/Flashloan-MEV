/**
 * Centralized Profit Thresholds Configuration
 * Single source of truth for all profit-related thresholds
 */

export interface ProfitThresholds {
  arbitrage: {
    minProfitUsd: number;
    minProfitMarginBps: number;
    maxSlippageBps: number;
  };
  liquidation: {
    minProfitUsd: number;
    minProfitMarginBps: number;
    maxSlippageBps: number;
  };
  stablePool: {
    minProfitUsd: number;
    minProfitMarginBps: number;
    maxSlippageBps: number;
  };
  backrun: {
    minProfitUsd: number;
    minProfitMarginBps: number;
    maxSlippageBps: number;
  };
}

/**
 * Base L2 optimized profit thresholds
 */
export const BASE_L2_PROFIT_THRESHOLDS: ProfitThresholds = {
  arbitrage: {
    minProfitUsd: 8.0, // Lower threshold for Base L2 due to low gas costs
    minProfitMarginBps: 50, // 0.5% minimum margin
    maxSlippageBps: 100, // 1% max slippage
  },
  liquidation: {
    minProfitUsd: 15.0, // Higher due to complexity and gas usage
    minProfitMarginBps: 100, // 1% minimum margin
    maxSlippageBps: 250, // 2.5% max slippage
  },
  stablePool: {
    minProfitUsd: 5.0, // Lower for stable swaps
    minProfitMarginBps: 25, // 0.25% minimum margin
    maxSlippageBps: 50, // 0.5% max slippage
  },
  backrun: {
    minProfitUsd: 12.0, // Medium threshold for backrun opportunities
    minProfitMarginBps: 75, // 0.75% minimum margin
    maxSlippageBps: 150, // 1.5% max slippage
  },
};

/**
 * Get profit threshold for specific strategy
 */
export function getProfitThreshold(
  strategy: keyof ProfitThresholds
): ProfitThresholds[keyof ProfitThresholds] {
  return BASE_L2_PROFIT_THRESHOLDS[strategy];
}

/**
 * Validate if profit meets threshold requirements
 */
export function validateProfitThreshold(
  strategy: keyof ProfitThresholds,
  profitUsd: number,
  profitMarginBps: number
): { valid: boolean; reason?: string } {
  const threshold = getProfitThreshold(strategy);

  if (profitUsd < threshold.minProfitUsd) {
    return {
      valid: false,
      reason: `Profit ${profitUsd.toFixed(2)} USD below minimum ${threshold.minProfitUsd} USD`,
    };
  }

  if (profitMarginBps < threshold.minProfitMarginBps) {
    return {
      valid: false,
      reason: `Margin ${profitMarginBps}bps below minimum ${threshold.minProfitMarginBps}bps`,
    };
  }

  return { valid: true };
}
