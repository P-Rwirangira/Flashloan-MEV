import { run } from 'hardhat';
import { ContractManager } from '../src/contracts/contract-manager';

async function main() {
  const contractManager = new ContractManager();

  // Check if contract is deployed
  if (!contractManager.isFlashExecutorDeployed()) {
    console.error('Flash Executor contract not deployed. Run deployment first.');
    process.exit(1);
  }

  const contractConfig = contractManager.getFlashExecutorConfig();
  const deploymentConfig = contractManager.getDeploymentConfig();

  console.log('Verifying Flash Executor contract...');
  console.log('Contract Address:', contractConfig.address);
  console.log('Network:', contractConfig.network);
  console.log('Chain ID:', contractConfig.chainId);

  try {
    // Verify the contract on Etherscan/Basescan
    await run('verify:verify', {
      address: contractConfig.address,
      constructorArguments: [contractConfig.minProfit],
      contract: 'contracts/FlashExecutor.sol:FlashExecutor',
    });

    console.log('✓ Contract verified successfully!');
    console.log(
      `View on explorer: ${getExplorerUrl(contractConfig.network, contractConfig.address)}`
    );
  } catch (error: any) {
    if (error.message.includes('Already Verified')) {
      console.log('✓ Contract already verified!');
      console.log(
        `View on explorer: ${getExplorerUrl(contractConfig.network, contractConfig.address)}`
      );
    } else {
      console.error('✗ Verification failed:', error.message);
      process.exit(1);
    }
  }
}

function getExplorerUrl(network: string, address: string): string {
  switch (network.toLowerCase()) {
    case 'base':
      return `https://basescan.org/address/${address}`;
    case 'base-sepolia':
      return `https://sepolia.basescan.org/address/${address}`;
    default:
      return `https://etherscan.io/address/${address}`;
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
