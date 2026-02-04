import { RegisteredGroup } from '../types.js';

export interface MessagingPlatform {
  /**
   * Platform name (e.g., 'WhatsApp', 'Telegram', 'Discord')
   */
  name: string;

  /**
   * Start the platform bot/client
   */
  start(): Promise<void>;

  /**
   * Stop the platform bot/client
   */
  stop(): Promise<void>;

  /**
   * Send a text message
   */
  sendMessage(jid: string, text: string): Promise<void>;

  /**
   * Send a photo
   */
  sendPhoto(jid: string, imagePath: string, caption?: string): Promise<void>;

  /**
   * Check if a JID belongs to this platform
   */
  isJidForPlatform(jid: string): boolean;

  /**
   * Check if a group folder belongs to this platform (for IPC routing)
   */
  isGroupForPlatform(groupFolder: string): boolean;
}
