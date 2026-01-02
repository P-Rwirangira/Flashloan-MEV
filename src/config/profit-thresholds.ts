/**
 * Profit Thresholds Configuration
 *
 * Centralized profit validation and threshold management
 */

export interface ProfitThreshold {
  minProfitUsd: number;
  minProfitMarginBps: number;
  strategy: string;
  description: string;
}

export interface ProfitValidationResult {
  valid: boolean;
  reason?: string;
  threshold: ProfitThreshold;
}

// Base L2 optimized thresholds
const PROFIT_THRESHOLDS: Record<string, ProfitThreshold> = {
  arbitrage: {
    minProfitUsd: 8.0, // Base L2 optimized - lower gas costs
    minProfitMarginBps: 50, // 0.5% minimum margin
    strategy: 'arbitrage',
    description: 'Cross-DEX arbitrage on Base L2',
  },
  liquidation: {
    minProfitUsd: 15.0, // Higher due to complexity
    minProfitMarginBps: 100, // 1% minimum margin
    strategy: 'liquidation',
    description: 'Lending protocol liquidations',
  },
  stablePool: {
    minProfitUsd: 5.0, // Lower for stable swaps
    minProfitMarginBps: 25, // 0.25% minimum margin
    strategy: 'stablePool',
    description: 'Stable pool rebalancing',
  },
};

/**
 * Get profit threshold for strategy
 */
export function getProfitThreshold(strategy: string): ProfitThreshold {
  const threshold = PROFIT_THRESHOLDS[strategy];
  if (!threshold) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }
  return threshold;
}

/**
 * Validate profit against threshold
 */
export function validateProfitThreshold(
  strategy: string,
  profitUsd: number,
  profitMarginBps: number
): ProfitValidationResult {
  const threshold = getProfitThreshold(strategy);

  if (profitUsd < threshold.minProfitUsd) {
    return {
      valid: false,
      reason: `Profit ${profitUsd.toFixed(2)} USD below minimum ${threshold.minProfitUsd} USD`,
      threshold,
    };
  }

  if (profitMarginBps < threshold.minProfitMarginBps) {
    return {
      valid: false,
      reason: `Margin ${profitMarginBps.toFixed(0)}bps below minimum ${threshold.minProfitMarginBps}bps`,
      threshold,
    };
  }

  return {
    valid: true,
    threshold,
  };
}

/**
 * Update profit threshold for strategy
 */
export function updateProfitThreshold(strategy: string, threshold: Partial<ProfitThreshold>): void {
  const existing = PROFIT_THRESHOLDS[strategy];
  if (!existing) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }

  PROFIT_THRESHOLDS[strategy] = {
    ...existing,
    ...threshold,
    strategy, // Ensure strategy field is preserved
  };
}

/**
 * Get all profit thresholds
 */
export function getAllProfitThresholds(): Record<string, ProfitThreshold> {
  return { ...PROFIT_THRESHOLDS };
}
