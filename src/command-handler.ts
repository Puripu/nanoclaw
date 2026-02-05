/**
 * Command Handler for NanoClaw
 * Handles special commands like /model for switching AI providers
 */

import fs from 'fs';
import path from 'path';
import { getProviderManager, ProviderFactory, ModelProviderName } from './model-providers/index.js';
import { GROUPS_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
  clearSession?: boolean;  // Signal to caller to clear session state
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

  // Check for /clear or /reset command
  if (trimmed === '/clear' || trimmed === '/reset') {
    const response = handleClearCommand(groupFolder);
    return { handled: true, response, clearSession: true };
  }

  // Check for /help command
  if (trimmed === '/help') {
    return { handled: true, response: getHelpText(isMain) };
  }

  return { handled: false };
}

/**
 * Handle /clear command - reset conversation context
 */
function handleClearCommand(groupFolder: string): string {
  // Clear Gemini session file if it exists
  const geminiSessionPath = path.join(GROUPS_DIR, groupFolder, '.gemini-session.json');
  try {
    if (fs.existsSync(geminiSessionPath)) {
      fs.unlinkSync(geminiSessionPath);
      logger.info({ groupFolder }, 'Cleared Gemini session file');
    }
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to clear Gemini session file');
  }

  // Clear Claude session directory contents
  const claudeSessionDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  try {
    if (fs.existsSync(claudeSessionDir)) {
      const files = fs.readdirSync(claudeSessionDir);
      for (const file of files) {
        const filePath = path.join(claudeSessionDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
        }
      }
      logger.info({ groupFolder }, 'Cleared Claude session directory');
    }
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to clear Claude session directory');
  }

  return `Context cleared. Starting fresh conversation.`;
}

/**
 * Get help text for all commands
 */
function getHelpText(isMain: boolean): string {
  let help = `*Available Commands*\n\n`;
  help += `*/clear* or */reset* - Clear conversation history and start fresh\n`;
  help += `*/model* - Show/switch AI model (claude or gemini)\n`;
  help += `*/help* - Show this help message\n`;

  if (isMain) {
    help += `\n*Main group only:*\n`;
    help += `*/model global <provider>* - Set default model for all groups\n`;
  }

  return help;
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

  help += `\nClaude is best for coding (indexes files). Gemini is faster/cheaper (manual file access).`;

  return help;
}
