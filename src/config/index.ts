/**
 * Configuration System
 *
 * Main configuration management with loading, validation, and hot reload.
 */

import { EventEmitter } from 'events';
import { ConfigLoader, LoaderOptions } from './loader';
import { ConfigValidator, ValidatorOptions } from './validator';
import { Config } from '../types/config';

export interface ConfigManagerOptions {
  readonly loader: LoaderOptions;
  readonly validator?: ValidatorOptions;
  readonly validateBusinessLogic?: boolean;
}

export class ConfigManager extends EventEmitter {
  private readonly loader: ConfigLoader;
  private readonly validator: ConfigValidator;
  private readonly validateBusinessLogic: boolean;
  private currentConfig?: Config;

  constructor(options: ConfigManagerOptions) {
    super();

    this.loader = new ConfigLoader(options.loader);
    this.validator = new ConfigValidator(options.validator);
    this.validateBusinessLogic = options.validateBusinessLogic ?? true;

    this.setupLoaderEvents();
  }

  /**
   * Load and validate configuration
   */
  async initialize(): Promise<Config> {
    try {
      const rawConfig = await this.loader.load();
      const config = this.validateConfig(rawConfig);

      this.currentConfig = config;
      this.emit('configLoaded', config);

      return config;
    } catch (error) {
      this.emit('configError', error);
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    if (!this.currentConfig) {
      throw new Error('Configuration not loaded. Call initialize() first.');
    }
    return this.currentConfig;
  }

  /**
   * Reload configuration from file
   */
  async reload(): Promise<Config> {
    return this.initialize();
  }

  /**
   * Stop configuration manager and cleanup resources
   */
  stop(): void {
    this.loader.stopWatching();
    this.removeAllListeners();
  }

  /**
   * Validate raw configuration data
   */
  private validateConfig(rawConfig: unknown): Config {
    // Schema validation
    const schemaResult = this.validator.validate(rawConfig);
    if (!schemaResult.valid) {
      throw new Error(`Configuration schema validation failed:\n${schemaResult.errors.join('\n')}`);
    }

    const config = this.validator.validateAndParse(rawConfig);

    // Business logic validation
    if (this.validateBusinessLogic) {
      const businessResult = this.validator.validateBusinessLogic(config);

      if (!businessResult.valid) {
        throw new Error(
          `Configuration business logic validation failed:\n${businessResult.errors.join('\n')}`
        );
      }

      if (businessResult.warnings.length > 0) {
        this.emit('configWarnings', businessResult.warnings);
      }
    }

    return config;
  }

  /**
   * Setup loader event handlers
   */
  private setupLoaderEvents(): void {
    this.loader.on('configChanged', async (newRawConfig: unknown) => {
      try {
        const newConfig = this.validateConfig(newRawConfig);
        const oldConfigCopy = this.currentConfig;

        this.currentConfig = newConfig;
        this.emit('configChanged', newConfig, oldConfigCopy);
      } catch (error) {
        this.emit('configReloadError', error);
      }
    });

    this.loader.on('configError', (error: Error) => {
      this.emit('configError', error);
    });

    this.loader.on('watcherError', (error: Error) => {
      this.emit('watcherError', error);
    });
  }
}

// Re-export types and classes
export { ConfigLoader, ConfigValidator };
export type { LoaderOptions, ValidatorOptions };
export * from '../types/config';
export * from './schema';
