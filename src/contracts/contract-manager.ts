/**
 * Contract Manager
 *
 * Manages smart contract deployments, configurations, and interactions
 */

import { ethers } from 'ethers';
import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';

export interface ContractConfig {
  address: Address;
  minProfit: string;
  owner: Address;
  network: string;
  chainId: string;
  deploymentBlock: number;
  deploymentTime: string;
}

export interface DeploymentConfig {
  minProfitEth: string;
  gasLimit: number;
}

export interface PoolConfig {
  address: Address;
  enabled: boolean;
  priority: number;
  minTvl: number;
  maxSlippage: number;
  tags: string[];
}

/**
 * Contract Manager for deployment and configuration
 */
export class ContractManager {
  private readonly logger = createComponentLogger('contract-manager');
  private flashExecutorConfig?: ContractConfig;
  private authorizedPools: Map<Address, PoolConfig> = new Map();

  constructor() {
    this.loadDefaultPools();
  }

  /**
   * Get deployment configuration
   */
  getDeploymentConfig(): DeploymentConfig {
    return {
      minProfitEth: process.env['MIN_PROFIT_ETH'] || '0.008', // 0.008 ETH (~$20 at $2500 ETH)
      gasLimit: parseInt(process.env['DEPLOY_GAS_LIMIT'] || '3000000', 10),
    };
  }

  /**
   * Update flash executor configuration
   */
  updateFlashExecutorConfig(config: ContractConfig): void {
    this.flashExecutorConfig = config;
    this.logger.info('Flash executor configuration updated', {
      address: config.address,
      network: config.network,
      chainId: config.chainId,
    });
  }

  /**
   * Get flash executor configuration
   */
  getFlashExecutorConfig(): ContractConfig | undefined {
    return this.flashExecutorConfig;
  }

  /**
   * Get all authorized pool addresses
   */
  getAllAuthorizedPoolAddresses(): Address[] {
    return Array.from(this.authorizedPools.keys()).filter(
      address => this.authorizedPools.get(address)?.enabled
    );
  }

  /**
   * Add authorized pool
   */
  addAuthorizedPool(address: Address, config: Partial<PoolConfig> = {}): void {
    const poolConfig: PoolConfig = {
      address,
      enabled: config.enabled ?? true,
      priority: config.priority ?? 1,
      minTvl: config.minTvl ?? 100000, // $100k minimum TVL
      maxSlippage: config.maxSlippage ?? 0.02, // 2% max slippage
      tags: config.tags ?? [],
      ...config,
    };

    this.authorizedPools.set(address, poolConfig);
    this.logger.info('Authorized pool added', { address, config: poolConfig });
  }

  /**
   * Remove authorized pool
   */
  removeAuthorizedPool(address: Address): void {
    const removed = this.authorizedPools.delete(address);
    if (removed) {
      this.logger.info('Authorized pool removed', { address });
    }
  }

  /**
   * Get pool configuration
   */
  getPoolConfig(address: Address): PoolConfig | undefined {
    return this.authorizedPools.get(address);
  }

  /**
   * Load default pools for Base mainnet
   */
  private loadDefaultPools(): void {
    // Base mainnet pools - high liquidity pairs
    const defaultPools: Array<{ address: Address; config: Partial<PoolConfig> }> = [
      {
        address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18' as Address, // WETH/USDC 0.05%
        config: {
          priority: 1,
          minTvl: 1000000,
          maxSlippage: 0.01,
          tags: ['high-volume', 'stable'],
        },
      },
      {
        address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address, // WETH/USDC 0.3%
        config: {
          priority: 2,
          minTvl: 500000,
          maxSlippage: 0.02,
          tags: ['medium-volume'],
        },
      },
      {
        address: '0xcDAC0d6c6C59727a65F871236188350531885C43' as Address, // Aerodrome WETH/USDC
        config: {
          priority: 1,
          minTvl: 500000,
          maxSlippage: 0.02,
          tags: ['volatile', 'high-volume'],
        },
      },
    ];

    for (const { address, config } of defaultPools) {
      this.addAuthorizedPool(address, config);
    }

    this.logger.info('Default pools loaded', { count: defaultPools.length });
  }

  /**
   * Validate contract deployment
   */
  async validateDeployment(contractAddress: Address, provider: ethers.Provider): Promise<boolean> {
    try {
      // Check if contract exists
      const code = await provider.getCode(contractAddress);
      if (code === '0x') {
        this.logger.error('Contract not deployed', { address: contractAddress });
        return false;
      }

      // Try to call a view function to verify it's our contract
      const contract = new ethers.Contract(
        contractAddress,
        ['function owner() view returns (address)'],
        provider
      );

      const owner = await (contract['owner'] as () => Promise<string>)();
      if (!ethers.isAddress(owner)) {
        this.logger.error('Invalid contract owner', { address: contractAddress, owner });
        return false;
      }

      this.logger.info('Contract deployment validated', {
        address: contractAddress,
        owner,
      });

      return true;
    } catch (error) {
      this.logger.error('Contract validation failed', {
        address: contractAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get contract ABI for flash executor
   */
  getFlashExecutorABI(): string[] {
    return [
      'function executeArbitrage(address flashPool, uint256 amount0, uint256 amount1, bytes calldata routeData) external',
      'function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external',
      'function isAuthorizedPool(address pool) external view returns (bool)',
      'function getMinProfit() external view returns (uint256)',
      'function paused() external view returns (bool)',
      'function owner() external view returns (address)',
      'function setMinProfit(uint256 minProfit) external',
      'function addAuthorizedPool(address pool) external',
      'function removeAuthorizedPool(address pool) external',
      'function pause() external',
      'function unpause() external',
      'function emergencyWithdraw(address token, uint256 amount) external',
      'event ArbitrageExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 profit, uint256 gasUsed)',
      'event ArbitrageFailed(address indexed caller, string reason, uint256 gasUsed)',
    ];
  }
}
