/**
 * Unit & Regression Tests: Circuit Breaker
 *
 * Verifies state transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED),
 * threshold enforcement, request blocking, probe recovery, and metrics.
 */

import { CircuitBreaker, CircuitBreakerState } from '../../src/monitoring/circuit-breaker';

describe('CircuitBreaker Unit Tests', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      minimumRequests: 3,
      recoveryTimeout: 500, // Short timeout for testing
      successThreshold: 2,
      monitoringWindow: 60000,
    });
  });

  afterEach(() => {
    breaker.reset();
  });

  test('should start in CLOSED state and allow requests', () => {
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(breaker.isRequestAllowed()).toBe(true);

    const metrics = breaker.getMetrics();
    expect(metrics.state).toBe(CircuitBreakerState.CLOSED);
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.failureCount).toBe(0);
  });

  test('should pass through successful execution and update metrics', async () => {
    const result = await breaker.execute(async () => 'success_value');

    expect(result).toBe('success_value');
    const metrics = breaker.getMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.failureRate).toBe(0);
  });

  test('should record failure and rethrow original error', async () => {
    const customError = new Error('simulated failure');

    await expect(
      breaker.execute(async () => {
        throw customError;
      })
    ).rejects.toThrow('simulated failure');

    const metrics = breaker.getMetrics();
    expect(metrics.failureCount).toBe(1);
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.failureRate).toBe(1);
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED); // Not tripped yet (1 < 3)
  });

  test('should trip to OPEN when failure threshold and minimum requests are met', async () => {
    const stateChangedSpy = jest.fn();
    breaker.on('stateChanged', stateChangedSpy);

    // 3 failures meet both minimumRequests (3) and failureThreshold (3)
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error(`fail ${i}`);
        });
      } catch {
        // Expected
      }
    }

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    expect(breaker.isRequestAllowed()).toBe(false);
    expect(stateChangedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oldState: CircuitBreakerState.CLOSED,
        newState: CircuitBreakerState.OPEN,
      })
    );

    // While OPEN, requests must be rejected immediately without running the action
    const mockAction = jest.fn();
    await expect(breaker.execute(mockAction)).rejects.toThrow(
      'Circuit breaker is OPEN - request blocked'
    );
    expect(mockAction).not.toHaveBeenCalled();
  });

  test('should not trip if request count is below minimumRequests', async () => {
    const highMinBreaker = new CircuitBreaker({
      failureThreshold: 2,
      minimumRequests: 5,
    });

    for (let i = 0; i < 2; i++) {
      try {
        await highMinBreaker.execute(async () => {
          throw new Error('fail');
        });
      } catch {
        // Expected
      }
    }

    // 2 failures >= failureThreshold(2), but total requests (2) < minimumRequests(5)
    expect(highMinBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    highMinBreaker.reset();
  });

  test('should support half-open probe and close on consecutive successes', async () => {
    // Force to HALF_OPEN
    breaker.forceState(CircuitBreakerState.HALF_OPEN);
    expect(breaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);

    // First success (need 2 for successThreshold)
    await breaker.execute(async () => 'probe 1');
    expect(breaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);

    // Second success closes the circuit
    await breaker.execute(async () => 'probe 2');
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(breaker.isRequestAllowed()).toBe(true);
  });

  test('should immediately trip to OPEN on any failure during HALF_OPEN state', async () => {
    breaker.forceState(CircuitBreakerState.HALF_OPEN);

    try {
      await breaker.execute(async () => {
        throw new Error('probe failed');
      });
    } catch {
      // Expected
    }

    // Immediate trip back to OPEN
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    expect(breaker.isRequestAllowed()).toBe(false);
  });

  test('should reset back to CLOSED with clean metrics', () => {
    breaker.forceState(CircuitBreakerState.OPEN);
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

    breaker.reset();
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(breaker.isRequestAllowed()).toBe(true);
  });
});
