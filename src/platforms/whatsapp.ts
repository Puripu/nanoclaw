import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  DATA_DIR
} from '../config.js';
import { RegisteredGroup, NewMessage } from '../types.js';
import {
  storeMessage,
  storeChatMetadata,
  getNewMessages,
  updateChatName,
  getLastGroupSync,
  setLastGroupSync
} from '../db.js';
import { MessagingPlatform } from './types.js';
import { logger } from '../logger.js';
import { getAgentService } from '../agent-service.js';
import { registeredGroups, registerGroup, lastAgentTimestamp, saveState } from '../state.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class WhatsAppPlatform implements MessagingPlatform {
  name = 'WhatsApp';
  private sock: WASocket | null = null;
  private lidToPhoneMap: Record<string, string> = {};
  private isRunning = false;
  private poller: NodeJS.Timeout | null = null;
  private lastLoopTimestamp = '';

  async start(): Promise<void> {
    await this.connectWhatsApp();
    this.isRunning = true;
    this.startMessageLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.poller) clearTimeout(this.poller);
    if (this.sock) {
      this.sock.end(undefined);
    }
  }

  isJidForPlatform(jid: string): boolean {
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us');
  }

  isGroupForPlatform(groupFolder: string): boolean {
    // Check if any registered group with this folder is a WhatsApp JID
    return Object.entries(registeredGroups).some(([jid, group]) =>
      group.folder === groupFolder && this.isJidForPlatform(jid)
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendMessage(jid, { text });
      logger.info({ jid, length: text.length }, 'WhatsApp message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WhatsApp message');
    }
  }

  async sendPhoto(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.sock) return;
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      await this.sock.sendMessage(jid, {
        image: imageBuffer,
        caption: caption
      });
      logger.info({ jid, imagePath }, 'WhatsApp photo sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send WhatsApp photo');
    }
  }

  private translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const phoneJid = this.lidToPhoneMap[lidUser];
    if (phoneJid) {
      return phoneJid;
    }
    return jid;
  }

  private async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  private async syncGroupMetadata(force = false): Promise<void> {
    if (!this.sock) return;

    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        const now = Date.now();
        if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async connectWhatsApp(): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger: logger as any,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          this.connectWhatsApp();
        } else {
          logger.info('Logged out from WhatsApp.');
        }
      } else if (connection === 'open') {
        logger.info('Connected to WhatsApp');

        if (this.sock?.user) {
          const lidUser = this.sock.user.lid?.split(':')[0];
          const phoneUser = this.sock.user.id?.split(':')[0];
          if (lidUser && phoneUser) {
            const phoneJid = `${phoneUser}@s.whatsapp.net`;
            this.lidToPhoneMap[lidUser] = phoneJid;
          }
        }

        this.syncGroupMetadata();
        setInterval(() => this.syncGroupMetadata(), GROUP_SYNC_INTERVAL_MS);
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = this.translateJid(rawJid);
        const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

        storeChatMetadata(chatJid, timestamp);

        // Store message if registered
        if (registeredGroups[chatJid]) {
          storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
        }
      }
    });
  }

  private async startMessageLoop(): Promise<void> {
    if (!this.isRunning) return;
    this.pollMessages();
  }

  private async pollMessages() {
     if (!this.isRunning) return;

     try {
        if (this.lastLoopTimestamp === '') {
            const statePath = path.join(DATA_DIR, 'router_state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8') || '{}');
            this.lastLoopTimestamp = state.last_timestamp || new Date().toISOString();
        }

        const jids = Object.keys(registeredGroups).filter(jid => this.isJidForPlatform(jid));
        if (jids.length > 0) {
            const { messages } = getNewMessages(jids, this.lastLoopTimestamp, ASSISTANT_NAME);

            if (messages.length > 0) {
                for (const msg of messages) {
                    try {
                       await this.processWhatsAppMessage(msg);
                       this.lastLoopTimestamp = msg.timestamp;

                       // Save state
                       const statePath = path.join(DATA_DIR, 'router_state.json');
                       const state = JSON.parse(fs.readFileSync(statePath, 'utf-8') || '{}');
                       state.last_timestamp = this.lastLoopTimestamp;
                       fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
                    } catch (err) {
                        logger.error({ err, msg: msg.id }, 'Error processing message');
                    }
                }
            }
        }
     } catch (err) {
         logger.error({ err }, 'Error in WhatsApp poll');
     }

     this.poller = setTimeout(() => this.pollMessages(), POLL_INTERVAL);
  }

  private async processWhatsAppMessage(msg: NewMessage): Promise<void> {
    const group = registeredGroups[msg.chat_jid];
    if (!group) return;

    const content = msg.content.trim();
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

    // Trigger check
    if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

    await this.setTyping(msg.chat_jid, true);

    // Delegate to AgentService
    const agentService = getAgentService();
    await agentService.processMessage(
        msg.chat_jid,
        msg.sender_name,
        content,
        msg.timestamp,
        'WhatsApp'
    );

    await this.setTyping(msg.chat_jid, false);
  }
}
