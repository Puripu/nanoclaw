import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseModelProvider, AgentRequest, AgentResponse, ModelProviderContext, ModelProviderName } from './types.js';
import { DATA_DIR, GROUPS_DIR, MAIN_GROUP_FOLDER } from '../config.js';
import { logger } from '../logger.js';

export class GeminiProvider extends BaseModelProvider {
  getName(): ModelProviderName {
    return 'gemini';
  }

  async runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse> {
    const groupDir = path.join(GROUPS_DIR, request.groupFolder);
    const envDir = path.join(groupDir, '.env-dir');
    const projectRoot = process.cwd();
    const isMain = request.isMain || request.groupFolder === MAIN_GROUP_FOLDER;

    fs.mkdirSync(envDir, { recursive: true });

    // Write environment variables for the container
    // This allows the container to access API keys securely
    const envLines: string[] = [];
    if (process.env.GOOGLE_API_KEY) envLines.push(`GOOGLE_API_KEY=${process.env.GOOGLE_API_KEY}`);
    if (process.env.GEMINI_API_KEY) envLines.push(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
    if (process.env.BRAVE_API_KEY) envLines.push(`BRAVE_API_KEY=${process.env.BRAVE_API_KEY}`);
    if (process.env.OVERSEER_URL) envLines.push(`OVERSEER_URL=${process.env.OVERSEER_URL}`);
    if (process.env.OVERSEER_API) envLines.push(`OVERSEER_API=${process.env.OVERSEER_API}`);
    fs.writeFileSync(path.join(envDir, 'env'), envLines.join('\n') + '\n');

    const inputJson = JSON.stringify(request);
    const containerName = `nanoclaw-gemini-${request.groupFolder}-${Date.now()}`;

    // Ensure IPC directory exists
    const ipcDir = path.join(DATA_DIR, 'ipc', request.groupFolder);
    fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

    try {
      // Determine container runtime (preferring Docker as per requirements for Linux/Generic)
      const runtime = process.platform === 'darwin' ? 'container' : 'docker';
      const image = process.env.GEMINI_CONTAINER_IMAGE || 'nanoclaw-agent-gemini:latest';

      // Build volume mounts
      const mounts: string[] = [];

      if (runtime === 'docker') {
        // Main group gets access to the entire project
        if (isMain) {
          mounts.push(`-v "${projectRoot}:/workspace/project"`);
        }
        mounts.push(`-v "${groupDir}:/workspace/group"`);
        mounts.push(`-v "${ipcDir}:/workspace/ipc"`);
        mounts.push(`-v "${envDir}:/workspace/env-dir"`);
      } else {
        // Apple Container uses --mount syntax
        if (isMain) {
          mounts.push(`--mount type=bind,source="${projectRoot}",target=/workspace/project`);
        }
        mounts.push(`--mount type=bind,source="${groupDir}",target=/workspace/group`);
        mounts.push(`--mount type=bind,source="${ipcDir}",target=/workspace/ipc`);
        mounts.push(`--mount type=bind,source="${envDir}",target=/workspace/env-dir`);
      }

      const cmd = `${runtime} run --rm -i --name ${containerName} ${mounts.join(' ')} ${image}`;

      logger.debug({ group: request.groupFolder }, 'Starting Gemini agent container');

      // Debug logging for Overseerr Env Vars
      const overseerUrl = process.env.OVERSEER_URL || process.env.OVERSEERR_URL;
      const overseerApi = process.env.OVERSEER_API || process.env.OVERSEER_API || process.env.OVERSEERR_API_KEY; // check for typo in env
      if (overseerUrl) logger.debug('Overseerr URL found in environment');
      else logger.warn('Overseerr URL NOT found in environment');

      if (overseerApi) logger.debug('Overseerr API Key found in environment');
      else logger.warn('Overseerr API Key NOT found in environment');

      const output = await new Promise<string>((resolve, reject) => {
        // const { exec } = await import('child_process'); // Removed dynamic import
        const child = exec(cmd, {
          maxBuffer: 10 * 1024 * 1024, // 10MB
          timeout: 5 * 60 * 1000 // 5 minute timeout for agent execution
        }, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            // Check if we got partial output that might contain JSON
            if (stdout) resolve(stdout);
            else reject(new Error(`Container execution failed: ${error.message}\nStderr: ${stderr}`));
          } else {
            resolve(stdout);
          }
        });

        if (child.stdin) {
          child.stdin.write(inputJson);
          child.stdin.end();
        }
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
      try { fs.unlinkSync(path.join(envDir, 'env')); } catch { }
    }
  }
}