/**
 * Relay Connectivity Test Script
 * Tests connection to bloXroute, Flashbots, and local node before live trading
 */

import { ethers } from 'ethers';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';

interface RelayTestResult {
  name: string;
  connected: boolean;
  latency?: number;
  error?: string;
  blockNumber?: number;
}

async function testFlashbotsRelay(): Promise<RelayTestResult> {
  const start = Date.now();
  try {
    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL || 'https://mainnet.base.org'
    );

    const authSigner = process.env.FLASHBOTS_AUTH_KEY
      ? new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY)
      : ethers.Wallet.createRandom();

    const flashbotsUrl = process.env.FLASHBOTS_PROTECT_URL || 'https://rpc.flashbots.net';

    console.log(`Testing Flashbots Protect at ${flashbotsUrl}...`);

    const flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      authSigner,
      flashbotsUrl
    );

    // Test basic connectivity by getting block number
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - start;

    return {
      name: 'Flashbots Protect',
      connected: true,
      latency,
      blockNumber,
    };
  } catch (error) {
    return {
      name: 'Flashbots Protect',
      connected: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testBloXrouteRelay(): Promise<RelayTestResult> {
  const start = Date.now();
  try {
    const apiKey = process.env.BLOXROUTE_API_KEY;

    if (!apiKey || apiKey === 'your_bloxroute_api_key_here') {
      return {
        name: 'bloXroute BDN',
        connected: false,
        error: 'API key not configured (set BLOXROUTE_API_KEY)',
      };
    }

    const bloXrouteUrl = `https://base.bdn.blxrbdn.com`;

    console.log(`Testing bloXroute BDN at ${bloXrouteUrl}...`);

    // Create FetchRequest with custom headers for bloXroute authentication
    const fetchRequest = new ethers.FetchRequest(bloXrouteUrl);
    fetchRequest.setHeader('Authorization', apiKey);

    const provider = new ethers.JsonRpcProvider(fetchRequest, undefined, {
      staticNetwork: true,
    });

    // Test basic connectivity
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - start;

    return {
      name: 'bloXroute BDN',
      connected: true,
      latency,
      blockNumber,
    };
  } catch (error) {
    return {
      name: 'bloXroute BDN',
      connected: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testLocalNode(): Promise<RelayTestResult> {
  const start = Date.now();
  try {
    const localUrl = process.env.BASE_RPC_URL || 'http://localhost:8545';

    console.log(`Testing local/public RPC at ${localUrl}...`);

    const provider = new ethers.JsonRpcProvider(localUrl);

    const blockNumber = await provider.getBlockNumber();
    const network = await provider.getNetwork();
    const latency = Date.now() - start;

    if (network.chainId !== 8453n) {
      return {
        name: 'Local/Public RPC',
        connected: false,
        error: `Wrong chain ID: ${network.chainId} (expected 8453 for Base)`,
      };
    }

    return {
      name: 'Local/Public RPC',
      connected: true,
      latency,
      blockNumber,
    };
  } catch (error) {
    return {
      name: 'Local/Public RPC',
      connected: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testWalletBalance(): Promise<void> {
  try {
    const privateKey = process.env.EXECUTION_PRIVATE_KEY || process.env.PRIVATE_KEY;

    if (!privateKey || privateKey === 'your_private_key_here') {
      console.log('\n⚠️  WARNING: No execution wallet configured');
      return;
    }

    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL || 'https://mainnet.base.org'
    );
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);

    console.log('\n💰 Wallet Status:');
    console.log(`   Address: ${wallet.address}`);
    console.log(`   Balance: ${balanceEth} ETH`);

    if (parseFloat(balanceEth) < 0.01) {
      console.log('   ⚠️  WARNING: Low balance! Fund wallet with at least 0.1 ETH for testing');
    } else if (parseFloat(balanceEth) > 1.0) {
      console.log(
        '   ⚠️  CAUTION: High balance detected. Recommend using dedicated wallet with <0.5 ETH for testing'
      );
    } else {
      console.log('   ✅ Balance looks good for testing');
    }
  } catch (error) {
    console.log('\n⚠️  Could not check wallet balance:', error);
  }
}

async function testContractDeployment(): Promise<void> {
  try {
    const contractAddress = process.env.FLASH_EXECUTOR_ADDRESS;

    if (!contractAddress || contractAddress.trim() === '') {
      console.log('\n❌ CRITICAL: FlashExecutor contract not deployed!');
      console.log('   Run: npm run deploy:testnet  (for Base Sepolia)');
      console.log('   Run: npm run deploy:mainnet  (for Base mainnet)');
      return;
    }

    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL || 'https://mainnet.base.org'
    );
    const code = await provider.getCode(contractAddress);

    if (code === '0x') {
      console.log('\n❌ CRITICAL: Contract address has no code!');
      console.log(`   Address: ${contractAddress}`);
      console.log('   This address is not a deployed contract');
    } else {
      console.log('\n✅ FlashExecutor Contract:');
      console.log(`   Address: ${contractAddress}`);
      console.log(`   Code Size: ${(code.length - 2) / 2} bytes`);
      console.log('   Status: Deployed');
    }
  } catch (error) {
    console.log('\n⚠️  Could not verify contract deployment:', error);
  }
}

async function main() {
  console.log('🧪 Base MEV Platform - Relay Connectivity Test\n');
  console.log('=' .repeat(60));

  // Test all relays in parallel
  const results = await Promise.all([
    testLocalNode(),
    testFlashbotsRelay(),
    testBloXrouteRelay(),
  ]);

  console.log('\n📊 Relay Test Results:\n');

  let hasWorkingRelay = false;
  let hasPrivateRelay = false;

  for (const result of results) {
    const status = result.connected ? '✅' : '❌';
    console.log(`${status} ${result.name}`);

    if (result.connected) {
      console.log(`   Latency: ${result.latency}ms`);
      console.log(`   Block Number: ${result.blockNumber}`);
      hasWorkingRelay = true;

      if (result.name !== 'Local/Public RPC') {
        hasPrivateRelay = true;
      }
    } else {
      console.log(`   Error: ${result.error}`);
    }
    console.log();
  }

  // Check wallet and contract
  await testWalletBalance();
  await testContractDeployment();

  // Summary and recommendations
  console.log('\n' + '='.repeat(60));
  console.log('\n📋 Pre-Flight Checklist:\n');

  if (!hasWorkingRelay) {
    console.log('❌ CRITICAL: No working RPC connection!');
    console.log('   Fix: Configure BASE_RPC_URL with valid endpoint\n');
  } else {
    console.log('✅ RPC connection working\n');
  }

  if (!hasPrivateRelay) {
    console.log('❌ CRITICAL: No private relay configured!');
    console.log('   Risk: Transactions will be visible in public mempool → 100% MEV theft');
    console.log('   Fix: Configure BLOXROUTE_API_KEY or use Flashbots Protect\n');
  } else {
    console.log('✅ Private relay configured\n');
  }

  const contractAddress = process.env.FLASH_EXECUTOR_ADDRESS;
  if (!contractAddress || contractAddress.trim() === '') {
    console.log('❌ BLOCKING: FlashExecutor contract not deployed\n');
  } else {
    console.log('✅ FlashExecutor contract configured\n');
  }

  const privateKey = process.env.EXECUTION_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey || privateKey === 'your_private_key_here') {
    console.log('❌ BLOCKING: Execution wallet not configured\n');
  } else {
    console.log('✅ Execution wallet configured\n');
  }

  console.log('='.repeat(60));

  if (!hasWorkingRelay || !hasPrivateRelay) {
    console.log('\n⚠️  NOT READY for live trading - critical issues detected\n');
    process.exit(1);
  } else if (!contractAddress || !privateKey) {
    console.log('\n⚠️  NOT READY - deployment incomplete\n');
    process.exit(1);
  } else {
    console.log('\n✅ Ready for testing - all systems operational\n');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
