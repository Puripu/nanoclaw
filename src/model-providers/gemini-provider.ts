import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseModelProvider, AgentRequest, AgentResponse, ModelProviderContext, ModelProviderName } from './types.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

export class GeminiProvider extends BaseModelProvider {
  getName(): ModelProviderName {
    return 'gemini';
  }

  async runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse> {
    const groupDir = path.join(GROUPS_DIR, request.groupFolder);
    const envDir = path.join(groupDir, '.env-dir');
    fs.mkdirSync(envDir, { recursive: true });

    // Write environment variables for the container
    // This allows the container to access the Gemini API Key securely
    const envContent = `GOOGLE_API_KEY=${process.env.GOOGLE_API_KEY}\n`;
    fs.writeFileSync(path.join(envDir, 'env'), envContent);

    const inputJson = JSON.stringify(request);
    const containerName = `nanoclaw-gemini-${request.groupFolder}-${Date.now()}`;

    try {
      // Determine container runtime (preferring Docker as per requirements for Linux/Generic)
      const runtime = process.platform === 'darwin' ? 'container' : 'docker';
      const image = process.env.GEMINI_CONTAINER_IMAGE || 'nanoclaw-agent-gemini:latest';
      
      let cmd = '';
      if (runtime === 'docker') {
        cmd = `docker run --rm -i \
          --name ${containerName} \
          -v "${groupDir}:/workspace/group" \
          -v "${path.join(DATA_DIR, 'ipc', request.groupFolder)}:/workspace/ipc" \
          -v "${envDir}:/workspace/env-dir" \
          ${image}`;
      } else {
        cmd = `container run --rm -i \
          --name ${containerName} \
          --mount type=bind,source="${groupDir}",target=/workspace/group \
          --mount type=bind,source="${path.join(DATA_DIR, 'ipc', request.groupFolder)}",target=/workspace/ipc \
          --mount type=bind,source="${envDir}",target=/workspace/env-dir \
          ${image}`;
      }

      logger.debug({ group: request.groupFolder }, 'Starting Gemini agent container');
      
      const output = execSync(cmd, {
        input: inputJson,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      try {
        const result = JSON.parse(output);
        return {
          status: 'success',
          result: result.output,
          newSessionId: result.sessionId
        };
      } catch (parseErr) {
        logger.error({ output, parseErr }, 'Failed to parse agent output');
        return { status: 'error', result: null, error: 'Invalid JSON response from agent' };
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Container execution failed');
      return { status: 'error', result: null, error: err.message };
    } finally {
      // Cleanup env file
      try { fs.unlinkSync(path.join(envDir, 'env')); } catch {}
    }
  }
}