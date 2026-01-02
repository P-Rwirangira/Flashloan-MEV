/**
 * Contract Manager
 *
 * Manages contract deployment, verification, and configuration
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as yaml from 'yaml';
import { logger } from '../utils/logger';
import { Address } from '../types/common';

export interface ContractConfig {
  address: string;
  deploymentBlock: number;
  deploymentTime: string;
  network: string;
  chainId: string;
  owner: string;
  minProfit: string;
}

export interface PoolConfig {
  address: string;
  token0: string;
  token1: string;
  fee?: number;
  stable?: boolean;
}

export interface DeploymentConfig {
  minProfitEth: string;
  gasLimit: number;
  gasPrice: string;
}

export interface NetworkConfig {
  rpcUrl: string;
  chainId: number;
  blockExplorer: string;
}

export interface CompoundMarket {
  underlying: string;
  cToken: string;
}
export interface ProtocolAddresses {
  aaveV3: { poolAddress: string };
  compoundLike: {
    moonwell: { comptroller: string; markets?: CompoundMarket[] };
    seamless: { comptroller: string; markets?: CompoundMarket[] };
  };
}

export interface ContractsYaml {
  contracts: {
    flashExecutor: ContractConfig;
    authorizedPools: {
      uniswapV3: PoolConfig[];
      aerodrome: PoolConfig[];
    };
  };
  deployment: DeploymentConfig;
  protocols: ProtocolAddresses;
  networks: {
    [key: string]: NetworkConfig;
  };
}

export class ContractManager {
  private configPath: string;
  private config: ContractsYaml;

  private constructor(configPath: string, config: ContractsYaml) {
    this.configPath = configPath;
    this.config = config;
  }

  /**
   * Create ContractManager instance asynchronously
   */
  static async create(configPath: string = 'config/contracts.yaml'): Promise<ContractManager> {
    const fullPath = join(process.cwd(), configPath);
    const config = await ContractManager.loadConfigAsync(fullPath);
    return new ContractManager(fullPath, config);
  }

  /**
   * Load configuration from YAML file asynchronously
   */
  private static async loadConfigAsync(configPath: string): Promise<ContractsYaml> {
    try {
      const configFile = await fs.readFile(configPath, 'utf8');
      return yaml.parse(configFile) as ContractsYaml;
    } catch (error) {
      logger.error('Failed to load contracts configuration:', error);
      throw new Error(`Failed to load contracts configuration: ${error}`);
    }
  }

  /**
   * Load configuration from YAML file (returns Promise)
   */
  async loadConfig(): Promise<ContractsYaml> {
    this.config = await ContractManager.loadConfigAsync(this.configPath);
    return this.config;
  }

  /**
   * Save configuration to YAML file asynchronously
   */
  private async saveConfig(): Promise<void> {
    try {
      const yamlString = yaml.stringify(this.config, { indent: 2 });
      const tempPath = `${this.configPath}.tmp`;

      // Write to temp file first
      await fs.writeFile(tempPath, yamlString, 'utf8');

      // Atomically rename temp file to real path
      await fs.rename(tempPath, this.configPath);

      logger.info('Contracts configuration saved successfully');
    } catch (error) {
      logger.error('Failed to save contracts configuration:', error);
      throw new Error(`Failed to save contracts configuration: ${error}`);
    }
  }

  /**
   * Update Flash Executor contract configuration
   */
  async updateFlashExecutorConfig(contractConfig: ContractConfig): Promise<void> {
    this.config.contracts.flashExecutor = contractConfig;
    await this.saveConfig();
    logger.info(`Flash Executor configuration updated: ${contractConfig.address}`);
  }

  /**
   * Get Flash Executor contract configuration
   */
  getFlashExecutorConfig(): ContractConfig {
    return this.config.contracts.flashExecutor;
  }

  /**
   * Get authorized pools configuration
   */
  getAuthorizedPools(): { uniswapV3: PoolConfig[]; aerodrome: PoolConfig[] } {
    return this.config.contracts.authorizedPools;
  }

  /**
   * Add normalized address helper
   */
  private normalizeAddress(address: string): string {
    return address.toLowerCase();
  }

  /**
   * Add authorized pool
   */
  async addAuthorizedPool(protocol: 'uniswapV3' | 'aerodrome', pool: PoolConfig): Promise<void> {
    const pools = this.config.contracts.authorizedPools[protocol];
    const normalizedAddress = this.normalizeAddress(pool.address);

    // Check for duplicates using normalized addresses
    const exists = pools.some(
      existingPool => this.normalizeAddress(existingPool.address) === normalizedAddress
    );

    if (!exists) {
      pools.push(pool);
      await this.saveConfig();
      logger.info(`Added authorized ${protocol} pool: ${pool.address}`);
    } else {
      logger.warn(`Pool already exists in ${protocol} authorized pools: ${pool.address}`);
    }
  }

  /**
   * Remove authorized pool
   */
  async removeAuthorizedPool(
    protocol: 'uniswapV3' | 'aerodrome',
    poolAddress: string
  ): Promise<void> {
    const pools = this.config.contracts.authorizedPools[protocol];
    const normalizedAddress = this.normalizeAddress(poolAddress);
    const index = pools.findIndex(
      pool => this.normalizeAddress(pool.address) === normalizedAddress
    );

    if (index !== -1) {
      pools.splice(index, 1);
      await this.saveConfig();
      logger.info(`Removed authorized ${protocol} pool: ${poolAddress}`);
    } else {
      logger.warn(`Pool not found in ${protocol} authorized pools: ${poolAddress}`);
    }
  }

  /**
   * Get deployment configuration
   */
  getDeploymentConfig(): DeploymentConfig {
    return this.config.deployment;
  }

  /**
   * Get protocol addresses
   */
  getProtocolAddresses(): ProtocolAddresses {
    return this.config.protocols;
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(network: string): NetworkConfig {
    const networkConfig = this.config.networks[network];
    if (!networkConfig) {
      throw new Error(`Network configuration not found: ${network}`);
    }
    return networkConfig;
  }

  /**
   * Check if Flash Executor is deployed
   */
  isFlashExecutorDeployed(): boolean {
    return this.config.contracts.flashExecutor.address !== '';
  }

  /**
   * Get all authorized pool addresses
   */
  getAllAuthorizedPoolAddresses(): Address[] {
    const pools: Address[] = [];

    // Add Uniswap V3 pools with normalized addresses
    this.config.contracts.authorizedPools.uniswapV3.forEach(pool => {
      pools.push(this.normalizeAddress(pool.address) as Address);
    });

    // Add Aerodrome pools with normalized addresses
    this.config.contracts.authorizedPools.aerodrome.forEach(pool => {
      pools.push(this.normalizeAddress(pool.address) as Address);
    });

    return pools;
  }

  /**
   * Resolve cToken for underlying for a compound-like protocol
   */
  getCTokenFor(protocol: 'moonwell' | 'seamless', underlying: string): string | undefined {
    const list = this.config.protocols.compoundLike[protocol]?.markets || [];
    const key = underlying.toLowerCase();
    const found = list.find(m => m.underlying.toLowerCase() === key);
    return found?.cToken;
  }

  /**
   * Validate contract configuration
   */
  validateConfig(): boolean {
    try {
      // Check if Flash Executor is configured
      if (!this.isFlashExecutorDeployed()) {
        logger.warn('Flash Executor not deployed');
        return false;
      }

      // Validate contract address format
      if (!ethers.isAddress(this.config.contracts.flashExecutor.address)) {
        logger.error('Invalid Flash Executor address format');
        return false;
      }

      // Validate authorized pools
      const allPools = this.getAllAuthorizedPoolAddresses();
      for (const poolAddress of allPools) {
        if (!ethers.isAddress(poolAddress)) {
          logger.error(`Invalid pool address format: ${poolAddress}`);
          return false;
        }
      }

      // Validate minimum profit
      try {
        ethers.parseEther(this.config.deployment.minProfitEth);
      } catch (error) {
        logger.error('Invalid minimum profit format');
        return false;
      }

      // Validate protocol addresses
      const protocols = this.config.protocols;
      if (!protocols || !protocols.aaveV3 || !ethers.isAddress(protocols.aaveV3.poolAddress)) {
        logger.error('Invalid Aave V3 pool address in protocols config');
        return false;
      }
      const moonwell = protocols.compoundLike?.moonwell;
      const seamless = protocols.compoundLike?.seamless;
      for (const entry of [moonwell, seamless]) {
        if (!entry || !ethers.isAddress(entry.comptroller)) {
          logger.error('Invalid Compound-like comptroller address in protocols config');
          return false;
        }
        if (entry.markets) {
          for (const m of entry.markets) {
            if (!ethers.isAddress(m.underlying) || !ethers.isAddress(m.cToken)) {
              logger.error('Invalid market mapping (underlying/cToken) in protocols config');
              return false;
            }
          }
        }
      }

      logger.info('Contract configuration validation passed');
      return true;
    } catch (error) {
      logger.error('Contract configuration validation failed:', error);
      return false;
    }
  }

  /**
   * Get contract deployment summary
   */
  getDeploymentSummary(): {
    flashExecutor: ContractConfig;
    authorizedPoolsCount: number;
    networks: string[];
    isValid: boolean;
  } {
    return {
      flashExecutor: this.config.contracts.flashExecutor,
      authorizedPoolsCount: this.getAllAuthorizedPoolAddresses().length,
      networks: Object.keys(this.config.networks),
      isValid: this.validateConfig(),
    };
  }

  /**
   * Reset configuration (for testing only)
   */
  async resetConfig(): Promise<void> {
    // Environment guard - only allow in test environment
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error('resetConfig can only be called in test environment');
    }

    this.config.contracts.flashExecutor = {
      address: '',
      deploymentBlock: 0,
      deploymentTime: '',
      network: '',
      chainId: '',
      owner: '',
      minProfit: '',
    };
    await this.saveConfig();
    logger.info('Contract configuration reset');
  }
}
