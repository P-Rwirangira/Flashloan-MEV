/**
 * Validation Utilities
 *
 * Input validation and sanitization functions.
 */

import { isAddress } from 'ethers';
import { Address } from '../types/common';

// Validate Ethereum address
export function validateAddress(address: string): address is Address {
  return isAddress(address);
}

// Validate positive number
export function validatePositiveNumber(value: number): boolean {
  return typeof value === 'number' && value > 0 && !isNaN(value);
}

// Validate percentage (0-100)
export function validatePercentage(value: number): boolean {
  return typeof value === 'number' && value >= 0 && value <= 100 && !isNaN(value);
}

// Validate basis points (0-10000)
export function validateBasisPoints(value: number): boolean {
  return typeof value === 'number' && value >= 0 && value <= 10000 && !isNaN(value);
}

// Validate URL
export function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Validate required string
export function validateRequiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Validate array of addresses
export function validateAddressArray(addresses: unknown[]): addresses is Address[] {
  return Array.isArray(addresses) && addresses.every(addr => validateAddress(String(addr)));
}
