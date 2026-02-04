/**
 * Gemini Model Provider for NanoClaw
 * Uses Gemini via containerized execution
 */

import {
  BaseModelProvider,
  AgentRequest,
  AgentResponse,
  ModelProviderContext,
  ModelProviderName
} from './types.js';
import {
  getContainerRuntime,
  buildVolumeMounts,
  spawnContainerAgent
} from '../container-utils.js';

// Container image for Gemini
const GEMINI_CONTAINER_IMAGE = process.env.GEMINI_CONTAINER_IMAGE || 'nanoclaw-agent-gemini:latest';

export class GeminiProvider extends BaseModelProvider {
  private runtime: 'docker' | 'container';

  constructor() {
    super();
    this.runtime = getContainerRuntime();
  }

  getName(): ModelProviderName {
    return 'gemini';
  }

  async runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse> {
    const { group, logsDir } = context;

    const mounts = buildVolumeMounts(group, request.isMain);

    // Prepare input for the container
    const containerInput = {
      prompt: request.prompt,
      sessionId: request.sessionId,
      groupFolder: request.groupFolder,
      chatJid: request.chatJid,
      isMain: request.isMain,
      isScheduledTask: request.isScheduledTask,
      containerConfig: group.containerConfig
    };

    return spawnContainerAgent({
      runtime: this.runtime,
      containerImage: GEMINI_CONTAINER_IMAGE,
      mounts,
      input: containerInput,
      logPrefix: 'gemini',
      logsDir
    });
  }
}
