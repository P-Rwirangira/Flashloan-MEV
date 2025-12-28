/**
 * Metrics Collector
 *
 * Collects and tracks performance metrics for the MEV platform
 * including opportunity rates, win rates, profit tracking, and relay performance
 */

import { EventEmitter } from 'events';
import { RelayProvider } from '../bundler/private-relay';

/**
 * Opportunity metrics
 */
export interface OpportunityMetrics {
  totalOpportunities: number;
  detectedOpportunities: number;
  simulatedOpportunities: number;
  submittedOpportunities: number;
  successfulOpportunities: number;

  // Rates (per hour)
  opportunityRate: number;
  detectionRate: number;
  simulationRate: number;
  submissionRate: number;
  winRate: number;
}

/**
 * Profit metrics
 */
export interface ProfitMetrics {
  totalProfitWei: bigint;
  totalProfitUSD: number;
  averageProfitWei: bigint;
  averageProfitUSD: number;

  totalGasCostWei: bigint;
  totalGasCostUSD: number;
  averageGasCostWei: bigint;
  averageGasCostUSD: number;

  totalBribesWei: bigint;
  totalBribesUSD: number;
  averageBribeWei: bigint;
  averageBribeUSD: number;

  netProfitWei: bigint;
  netProfitUSD: number;
  profitMargin: number; // percentage
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  averageDetectionLatency: number; // ms
  averageSimulationLatency: number; // ms
  averageSubmissionLatency: number; // ms
  averageEndToEndLatency: number; // ms

  p50DetectionLatency: number;
  p95DetectionLatency: number;
  p99DetectionLatency: number;

  p50SubmissionLatency: number;
  p95SubmissionLatency: number;
  p99SubmissionLatency: number;
}

/**
 * Relay metrics
 */
export interface RelayMetrics {
  provider: RelayProvider;
  totalSubmissions: number;
  successfulSubmissions: number;
  failedSubmissions: number;
  inclusionRate: number;
  averageLatency: number;
  averageInclusionTime: number;
  totalBribes: bigint;
  averageBribe: bigint;
}

/**
 * System health metrics
 */
export interface SystemHealthMetrics {
  uptime: number; // seconds
  memoryUsage: number; // MB
  cpuUsage: number; // percentage
  networkLatency: number; // ms
  rpcConnectionHealth: boolean;
  lastSuccessfulOperation: number; // timestamp
  consecutiveFailures: number;
  circuitBreakerStatus: 'closed' | 'open' | 'half-open';
}

/**
 * Metric data point
 */
export interface MetricDataPoint {
  timestamp: number;
  type: 'opportunity' | 'profit' | 'performance' | 'relay' | 'system';
  data: any;
}

/**
 * Time series data
 */
export interface TimeSeriesData {
  timestamps: number[];
  values: number[];
  labels?: string[];
}

/**
 * Metrics Collector class
 */
export class MetricsCollector extends EventEmitter {
  private readonly dataPoints: MetricDataPoint[];
  private readonly startTime: number;

  // Opportunity tracking
  private opportunityCounters = {
    total: 0,
    detected: 0,
    simulated: 0,
    submitted: 0,
    successful: 0,
  };

  // Profit tracking
  private profitData = {
    totalProfitWei: 0n,
    totalGasCostWei: 0n,
    totalBribesWei: 0n,
    transactions: 0,
  };

  // Performance tracking
  private latencyData: {
    detection: number[];
    simulation: number[];
    submission: number[];
    endToEnd: number[];
  } = {
    detection: [],
    simulation: [],
    submission: [],
    endToEnd: [],
  };

  // Relay tracking
  private relayData: Map<
    RelayProvider,
    {
      submissions: number;
      successes: number;
      failures: number;
      latencies: number[];
      inclusionTimes: number[];
      bribes: bigint[];
    }
  > = new Map();

  // System health tracking
  private systemHealth = {
    consecutiveFailures: 0,
    lastSuccessfulOperation: Date.now(),
    circuitBreakerStatus: 'closed' as const,
  };

  constructor() {
    super();

    this.dataPoints = [];
    this.startTime = Date.now();

    // Initialize relay data for all providers
    Object.values(RelayProvider).forEach(provider => {
      this.relayData.set(provider, {
        submissions: 0,
        successes: 0,
        failures: 0,
        latencies: [],
        inclusionTimes: [],
        bribes: [],
      });
    });

    // Start periodic metrics collection
    this.startPeriodicCollection();
  }

