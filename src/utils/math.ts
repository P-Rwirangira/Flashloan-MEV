/**
 * Math Utilities
 *
 * Mathematical functions for MEV calculations.
 */

import { BigNumberish, formatUnits } from 'ethers';

// Convert basis points to decimal
export function bpsToDecimal(bps: number): number {
  return bps / 10000;
}

// Convert decimal to basis points
export function decimalToBps(decimal: number): number {
  return Math.round(decimal * 10000);
}

// Calculate percentage change
export function percentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

// Calculate price impact
export function calculatePriceImpact(
  amountIn: BigNumberish,
  amountOut: BigNumberish,
  reserveIn: BigNumberish,
  reserveOut: BigNumberish
): number {
  // Simplified price impact calculation
  const spotPrice = Number(formatUnits(reserveOut)) / Number(formatUnits(reserveIn));
  const executionPrice = Number(formatUnits(amountOut)) / Number(formatUnits(amountIn));

  return Math.abs((executionPrice - spotPrice) / spotPrice) * 100;
}

// Safe division with fallback
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  return denominator === 0 ? fallback : numerator / denominator;
}

// Clamp value between min and max
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
