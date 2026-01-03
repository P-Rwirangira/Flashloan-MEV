/**
 * Automated deployment script for FlashExecutor contract
 * Can deploy to testnet or mainnet based on environment
 */

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

interface DeploymentResult {
  contractAddress: string;
  network: string;
  chainId: string;
  owner: string;
  minProfit: string;
  deploymentBlock: number;
  gasUsed: string;
  authorizedPools: number;
}

interface ContractConfig {
  flashExecutor?: {
    address?: string;
    minProfit?: string;
    owner?: string;
    network?: string;
    chainId?: string;
    deploymentBlock?: number;
    deploymentTime?: string;
  };
}

async function updateContractsYaml(result: DeploymentResult): Promise<void> {
  const contractsYamlPath = path.join(process.cwd(), 'config', 'contracts.yaml');

  let config: ContractConfig = {};

  if (fs.existsSync(contractsYamlPath)) {
    const content = fs.readFileSync(contractsYamlPath, 'utf8');
    config = YAML.parse(content) as ContractConfig;
  }

  if (!config.flashExecutor) {
    config.flashExecutor = {};
  }

  config.flashExecutor.address = result.contractAddress;
  config.flashExecutor.minProfit = result.minProfit;
  config.flashExecutor.owner = result.owner;
  config.flashExecutor.network = result.network;
  config.flashExecutor.chainId = result.chainId;
  config.flashExecutor.deploymentBlock = result.deploymentBlock;
  config.flashExecutor.deploymentTime = new Date().toISOString();

  const yamlContent = YAML.stringify(config);
  fs.writeFileSync(contractsYamlPath, yamlContent);

  console.log(`Updated ${contractsYamlPath} with deployment info`);
}

