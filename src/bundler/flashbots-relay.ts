/**
 * Flashbots Relay Implementation
 *
 * Provides private transaction submission via Flashbots Protect RPC
 */

import { ethers } from 'ethers';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface FlashbotsRelayOptions {
  connectionManager: RpcConnectionManager;
  wallet: ethers.Wallet;
  authSignerPrivateKey?: string | undefined;
  flashbotsRpcUrl?: string | undefined;
  network?: 'mainnet' | 'goerli' | 'sepolia' | 'base' | undefined;
}

export interface FlashbotsSubmissionResult {
  success: boolean;
  bundleHash?: string | undefined;
  transactionHash?: string | undefined;
  error?: string | undefined;
  simulation?:
    | {
        totalGasUsed: number;
        coinbaseDiff: string;
        gasFees: string;
        ethSentToCoinbase: string;
      }
    | undefined;
}

export class FlashbotsRelay {
  private readonly logger = createComponentLogger('flashbots-relay');
  private readonly connectionManager: RpcConnectionManager;
  private readonly wallet: ethers.Wallet;
  private flashbotsProvider?: FlashbotsBundleProvider | undefined;
  private authSigner?: ethers.Wallet | undefined;
  private readonly flashbotsRpcUrl: string;
  private readonly network: string;
  private initialized = false;

  constructor(options: FlashbotsRelayOptions) {
    this.connectionManager = options.connectionManager;
    this.wallet = options.wallet;
    this.network = options.network || 'base';

    // Flashbots RPC URLs by network (Base is not supported by Flashbots)
    const flashbotsUrls: Record<string, string> = {
      mainnet: 'https://relay.flashbots.net',
      goerli: 'https://relay-goerli.flashbots.net',
      sepolia: 'https://relay-sepolia.flashbots.net',
    };

    // Check if network is supported by Flashbots
    if (!flashbotsUrls[this.network]) {
      throw new Error(
        `Flashbots not supported on network: ${this.network}. Supported networks: ${Object.keys(flashbotsUrls).join(', ')}`
      );
    }

    this.flashbotsRpcUrl =
      options.flashbotsRpcUrl ?? flashbotsUrls[this.network] ?? 'https://rpc.flashbots.net';

    // Create auth signer if private key provided
    if (options.authSignerPrivateKey) {
      this.authSigner = new ethers.Wallet(options.authSignerPrivateKey);
    } else {
      // Generate random auth signer for reputation (cast to Wallet to satisfy type checker)
      const randomWallet = ethers.Wallet.createRandom();
      this.authSigner = new ethers.Wallet(randomWallet.privateKey);
    }

    this.logger.info('Flashbots relay created', {
      network: this.network,
      rpcUrl: this.flashbotsRpcUrl,
      authAddress: this.authSigner?.address ?? 'unknown',
    });
  }

  /**
   * Initialize Flashbots provider
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Flashbots relay already initialized');
      return;
    }

    try {
      const provider = this.connectionManager.getProvider();

      // Create Flashbots bundle provider
      this.flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        this.authSigner!,
        this.flashbotsRpcUrl
      );

      this.initialized = true;
      this.logger.info('Flashbots relay initialized successfully');
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'flashbots-initialization',
      });
      throw error;
    }
  }

  /**
   * Send private transaction via Flashbots Protect
   */
  async sendPrivateTransaction(
    transaction: ethers.TransactionRequest
  ): Promise<FlashbotsSubmissionResult> {
    if (!this.initialized || !this.flashbotsProvider) {
      throw new Error('Flashbots relay not initialized');
    }

    try {
      const startTime = Date.now();

      // Sign the transaction
      const signedTx = await this.wallet.signTransaction(transaction);

      // Send via Flashbots Protect (single transaction)
      const response = await this.flashbotsProvider.sendPrivateTransaction(
        { signedTransaction: signedTx } as any,
        {
          maxBlockNumber: (await this.connectionManager.getProvider().getBlockNumber()) + 5,
        }
      );

      const latency = Date.now() - startTime;

      this.logger.info('Private transaction sent via Flashbots', {
        transactionHash: (response as any).hash,
        latency,
      });

      return {
        success: true,
        transactionHash: (response as any).hash,
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'flashbots-send-private-tx',
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Send bundle of transactions via Flashbots
   */
  async sendBundle(
    signedTransactions: string[],
    targetBlockNumber: number
  ): Promise<FlashbotsSubmissionResult> {
    if (!this.initialized || !this.flashbotsProvider) {
      throw new Error('Flashbots relay not initialized');
    }

    try {
      const startTime = Date.now();

      // Submit bundle
      const bundleSubmission = await this.flashbotsProvider.sendRawBundle(
        signedTransactions,
        targetBlockNumber
      );

      const latency = Date.now() - startTime;

      // Simulate bundle to check profitability (optional - may not be available on all networks)
      let simulationData: any = undefined;
      try {
        if (
          'simulate' in bundleSubmission &&
          typeof (bundleSubmission as any).simulate === 'function'
        ) {
          const simulation = await (bundleSubmission as any).simulate();
          if ((simulation as any).results) {
            simulationData = {
              totalGasUsed: (simulation as any).totalGasUsed,
              coinbaseDiff: (simulation as any).coinbaseDiff.toString(),
              gasFees: (simulation as any).gasFees.toString(),
              ethSentToCoinbase: (simulation as any).ethSentToCoinbase.toString(),
            };
          }
        }
      } catch (simError) {
        this.logger.warn('Bundle simulation not available or failed', {
          error: (simError as Error).message,
        });
      }

      this.logger.info('Bundle sent via Flashbots', {
        bundleHash: (bundleSubmission as any).bundleHash,
        targetBlock: targetBlockNumber,
        latency,
        simulation: simulationData
          ? {
              totalGasUsed: simulationData.totalGasUsed,
              coinbaseDiff: simulationData.coinbaseDiff,
            }
          : undefined,
      });

      return {
        success: true,
        bundleHash: (bundleSubmission as any).bundleHash,
        simulation: simulationData,
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'flashbots-send-bundle',
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
    rpcUrl: string;
    authAddress: string;
  } {
    return {
      initialized: this.initialized,
      network: this.network,
      rpcUrl: this.flashbotsRpcUrl,
      authAddress: this.authSigner?.address || '',
    };
  }
}
