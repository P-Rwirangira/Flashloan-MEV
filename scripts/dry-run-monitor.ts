/**
 * Dry-run monitoring script
 * Monitors bot performance during dry-run testing and generates reports
 */

import * as fs from 'fs';
import * as path from 'path';

interface OpportunityLog {
  timestamp: string;
  type: string;
  profit: number;
  gasEstimate: number;
  pools: string[];
  detected: boolean;
  executed: boolean;
  reason?: string;
}

interface DryRunStats {
  startTime: string;
  endTime: string;
  duration: number;
  opportunitiesDetected: number;
  potentiallyProfitable: number;
  rejected: number;
  rejectionReasons: Record<string, number>;
  averageProfit: number;
  maxProfit: number;
  minProfit: number;
  gasEstimateAvg: number;
  uptime: number;
  errors: number;
}

class DryRunMonitor {
  private opportunities: OpportunityLog[] = [];
  private startTime: Date;
  private errors: number = 0;

  constructor() {
    this.startTime = new Date();
  }

  logOpportunity(opportunity: OpportunityLog): void {
    this.opportunities.push(opportunity);
  }

  logError(): void {
    this.errors++;
  }

  generateStats(): DryRunStats {
    const endTime = new Date();
    const duration = (endTime.getTime() - this.startTime.getTime()) / 1000 / 60 / 60; // hours

    const profitable = this.opportunities.filter(o => o.profit > 0 && o.detected);
    const rejected = this.opportunities.filter(o => !o.detected || !o.executed);

    const rejectionReasons: Record<string, number> = {};
    rejected.forEach(o => {
      if (o.reason) {
        rejectionReasons[o.reason] = (rejectionReasons[o.reason] || 0) + 1;
      }
    });

    const profits = profitable.map(o => o.profit);
    const gasEstimates = this.opportunities.map(o => o.gasEstimate).filter(g => g > 0);

    return {
      startTime: this.startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration,
      opportunitiesDetected: this.opportunities.length,
      potentiallyProfitable: profitable.length,
      rejected: rejected.length,
      rejectionReasons,
      averageProfit: profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0,
      maxProfit: profits.length > 0 ? Math.max(...profits) : 0,
      minProfit: profits.length > 0 ? Math.min(...profits) : 0,
      gasEstimateAvg: gasEstimates.length > 0 ? gasEstimates.reduce((a, b) => a + b, 0) / gasEstimates.length : 0,
      uptime: duration,
      errors: this.errors,
    };
  }

  generateReport(): string {
    const stats = this.generateStats();

    const report = [
      '=== Dry-Run Testing Report ===',
      '',
      'Duration:',
      `  Start: ${stats.startTime}`,
      `  End: ${stats.endTime}`,
      `  Total: ${stats.duration.toFixed(2)} hours`,
      '',
      'Opportunities:',
      `  Total Detected: ${stats.opportunitiesDetected}`,
      `  Potentially Profitable: ${stats.potentiallyProfitable}`,
      `  Rejected: ${stats.rejected}`,
      '',
      'Profitability:',
      `  Average Profit: $${stats.averageProfit.toFixed(2)}`,
      `  Max Profit: $${stats.maxProfit.toFixed(2)}`,
      `  Min Profit: $${stats.minProfit.toFixed(2)}`,
      '',
      'Gas Estimates:',
      `  Average Gas Cost: $${stats.gasEstimateAvg.toFixed(4)}`,
      '',
      'Rejection Reasons:',
    ];

    Object.entries(stats.rejectionReasons).forEach(([reason, count]) => {
      report.push(`  ${reason}: ${count}`);
    });

    report.push('');
    report.push('System Health:');
    report.push(`  Uptime: ${stats.uptime.toFixed(2)} hours`);
    report.push(`  Errors: ${stats.errors}`);
    report.push('');

    // Performance assessment
    report.push('Performance Assessment:');

    const profitRate = stats.opportunitiesDetected > 0 
      ? (stats.potentiallyProfitable / stats.opportunitiesDetected * 100).toFixed(1)
      : '0';

    report.push(`  Win Rate: ${profitRate}%`);

    if (parseFloat(profitRate) >= 70) {
      report.push('  Status: EXCELLENT - High detection accuracy');
    } else if (parseFloat(profitRate) >= 50) {
      report.push('  Status: GOOD - Acceptable performance');
    } else if (parseFloat(profitRate) >= 30) {
      report.push('  Status: FAIR - Needs tuning');
    } else {
      report.push('  Status: POOR - Significant optimization needed');
    }

    report.push('');
    report.push('Recommendations:');

    if (stats.averageProfit < 15) {
      report.push('  - Increase minProfitUSD threshold to reduce false positives');
    }

    if (stats.errors > stats.duration * 2) {
      report.push('  - High error rate detected, investigate logs');
    }

    if (stats.opportunitiesDetected < stats.duration * 5) {
      report.push('  - Low opportunity detection, consider lowering profit threshold');
    }

    return report.join('\n');
  }

  saveReport(outputPath: string): void {
    const report = this.generateReport();
    fs.writeFileSync(outputPath, report);
    console.log(`Report saved to: ${outputPath}`);
  }
}

async function monitorDryRun(): Promise<void> {
  console.log('=== Starting Dry-Run Monitor ===');
  console.log('This script will monitor bot logs and generate performance reports');
  console.log('Press Ctrl+C to stop monitoring and generate final report\n');

  const monitor = new DryRunMonitor();
  const logsDir = path.join(process.cwd(), 'logs');

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Simulate monitoring (in real implementation, would tail log files)
  console.log('Monitoring started...');
  console.log('Run the bot with: npm run dev');
  console.log('Logs will be analyzed for opportunity detection\n');

  // Setup graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nGenerating final report...\n');
    
    const report = monitor.generateReport();
    console.log(report);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(logsDir, `dry-run-report-${timestamp}.txt`);
    monitor.saveReport(reportPath);

    console.log('\n Monitoring stopped');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

// Export for testing
export { DryRunMonitor, DryRunStats, OpportunityLog };

if (require.main === module) {
  monitorDryRun();
}
