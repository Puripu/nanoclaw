/**
 * Model Provider Manager for NanoClaw
 * Manages per-group model provider selection with persistence
 */

import fs from 'fs';
import path from 'path';
import { ModelProviderName } from './types.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

interface ModelProviderStore {
  global_default: ModelProviderName;
  groups: Record<string, ModelProviderName>;
}

const PROVIDER_STORE_PATH = path.join(DATA_DIR, 'model_providers.json');

export class ModelProviderManager {
  private store: ModelProviderStore;

  constructor() {
    this.store = this.load();
  }

  private load(): ModelProviderStore {
    try {
      if (fs.existsSync(PROVIDER_STORE_PATH)) {
        const data = fs.readFileSync(PROVIDER_STORE_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        return {
          global_default: parsed.global_default || 'claude',
          groups: parsed.groups || {}
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load model provider store, using defaults');
    }

    return {
      global_default: 'claude',
      groups: {}
    };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(PROVIDER_STORE_PATH), { recursive: true });
      fs.writeFileSync(PROVIDER_STORE_PATH, JSON.stringify(this.store, null, 2));
    } catch (err) {
      logger.error({ err }, 'Failed to save model provider store');
    }
  }

  /**
   * Get the model provider for a specific group
   */
  getProviderForGroup(groupFolder: string): ModelProviderName {
    return this.store.groups[groupFolder] || this.store.global_default;
  }

  /**
   * Set the model provider for a specific group
   */
  setProviderForGroup(groupFolder: string, provider: ModelProviderName): void {
    this.store.groups[groupFolder] = provider;
    this.save();
    logger.info({ groupFolder, provider }, 'Group model provider updated');
  }

  /**
   * Clear the group-specific provider (revert to global default)
   */
  clearProviderForGroup(groupFolder: string): void {
    delete this.store.groups[groupFolder];
    this.save();
    logger.info({ groupFolder }, 'Group model provider cleared (using global default)');
  }

  /**
   * Set the global default provider
   */
  setGlobalDefault(provider: ModelProviderName): void {
    this.store.global_default = provider;
    this.save();
    logger.info({ provider }, 'Global default model provider updated');
  }

  /**
   * Get the global default provider
   */
  getGlobalDefault(): ModelProviderName {
    return this.store.global_default;
  }

  /**
   * Get all group-specific provider settings
   */
  getAllGroupSettings(): Record<string, ModelProviderName> {
    return { ...this.store.groups };
  }

  /**
   * Check if a group has a specific provider set (vs using global default)
   */
  hasGroupSpecificProvider(groupFolder: string): boolean {
    return groupFolder in this.store.groups;
  }
}

// Singleton instance
let managerInstance: ModelProviderManager | null = null;

export function getProviderManager(): ModelProviderManager {
  if (!managerInstance) {
    managerInstance = new ModelProviderManager();
  }
  return managerInstance;
}
