/**
 * Provider Factory for NanoClaw
 * Creates and caches model provider instances
 */

import { BaseModelProvider, ModelProviderName } from './types.js';
import { ClaudeProvider } from './claude-provider.js';
import { GeminiProvider } from './gemini-provider.js';

export class ProviderFactory {
  private static providers: Map<ModelProviderName, BaseModelProvider> = new Map();

  static getProvider(providerName: ModelProviderName): BaseModelProvider {
    if (!this.providers.has(providerName)) {
      switch (providerName) {
        case 'claude':
          this.providers.set('claude', new ClaudeProvider());
          break;
        case 'gemini':
          this.providers.set('gemini', new GeminiProvider());
          break;
        default:
          throw new Error(`Unknown provider: ${providerName}`);
      }
    }
    return this.providers.get(providerName)!;
  }

  static getAvailableProviders(): ModelProviderName[] {
    return ['claude', 'gemini'];
  }
}
