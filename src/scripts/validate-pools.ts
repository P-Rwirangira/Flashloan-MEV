#!/usr/bin/env tsx

/**
 * Pool Validation Script
 * 
 * Validates all configured pools before starting the MEV platform.
 * Run with: npm run validate-pools
 */

import { RpcConnectionManager } from '../rpc/connection-manager';
import { Address } from '../types/common';
import { PoolValidator } from '../utils/pool-validator';
import { ConfigLoader } from '../config/loader';
import path from 'path';

async function main() {
  console.log('🔍 Base MEV Platform - Pool Validation');
  console.log('=====================================\n');

  try {
    // Load configuration
    const configLoader = new ConfigLoader({
      configPath: path.join(process.cwd(), 'config', 'default.yaml'),
      watchForChanges: false,
      envPrefix: 'MEV_',
    });

    const config = await configLoader.load();
    
    // Initialize connection manager
    const connectionManager = new RpcConnectionManager({
      network: {
        name: 'base',
        chainId: 8453,
        rpcUrl: process.env['BASE_RPC_URL'] || 'https://mainnet.base.org',
        wsUrl: process.env['BASE_WS_URL'] || '',
        fallbackRpcs: [
          'https://base-mainnet.g.alchemy.com/v2/demo',
          'https://base.blockpi.network/v1/rpc/public',
        ],
      },
      healthCheckIntervalMs: 30000,
      maxConsecutiveFailures: 3,
      connectionTimeoutMs: 10000,
      requestTimeoutMs: 30000,
    });

    await connectionManager.initialize();
    console.log('✅ RPC connection established\n');

    // Initialize validator
    const validator = new PoolValidator(connectionManager);

    // Collect all pool addresses from config
    const poolAddresses: string[] = [];
    
    if (config.allowedPools?.uniswapV3) {
      poolAddresses.push(...config.allowedPools.uniswapV3.map((p: any) => p.address));
    }
    
    if (config.allowedPools?.aerodrome) {
      poolAddresses.push(...config.allowedPools.aerodrome.map((p: any) => p.address));
    }

    if (poolAddresses.length === 0) {
      console.log('⚠️  No pools configured for validation');
      return;
    }

    console.log(`🔍 Validating ${poolAddresses.length} configured pools...\n`);

    // Validate all pools
    const results = await validator.validatePools(poolAddresses as Address[]);

    // Generate and display report
    const report = validator.generateValidationReport(results);
    console.log(report);

    // Summary
    const validCount = results.filter(r => r.isValid).length;
    const invalidCount = results.filter(r => !r.isValid).length;
    const warningCount = results.filter(r => r.warnings.length > 0).length;

    console.log('Summary:');
    console.log('--------');
    console.log(`✅ Valid pools: ${validCount}`);
    console.log(`❌ Invalid pools: ${invalidCount}`);
    console.log(`⚠️  Pools with warnings: ${warningCount}`);

    if (invalidCount > 0) {
      console.log('\n🚨 Some pools are invalid. Please check the configuration.');
      console.log('   Invalid pools will be skipped during platform startup.');
    }

    if (warningCount > 0) {
      console.log('\n⚠️  Some pools have warnings. Review them before live trading.');
    }

    if (validCount > 0) {
      console.log('\n🎉 Pool validation completed successfully!');
      console.log('   The platform can start with the valid pools.');
    }

  } catch (error) {
    console.error('❌ Pool validation failed:', error);
    process.exit(1);
  }
}

// Run the validation
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});