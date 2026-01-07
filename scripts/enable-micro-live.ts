/**
 * Enable micro-live trading mode with safety limits
 * Configures bot for live trading with small position sizes
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

interface SafetyLimits {
  maxPositionSize: number;
  minProfitUSD: number;
  maxGasPriceGwei: number;
  maxSlippageBps: number;
  circuitBreakerThreshold: number;
  maxDailyLossUSD: number;
}

function updateConfigYaml(limits: SafetyLimits): void {
  const configPath = path.join(process.cwd(), 'config', 'default.yaml');

  if (!fs.existsSync(configPath)) {
    console.error('Error: config/default.yaml not found');
    process.exit(1);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const config = YAML.parse(content);

  // Disable safety modes
  config.dryRun = false;
  config.paperTrading = false;

  // Apply safety limits
  if (config.strategies?.arbitrage) {
    config.strategies.arbitrage.maxPositionSize = limits.maxPositionSize;
    config.strategies.arbitrage.minProfitUSD = limits.minProfitUSD;
    config.strategies.arbitrage.maxGasPriceGwei = limits.maxGasPriceGwei;
    config.strategies.arbitrage.maxSlippageBps = limits.maxSlippageBps;
  }

  if (config.risk?.circuitBreaker) {
    config.risk.circuitBreaker.failureThreshold = limits.circuitBreakerThreshold;
    config.risk.circuitBreaker.maxDailyLossUSD = limits.maxDailyLossUSD;
  }

  const updatedContent = YAML.stringify(config);
  fs.writeFileSync(configPath, updatedContent);

  console.log('\n Configuration updated with safety limits');
}

function displayConfiguration(limits: SafetyLimits): void {
  console.log('\n=== Micro-Live Trading Configuration ===');
  console.log('\nSafety Limits:');
  console.log(`  Max Position Size: $${limits.maxPositionSize}`);
  console.log(`  Min Profit: $${limits.minProfitUSD}`);
  console.log(`  Max Gas Price: ${limits.maxGasPriceGwei} Gwei`);
  console.log(`  Max Slippage: ${(limits.maxSlippageBps / 100).toFixed(2)}%`);
  console.log(`  Circuit Breaker: ${limits.circuitBreakerThreshold} failures`);
  console.log(`  Max Daily Loss: $${limits.maxDailyLossUSD}`);
}

function displayWarnings(): void {
  console.log('\n=== IMPORTANT WARNINGS ===');
  console.log('\n Real Funds at Risk:');
  console.log('  - This enables LIVE TRADING with REAL money');
  console.log('  - Failed trades will cost gas (approx $0.10-0.50 each)');
  console.log('  - Always possible to lose money due to MEV competition');
  console.log('\n What to Monitor:');
  console.log('  1. WATCH THE FIRST 10 TRADES MANUALLY');
  console.log('  2. Verify each transaction on BaseScan');
  console.log('  3. Check actual profit matches predicted');
  console.log('  4. Monitor gas costs');
  console.log('  5. Watch for circuit breaker activations');
  console.log('\n  Stop Immediately If:');
  console.log('  - Win rate < 40% after 10 trades');
  console.log('  - Actual profit significantly lower than predicted');
  console.log('  - Gas costs exceeding estimates');
  console.log('  - Multiple failed transactions');
  console.log('\n🛑 Emergency Stop:');
  console.log('  1. Stop the bot: Ctrl+C');
  console.log('  2. Edit config/default.yaml');
  console.log('  3. Set: dryRun: true');
  console.log('  4. Investigate logs before restarting');
}

function displayPreFlightChecklist(): void {
  console.log('\n=== Pre-Flight Checklist ===');
  console.log('\nBefore enabling live trading, verify:');
  console.log('  [ ] Contract deployed and tested');
  console.log('  [ ] Private relays configured (bloXroute/Flashbots)');
  console.log('  [ ] Wallet funded with 0.1-0.5 ETH only');
  console.log('  [ ] 24h+ dry-run testing completed');
  console.log('  [ ] 48h+ paper trading completed');
  console.log('  [ ] Paper trading showed positive P&L');
  console.log('  [ ] Win rate > 60% in paper trading');
  console.log('  [ ] Understanding of risk management');
  console.log('  [ ] Emergency stop procedure understood');
}

async function confirmLiveTrading(): Promise<boolean> {
  console.log('\n=== FINAL CONFIRMATION ===');
  console.log('\nYou are about to enable LIVE TRADING with REAL funds.');
  console.log('This action cannot be undone automatically.');
  console.log('\nType "I UNDERSTAND THE RISKS" to proceed:');

  const confirmation = await question('> ');

  return confirmation.trim() === 'I UNDERSTAND THE RISKS';
}

async function main() {
  console.log('=== Enable Micro-Live Trading Mode ===\n');

  displayPreFlightChecklist();

  const proceed = await question('\nHave you completed all checklist items? (yes/no): ');

  if (proceed.toLowerCase() !== 'yes') {
    console.log('\nPlease complete all checklist items before enabling live trading.');
    rl.close();
    return;
  }

  // Configure safety limits
  const limits: SafetyLimits = {
    maxPositionSize: 100, // $100
    minProfitUSD: 20.0,
    maxGasPriceGwei: 0.1,
    maxSlippageBps: 100,
    circuitBreakerThreshold: 3,
    maxDailyLossUSD: 50,
  };

  console.log('\n=== Recommended Safety Limits (Conservative) ===');
  displayConfiguration(limits);

  const customize = await question('\nCustomize limits? (y/n): ');

  if (customize.toLowerCase() === 'y') {
    const maxPos = await question(`Max Position Size ($) [${limits.maxPositionSize}]: `);
    if (maxPos.trim()) limits.maxPositionSize = parseFloat(maxPos);

    const minProfit = await question(`Min Profit ($) [${limits.minProfitUSD}]: `);
    if (minProfit.trim()) limits.minProfitUSD = parseFloat(minProfit);

    const maxLoss = await question(`Max Daily Loss ($) [${limits.maxDailyLossUSD}]: `);
    if (maxLoss.trim()) limits.maxDailyLossUSD = parseFloat(maxLoss);
  }

  displayConfiguration(limits);
  displayWarnings();

  const confirmed = await confirmLiveTrading();

  if (!confirmed) {
    console.log('\nLive trading NOT enabled. Configuration unchanged.');
    rl.close();
    return;
  }

  try {
    updateConfigYaml(limits);

    console.log('\n=== Live Trading Enabled ===');
    console.log('\n Ready to start:');
    console.log('   npm run start');
    console.log('\n Monitor health:');
    console.log('   curl http://localhost:3002/health');
    console.log('\n Watch logs:');
    console.log('   tail -f logs/*.log');
    console.log('\n  STAY VIGILANT FOR THE FIRST 10 TRADES!');

    rl.close();
  } catch (error) {
    console.error('\nError enabling live trading:', error);
    rl.close();
    process.exit(1);
  }
}

main();