  /**
   * Record opportunity detection
   */
  recordOpportunityDetected(): void {
    this.opportunityCounters.total++;
    this.opportunityCounters.detected++;

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'opportunity',
      data: { event: 'detected', count: this.opportunityCounters.detected },
    });

    this.emit('opportunityDetected', this.opportunityCounters);
  }

  /**
   * Record opportunity simulation
   */
  recordOpportunitySimulated(latency: number, profitable: boolean): void {
    this.opportunityCounters.simulated++;
    this.latencyData.simulation.push(latency);

    if (profitable) {
      this.opportunityCounters.submitted++;
    }

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'performance',
      data: { event: 'simulation', latency, profitable },
    });

    this.emit('opportunitySimulated', { latency, profitable });
  }

  /**
   * Record opportunity submission
   */
  recordOpportunitySubmitted(relay: RelayProvider, latency: number, bribe: bigint): void {
    this.latencyData.submission.push(latency);

    const relayStats = this.relayData.get(relay);
    if (relayStats) {
      relayStats.submissions++;
      relayStats.latencies.push(latency);
      relayStats.bribes.push(bribe);
    }

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'relay',
      data: { event: 'submitted', relay, latency, bribe: bribe.toString() },
    });

    this.emit('opportunitySubmitted', { relay, latency, bribe });
  }

  /**
   * Record successful opportunity execution
   */
  recordOpportunitySuccess(
    relay: RelayProvider,
    profit: bigint,
    gasCost: bigint,
    bribe: bigint,
    inclusionTime: number,
    endToEndLatency: number
  ): void {
    this.opportunityCounters.successful++;
    this.systemHealth.consecutiveFailures = 0;
    this.systemHealth.lastSuccessfulOperation = Date.now();

    // Update profit data
    this.profitData.totalProfitWei += profit;
    this.profitData.totalGasCostWei += gasCost;
    this.profitData.totalBribesWei += bribe;
    this.profitData.transactions++;

    // Update performance data
    this.latencyData.endToEnd.push(endToEndLatency);

    // Update relay data
    const relayStats = this.relayData.get(relay);
    if (relayStats) {
      relayStats.successes++;
      relayStats.inclusionTimes.push(inclusionTime);
    }

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'profit',
      data: {
        event: 'success',
        relay,
        profit: profit.toString(),
        gasCost: gasCost.toString(),
        bribe: bribe.toString(),
        inclusionTime,
        endToEndLatency,
      },
    });

    this.emit('opportunitySuccess', {
      relay,
      profit,
      gasCost,
      bribe,
      inclusionTime,
      endToEndLatency,
    });
  }

  /**
   * Record opportunity failure
   */
  recordOpportunityFailure(relay: RelayProvider, reason: string, gasCost?: bigint): void {
    this.systemHealth.consecutiveFailures++;

    if (gasCost) {
      this.profitData.totalGasCostWei += gasCost;
    }

    // Update relay data
    const relayStats = this.relayData.get(relay);
    if (relayStats) {
      relayStats.failures++;
    }

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'opportunity',
      data: {
        event: 'failure',
        relay,
        reason,
        gasCost: gasCost?.toString(),
      },
    });

    this.emit('opportunityFailure', { relay, reason, gasCost });
  }

  /**
   * Get opportunity metrics
   */
  getOpportunityMetrics(): OpportunityMetrics {
    const uptime = (Date.now() - this.startTime) / 1000; // seconds
    const uptimeHours = uptime / 3600;

    return {
      totalOpportunities: this.opportunityCounters.total,
      detectedOpportunities: this.opportunityCounters.detected,
      simulatedOpportunities: this.opportunityCounters.simulated,
      submittedOpportunities: this.opportunityCounters.submitted,
      successfulOpportunities: this.opportunityCounters.successful,

      opportunityRate: uptimeHours > 0 ? this.opportunityCounters.total / uptimeHours : 0,
      detectionRate: uptimeHours > 0 ? this.opportunityCounters.detected / uptimeHours : 0,
      simulationRate: uptimeHours > 0 ? this.opportunityCounters.simulated / uptimeHours : 0,
      submissionRate: uptimeHours > 0 ? this.opportunityCounters.submitted / uptimeHours : 0,
      winRate:
        this.opportunityCounters.submitted > 0
          ? this.opportunityCounters.successful / this.opportunityCounters.submitted
          : 0,
    };
  }

  /**
   * Get profit metrics (simplified USD conversion)
   */
  getProfitMetrics(ethPriceUSD: number = 2000): ProfitMetrics {
    const weiToEth = (wei: bigint) => Number(wei) / 1e18;
    const weiToUSD = (wei: bigint) => weiToEth(wei) * ethPriceUSD;

    const avgProfitWei =
      this.profitData.transactions > 0
        ? this.profitData.totalProfitWei / BigInt(this.profitData.transactions)
        : 0n;

    const avgGasCostWei =
      this.profitData.transactions > 0
        ? this.profitData.totalGasCostWei / BigInt(this.profitData.transactions)
        : 0n;

    const avgBribeWei =
      this.profitData.transactions > 0
        ? this.profitData.totalBribesWei / BigInt(this.profitData.transactions)
        : 0n;

    const netProfitWei =
      this.profitData.totalProfitWei -
      this.profitData.totalGasCostWei -
      this.profitData.totalBribesWei;
    const totalCostWei = this.profitData.totalGasCostWei + this.profitData.totalBribesWei;
    const profitMargin =
      totalCostWei > 0n ? (Number(netProfitWei) / Number(totalCostWei)) * 100 : 0;

    return {
      totalProfitWei: this.profitData.totalProfitWei,
      totalProfitUSD: weiToUSD(this.profitData.totalProfitWei),
      averageProfitWei: avgProfitWei,
      averageProfitUSD: weiToUSD(avgProfitWei),

      totalGasCostWei: this.profitData.totalGasCostWei,
      totalGasCostUSD: weiToUSD(this.profitData.totalGasCostWei),
      averageGasCostWei: avgGasCostWei,
      averageGasCostUSD: weiToUSD(avgGasCostWei),

      totalBribesWei: this.profitData.totalBribesWei,
      totalBribesUSD: weiToUSD(this.profitData.totalBribesWei),
      averageBribeWei: avgBribeWei,
      averageBribeUSD: weiToUSD(avgBribeWei),

      netProfitWei,
      netProfitUSD: weiToUSD(netProfitWei),
      profitMargin,
    };
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const calculateStats = (data: number[]) => {
      if (data.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0 };

      const sorted = [...data].sort((a, b) => a - b);
      const avg = data.reduce((sum, val) => sum + val, 0) / data.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      return { avg, p50, p95, p99 };
    };

    const detectionStats = calculateStats(this.latencyData.detection);
    const simulationStats = calculateStats(this.latencyData.simulation);
    const submissionStats = calculateStats(this.latencyData.submission);
    const endToEndStats = calculateStats(this.latencyData.endToEnd);

    return {
      averageDetectionLatency: detectionStats.avg,
      averageSimulationLatency: simulationStats.avg,
      averageSubmissionLatency: submissionStats.avg,
      averageEndToEndLatency: endToEndStats.avg,

      p50DetectionLatency: detectionStats.p50,
      p95DetectionLatency: detectionStats.p95,
      p99DetectionLatency: detectionStats.p99,

      p50SubmissionLatency: submissionStats.p50,
      p95SubmissionLatency: submissionStats.p95,
      p99SubmissionLatency: submissionStats.p99,
    };
  }

  /**
   * Get relay metrics
   */
  getRelayMetrics(): RelayMetrics[] {
    return Array.from(this.relayData.entries()).map(([provider, data]) => {
      const inclusionRate = data.submissions > 0 ? data.successes / data.submissions : 0;
      const averageLatency =
        data.latencies.length > 0
          ? data.latencies.reduce((sum, val) => sum + val, 0) / data.latencies.length
          : 0;
      const averageInclusionTime =
        data.inclusionTimes.length > 0
          ? data.inclusionTimes.reduce((sum, val) => sum + val, 0) / data.inclusionTimes.length
          : 0;
      const totalBribes = data.bribes.reduce((sum, val) => sum + val, 0n);
      const averageBribe = data.bribes.length > 0 ? totalBribes / BigInt(data.bribes.length) : 0n;

      return {
        provider,
        totalSubmissions: data.submissions,
        successfulSubmissions: data.successes,
        failedSubmissions: data.failures,
        inclusionRate,
        averageLatency,
        averageInclusionTime,
        totalBribes,
        averageBribe,
      };
    });
  }

  /**
   * Get system health metrics
   */
  getSystemHealthMetrics(): SystemHealthMetrics {
    const uptime = (Date.now() - this.startTime) / 1000;

    // Simplified system metrics (in production, would use actual system monitoring)
    const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB
    const cpuUsage = 0; // Would use actual CPU monitoring
    const networkLatency = 50; // Would measure actual network latency
    const rpcConnectionHealth = true; // Would check actual RPC health

    return {
      uptime,
      memoryUsage,
      cpuUsage,
      networkLatency,
      rpcConnectionHealth,
      lastSuccessfulOperation: this.systemHealth.lastSuccessfulOperation,
      consecutiveFailures: this.systemHealth.consecutiveFailures,
      circuitBreakerStatus: this.systemHealth.circuitBreakerStatus,
    };
  }

  /**
   * Get time series data for a specific metric
   */
  getTimeSeriesData(
    metricType: 'opportunity' | 'profit' | 'performance' | 'relay',
    timeRange: number = 3600000 // 1 hour in ms
  ): TimeSeriesData {
    const cutoff = Date.now() - timeRange;
    const relevantPoints = this.dataPoints.filter(
      point => point.timestamp >= cutoff && point.type === metricType
    );

    const timestamps = relevantPoints.map(point => point.timestamp);
    const values = relevantPoints.map(point => {
      // Extract numeric value based on metric type
      switch (metricType) {
        case 'opportunity':
          return point.data.count || 1;
        case 'profit':
          return parseFloat(point.data.profit) || 0;
        case 'performance':
          return point.data.latency || 0;
        case 'relay':
          return point.data.latency || 0;
        default:
          return 0;
      }
    });

    return { timestamps, values };
  }

  /**
   * Update circuit breaker status
   */
  updateCircuitBreakerStatus(status: 'closed' | 'open' | 'half-open'): void {
    this.systemHealth.circuitBreakerStatus = status;

    this.addDataPoint({
      timestamp: Date.now(),
      type: 'system',
      data: { event: 'circuit_breaker', status },
    });

    this.emit('circuitBreakerStatusChanged', status);
  }

  /**
   * Add data point to time series
   */
  private addDataPoint(dataPoint: MetricDataPoint): void {
    this.dataPoints.push(dataPoint);

    // Keep only last 10,000 data points to prevent memory bloat
    if (this.dataPoints.length > 10000) {
      this.dataPoints.splice(0, this.dataPoints.length - 10000);
    }
  }

  /**
   * Start periodic metrics collection
   */
  private startPeriodicCollection(): void {
    // Emit metrics summary every minute
    setInterval(() => {
      const summary = {
        opportunity: this.getOpportunityMetrics(),
        profit: this.getProfitMetrics(),
        performance: this.getPerformanceMetrics(),
        system: this.getSystemHealthMetrics(),
      };

      this.emit('metricsUpdate', summary);
    }, 60000); // 1 minute
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.opportunityCounters = {
      total: 0,
      detected: 0,
      simulated: 0,
      submitted: 0,
      successful: 0,
    };

    this.profitData = {
      totalProfitWei: 0n,
      totalGasCostWei: 0n,
      totalBribesWei: 0n,
      transactions: 0,
    };

    this.latencyData = {
      detection: [],
      simulation: [],
      submission: [],
      endToEnd: [],
    };

    this.relayData.clear();
    Object.values(RelayProvider).forEach(provider => {
      this.relayData.set(provider, {
        submissions: 0,
        successes: 0,
        failures: 0,
        latencies: [],
        inclusionTimes: [],
        bribes: [],
      });
    });

    this.systemHealth = {
      consecutiveFailures: 0,
      lastSuccessfulOperation: Date.now(),
      circuitBreakerStatus: 'closed',
    };

    this.dataPoints.length = 0;

    this.emit('metricsReset');
  }

  /**
   * Export metrics data
   */
  exportMetrics(): {
    opportunity: OpportunityMetrics;
    profit: ProfitMetrics;
    performance: PerformanceMetrics;
    relays: RelayMetrics[];
    system: SystemHealthMetrics;
    timeSeries: {
      opportunity: TimeSeriesData;
      profit: TimeSeriesData;
      performance: TimeSeriesData;
    };
  } {
    return {
      opportunity: this.getOpportunityMetrics(),
      profit: this.getProfitMetrics(),
      performance: this.getPerformanceMetrics(),
      relays: this.getRelayMetrics(),
      system: this.getSystemHealthMetrics(),
      timeSeries: {
        opportunity: this.getTimeSeriesData('opportunity'),
        profit: this.getTimeSeriesData('profit'),
        performance: this.getTimeSeriesData('performance'),
      },
    };
  }
}
