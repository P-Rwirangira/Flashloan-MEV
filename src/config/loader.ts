/**
 * Configuration Loader
 *
 * Loads and parses configuration from YAML/JSON files with environment variable substitution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { EventEmitter } from 'events';
import { Config } from '../types/config';

export interface LoaderOptions {
  readonly configPath: string;
  readonly watchForChanges?: boolean;
  readonly envPrefix?: string;
}

export class ConfigLoader extends EventEmitter {
  private readonly configPath: string;
  private readonly watchForChanges: boolean;
  private readonly envPrefix: string;
  private watcher?: fs.FSWatcher | undefined;
  private lastConfig?: Config;

  constructor(options: LoaderOptions) {
    super();
    this.configPath = path.resolve(options.configPath);
    this.watchForChanges = options.watchForChanges ?? false;
    this.envPrefix = options.envPrefix ?? 'MEV_';
  }

  /**
   * Load configuration from file with environment variable substitution
   */
  async load(): Promise<Config> {
    try {
      const configContent = await fs.promises.readFile(this.configPath, 'utf8');
      const substitutedContent = this.substituteEnvironmentVariables(configContent);

      let parsedConfig: any;
      const ext = path.extname(this.configPath).toLowerCase();

      if (ext === '.yaml' || ext === '.yml') {
        parsedConfig = yaml.parse(substitutedContent);
      } else if (ext === '.json') {
        parsedConfig = JSON.parse(substitutedContent);
      } else {
        throw new Error(`Unsupported configuration file format: ${ext}`);
      }

      const config = parsedConfig as Config;
      this.lastConfig = config;

      if (this.watchForChanges && !this.watcher) {
        this.setupFileWatcher();
      }

      return config;
    } catch (error) {
      throw new Error(`Failed to load configuration from ${this.configPath}: ${error}`);
    }
  }

  /**
   * Get the last loaded configuration
   */
  getLastConfig(): Config | undefined {
    return this.lastConfig;
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  /**
   * Substitute environment variables in configuration content
   * Supports ${VAR_NAME} and ${VAR_NAME:default_value} syntax
   */
  private substituteEnvironmentVariables(content: string): string {
    return content.replace(/\$\{([^}]+)\}/g, (_, varExpression) => {
      const colonIndex = varExpression.indexOf(':');
      const varName = colonIndex === -1 ? varExpression : varExpression.slice(0, colonIndex);
      const defaultValue = colonIndex === -1 ? undefined : varExpression.slice(colonIndex + 1);

      const fullVarName = varName.startsWith(this.envPrefix)
        ? varName
        : `${this.envPrefix}${varName}`;

      const envValue = process.env[fullVarName] || process.env[varName];

      if (envValue !== undefined) {
        return envValue;
      }

      if (defaultValue !== undefined) {
        return defaultValue;
      }

      throw new Error(`Environment variable ${fullVarName} is required but not set`);
    });
  }

  /**
   * Setup file watcher for hot reload
   */
  private setupFileWatcher(): void {
    this.watcher = fs.watch(this.configPath, { persistent: false }, async eventType => {
      if (eventType === 'change') {
        try {
          const newConfig = await this.load();
          this.emit('configChanged', newConfig, this.lastConfig);
        } catch (error) {
          this.emit('configError', error);
        }
      }
    });

    this.watcher.on('error', error => {
      this.emit('watcherError', error);
    });
  }
}
