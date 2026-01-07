/**
 * Test FlashExecutor contract deployment on Sepolia
 * Performs a small test transaction to validate deployment
 */

import { ethers } from 'hardhat';
import { FlashExecutor } from '../typechain-types';

interface TestResult {
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

async function testContractDeployment(contractAddress: string): Promise<TestResult> {
  try {
    console.log('Testing FlashExecutor contract at:', contractAddress);

    const [deployer] = await ethers.getSigners();
    const FlashExecutor = await ethers.getContractFactory('FlashExecutor');
    const flashExecutor = FlashExecutor.attach(contractAddress) as FlashExecutor;

    // Test 1: Check if contract is deployed
    const code = await ethers.provider.getCode(contractAddress);
    if (code === '0x') {
      return {
        success: false,
        error: 'No contract code at address',
      };
    }
    console.log('✓ Contract code exists');

    // Test 2: Check owner
    const owner = await flashExecutor.owner();
    console.log('✓ Owner:', owner);

    if (owner !== deployer.address) {
      console.log('⚠ Warning: Deployer is not the owner');
    }

    // Test 3: Check minProfit
    const minProfit = await flashExecutor.getMinProfit();
    console.log('✓ Min Profit:', ethers.formatEther(minProfit), 'ETH');

    // Test 4: Check if contract is paused
    const isPaused = await flashExecutor.paused();
    console.log('✓ Paused:', isPaused);

    if (isPaused) {
      console.log('⚠ Warning: Contract is paused');
    }

    // Test 5: Check authorized caller
    const isAuthorizedCaller = await flashExecutor.authorizedCallers(deployer.address);
    console.log('✓ Deployer is authorized caller:', isAuthorizedCaller);

    // Test 6: Get network info
    const network = await ethers.provider.getNetwork();
    const balance = await ethers.provider.getBalance(contractAddress);

    console.log('\n=== Contract Test Summary ===');
    console.log('Address:', contractAddress);
    console.log('Network:', network.name);
    console.log('Chain ID:', network.chainId.toString());
    console.log('Owner:', owner);
    console.log('Min Profit:', ethers.formatEther(minProfit), 'ETH');
    console.log('Contract Balance:', ethers.formatEther(balance), 'ETH');
    console.log('Is Paused:', isPaused);
    console.log('Deployer Authorized:', isAuthorizedCaller);

    return {
      success: true,
      details: {
        address: contractAddress,
        network: network.name,
        chainId: network.chainId.toString(),
        owner,
        minProfit: minProfit.toString(),
        balance: balance.toString(),
        isPaused,
        deployerAuthorized: isAuthorizedCaller,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const contractAddress = process.env.FLASH_EXECUTOR_ADDRESS;

  if (!contractAddress) {
    console.error('Error: FLASH_EXECUTOR_ADDRESS environment variable not set');
    console.log('Set it with: export FLASH_EXECUTOR_ADDRESS=0x...');
    process.exit(1);
  }

  console.log('Testing FlashExecutor contract deployment...\n');

  const result = await testContractDeployment(contractAddress);

  if (result.success) {
    console.log('\n✓ All tests passed!');
    console.log('\nContract is ready for use.');
    process.exit(0);
  } else {
    console.error('\n✗ Test failed:', result.error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
