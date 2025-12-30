/**
 * WebSocket Client
 *
 * Handles WebSocket connections for real-time blockchain data.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createComponentLogger } from '../utils/logger';

export interface WebSocketClientOptions {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  pingInterval?: number;
  pongTimeout?: number;
}

export class WebSocketClient extends EventEmitter {
  private readonly logger = createComponentLogger('websocket-client');
  private readonly options: WebSocketClientOptions;

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isConnected = false;

  constructor(options: WebSocketClientOptions) {
    super();
    this.options = {
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      pingInterval: 30000,
      pongTimeout: 5000,
      ...options,
    };
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      return;
    }

    this.isConnecting = true;
    this.logger.info('Connecting to WebSocket', { url: this.options.url });

    try {
      this.ws = new WebSocket(this.options.url);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.logger.info('WebSocket connected successfully');
        this.startPingInterval();
        this.emit('connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.emit('message', message);
        } catch (error) {
          this.logger.warn('Failed to parse WebSocket message', {
            error: (error as Error).message,
            data: data.toString().substring(0, 100),
          });
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.handleDisconnection(code, reason.toString());
      });

      this.ws.on('error', (error: Error) => {
        this.logger.logError(error, { operation: 'websocket-connection' });
        this.emit('error', error);
      });

      this.ws.on('pong', () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      });
    } catch (error) {
      this.isConnecting = false;
      this.logger.logError(error as Error, { operation: 'websocket-connect' });
      throw error;
    }
  }

  send(data: any): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(message);
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'websocket-send' });
      throw error;
    }
  }

  disconnect(): void {
    this.logger.info('Disconnecting WebSocket');

    this.clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
  }

  private handleDisconnection(code: number, reason: string): void {
    this.isConnected = false;
    this.isConnecting = false;
    this.clearTimers();

    this.logger.warn('WebSocket disconnected', { code, reason });
    this.emit('disconnected', { code, reason });

    if (this.reconnectAttempts < this.options.maxReconnectAttempts!) {
      this.scheduleReconnect();
    } else {
      this.logger.error('Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay =
      this.options.reconnectInterval! * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5));

    this.logger.info('Scheduling WebSocket reconnection', {
      attempt: this.reconnectAttempts,
      delay: delay,
      maxAttempts: this.options.maxReconnectAttempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(error => {
        this.logger.logError(error as Error, { operation: 'websocket-reconnect' });
      });
    }, delay);
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();

        this.pongTimer = setTimeout(() => {
          this.logger.warn('WebSocket pong timeout - closing connection');
          this.ws?.close();
        }, this.options.pongTimeout!);
      }
    }, this.options.pingInterval!);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      url: this.options.url,
    };
  }
}
