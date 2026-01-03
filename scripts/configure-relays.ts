/**
 * Configure and test private relay connections
 * Sets up bloXroute and Flashbots relay configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ethers } from 'ethers';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

interface RelayConfig {
  bloxrouteApiKey?: string;
  flashbotsAuthKey?: string;
  flashbotsProtectUrl?: string;
}

async function testBloXrouteConnection(apiKey: string): Promise<boolean> {
  try {
    console.log('Testing bloXroute connection...');

    const provider = new ethers.JsonRpcProvider('https://base.bdn.blxrbdn.com', undefined, {
      staticNetwork: true,
    });

    // Add authorization header
    (provider as any).headers = { Authorization: apiKey };

    const blockNumber = await provider.getBlockNumber();
    console.log('✓ bloXroute connected successfully');
    console.log('  Current block:', blockNumber);
    return true;
  } catch (error) {
    console.error('✗ bloXroute connection failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function testFlashbotsConnection(): Promise<boolean> {
  try {
    console.log('Testing Flashbots Protect connection...');

    const provider = new ethers.JsonRpcProvider('https://rpc.flashbots.net');
    const blockNumber = await provider.getBlockNumber();

    console.log('✓ Flashbots Protect connected successfully');
    console.log('  Current block:', blockNumber);
    return true;
  } catch (error) {
    console.error('✗ Flashbots connection failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function configureRelays(): Promise<RelayConfig> {
  console.log('=== Private Relay Configuration ===\n');

  const config: RelayConfig = {};

  // Configure bloXroute
  console.log('1. bloXroute Configuration');
  console.log('   bloXroute provides MEV protection via their BDN network');
  console.log('   Get API key from: https://portal.blxrbdn.com/');

  const configureBloxroute = await question('\n   Configure bloXroute? (y/n): ');

  if (configureBloxroute.toLowerCase() === 'y') {
    const apiKey = await question('   Enter bloXroute API key: ');
    config.bloxrouteApiKey = apiKey.trim();

    if (config.bloxrouteApiKey) {
      const testConnection = await question('   Test connection now? (y/n): ');
      if (testConnection.toLowerCase() === 'y') {
        await testBloXrouteConnection(config.bloxrouteApiKey);
      }
    }
  }

  // Configure Flashbots
  console.log('\n2. Flashbots Protect Configuration');
  console.log('   Flashbots Protect is free and works without authentication');

  const configureFlashbots = await question('   Configure Flashbots Protect? (y/n): ');

  if (configureFlashbots.toLowerCase() === 'y') {
    config.flashbotsProtectUrl = 'https://rpc.flashbots.net';

    const useAuthKey = await question('   Use authentication key? (optional, y/n): ');
    if (useAuthKey.toLowerCase() === 'y') {
      const authKey = await question('   Enter Flashbots auth private key (or leave empty to generate): ');
      if (authKey.trim()) {
        config.flashbotsAuthKey = authKey.trim();
      } else {
        const wallet = ethers.Wallet.createRandom();
        config.flashbotsAuthKey = wallet.privateKey;
        console.log('   Generated new auth key:', wallet.privateKey);
        console.log('   Address:', wallet.address);
      }
    }

    const testConnection = await question('   Test connection now? (y/n): ');
    if (testConnection.toLowerCase() === 'y') {
      await testFlashbotsConnection();
    }
  }

  return config;
}

function updateEnvFile(config: RelayConfig): void {
  const envPath = path.join(process.cwd(), '.env');

  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  } else {
    const examplePath = path.join(process.cwd(), '.env.example');
    if (fs.existsSync(examplePath)) {
      envContent = fs.readFileSync(examplePath, 'utf8');
    }
  }

  // Update bloXroute API key
  if (config.bloxrouteApiKey) {
    if (envContent.includes('BLOXROUTE_API_KEY=')) {
      envContent = envContent.replace(
        /BLOXROUTE_API_KEY=.*/,
        `BLOXROUTE_API_KEY=${config.bloxrouteApiKey}`
      );
    } else {
      envContent += `\n# Private Relay Configuration\n`;
      envContent += `BLOXROUTE_API_KEY=${config.bloxrouteApiKey}\n`;
    }
  }

  // Update Flashbots config
  if (config.flashbotsProtectUrl) {
    if (envContent.includes('FLASHBOTS_PROTECT_URL=')) {
      envContent = envContent.replace(
        /FLASHBOTS_PROTECT_URL=.*/,
        `FLASHBOTS_PROTECT_URL=${config.flashbotsProtectUrl}`
      );
    } else {
      envContent += `FLASHBOTS_PROTECT_URL=${config.flashbotsProtectUrl}\n`;
    }
  }

  if (config.flashbotsAuthKey) {
    if (envContent.includes('FLASHBOTS_AUTH_KEY=')) {
      envContent = envContent.replace(
        /FLASHBOTS_AUTH_KEY=.*/,
        `FLASHBOTS_AUTH_KEY=${config.flashbotsAuthKey}`
      );
    } else {
      envContent += `FLASHBOTS_AUTH_KEY=${config.flashbotsAuthKey}\n`;
    }
  }

  fs.writeFileSync(envPath, envContent);
  console.log('\n✓ Updated .env with relay configuration');
}

async function main() {
  try {
    const config = await configureRelays();

    console.log('\n=== Configuration Summary ===');
    console.log('bloXroute:', config.bloxrouteApiKey ? 'Configured' : 'Not configured');
    console.log('Flashbots Protect:', config.flashbotsProtectUrl ? 'Configured' : 'Not configured');
    console.log('Flashbots Auth:', config.flashbotsAuthKey ? 'Configured' : 'Not configured');

    const save = await question('\nSave configuration to .env? (y/n): ');

    if (save.toLowerCase() === 'y') {
      updateEnvFile(config);

      console.log('\n=== Next Steps ===');
      console.log('1. Test all relay connections: npm run test:relay');
      console.log('2. Start dry-run testing: npm run dev');
      console.log('\n⚠️  Important: Never commit .env file to version control!');
    } else {
      console.log('\nConfiguration not saved.');
    }

    rl.close();
  } catch (error) {
    console.error('Error during configuration:', error);
    rl.close();
    process.exit(1);
  }
}

main();
