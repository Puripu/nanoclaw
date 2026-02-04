/**
 * Model Provider Types for NanoClaw
 * Defines the interface for interchangeable AI model providers
 */

import { RegisteredGroup } from '../types.js';

export type ModelProviderName = 'claude' | 'gemini';

export interface AgentRequest {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface AgentResponse {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ModelProviderContext {
  group: RegisteredGroup;
  logsDir: string;
}

export abstract class BaseModelProvider {
  abstract getName(): ModelProviderName;
  abstract runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse>;
}
