/**
 * Simulator Module
 *
 * Pre-execution validation using forked Base state.
 * Validates profitability and calculates exact execution parameters.
 */

// Re-export simulator components
export * from './foundry-simulator';
export * from './profit-calculator';
export * from './gas-estimator';

// Main simulator interface for easy integration
export { FoundrySimulator as Simulator } from './foundry-simulator';
export { ProfitCalculator } from './profit-calculator';
export { GasEstimator } from './gas-estimator';

// Type exports for external use
export type {
  FoundrySimulatorOptions,
  SimulationResult,
  ForkState,
} from './foundry-simulator';

export type {
  GasEstimatorOptions,
  GasEstimate,
  GasPriceData,
} from './gas-estimator';

export type {
  ProfitCalculatorOptions,
  DetailedProfitCalculation,
  ProfitThresholds,
  IPriceOracle,
} from './profit-calculator';
