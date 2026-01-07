/**
 * Automated deployment script for FlashExecutor contract
 * Can deploy to testnet or mainnet based on environment
 */

import { config } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

// Load environment variables
config();

// Get network from command line argument
const network = process.argv[2] || 'base-sepolia';

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
  // Setup provider based on network
  let provider: ethers.Provider;
  let chainId: number;
  
  if (network === 'base-sepolia') {
    provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org');
    chainId = 84532;
  } else if (network === 'base') {
    provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
    chainId = 8453;
  } else {
    throw new Error(`Unsupported network: ${network}`);
  }

  // Setup wallet
  const privateKey = process.env.EXECUTION_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('EXECUTION_PRIVATE_KEY or PRIVATE_KEY environment variable not set');
  }
  
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('=== Deployment Configuration ===');
  console.log('Deploying with account:', wallet.address);
  console.log('Account balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');
  console.log('Network:', network);
  console.log('Chain ID:', chainId);

  // Set minProfit based on environment
  const isTestnet = chainId === 84532; // Base Sepolia

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  const minBalance = isTestnet ? ethers.parseEther('0.0001') : ethers.parseEther('0.01');
  if (balance < minBalance) {
    throw new Error(`Insufficient balance: ${ethers.formatEther(balance)} ETH. Need at least ${ethers.formatEther(minBalance)} ETH`);
  }

  const minProfitEth = isTestnet ? '0.001' : '0.005'; // Lower for testnet
  const minProfit = ethers.parseEther(minProfitEth);

  console.log('\n=== Deploying FlashExecutor ===');
  console.log('Min Profit:', minProfitEth, 'ETH');

  // Load contract ABI and bytecode from artifacts
  const artifactPath = path.join(process.cwd(), 'artifacts', 'contracts', 'FlashExecutor.sol', 'FlashExecutor.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('Contract artifact not found. Run "npm run build:contracts" first.');
  }
  
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const contractFactory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  const flashExecutor = await contractFactory.deploy(minProfit, {
    gasLimit: 5000000,
  });

  console.log('Deployment transaction submitted...');

  const deploymentTx = flashExecutor.deploymentTransaction();
  const receipt = await deploymentTx?.wait();
  const gasUsed = receipt?.gasUsed || 0n;

  await flashExecutor.waitForDeployment();

  const contractAddress = await flashExecutor.getAddress();
  const deploymentBlock = await provider.getBlockNumber();
  const owner = await flashExecutor.owner();

  console.log('\n=== Deployment Successful ===');
  console.log('Contract Address:', contractAddress);
  console.log('Deployment Block:', deploymentBlock);
  console.log('Owner:', owner);
  console.log('Gas Used:', gasUsed.toString());

  // Load authorized pools from config
  const poolsToAuthorize = await getAuthorizedPoolsFromConfig(BigInt(chainId));

  console.log(`\n=== Authorizing ${poolsToAuthorize.length} Pools ===`);

  let authorizedCount = 0;
  const failedPools: string[] = [];

  for (const poolAddress of poolsToAuthorize) {
    try {
      console.log(`Authorizing pool: ${poolAddress}...`);
      const tx = await flashExecutor.addAuthorizedPool(poolAddress);
      await tx.wait();
      console.log(` Authorized: ${poolAddress}`);
      authorizedCount++;
    } catch (error) {
      console.error(` Failed to authorize ${poolAddress}:`, error instanceof Error ? error.message : error);
      failedPools.push(poolAddress);
    }
  }

  if (failedPools.length > 0) {
    console.log(`\nWarning: ${failedPools.length} pools failed to authorize`);
    console.log('Failed pools:', failedPools.join(', '));
  }

  const result: DeploymentResult = {
    contractAddress,
    network,
    chainId: chainId.toString(),
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

async function getAuthorizedPoolsFromConfig(_chainId: bigint): Promise<string[]> {
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

// Run if this is the main module
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

export { deployContract, DeploymentResult };
