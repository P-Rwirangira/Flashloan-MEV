/**
 * bloXroute Relay Implementation
 *
 * Provides private transaction submission via bloXroute BDN
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';

export interface BloXrouteRelayOptions {
  wallet: ethers.Wallet;
  apiKey: string;
  network?: 'mainnet' | 'base' | 'polygon' | 'bsc' | undefined;
  endpoint?: string | undefined;
}

export interface BloXrouteSubmissionResult {
  success: boolean;
  transactionHash?: string | undefined;
  error?: string | undefined;
  latency?: number | undefined;
}

export class BloXrouteRelay {
  private readonly logger = createComponentLogger('bloxroute-relay');
  private readonly wallet: ethers.Wallet;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly network: string;
  private initialized = false;

  constructor(options: BloXrouteRelayOptions) {
    this.wallet = options.wallet;
    this.apiKey = options.apiKey;
    this.network = options.network || 'base';

    // bloXroute endpoints by network
    const endpoints: Record<string, string> = {
      mainnet: 'https://api.blxrbdn.com',
      base: 'https://base.bdn.blxrbdn.com',
      polygon: 'https://polygon.bdn.blxrbdn.com',
      bsc: 'https://bsc.bdn.blxrbdn.com',
    };

    this.endpoint = options.endpoint ?? endpoints[this.network] ?? 'https://base.bdn.blxrbdn.com';

    this.logger.info('bloXroute relay created', {
      network: this.network,
      endpoint: this.endpoint,
    });
  }

  /**
   * Initialize bloXroute relay
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('bloXroute relay already initialized');
      return;
    }

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        // Verify API key by making a test request
        const response = await fetch(`${this.endpoint}/api/v1/status`, {
          headers: {
            Authorization: this.apiKey,
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`bloXroute API returned ${response.status}: ${response.statusText}`);
        }

        this.initialized = true;
        this.logger.info('bloXroute relay initialized successfully');
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('bloXroute initialization timeout after 10 seconds');
        }
        throw error;
      }
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'bloxroute-initialization',
      });
      throw error;
    }
  }

  /**
   * Send private transaction via bloXroute
   */
  async sendPrivateTransaction(
    transaction: ethers.TransactionRequest
  ): Promise<BloXrouteSubmissionResult> {
    if (!this.initialized) {
      throw new Error('bloXroute relay not initialized');
    }

    try {
      const startTime = Date.now();

      // Sign the transaction
      const signedTx = await this.wallet.signTransaction(transaction);

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        // Send via bloXroute private transaction endpoint
        const response = await fetch(`${this.endpoint}/api/v1/tx`, {
          method: 'POST',
          headers: {
            Authorization: this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            transaction: signedTx,
            blockchain_network: this.network,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const latency = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`bloXroute API error: ${response.status} - ${errorText}`);
        }

        const result = (await response.json()) as { tx_hash: string };

        this.logger.info('Private transaction sent via bloXroute', {
          transactionHash: result.tx_hash,
          latency,
        });

        return {
          success: true,
          transactionHash: result.tx_hash,
          latency,
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('bloXroute transaction submission timeout after 30 seconds');
        }
        throw error;
      }
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'bloxroute-send-private-tx',
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Check if relay is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get relay status
   */
  getStatus(): {
    initialized: boolean;
    network: string;
    endpoint: string;
  } {
    return {
      initialized: this.initialized,
      network: this.network,
      endpoint: this.endpoint,
    };
  }
}
