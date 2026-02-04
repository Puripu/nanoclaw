/**
 * Discord Platform Integration
 */

import { Client, GatewayIntentBits, Message, TextChannel, Partials } from 'discord.js';
import path from 'path';
import fs from 'fs';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { handleCommand } from '../command-handler.js';
import { MessagingPlatform } from './types.js';
import { getAgentService } from '../agent-service.js';
import { registerGroup, registeredGroups } from '../state.js';
import { loadJson, saveJson } from '../utils.js';

export const DISCORD_GROUP_FOLDER = 'discord';
export const DISCORD_JID_PREFIX = 'discord-';

interface DiscordChannelConfig {
  mode: 'mention' | 'always';
  enabled: boolean;
}

interface DiscordState {
  channelConfigs: Record<string, DiscordChannelConfig>;
  defaultMode: 'mention' | 'always';
}

export class DiscordPlatform implements MessagingPlatform {
  name = 'Discord';
  private client: Client | null = null;
  private state: DiscordState = {
    channelConfigs: {},
    defaultMode: 'mention'
  };

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      logger.info('DISCORD_BOT_TOKEN not set, skipping Discord bot');
      return;
    }

    this.loadDiscordState();
    this.ensureDiscordFolder();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      partials: [Partials.Channel]
    });

    this.client.on('ready', () => {
      logger.info({ user: this.client?.user?.tag }, 'Discord bot logged in');
    });

    this.client.on('messageCreate', async (message: Message) => {
      if (message.author.bot) return;

      const channelId = message.channel.id;
      const userId = message.author.id;
      const username = message.author.displayName || message.author.username;
      const content = message.content;

      if (content.startsWith('!bob ')) {
        await this.handleBotCommand(message);
        return;
      }

      if (content.startsWith('/model')) {
        const result = handleCommand(content, DISCORD_GROUP_FOLDER, false);
        if (result.handled && result.response) {
          await message.reply(result.response);
        }
        return;
      }

      const mode = this.getChannelMode(channelId);
      const isMentioned = this.client?.user ? message.mentions.has(this.client.user) : false;

      if (mode === 'mention' && !isMentioned) return;

      let cleanContent = content;
      if (isMentioned && this.client?.user) {
        cleanContent = content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
      }

      if (!cleanContent) return;

      // Auto-register JID
      const jid = `${DISCORD_JID_PREFIX}${channelId}`;
      if (!registeredGroups[jid]) {
          registerGroup(jid, {
              name: `Discord ${channelId}`,
              folder: DISCORD_GROUP_FOLDER,
              trigger: '',
              added_at: new Date().toISOString()
          });
      }

      logger.info({ channelId, userId, username, contentLength: cleanContent.length, mode }, 'Discord message received');

      try {
        await (message.channel as TextChannel).sendTyping();
      } catch (err) {
        logger.debug({ err }, 'Failed to send typing indicator');
      }

      try {
          const agentService = getAgentService();
          await agentService.processMessage(
              jid,
              username,
              cleanContent,
              new Date().toISOString(),
              'Discord'
          );
      } catch (err) {
        logger.error({ err }, 'Error processing Discord message');
        await message.reply('Sorry, something went wrong. Please try again.');
      }
    });

    await this.client.login(token);
    logger.info('Discord bot started');
  }

  async stop(): Promise<void> {
    if (this.client) {
        await this.client.destroy();
    }
  }

  isJidForPlatform(jid: string): boolean {
    return jid.startsWith(DISCORD_JID_PREFIX);
  }

  isGroupForPlatform(groupFolder: string): boolean {
    return groupFolder === DISCORD_GROUP_FOLDER;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) return;

    const actualChannelId = jid.startsWith(DISCORD_JID_PREFIX)
      ? jid.slice(DISCORD_JID_PREFIX.length)
      : jid;

    const channel = await this.client.channels.fetch(actualChannelId);
    if (!channel || !('send' in channel)) {
       logger.error({ channelId: actualChannelId }, 'Discord channel not found');
       return;
    }

    const sendableChannel = channel as TextChannel;
    const maxLength = 1900;

    if (text.length <= maxLength) {
        await sendableChannel.send(text);
    } else {
        const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'gs')) || [];
        for (const chunk of chunks) {
            await sendableChannel.send(chunk);
        }
    }
  }

  async sendPhoto(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.client) return;

    const actualChannelId = jid.startsWith(DISCORD_JID_PREFIX)
      ? jid.slice(DISCORD_JID_PREFIX.length)
      : jid;

    const channel = await this.client.channels.fetch(actualChannelId);
    if (channel && 'send' in channel) {
        await (channel as TextChannel).send({
            content: caption,
            files: [imagePath]
        });
    }
  }

  private getStatePath(): string {
    return path.join(DATA_DIR, 'discord_state.json');
  }

  private loadDiscordState(): void {
    const state = loadJson<Partial<DiscordState>>(this.getStatePath(), {});
    this.state = {
      channelConfigs: state.channelConfigs || {},
      defaultMode: state.defaultMode || 'mention'
    };
  }

  private saveDiscordState(): void {
    saveJson(this.getStatePath(), this.state);
  }

  private getChannelMode(channelId: string): 'mention' | 'always' {
    const config = this.state.channelConfigs[channelId];
    if (config && !config.enabled) return 'mention';
    return config?.mode || this.state.defaultMode;
  }

  private setChannelMode(channelId: string, mode: 'mention' | 'always', enabled = true): void {
    this.state.channelConfigs[channelId] = { mode, enabled };
    this.saveDiscordState();
  }

  private async handleBotCommand(message: Message): Promise<void> {
    const args = message.content.slice(5).trim().split(/\s+/);
    const command = args[0]?.toLowerCase();

    switch (command) {
      case 'mode': {
        const mode = args[1]?.toLowerCase();
        if (mode === 'always' || mode === 'mention') {
          this.setChannelMode(message.channel.id, mode);
          await message.reply(`Channel mode set to **${mode}**.`);
        }
        break;
      }
      case 'status': {
        const config = this.state.channelConfigs[message.channel.id];
        await message.reply(`Mode: ${config?.mode || this.state.defaultMode}`);
        break;
      }
      case 'help':
      default:
        await message.reply('Commands: `!bob mode always|mention`, `!bob status`');
    }
  }

  private ensureDiscordFolder(): void {
    const groupDir = path.join(DATA_DIR, '..', 'groups', DISCORD_GROUP_FOLDER);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    if (!fs.existsSync(path.join(groupDir, 'CLAUDE.md'))) {
        fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), `# ${ASSISTANT_NAME}\nDiscord Assistant`);
    }
  }
}
