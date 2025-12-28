/**
 * Alerting System
 *
 * Monitors system metrics and triggers alerts when thresholds are breached
 * Supports multiple alert channels and severity levels
 */

import { EventEmitter } from 'events';
import {
  MetricsCollector,
  OpportunityMetrics,
  PerformanceMetrics,
  SystemHealthMetrics,
} from './metrics-collector';

/**
 * Alert severity levels
 */
export enum AlertSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Alert types
 */
export enum AlertType {
  CONSECUTIVE_REVERTS = 'consecutive_reverts',
  LATENCY_SLO_BREACH = 'latency_slo_breach',
  LOW_WIN_RATE = 'low_win_rate',
  HIGH_GAS_COSTS = 'high_gas_costs',
  RPC_CONNECTION_FAILURE = 'rpc_connection_failure',
  MEMORY_USAGE_HIGH = 'memory_usage_high',
  CIRCUIT_BREAKER_TRIGGERED = 'circuit_breaker_triggered',
  PROFIT_MARGIN_LOW = 'profit_margin_low',
  RELAY_FAILURE_RATE_HIGH = 'relay_failure_rate_high',
}

/**
 * Alert configuration
 */
export interface AlertConfig {
  type: AlertType;
  enabled: boolean;
  severity: AlertSeverity;
  threshold: number;
  timeWindow: number; // ms
  cooldown: number; // ms
  description: string;
}

/**
 * Alert instance
 */
export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  data?: any;
  acknowledged: boolean;
  resolved: boolean;
}

/**
 * Alert channel interface
 */
export interface AlertChannel {
  name: string;
  enabled: boolean;
  sendAlert(alert: Alert): Promise<boolean>;
}

/**
 * Console alert channel
 */
export class ConsoleAlertChannel implements AlertChannel {
  name = 'console';
  enabled = true;

  async sendAlert(alert: Alert): Promise<boolean> {
    const timestamp = new Date(alert.timestamp).toISOString();
    const severityColor = this.getSeverityColor(alert.severity);

    console.log(
      `${severityColor}[${alert.severity.toUpperCase()}] ${timestamp} - ${alert.type}: ${alert.message}\x1b[0m`
    );

    if (alert.data) {
      console.log('Alert data:', JSON.stringify(alert.data, null, 2));
    }

    return true;
  }

  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.INFO:
        return '\x1b[36m'; // Cyan
      case AlertSeverity.WARNING:
        return '\x1b[33m'; // Yellow
      case AlertSeverity.ERROR:
        return '\x1b[31m'; // Red
      case AlertSeverity.CRITICAL:
        return '\x1b[35m'; // Magenta
      default:
        return '\x1b[0m'; // Reset
    }
  }
}

/**
 * Webhook alert channel
 */
export class WebhookAlertChannel implements AlertChannel {
  name = 'webhook';
  enabled: boolean;
  private readonly webhookUrl: string;

  constructor(webhookUrl: string, enabled: boolean = true) {
    this.webhookUrl = webhookUrl;
    this.enabled = enabled;
  }

  async sendAlert(alert: Alert): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const payload = {
        alert_id: alert.id,
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        timestamp: alert.timestamp,
        data: alert.data,
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      return response.ok;
    } catch (error) {
      console.error('Failed to send webhook alert:', error);
      return false;
    }
  }
}

/**
 * Alerting System class
 */
export class AlertingSystem extends EventEmitter {
  private readonly metricsCollector: MetricsCollector;
  private readonly alertConfigs: Map<AlertType, AlertConfig>;
  private readonly alertChannels: AlertChannel[];
  private readonly activeAlerts: Map<string, Alert>;
  private readonly alertHistory: Alert[];
  private readonly lastAlertTimes: Map<AlertType, number>;

  private monitoringInterval: NodeJS.Timeout | undefined;

