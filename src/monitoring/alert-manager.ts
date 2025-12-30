/**
 * Alert Manager
 *
 * Manages alerts and notifications for the MEV bot system.
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';

export enum AlertSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum AlertCategory {
  SYSTEM = 'system',
  PERFORMANCE = 'performance',
  SECURITY = 'security',
  OPPORTUNITY = 'opportunity',
  ERROR = 'error',
}

export interface Alert {
  id: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  category: AlertCategory;
  timestamp: number;
  source: string;
  metadata?: Record<string, any>;
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (data: any) => boolean;
  severity: AlertSeverity;
  category: AlertCategory;
  message: string;
  enabled: boolean;
  cooldownMs?: number;
  lastTriggered?: number;
}

export interface AlertManagerOptions {
  maxAlerts?: number;
  alertRetentionMs?: number;
  enableConsoleOutput?: boolean;
  enableFileOutput?: boolean;
  outputPath?: string;
}

export class AlertManager extends EventEmitter {
  private readonly logger = createComponentLogger('alert-manager');
  private readonly options: Required<AlertManagerOptions>;

  private alerts: Map<string, Alert> = new Map();
  private alertRules: Map<string, AlertRule> = new Map();
  private alertCounter = 0;

  constructor(options: AlertManagerOptions = {}) {
    super();
    this.options = {
      maxAlerts: 1000,
      alertRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
      enableConsoleOutput: true,
      enableFileOutput: false,
      outputPath: './logs/alerts.log',
      ...options,
    };

    // Set up periodic cleanup
    setInterval(() => this.cleanupOldAlerts(), 60000); // Every minute
  }

  /**
   * Create and emit an alert
   */
  createAlert(
    title: string,
    message: string,
    severity: AlertSeverity,
    category: AlertCategory,
    source: string,
    metadata?: Record<string, any>
  ): Alert {
    const alert: Alert = {
      id: `alert_${++this.alertCounter}_${Date.now()}`,
      title,
      message,
      severity,
      category,
      timestamp: Date.now(),
      source,
      metadata: metadata || {},
      acknowledged: false,
    };

    this.alerts.set(alert.id, alert);
    this.processAlert(alert);

    // Cleanup if we exceed max alerts
    if (this.alerts.size > this.options.maxAlerts) {
      this.cleanupOldAlerts();
    }

    return alert;
  }

  /**
   * Add an alert rule
   */
  addRule(rule: AlertRule): void {
    this.alertRules.set(rule.id, rule);
    this.logger.info('Added alert rule', {
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      category: rule.category,
    });
  }

  /**
   * Remove an alert rule
   */
  removeRule(ruleId: string): void {
    this.alertRules.delete(ruleId);
    this.logger.info('Removed alert rule', { id: ruleId });
  }

  /**
   * Evaluate data against all rules
   */
  evaluateRules(data: any, source: string): void {
    for (const rule of this.alertRules.values()) {
      if (!rule.enabled) continue;

      // Check cooldown
      if (rule.cooldownMs && rule.lastTriggered) {
        const timeSinceLastTrigger = Date.now() - rule.lastTriggered;
        if (timeSinceLastTrigger < rule.cooldownMs) {
          continue;
        }
      }

      try {
        if (rule.condition(data)) {
          this.createAlert(rule.name, rule.message, rule.severity, rule.category, source, {
            ruleId: rule.id,
            triggerData: data,
          });

          // Update last triggered time
          rule.lastTriggered = Date.now();
        }
      } catch (error) {
        this.logger.warn('Error evaluating alert rule', {
          ruleId: rule.id,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, acknowledgedBy: string): boolean {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      return false;
    }

    alert.acknowledged = true;
    alert.acknowledgedBy = acknowledgedBy;
    alert.acknowledgedAt = Date.now();

    this.logger.info('Alert acknowledged', {
      alertId,
      acknowledgedBy,
      title: alert.title,
    });

    this.emit('alertAcknowledged', alert);
    return true;
  }

  /**
   * Get alerts with optional filtering
   */
  getAlerts(filter?: {
    severity?: AlertSeverity;
    category?: AlertCategory;
    acknowledged?: boolean;
    since?: number;
  }): Alert[] {
    let alerts = Array.from(this.alerts.values());

    if (filter) {
      if (filter.severity) {
        alerts = alerts.filter(a => a.severity === filter.severity);
      }
      if (filter.category) {
        alerts = alerts.filter(a => a.category === filter.category);
      }
      if (filter.acknowledged !== undefined) {
        alerts = alerts.filter(a => a.acknowledged === filter.acknowledged);
      }
      if (filter.since) {
        alerts = alerts.filter(a => a.timestamp >= filter.since!);
      }
    }

    return alerts.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get alert statistics
   */
  getStats(): {
    total: number;
    bySeverity: Record<AlertSeverity, number>;
    byCategory: Record<AlertCategory, number>;
    acknowledged: number;
    unacknowledged: number;
  } {
    const alerts = Array.from(this.alerts.values());

    const bySeverity = {
      [AlertSeverity.LOW]: 0,
      [AlertSeverity.MEDIUM]: 0,
      [AlertSeverity.HIGH]: 0,
      [AlertSeverity.CRITICAL]: 0,
    };

    const byCategory = {
      [AlertCategory.SYSTEM]: 0,
      [AlertCategory.PERFORMANCE]: 0,
      [AlertCategory.SECURITY]: 0,
      [AlertCategory.OPPORTUNITY]: 0,
      [AlertCategory.ERROR]: 0,
    };

    let acknowledged = 0;

    alerts.forEach(alert => {
      bySeverity[alert.severity]++;
      byCategory[alert.category]++;
      if (alert.acknowledged) acknowledged++;
    });

    return {
      total: alerts.length,
      bySeverity,
      byCategory,
      acknowledged,
      unacknowledged: alerts.length - acknowledged,
    };
  }

  private processAlert(alert: Alert): void {
    this.logger.info('Alert created', {
      id: alert.id,
      title: alert.title,
      severity: alert.severity,
      category: alert.category,
      source: alert.source,
    });

    // Console output
    if (this.options.enableConsoleOutput) {
      this.outputToConsole(alert);
    }

    // File output
    if (this.options.enableFileOutput) {
      this.outputToFile(alert);
    }

    // Emit event
    this.emit('alertCreated', alert);

    // Emit severity-specific events
    this.emit(`alert${alert.severity}`, alert);
  }

  private outputToConsole(alert: Alert): void {
    const timestamp = new Date(alert.timestamp).toISOString();
    const prefix = `[${timestamp}] [${alert.severity.toUpperCase()}] [${alert.category}]`;

    switch (alert.severity) {
      case AlertSeverity.CRITICAL:
        console.error(`${prefix} ${alert.title}: ${alert.message}`);
        break;
      case AlertSeverity.HIGH:
        console.warn(`${prefix} ${alert.title}: ${alert.message}`);
        break;
      default:
        console.log(`${prefix} ${alert.title}: ${alert.message}`);
    }
  }

  private outputToFile(alert: Alert): void {
    try {
      const fs = require('fs');
      const path = require('path');

      // Ensure directory exists
      const dir = path.dirname(this.options.outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date(alert.timestamp).toISOString();
      const logLine =
        JSON.stringify({
          timestamp,
          id: alert.id,
          title: alert.title,
          message: alert.message,
          severity: alert.severity,
          category: alert.category,
          source: alert.source,
          metadata: alert.metadata,
        }) + '\n';

      fs.appendFileSync(this.options.outputPath, logLine);
    } catch (error) {
      this.logger.warn('Failed to write alert to file', {
        error: (error as Error).message,
        alertId: alert.id,
      });
    }
  }

  private cleanupOldAlerts(): void {
    const cutoffTime = Date.now() - this.options.alertRetentionMs;
    let removedCount = 0;

    for (const [id, alert] of this.alerts.entries()) {
      if (alert.timestamp < cutoffTime) {
        this.alerts.delete(id);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.debug('Cleaned up old alerts', { removedCount });
    }
  }

  /**
   * Clear all alerts
   */
  clearAlerts(): void {
    const count = this.alerts.size;
    this.alerts.clear();
    this.logger.info('Cleared all alerts', { count });
  }

  /**
   * Enable or disable a rule
   */
  toggleRule(ruleId: string, enabled: boolean): boolean {
    const rule = this.alertRules.get(ruleId);
    if (!rule) {
      return false;
    }

    rule.enabled = enabled;
    this.logger.info('Toggled alert rule', { ruleId, enabled });
    return true;
  }
}