async function updateEnvFile(contractAddress: string): Promise<void> {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.log('Warning: .env file not found, skipping update');
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf8');

  // Update or add FLASH_EXECUTOR_ADDRESS
  if (envContent.includes('FLASH_EXECUTOR_ADDRESS=')) {
    envContent = envContent.replace(
      /FLASH_EXECUTOR_ADDRESS=.*/,
      `FLASH_EXECUTOR_ADDRESS=${contractAddress}`
    );
  } else {
    envContent += `\nFLASH_EXECUTOR_ADDRESS=${contractAddress}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`Updated .env with FLASH_EXECUTOR_ADDRESS=${contractAddress}`);
}

async function deployContract(): Promise<DeploymentResult> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log('=== Deployment Configuration ===');
  console.log('Deploying with account:', deployer.address);
  console.log('Account balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH');
  console.log('Network:', network.name);
  console.log('Chain ID:', network.chainId.toString());

  // Check balance
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance < ethers.parseEther('0.01')) {
    throw new Error(`Insufficient balance: ${ethers.formatEther(balance)} ETH. Need at least 0.01 ETH`);
  }

  // Set minProfit based on environment
  const isTestnet = network.chainId === 84532n; // Base Sepolia
  const minProfitEth = isTestnet ? '0.001' : '0.005'; // Lower for testnet
  const minProfit = ethers.parseEther(minProfitEth);

  console.log('\n=== Deploying FlashExecutor ===');
  console.log('Min Profit:', minProfitEth, 'ETH');

  const FlashExecutor = await ethers.getContractFactory('FlashExecutor');
  const flashExecutor = await FlashExecutor.deploy(minProfit, {
    gasLimit: 5000000,
  });

  console.log('Deployment transaction submitted...');

  const deploymentTx = flashExecutor.deploymentTransaction();
  const receipt = await deploymentTx?.wait();
  const gasUsed = receipt?.gasUsed || 0n;

  await flashExecutor.waitForDeployment();

  const contractAddress = await flashExecutor.getAddress();
  const deploymentBlock = await ethers.provider.getBlockNumber();
  const owner = await flashExecutor.owner();

  console.log('\n=== Deployment Successful ===');
  console.log('Contract Address:', contractAddress);
  console.log('Deployment Block:', deploymentBlock);
  console.log('Owner:', owner);
  console.log('Gas Used:', gasUsed.toString());

  // Load authorized pools from config
  const poolsToAuthorize = await getAuthorizedPoolsFromConfig(network.chainId);

  console.log(`\n=== Authorizing ${poolsToAuthorize.length} Pools ===`);

  let authorizedCount = 0;
  const failedPools: string[] = [];

  for (const poolAddress of poolsToAuthorize) {
    try {
      console.log(`Authorizing pool: ${poolAddress}...`);
      const tx = await flashExecutor.addAuthorizedPool(poolAddress);
      await tx.wait();
      console.log(`✓ Authorized: ${poolAddress}`);
      authorizedCount++;
    } catch (error) {
      console.error(`✗ Failed to authorize ${poolAddress}:`, error instanceof Error ? error.message : error);
      failedPools.push(poolAddress);
    }
  }

  if (failedPools.length > 0) {
    console.log(`\nWarning: ${failedPools.length} pools failed to authorize`);
    console.log('Failed pools:', failedPools.join(', '));
  }

  const result: DeploymentResult = {
    contractAddress,
    network: network.name,
    chainId: network.chainId.toString(),
    owner,
    minProfit: minProfit.toString(),
    deploymentBlock,
    gasUsed: gasUsed.toString(),
    authorizedPools: authorizedCount,
  };

  // Update config files
  await updateContractsYaml(result);
  await updateEnvFile(contractAddress);

  return result;
}

async function getAuthorizedPoolsFromConfig(chainId: bigint): Promise<string[]> {
  const contractsYamlPath = path.join(process.cwd(), 'config', 'contracts.yaml');

  if (!fs.existsSync(contractsYamlPath)) {
    console.log('Warning: contracts.yaml not found, no pools will be authorized');
    return [];
  }

  const content = fs.readFileSync(contractsYamlPath, 'utf8');
  const config = YAML.parse(content);

  const pools: string[] = [];

  // Extract Uniswap V3 pools
  if (config.uniswapV3?.pools) {
    for (const pool of Object.values(config.uniswapV3.pools)) {
      if (typeof pool === 'object' && pool !== null && 'address' in pool) {
        const addr = (pool as { address: string }).address;
        if (addr && addr !== '0x0000000000000000000000000000000000000000' && ethers.isAddress(addr)) {
          pools.push(addr);
        }
      }
    }
  }

  // Extract Aerodrome pools
  if (config.aerodrome?.pools) {
    for (const pool of Object.values(config.aerodrome.pools)) {
      if (typeof pool === 'object' && pool !== null && 'address' in pool) {
        const addr = (pool as { address: string }).address;
        if (addr && addr !== '0x0000000000000000000000000000000000000000' && ethers.isAddress(addr)) {
          pools.push(addr);
        }
      }
    }
  }

  console.log(`Found ${pools.length} pools in configuration`);
  return pools;
}

async function main() {
  try {
    console.log('=== Base MEV Platform - Automated Deployment ===\n');

    const result = await deployContract();

    console.log('\n=== Deployment Complete ===');
    console.log('Contract Address:', result.contractAddress);
    console.log('Network:', result.network);
    console.log('Chain ID:', result.chainId);
    console.log('Authorized Pools:', result.authorizedPools);
    console.log('Gas Used:', result.gasUsed);

    console.log('\n=== Next Steps ===');
    console.log('1. Verify contract on BaseScan:');
    console.log(`   export CONTRACT_ADDRESS=${result.contractAddress}`);
    console.log('   npm run verify:testnet  (or verify:mainnet)');
    console.log('\n2. Test connectivity:');
    console.log('   npm run test:relay');
    console.log('\n3. Start dry-run testing:');
    console.log('   npm run dev');

    return result;
  } catch (error) {
    console.error('\n=== Deployment Failed ===');
    console.error(error);
    throw error;
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

export { deployContract, DeploymentResult };