  constructor(metricsCollector: MetricsCollector) {
    super();

    this.metricsCollector = metricsCollector;
    this.alertConfigs = new Map();
    this.alertChannels = [];
    this.activeAlerts = new Map();
    this.alertHistory = [];
    this.lastAlertTimes = new Map();

    // Initialize default alert configurations
    this.initializeDefaultConfigs();

    // Add default console channel
    this.addChannel(new ConsoleAlertChannel());

    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Initialize default alert configurations
   */
  private initializeDefaultConfigs(): void {
    const defaultConfigs: AlertConfig[] = [
      {
        type: AlertType.CONSECUTIVE_REVERTS,
        enabled: true,
        severity: AlertSeverity.ERROR,
        threshold: 5,
        timeWindow: 300000, // 5 minutes
        cooldown: 600000, // 10 minutes
        description: 'Multiple consecutive transaction reverts detected',
      },
      {
        type: AlertType.LATENCY_SLO_BREACH,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 300, // 300ms
        timeWindow: 300000, // 5 minutes
        cooldown: 300000, // 5 minutes
        description: 'Latency SLO breach detected',
      },
      {
        type: AlertType.LOW_WIN_RATE,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 0.3, // 30%
        timeWindow: 1800000, // 30 minutes
        cooldown: 600000, // 10 minutes
        description: 'Win rate below acceptable threshold',
      },
      {
        type: AlertType.HIGH_GAS_COSTS,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 0.01, // 0.01 ETH
        timeWindow: 600000, // 10 minutes
        cooldown: 300000, // 5 minutes
        description: 'Average gas costs are unusually high',
      },
      {
        type: AlertType.RPC_CONNECTION_FAILURE,
        enabled: true,
        severity: AlertSeverity.CRITICAL,
        threshold: 1,
        timeWindow: 60000, // 1 minute
        cooldown: 300000, // 5 minutes
        description: 'RPC connection failure detected',
      },
      {
        type: AlertType.MEMORY_USAGE_HIGH,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 1024, // 1GB
        timeWindow: 300000, // 5 minutes
        cooldown: 600000, // 10 minutes
        description: 'Memory usage is high',
      },
      {
        type: AlertType.CIRCUIT_BREAKER_TRIGGERED,
        enabled: true,
        severity: AlertSeverity.CRITICAL,
        threshold: 1,
        timeWindow: 0, // Immediate
        cooldown: 0, // No cooldown
        description: 'Circuit breaker has been triggered',
      },
      {
        type: AlertType.PROFIT_MARGIN_LOW,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 10, // 10%
        timeWindow: 1800000, // 30 minutes
        cooldown: 600000, // 10 minutes
        description: 'Profit margin is below acceptable threshold',
      },
      {
        type: AlertType.RELAY_FAILURE_RATE_HIGH,
        enabled: true,
        severity: AlertSeverity.ERROR,
        threshold: 0.5, // 50%
        timeWindow: 600000, // 10 minutes
        cooldown: 300000, // 5 minutes
        description: 'Relay failure rate is high',
      },
    ];

    defaultConfigs.forEach(config => {
      this.alertConfigs.set(config.type, config);
    });
  }

  /**
   * Add alert channel
   */
  addChannel(channel: AlertChannel): void {
    this.alertChannels.push(channel);
    this.emit('channelAdded', channel.name);
  }

  /**
   * Remove alert channel
   */
  removeChannel(channelName: string): boolean {
    const index = this.alertChannels.findIndex(channel => channel.name === channelName);
    if (index !== -1) {
      this.alertChannels.splice(index, 1);
      this.emit('channelRemoved', channelName);
      return true;
    }
    return false;
  }

  /**
   * Update alert configuration
   */
  updateAlertConfig(type: AlertType, config: Partial<AlertConfig>): void {
    const existingConfig = this.alertConfigs.get(type);
    if (existingConfig) {
      this.alertConfigs.set(type, { ...existingConfig, ...config });
      this.emit('configUpdated', type, config);
    }
  }

  /**
   * Start monitoring system
   */
  private startMonitoring(): void {
    // Check metrics every 30 seconds
    this.monitoringInterval = setInterval(() => {
      this.checkMetrics();
    }, 30000);
  }

  /**
   * Stop monitoring system
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * Check all metrics for alert conditions
   */
  private checkMetrics(): void {
    const opportunityMetrics = this.metricsCollector.getOpportunityMetrics();
    const performanceMetrics = this.metricsCollector.getPerformanceMetrics();
    const systemMetrics = this.metricsCollector.getSystemHealthMetrics();
    const profitMetrics = this.metricsCollector.getProfitMetrics();
    const relayMetrics = this.metricsCollector.getRelayMetrics();

    // Check consecutive reverts
    this.checkConsecutiveReverts(systemMetrics);

    // Check latency SLO breaches
    this.checkLatencySLO(performanceMetrics);

    // Check win rate
    this.checkWinRate(opportunityMetrics);

    // Check gas costs
    this.checkGasCosts(profitMetrics);

    // Check RPC connection
    this.checkRPCConnection(systemMetrics);

    // Check memory usage
    this.checkMemoryUsage(systemMetrics);

    // Check profit margin
    this.checkProfitMargin(profitMetrics);

    // Check relay failure rates
    this.checkRelayFailureRates(relayMetrics);
  }

  /**
   * Check consecutive reverts
   */
  private checkConsecutiveReverts(systemMetrics: SystemHealthMetrics): void {
    const config = this.alertConfigs.get(AlertType.CONSECUTIVE_REVERTS);
    if (!config || !config.enabled) return;

    if (systemMetrics.consecutiveFailures >= config.threshold) {
      this.triggerAlert(AlertType.CONSECUTIVE_REVERTS, {
        message: `${systemMetrics.consecutiveFailures} consecutive transaction failures detected`,
        data: { consecutiveFailures: systemMetrics.consecutiveFailures },
      });
    }
  }

  /**
   * Check latency SLO breaches
   */
  private checkLatencySLO(performanceMetrics: PerformanceMetrics): void {
    const config = this.alertConfigs.get(AlertType.LATENCY_SLO_BREACH);
    if (!config || !config.enabled) return;

    const p95Latency = performanceMetrics.p95SubmissionLatency;
    if (p95Latency > config.threshold) {
      this.triggerAlert(AlertType.LATENCY_SLO_BREACH, {
        message: `P95 submission latency (${p95Latency}ms) exceeds SLO threshold (${config.threshold}ms)`,
        data: { p95Latency, threshold: config.threshold },
      });
    }
  }

  /**
   * Check win rate
   */
  private checkWinRate(opportunityMetrics: OpportunityMetrics): void {
    const config = this.alertConfigs.get(AlertType.LOW_WIN_RATE);
    if (!config || !config.enabled) return;

    if (
      opportunityMetrics.winRate < config.threshold &&
      opportunityMetrics.submittedOpportunities > 10
    ) {
      this.triggerAlert(AlertType.LOW_WIN_RATE, {
        message: `Win rate (${(opportunityMetrics.winRate * 100).toFixed(1)}%) is below threshold (${(config.threshold * 100).toFixed(1)}%)`,
        data: { winRate: opportunityMetrics.winRate, threshold: config.threshold },
      });
    }
  }

  /**
   * Check gas costs
   */
  private checkGasCosts(profitMetrics: any): void {
    const config = this.alertConfigs.get(AlertType.HIGH_GAS_COSTS);
    if (!config || !config.enabled) return;

    const avgGasCostEth = Number(profitMetrics.averageGasCostWei) / 1e18;
    if (avgGasCostEth > config.threshold) {
      this.triggerAlert(AlertType.HIGH_GAS_COSTS, {
        message: `Average gas cost (${avgGasCostEth.toFixed(4)} ETH) exceeds threshold (${config.threshold} ETH)`,
        data: { avgGasCostEth, threshold: config.threshold },
      });
    }
  }

  /**
   * Check RPC connection
   */
  private checkRPCConnection(systemMetrics: SystemHealthMetrics): void {
    const config = this.alertConfigs.get(AlertType.RPC_CONNECTION_FAILURE);
    if (!config || !config.enabled) return;

    if (!systemMetrics.rpcConnectionHealth) {
      this.triggerAlert(AlertType.RPC_CONNECTION_FAILURE, {
        message: 'RPC connection failure detected',
        data: { rpcConnectionHealth: systemMetrics.rpcConnectionHealth },
      });
    }
  }

  /**
   * Check memory usage
   */
  private checkMemoryUsage(systemMetrics: SystemHealthMetrics): void {
    const config = this.alertConfigs.get(AlertType.MEMORY_USAGE_HIGH);
    if (!config || !config.enabled) return;

    if (systemMetrics.memoryUsage > config.threshold) {
      this.triggerAlert(AlertType.MEMORY_USAGE_HIGH, {
        message: `Memory usage (${systemMetrics.memoryUsage.toFixed(1)} MB) exceeds threshold (${config.threshold} MB)`,
        data: { memoryUsage: systemMetrics.memoryUsage, threshold: config.threshold },
      });
    }
  }

  /**
   * Check profit margin
   */
  private checkProfitMargin(profitMetrics: any): void {
    const config = this.alertConfigs.get(AlertType.PROFIT_MARGIN_LOW);
    if (!config || !config.enabled) return;

    if (profitMetrics.profitMargin < config.threshold && profitMetrics.netProfitWei !== 0n) {
      this.triggerAlert(AlertType.PROFIT_MARGIN_LOW, {
        message: `Profit margin (${profitMetrics.profitMargin.toFixed(1)}%) is below threshold (${config.threshold}%)`,
        data: { profitMargin: profitMetrics.profitMargin, threshold: config.threshold },
      });
    }
  }

  /**
   * Check relay failure rates
   */
  private checkRelayFailureRates(relayMetrics: any[]): void {
    const config = this.alertConfigs.get(AlertType.RELAY_FAILURE_RATE_HIGH);
    if (!config || !config.enabled) return;

    relayMetrics.forEach(relay => {
      const failureRate =
        relay.totalSubmissions > 0 ? relay.failedSubmissions / relay.totalSubmissions : 0;

      if (failureRate > config.threshold && relay.totalSubmissions > 5) {
        this.triggerAlert(AlertType.RELAY_FAILURE_RATE_HIGH, {
          message: `${relay.provider} failure rate (${(failureRate * 100).toFixed(1)}%) exceeds threshold (${(config.threshold * 100).toFixed(1)}%)`,
          data: { provider: relay.provider, failureRate, threshold: config.threshold },
        });
      }
    });
  }

  /**
   * Trigger an alert
   */
  private async triggerAlert(
    type: AlertType,
    alertData: { message: string; data?: any }
  ): Promise<void> {
    const config = this.alertConfigs.get(type);
    if (!config) return;

    // Check cooldown
    const lastAlertTime = this.lastAlertTimes.get(type) || 0;
    const now = Date.now();
    if (now - lastAlertTime < config.cooldown) {
      return; // Still in cooldown period
    }

    // Create alert
    const alert: Alert = {
      id: `${type}_${now}`,
      type,
      severity: config.severity,
      message: alertData.message,
      timestamp: now,
      data: alertData.data,
      acknowledged: false,
      resolved: false,
    };

    // Store alert
    this.activeAlerts.set(alert.id, alert);
    this.alertHistory.push(alert);
    this.lastAlertTimes.set(type, now);

    // Send to all channels
    const enabledChannels = this.alertChannels.filter(channel => channel.enabled);
    const channelResults = await Promise.allSettled(
      enabledChannels.map(channel => channel.sendAlert(alert))
    );

    // Log channel results
    channelResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const channel = enabledChannels[index];
        if (channel) {
          console.error(`Failed to send alert to channel ${channel.name}:`, result.reason);
        }
      }
    });

    // Log alert creation for monitoring
    console.log(`Alert triggered: ${alert.type} - ${alert.message}`, {
      alertId: alert.id,
      severity: alert.severity,
      timestamp: alert.timestamp,
      channelsSent: channelResults.filter(r => r.status === 'fulfilled').length,
      channelsFailed: channelResults.filter(r => r.status === 'rejected').length,
    });

    this.emit('alertTriggered', alert);
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('alertAcknowledged', alert);
      return true;
    }
    return false;
  }

  /**
   * Resolve alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.resolved = true;
      this.activeAlerts.delete(alertId);
      this.emit('alertResolved', alert);
      return true;
    }
    return false;
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit: number = 100): Alert[] {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): {
    totalAlerts: number;
    activeAlerts: number;
    alertsByType: Record<string, number>;
    alertsBySeverity: Record<string, number>;
  } {
    const alertsByType: Record<string, number> = {};
    const alertsBySeverity: Record<string, number> = {};

    this.alertHistory.forEach(alert => {
      alertsByType[alert.type] = (alertsByType[alert.type] || 0) + 1;
      alertsBySeverity[alert.severity] = (alertsBySeverity[alert.severity] || 0) + 1;
    });

    return {
      totalAlerts: this.alertHistory.length,
      activeAlerts: this.activeAlerts.size,
      alertsByType,
      alertsBySeverity,
    };
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.alertHistory.length = 0;
    this.emit('historyCleared');
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopMonitoring();
    this.activeAlerts.clear();
    this.alertHistory.length = 0;
    this.lastAlertTimes.clear();
  }
}

// Alert utility functions
export const AlertUtils = {
  /**
   * Get alert severity priority for sorting
   */
  getSeverityPriority: (severity: AlertSeverity): number => {
    switch (severity) {
      case AlertSeverity.CRITICAL:
        return 4;
      case AlertSeverity.ERROR:
        return 3;
      case AlertSeverity.WARNING:
        return 2;
      case AlertSeverity.INFO:
        return 1;
      default:
        return 0;
    }
  },

  /**
   * Check if alert severity requires immediate attention
   */
  requiresImmediateAttention: (severity: AlertSeverity): boolean => {
    return severity === AlertSeverity.CRITICAL || severity === AlertSeverity.ERROR;
  },

  /**
   * Get default alert configurations for all types
   */
  getDefaultAlertConfigs: (): AlertConfig[] => {
    return [
      {
        type: AlertType.CONSECUTIVE_REVERTS,
        enabled: true,
        severity: AlertSeverity.ERROR,
        threshold: 3,
        timeWindow: 300000, // 5 minutes
        cooldown: 600000, // 10 minutes
        description: 'Multiple consecutive transaction reverts detected',
      },
      {
        type: AlertType.LATENCY_SLO_BREACH,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 1000, // 1 second
        timeWindow: 60000, // 1 minute
        cooldown: 300000, // 5 minutes
        description: 'Service latency exceeding SLO threshold',
      },
      {
        type: AlertType.LOW_WIN_RATE,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 0.5, // 50%
        timeWindow: 3600000, // 1 hour
        cooldown: 1800000, // 30 minutes
        description: 'MEV opportunity win rate below threshold',
      },
      {
        type: AlertType.HIGH_GAS_COSTS,
        enabled: true,
        severity: AlertSeverity.INFO,
        threshold: 100, // gwei
        timeWindow: 300000, // 5 minutes
        cooldown: 600000, // 10 minutes
        description: 'Gas prices above normal threshold',
      },
      {
        type: AlertType.RPC_CONNECTION_FAILURE,
        enabled: true,
        severity: AlertSeverity.CRITICAL,
        threshold: 1,
        timeWindow: 60000, // 1 minute
        cooldown: 300000, // 5 minutes
        description: 'RPC connection failure detected',
      },
      {
        type: AlertType.MEMORY_USAGE_HIGH,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 0.8, // 80%
        timeWindow: 300000, // 5 minutes
        cooldown: 600000, // 10 minutes
        description: 'Memory usage above threshold',
      },
      {
        type: AlertType.CIRCUIT_BREAKER_TRIGGERED,
        enabled: true,
        severity: AlertSeverity.ERROR,
        threshold: 1,
        timeWindow: 60000, // 1 minute
        cooldown: 1800000, // 30 minutes
        description: 'Circuit breaker has been triggered',
      },
      {
        type: AlertType.PROFIT_MARGIN_LOW,
        enabled: true,
        severity: AlertSeverity.INFO,
        threshold: 0.01, // 1%
        timeWindow: 3600000, // 1 hour
        cooldown: 1800000, // 30 minutes
        description: 'Profit margins below expected threshold',
      },
      {
        type: AlertType.RELAY_FAILURE_RATE_HIGH,
        enabled: true,
        severity: AlertSeverity.WARNING,
        threshold: 0.2, // 20%
        timeWindow: 600000, // 10 minutes
        cooldown: 1800000, // 30 minutes
        description: 'High failure rate on transaction relays',
      },
    ];
  },

  /**
   * Format alert for display
   */
  formatAlert: (alert: Alert): string => {
    const timestamp = new Date(alert.timestamp).toISOString();
    const status = alert.resolved ? '[RESOLVED]' : alert.acknowledged ? '[ACK]' : '[ACTIVE]';
    return `${status} [${alert.severity.toUpperCase()}] ${timestamp} - ${alert.type}: ${alert.message}`;
  },

  /**
   * Validate alert configuration
   */
  validateAlertConfig: (config: AlertConfig): boolean => {
    if (!Object.values(AlertType).includes(config.type)) {
      return false;
    }
    if (!Object.values(AlertSeverity).includes(config.severity)) {
      return false;
    }
    if (config.threshold < 0 || config.cooldown < 0) {
      return false;
    }
    // Allow timeWindow === 0 for CIRCUIT_BREAKER_TRIGGERED, but require > 0 for others
    if (
      config.timeWindow < 0 ||
      (config.timeWindow === 0 && config.type !== AlertType.CIRCUIT_BREAKER_TRIGGERED)
    ) {
      return false;
    }
    return true;
  },

  /**
   * Get alert type display name
   */
  getAlertTypeDisplayName: (type: AlertType): string => {
    switch (type) {
      case AlertType.CONSECUTIVE_REVERTS:
        return 'Consecutive Reverts';
      case AlertType.LATENCY_SLO_BREACH:
        return 'Latency SLO Breach';
      case AlertType.LOW_WIN_RATE:
        return 'Low Win Rate';
      case AlertType.HIGH_GAS_COSTS:
        return 'High Gas Costs';
      case AlertType.RPC_CONNECTION_FAILURE:
        return 'RPC Connection Failure';
      case AlertType.MEMORY_USAGE_HIGH:
        return 'High Memory Usage';
      case AlertType.CIRCUIT_BREAKER_TRIGGERED:
        return 'Circuit Breaker Triggered';
      case AlertType.PROFIT_MARGIN_LOW:
        return 'Low Profit Margin';
      case AlertType.RELAY_FAILURE_RATE_HIGH:
        return 'High Relay Failure Rate';
      default:
        return 'Unknown Alert Type';
    }
  },
};
