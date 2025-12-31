/**
 * Contract Manager
 *
 * Manages contract deployment, verification, and configuration
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
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

export interface ContractsYaml {
  contracts: {
    flashExecutor: ContractConfig;
    authorizedPools: {
      uniswapV3: PoolConfig[];
      aerodrome: PoolConfig[];
    };
  };
  deployment: DeploymentConfig;
  networks: {
    [key: string]: NetworkConfig;
  };
}

export class ContractManager {
  private configPath: string;
  private config: ContractsYaml;

  constructor(configPath: string = 'config/contracts.yaml') {
    this.configPath = join(process.cwd(), configPath);
    this.config = this.loadConfig();
  }

  /**
   * Load configuration from YAML file
   */
  private loadConfig(): ContractsYaml {
    try {
      const configFile = readFileSync(this.configPath, 'utf8');
      return yaml.parse(configFile) as ContractsYaml;
    } catch (error) {
      logger.error('Failed to load contracts configuration:', error);
      throw new Error(`Failed to load contracts configuration: ${error}`);
    }
  }

  /**
   * Save configuration to YAML file
   */
  private saveConfig(): void {
    try {
      const yamlString = yaml.stringify(this.config, { indent: 2 });
      writeFileSync(this.configPath, yamlString, 'utf8');
      logger.info('Contracts configuration saved successfully');
    } catch (error) {
      logger.error('Failed to save contracts configuration:', error);
      throw new Error(`Failed to save contracts configuration: ${error}`);
    }
  }

  /**
   * Update Flash Executor contract configuration
   */
  updateFlashExecutorConfig(contractConfig: ContractConfig): void {
    this.config.contracts.flashExecutor = contractConfig;
    this.saveConfig();
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
   * Add authorized pool
   */
  addAuthorizedPool(protocol: 'uniswapV3' | 'aerodrome', pool: PoolConfig): void {
    this.config.contracts.authorizedPools[protocol].push(pool);
    this.saveConfig();
    logger.info(`Added authorized ${protocol} pool: ${pool.address}`);
  }

  /**
   * Remove authorized pool
   */
  removeAuthorizedPool(protocol: 'uniswapV3' | 'aerodrome', poolAddress: string): void {
    const pools = this.config.contracts.authorizedPools[protocol];
    const index = pools.findIndex(pool => pool.address.toLowerCase() === poolAddress.toLowerCase());

    if (index !== -1) {
      pools.splice(index, 1);
      this.saveConfig();
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

    // Add Uniswap V3 pools
    this.config.contracts.authorizedPools.uniswapV3.forEach(pool => {
      pools.push(pool.address as Address);
    });

    // Add Aerodrome pools
    this.config.contracts.authorizedPools.aerodrome.forEach(pool => {
      pools.push(pool.address as Address);
    });

    return pools;
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
   * Reset configuration (for testing)
   */
  resetConfig(): void {
    this.config.contracts.flashExecutor = {
      address: '',
      deploymentBlock: 0,
      deploymentTime: '',
      network: '',
      chainId: '',
      owner: '',
      minProfit: '',
    };
    this.saveConfig();
    logger.info('Contract configuration reset');
  }
}
