/**
 * Command Handler for NanoClaw
 * Handles special commands like /model for switching AI providers
 */

import { getProviderManager, ProviderFactory, ModelProviderName } from './model-providers/index.js';
import { logger } from './logger.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
}

/**
 * Check if a message is a command and handle it
 */
export function handleCommand(
  message: string,
  groupFolder: string,
  isMain: boolean
): CommandResult {
  const trimmed = message.trim();

  // Check for /model command
  if (trimmed.startsWith('/model')) {
    const args = trimmed.slice(6).trim().split(/\s+/).filter(Boolean);
    const response = handleModelCommand(args, groupFolder, isMain);
    return { handled: true, response };
  }

  return { handled: false };
}

/**
 * Handle /model command for switching AI providers
 */
function handleModelCommand(
  args: string[],
  groupFolder: string,
  isMain: boolean
): string {
  const providerManager = getProviderManager();
  const subcommand = args[0]?.toLowerCase();

  // /model or /model status - show current status
  if (!subcommand || subcommand === 'status') {
    const current = providerManager.getProviderForGroup(groupFolder);
    const globalDefault = providerManager.getGlobalDefault();
    const hasOverride = providerManager.hasGroupSpecificProvider(groupFolder);
    const available = ProviderFactory.getAvailableProviders();

    let response = `*Model Status*\n`;
    response += `Current: *${current}*${hasOverride ? '' : ' (using global default)'}\n`;
    response += `Global default: ${globalDefault}\n`;
    response += `Available: ${available.join(', ')}`;

    if (isMain) {
      const allSettings = providerManager.getAllGroupSettings();
      const groups = Object.entries(allSettings);
      if (groups.length > 0) {
        response += `\n\nGroup overrides:\n`;
        for (const [group, provider] of groups) {
          response += `- ${group}: ${provider}\n`;
        }
      }
    }

    return response;
  }

  // /model claude or /model gemini - switch this group
  if (subcommand === 'claude' || subcommand === 'gemini') {
    const provider = subcommand as ModelProviderName;
    providerManager.setProviderForGroup(groupFolder, provider);
    logger.info({ groupFolder, provider }, 'Model provider switched via command');
    return `Switched to *${provider}* for this group. Future messages will use ${provider}.`;
  }

  // /model reset - clear group override, use global default
  if (subcommand === 'reset' || subcommand === 'clear') {
    providerManager.clearProviderForGroup(groupFolder);
    const globalDefault = providerManager.getGlobalDefault();
    logger.info({ groupFolder }, 'Model provider reset to global default');
    return `Reset to global default (*${globalDefault}*) for this group.`;
  }

  // /model global <provider> - set global default (main only)
  if (subcommand === 'global') {
    if (!isMain) {
      return `The /model global command can only be used from the main group.`;
    }

    const provider = args[1]?.toLowerCase();
    if (provider === 'claude' || provider === 'gemini') {
      providerManager.setGlobalDefault(provider as ModelProviderName);
      logger.info({ provider }, 'Global default model provider changed');
      return `Global default set to *${provider}*. New groups will use ${provider} by default.`;
    }

    return `Usage: /model global <claude|gemini>`;
  }

  // /model help
  if (subcommand === 'help') {
    return getModelHelp(isMain);
  }

  // Unknown subcommand
  return `Unknown /model subcommand: ${subcommand}\n\n${getModelHelp(isMain)}`;
}

function getModelHelp(isMain: boolean): string {
  let help = `*/model* - AI model selection\n\n`;
  help += `Commands:\n`;
  help += `• /model status - Show current model\n`;
  help += `• /model claude - Switch to Claude\n`;
  help += `• /model gemini - Switch to Gemini\n`;
  help += `• /model reset - Use global default\n`;

  if (isMain) {
    help += `• /model global <claude|gemini> - Set global default\n`;
  }

  help += `\nClaude is best for coding tasks. Gemini is faster and cheaper for general questions.`;

  return help;
}
