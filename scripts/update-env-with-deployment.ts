/**
 * Update environment files with deployed contract address
 */

import * as fs from 'fs';
import * as path from 'path';

interface UpdateOptions {
  contractAddress: string;
  network: string;
  chainId: string;
}

function updateEnvFile(options: UpdateOptions): void {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.log('Creating new .env file...');
    const examplePath = path.join(process.cwd(), '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
    } else {
      fs.writeFileSync(envPath, '');
    }
  }

  let envContent = fs.readFileSync(envPath, 'utf8');

  // Update or add FLASH_EXECUTOR_ADDRESS
  if (envContent.includes('FLASH_EXECUTOR_ADDRESS=')) {
    envContent = envContent.replace(
      /FLASH_EXECUTOR_ADDRESS=.*/,
      `FLASH_EXECUTOR_ADDRESS=${options.contractAddress}`
    );
  } else {
    envContent += `\n# Deployed Contract Address (${options.network})\n`;
    envContent += `FLASH_EXECUTOR_ADDRESS=${options.contractAddress}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(` Updated .env with contract address`);
}

function updateEnvExample(options: UpdateOptions): void {
  const envExamplePath = path.join(process.cwd(), '.env.example');

  if (!fs.existsSync(envExamplePath)) {
    console.log('Warning: .env.example not found, skipping');
    return;
  }

  let envContent = fs.readFileSync(envExamplePath, 'utf8');

  // Add comment with deployment info
  const deploymentComment = `# FlashExecutor deployed on ${options.network} (Chain ID: ${options.chainId})`;

  if (envContent.includes('FLASH_EXECUTOR_ADDRESS=')) {
    envContent = envContent.replace(
      /# FlashExecutor.*/,
      deploymentComment
    );
  } else if (envContent.includes('FLASH_EXECUTOR_ADDRESS')) {
    envContent = envContent.replace(
      /FLASH_EXECUTOR_ADDRESS.*/,
      `${deploymentComment}\nFLASH_EXECUTOR_ADDRESS=`
    );
  }

  fs.writeFileSync(envExamplePath, envContent);
  console.log(` Updated .env.example with deployment info`);
}

function createDeploymentRecord(options: UpdateOptions): void {
  const deploymentsDir = path.join(process.cwd(), 'deployments');

  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const record = {
    contractAddress: options.contractAddress,
    network: options.network,
    chainId: options.chainId,
    deploymentTime: new Date().toISOString(),
  };

  const filename = `${options.network}-${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
  console.log(` Created deployment record: ${filename}`);
}

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS || process.argv[2];
  const network = process.env.NETWORK || process.argv[3] || 'unknown';
  const chainId = process.env.CHAIN_ID || process.argv[4] || '0';

  if (!contractAddress) {
    console.error('Error: CONTRACT_ADDRESS not provided');
    console.log('Usage: npm run deploy:update-env <contract_address> [network] [chainId]');
    console.log('   or: CONTRACT_ADDRESS=0x... npm run deploy:update-env');
    process.exit(1);
  }

  if (!contractAddress.startsWith('0x') || contractAddress.length !== 42) {
    console.error('Error: Invalid contract address format');
    process.exit(1);
  }

  console.log('=== Updating Environment Files ===');
  console.log('Contract Address:', contractAddress);
  console.log('Network:', network);
  console.log('Chain ID:', chainId);
  console.log('');

  const options: UpdateOptions = {
    contractAddress,
    network,
    chainId,
  };

  updateEnvFile(options);
  updateEnvExample(options);
  createDeploymentRecord(options);

  console.log('\n Environment files updated successfully');
  console.log('\nNext steps:');
  console.log('1. Verify the deployment: npm run deploy:test');
  console.log('2. Test relay connectivity: npm run test:relay');
  console.log('3. Start dry-run: npm run dev');
}

main();
