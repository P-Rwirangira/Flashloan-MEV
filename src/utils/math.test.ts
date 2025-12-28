/**
 * Math Utilities Tests
 */

import { bpsToDecimal, decimalToBps, percentageChange, safeDivide, clamp } from './math';

describe('Math Utilities', () => {
  describe('bpsToDecimal', () => {
    it('should convert basis points to decimal', () => {
      expect(bpsToDecimal(100)).toBe(0.01);
      expect(bpsToDecimal(500)).toBe(0.05);
      expect(bpsToDecimal(10000)).toBe(1);
    });
  });

  describe('decimalToBps', () => {
    it('should convert decimal to basis points', () => {
      expect(decimalToBps(0.01)).toBe(100);
      expect(decimalToBps(0.05)).toBe(500);
      expect(decimalToBps(1)).toBe(10000);
    });
  });

  describe('percentageChange', () => {
    it('should calculate percentage change correctly', () => {
      expect(percentageChange(100, 110)).toBe(10);
      expect(percentageChange(100, 90)).toBe(-10);
      expect(percentageChange(0, 100)).toBe(0);
    });
  });

  describe('safeDivide', () => {
    it('should divide safely', () => {
      expect(safeDivide(10, 2)).toBe(5);
      expect(safeDivide(10, 0)).toBe(0);
      expect(safeDivide(10, 0, 999)).toBe(999);
    });
  });

  describe('clamp', () => {
    it('should clamp values between min and max', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });
});
