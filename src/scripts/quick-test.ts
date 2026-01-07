#!/usr/bin/env tsx

/**
 * Quick Test Script
 * 
 * Tests the enhanced arbitrage scanner and pool initialization quickly.
 */

import { RpcConnectionManager } from '../rpc/connection-manager';
import { PoolManager } from '../scanner/pool-manager';
import { ArbitrageScanner } from '../scanner/arbitrage-scanner';
import { ConfigLoader } from '../config/loader';
import path from 'path';

async function main() {
  console.log('🚀 Quick Test - Enhanced Arbitrage Scanner');
  console.log('==========================================\n');

  try {
    // Load configuration
    const configLoader = new ConfigLoader({
      configPath: path.join(process.cwd(), 'config', 'default.yaml'),
      watchForChanges: false,
      envPrefix: 'MEV_',
    });

    const config = await configLoader.load();
    console.log('✅ Configuration loaded');

    // Initialize connection manager
    const connectionManager = new RpcConnectionManager({
      network: {
        name: 'base',
        chainId: 8453,
        rpcUrl: process.env['BASE_RPC_URL'] || 'https://base-rpc.publicnode.com',
        wsUrl: process.env['BASE_WS_URL'] || '',
        fallbackRpcs: [
          'https://base.llamarpc.com',
          'https://base.meowrpc.com',
        ],
      },
      healthCheckIntervalMs: 30000,
      maxConsecutiveFailures: 3,
      connectionTimeoutMs: 5000, // Shorter timeout for testing
      requestTimeoutMs: 10000,
    });

    console.log('🔗 Initializing RPC connection...');
    await connectionManager.initialize();
    console.log('✅ RPC connection established');

    // Test basic RPC call
    const provider = connectionManager.getProvider();
    const blockNumber = await provider.getBlockNumber();
    console.log(`📦 Current block: ${blockNumber}`);

    // Initialize pool manager
    console.log('🏊 Initializing pool manager...');
    const poolManager = new PoolManager({
      connectionManager,
      allowedPools: config.allowedPools || { uniswapV3: [], aerodrome: [] },
      updateIntervalMs: 10000, // Longer interval for testing
    });

    await poolManager.initialize();
    console.log('✅ Pool manager initialized');

    // Start monitoring briefly
    console.log('👀 Starting pool monitoring...');
    await poolManager.startMonitoring();
    
    // Wait a bit for pools to initialize
    console.log('⏳ Waiting for pool initialization...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const poolStates = poolManager.getAllPoolStates();
    console.log(`📊 Pool states loaded: ${poolStates.size} pools`);

    if (poolStates.size > 0) {
      console.log('Pool details:');
      for (const [address, state] of poolStates) {
        console.log(`  - ${address}: ${state.token0}/${state.token1} (${state.type})`);
      }
    }

    // Initialize enhanced scanner
    console.log('🔍 Initializing enhanced arbitrage scanner...');
    const scanner = new ArbitrageScanner({
      poolManager,
      connectionManager,
      config: config.strategies.arbitrage,
      scanIntervalMs: 5000, // 5 second intervals for testing
    });

    // Set up event listeners
    scanner.on('scanningStarted', () => {
      console.log('✅ Scanner started successfully');
    });

    scanner.on('scanCompleted', (event: any) => {
      console.log(`📈 Scan completed: ${event.opportunitiesFound} opportunities found in ${event.duration}ms`);
    });

    scanner.on('opportunityDetected', (opportunity: any) => {
      console.log(`💰 Opportunity detected: ${opportunity.id} - ${opportunity.expectedProfit?.toString()} profit`);
    });

    scanner.on('scanError', (error: any) => {
      console.log(`❌ Scan error: ${error.message}`);
    });

    // Start scanning
    await scanner.startScanning();
    
    // Run for 30 seconds
    console.log('🏃 Running scanner for 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Get active opportunities
    const opportunities = scanner.getActiveOpportunities();
    console.log('\n📊 Scanner Results:');
    console.log(`  - Active opportunities: ${opportunities.length}`);
    
    if (opportunities.length > 0) {
      console.log('  - Opportunity details:');
      opportunities.forEach((opp, i) => {
        console.log(`    ${i + 1}. ${opp.id} - Profit: ${opp.expectedProfit.toString()}`);
      });
    }

    // Stop scanner
    await scanner.stopScanning();
    await poolManager.stopMonitoring();

    console.log('\n🎉 Quick test completed successfully!');

  } catch (error) {
    console.error('❌ Quick test failed:', error);
    process.exit(1);
  }
}

// Run the test
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});