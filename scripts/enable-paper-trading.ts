/**
 * Enable paper trading mode
 * Updates configuration to simulate execution without real transactions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

function updateConfigYaml(): void {
  const configPath = path.join(process.cwd(), 'config', 'default.yaml');

  if (!fs.existsSync(configPath)) {
    console.error('Error: config/default.yaml not found');
    process.exit(1);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const config = YAML.parse(content);

  console.log('Current configuration:');
  console.log(`  dryRun: ${config.dryRun}`);
  console.log(`  paperTrading: ${config.paperTrading}`);

  // Update to paper trading mode
  config.dryRun = false;
  config.paperTrading = true;

  const updatedContent = YAML.stringify(config);
  fs.writeFileSync(configPath, updatedContent);

  console.log('\nUpdated configuration:');
  console.log('  dryRun: false');
  console.log('  paperTrading: true');
  console.log('\n✓ Paper trading mode enabled');
}

function displayInstructions(): void {
  console.log('\n=== Paper Trading Mode ===');
  console.log('\nWhat is Paper Trading?');
  console.log('  - Bot simulates full execution flow');
  console.log('  - Transactions are built but NOT signed');
  console.log('  - Gas costs and profits are calculated');
  console.log('  - No real funds are risked');
  console.log('\nWhat to Monitor:');
  console.log('  1. Hypothetical P&L');
  console.log('  2. Gas cost estimates');
  console.log('  3. Win rate (profitable vs unprofitable)');
  console.log('  4. Transaction building errors');
  console.log('\nSuccess Criteria:');
  console.log('  - Hypothetical P&L > $50 over 48 hours');
  console.log('  - Win rate > 60%');
  console.log('  - Average profit per trade > $15');
  console.log('  - No transaction building errors');
  console.log('\nNext Steps:');
  console.log('  1. Start the bot: npm run dev');
  console.log('  2. Monitor logs for 48 hours');
  console.log('  3. Review performance metrics');
  console.log('  4. If successful, proceed to micro-live testing');
  console.log('\nTo disable paper trading:');
  console.log('  Edit config/default.yaml and set paperTrading: false');
}

async function main() {
  console.log('=== Enable Paper Trading Mode ===\n');

  try {
    updateConfigYaml();
    displayInstructions();
  } catch (error) {
    console.error('Error enabling paper trading:', error);
    process.exit(1);
  }
}

main();
