import { ethers } from 'hardhat';
import { parseEther } from 'ethers';
import { ContractManager } from '../src/contracts/contract-manager';

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const contractManager = new ContractManager();

  console.log('Deploying contracts with the account:', deployer.address);
  console.log('Account balance:', (await ethers.provider.getBalance(deployer.address)).toString());
  console.log('Network:', network.name, 'Chain ID:', network.chainId.toString());

  // Get deployment configuration
  const deploymentConfig = contractManager.getDeploymentConfig();

  // Validate minProfitEth
  if (!deploymentConfig.minProfitEth) {
    throw new Error('minProfitEth is required in deployment configuration');
  }

  const minProfitEthStr = String(deploymentConfig.minProfitEth).trim();

  // Validate format (decimal number)
  if (!/^\d+(\.\d+)?$/.test(minProfitEthStr)) {
    throw new Error(
      `Invalid minProfitEth format: ${minProfitEthStr}. Must be a positive decimal number.`
    );
  }

  const minProfitNum = parseFloat(minProfitEthStr);
  if (minProfitNum <= 0) {
    throw new Error(`minProfitEth must be positive, got: ${minProfitNum}`);
  }

  let minProfit: bigint;
  try {
    minProfit = parseEther(minProfitEthStr);
  } catch (error) {
    throw new Error(`Failed to parse minProfitEth "${minProfitEthStr}": ${error}`);
  }

  console.log('Minimum profit set to:', minProfit.toString(), 'wei');

  // Deploy FlashExecutor
  const FlashExecutor = await ethers.getContractFactory('FlashExecutor');
  const flashExecutor = await FlashExecutor.deploy(minProfit, {
    gasLimit: deploymentConfig.gasLimit,
  });

  const deploymentTx = flashExecutor.deploymentTransaction();
  const receipt = await deploymentTx?.wait();
  const actualGasUsed = receipt?.gasUsed || 'unknown';

  await flashExecutor.waitForDeployment();

  const contractAddress = await flashExecutor.getAddress();
  const deploymentBlock = await ethers.provider.getBlockNumber();

  console.log('FlashExecutor deployed to:', contractAddress);
  console.log('Deployment block:', deploymentBlock);
  console.log('Owner:', await flashExecutor.owner());

  // Update contract configuration
  const contractConfig = {
    address: contractAddress,
    minProfit: minProfit.toString(),
    owner: await flashExecutor.owner(),
    network: network.name,
    chainId: network.chainId.toString(),
    deploymentBlock,
    deploymentTime: new Date().toISOString(),
  };

  contractManager.updateFlashExecutorConfig(contractConfig);

  // Add authorized pools to the contract
  const authorizedPools = contractManager.getAllAuthorizedPoolAddresses();
  console.log(`\nAdding ${authorizedPools.length} authorized pools...`);

  const failedPools: string[] = [];

  for (const poolAddress of authorizedPools) {
    try {
      console.log(`Adding pool: ${poolAddress}`);
      const tx = await flashExecutor.addAuthorizedPool(poolAddress);
      await tx.wait();
      console.log(`✓ Pool added: ${poolAddress}`);
    } catch (error) {
      console.error(`✗ Failed to add pool ${poolAddress}:`, error);
      failedPools.push(poolAddress);
    }
  }

  // Check if any pools failed to register
  if (failedPools.length > 0) {
    const errorMsg = `Failed to register ${failedPools.length} pools: ${failedPools.join(', ')}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log('\n=== Deployment Summary ===');
  console.log('Contract Address:', contractAddress);
  console.log('Network:', network.name);
  console.log('Chain ID:', network.chainId.toString());
  console.log('Owner:', await flashExecutor.owner());
  console.log('Min Profit:', minProfit.toString(), 'wei');
  console.log('Authorized Pools:', authorizedPools.length);
  console.log('Deployment Block:', deploymentBlock);
  console.log('Gas Used:', actualGasUsed.toString());

  return {
    contractAddress,
    network: network.name,
    chainId: network.chainId.toString(),
    owner: await flashExecutor.owner(),
    minProfit: minProfit.toString(),
    authorizedPools: authorizedPools.length,
    deploymentBlock,
  };
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
