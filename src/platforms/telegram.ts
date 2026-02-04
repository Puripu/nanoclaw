/**
 * Telegram Platform Integration
 */

import dns from 'dns';
import https from 'https';

// Workaround for DNS resolution issues - force IPv4 only
dns.setDefaultResultOrder('ipv4first');

// Create custom HTTPS agent that forces IPv4
const ipv4Agent = new https.Agent({
  family: 4,  // Force IPv4
  keepAlive: true
});

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import path from 'path';
import fs from 'fs';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { handleCommand } from '../command-handler.js';
import { MessagingPlatform } from './types.js';
import { getAgentService } from '../agent-service.js';
import { registerGroup, registeredGroups } from '../state.js';

export const TELEGRAM_GROUP_FOLDER = 'telegram';
export const TELEGRAM_JID = 'telegram@bot';

export class TelegramPlatform implements MessagingPlatform {
  name = 'Telegram';
  private bot: Telegraf | null = null;
  private defaultChatId: string | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.info('TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
      return;
    }

    // Diagnostics
    try {
      const dnsPromises = await import('dns/promises');
      const addr = await dnsPromises.lookup('api.telegram.org');
      logger.info({ host: 'api.telegram.org', address: addr.address }, 'Telegram API host resolved');
    } catch (err) {
      logger.error({ err }, 'Failed to resolve api.telegram.org. Bot may fail to connect.');
    }

    this.ensureTelegramFolder();

    this.bot = new Telegraf(token, {
      telegram: {
        agent: ipv4Agent
      }
    });

    // Register generic Telegram group if not exists
    if (!registeredGroups[TELEGRAM_JID]) {
        const telegramGroup: RegisteredGroup = {
            name: 'Telegram',
            folder: TELEGRAM_GROUP_FOLDER,
            trigger: '',
            added_at: new Date().toISOString()
        };
        registerGroup(TELEGRAM_JID, telegramGroup);
    }

    this.bot.on(message('text'), async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const userId = ctx.from?.id.toString() || 'unknown';
      const username = ctx.from?.username || ctx.from?.first_name || 'User';
      const text = ctx.message.text;

      // Map chat ID to JID
      // We use a specific JID for each chat to allow separation,
      // but for "Same options" we need to register them.
      // The original code treated all Telegram chats as one session (TELEGRAM_JID) mostly,
      // BUT it used `sessionKey = ...-telegram-${chatId}` for sessions.
      // AgentService expects `registeredGroups` to find the group folder.

      // If we want each chat to be independent, we should probably auto-register them?
      // Or map them all to the 'telegram' folder but use different session IDs?
      // `AgentService.runAgent` uses `sessions[group.folder]`.
      // This implies ONE session per folder.
      // So if we map all chats to `telegram` folder, they share context/session?

      // Original code:
      // const sessionKey = `${providerName}-telegram-${chatId}`;
      // const sessionId = telegramSessions[sessionKey];

      // It seems original code maintained separate sessions per chat ID manually, ignoring `sessions.json` structure partially?
      // `telegramSessions` was a separate state file! `telegram_state.json`.

      // To standardize, we should probably treat each Telegram chat as a "Group" or map them to the same group but fix session management.
      // But `AgentService` uses `sessions[group.folder]`.

      // If we want "Same options", maybe we should just use the `telegram` folder for all,
      // but that means shared context.

      // For now, I will stick to the original logic where possible:
      // Map this chat to `TELEGRAM_JID` (the generic one) but that implies shared session.
      // The original code was: `sessionId = telegramSessions[sessionKey]` and passed it to `runContainerAgent`.

      // `AgentService.runAgent` uses `sessions[group.folder]`.
      // To support multi-session per folder, `AgentService` needs to be smarter or `runContainerAgent` needs to handle it.

      // I'll use a dynamic JID: `telegram-${chatId}`.
      // And I need to ensure this JID is registered to `telegram` folder.
      const dynamicJid = `telegram-${chatId}`;
      if (!registeredGroups[dynamicJid]) {
           registerGroup(dynamicJid, {
               name: `Telegram ${username}`,
               folder: TELEGRAM_GROUP_FOLDER,
               trigger: '',
               added_at: new Date().toISOString()
           });
      }

      logger.info({ chatId, userId, username, textLength: text.length }, 'Telegram message received');
      this.defaultChatId = chatId;

      // Handle /model commands
      if (text.startsWith('/model')) {
        const result = handleCommand(text, TELEGRAM_GROUP_FOLDER, false);
        if (result.handled && result.response) {
          await ctx.reply(result.response, { parse_mode: 'Markdown' }).catch(() => {
            return ctx.reply(result.response!);
          });
        }
        return;
      }

      await ctx.sendChatAction('typing');

      try {
          const agentService = getAgentService();
          await agentService.processMessage(
              dynamicJid,
              username,
              text,
              new Date().toISOString(),
              'Telegram'
          );
      } catch (err) {
          logger.error({ err }, 'Error processing Telegram message');
          await ctx.reply('Sorry, something went wrong. Please try again.');
      }
    });

    this.bot.command('start', (ctx) => {
      ctx.reply(`Hello! I'm ${ASSISTANT_NAME}. Just send me a message and I'll help you out.`);
    });

    this.bot.launch();
    this.isRunning = true;
    logger.info('Telegram bot started');

    // Graceful shutdown
    process.once('SIGINT', () => this.stop());
    process.once('SIGTERM', () => this.stop());
  }

  async stop(): Promise<void> {
    if (this.bot && this.isRunning) {
        this.bot.stop();
        this.isRunning = false;
    }
  }

  isJidForPlatform(jid: string): boolean {
    return jid === TELEGRAM_JID || jid.startsWith('telegram-');
  }

  isGroupForPlatform(groupFolder: string): boolean {
      return groupFolder === TELEGRAM_GROUP_FOLDER;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) return;

    // Extract chat ID
    let chatId = jid;
    if (jid.startsWith('telegram-')) {
        chatId = jid.replace('telegram-', '');
    } else if (jid === TELEGRAM_JID && this.defaultChatId) {
        chatId = this.defaultChatId;
    } else if (jid === TELEGRAM_JID) {
        logger.warn('Cannot send to generic telegram JID without context');
        return;
    }

    const maxLength = 4000;
    if (text.length <= maxLength) {
      await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {
        return this.bot!.telegram.sendMessage(chatId, text);
      });
    } else {
      const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'gs')) || [];
      for (const chunk of chunks) {
        await this.bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
          return this.bot!.telegram.sendMessage(chatId, chunk);
        });
      }
    }
  }

  async sendPhoto(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.bot) return;

    let chatId = jid;
    if (jid.startsWith('telegram-')) {
        chatId = jid.replace('telegram-', '');
    } else if (jid === TELEGRAM_JID && this.defaultChatId) {
        chatId = this.defaultChatId;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    await this.bot.telegram.sendPhoto(chatId, { source: imageBuffer }, { caption });
  }

  private ensureTelegramFolder(): void {
    const groupDir = path.join(DATA_DIR, '..', 'groups', TELEGRAM_GROUP_FOLDER);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
        // Create default CLAUDE.md
        const content = `# ${ASSISTANT_NAME}
You are ${ASSISTANT_NAME}, a personal assistant communicating via Telegram.
## What You Can Do
- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
`;
        fs.writeFileSync(claudeMdPath, content);
    }
  }
}
