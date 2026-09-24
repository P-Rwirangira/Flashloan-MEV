/**
 * Extended Unit Tests: Math Utilities
 *
 * Verifies edge cases for price impact, basis point conversions,
 * boundary clamping, and safe division with zero denominators.
 */

import {
  calculatePriceImpact,
  safeDivide,
  clamp,
  bpsToDecimal,
  decimalToBps,
  percentageChange,
} from '../../src/utils/math';
import { parseUnits } from 'ethers';

describe('Math Utilities - Extended & Edge Case Tests', () => {
  describe('calculatePriceImpact', () => {
    test('should calculate correct price impact for standard pool swap', () => {
      // 100 WETH and 250,000 USDC reserves
      const reserveIn = parseUnits('100', 18);
      const reserveOut = parseUnits('250000', 18);

      // Swapping 1 WETH for 2450 USDC
      const amountIn = parseUnits('1', 18);
      const amountOut = parseUnits('2450', 18);

      const impact = calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut);

      // Spot price: 250,000 / 100 = 2500
      // Execution price: 2450 / 1 = 2450
      // Impact: |2450 - 2500| / 2500 * 100 = 2%
      expect(impact).toBeCloseTo(2.0, 5);
    });

    test('should return 0% impact when execution price matches spot price', () => {
      const reserveIn = parseUnits('1000', 18);
      const reserveOut = parseUnits('1000', 18);

      const amountIn = parseUnits('10', 18);
      const amountOut = parseUnits('10', 18);

      const impact = calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut);
      expect(impact).toBe(0);
    });
  });

  describe('safeDivide', () => {
    test('should return fallback when denominator is 0', () => {
      expect(safeDivide(100, 0, 0)).toBe(0);
      expect(safeDivide(50, 0, -1)).toBe(-1);
    });

    test('should divide correctly for non-zero denominators', () => {
      expect(safeDivide(100, 4)).toBe(25);
      expect(safeDivide(-50, 2)).toBe(-25);
    });
  });

  describe('clamp', () => {
    test('should keep values within [min, max] range', () => {
      expect(clamp(5, 1, 10)).toBe(5);
      expect(clamp(0, 1, 10)).toBe(1);
      expect(clamp(15, 1, 10)).toBe(10);
      expect(clamp(-10, -5, 5)).toBe(-5);
    });
  });

  describe('bpsToDecimal and decimalToBps', () => {
    test('should round-trip basis point conversions accurately', () => {
      expect(bpsToDecimal(50)).toBe(0.005);
      expect(decimalToBps(0.005)).toBe(50);
      expect(decimalToBps(bpsToDecimal(125))).toBe(125);
    });
  });

  describe('percentageChange', () => {
    test('should calculate positive and negative percentage changes', () => {
      expect(percentageChange(200, 250)).toBe(25);
      expect(percentageChange(200, 150)).toBe(-25);
      expect(percentageChange(0, 50)).toBe(0); // Safe guard on 0
    });
  });
});
