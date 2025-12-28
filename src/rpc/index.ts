/**
 * RPC Connection Layer
 *
 * Manages connections to Base blockchain nodes with failover support.
 * Provides WebSocket and HTTP connections with health monitoring.
 */

// Re-export RPC components
export * from './connection-manager';
export * from './websocket-client';
export * from './http-client';
export * from './health-monitor';
