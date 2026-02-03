/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';
import { createBrowserMcp } from './browser-mcp.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  // Use process.stderr.write for unbuffered output to ensure we see diagnostics even on crash
  process.stderr.write(`[agent-runner] ${message}\n`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  // sessions-index.json is in the same directory as the transcript
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Run diagnostic checks to identify common configuration issues.
 */
async function runDoctor(): Promise<void> {
  log('Running diagnostic checks...');

  // 1. Check Authentication
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const eula = process.env.CLAUDE_CODE_EULA_ACCEPTED;
  const skip = process.env.CLAUDE_CODE_SKIP_PERMISSION_CHECKS;

  if (!oauthToken && !apiKey) {
    log('WARNING: No authentication token found (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)');
  } else {
    if (oauthToken) {
      const masked = oauthToken.length > 10 ? `${oauthToken.slice(0, 5)}...${oauthToken.slice(-5)}` : '***';
      log(`Auth: OAuth token present (length: ${oauthToken.length}, value: ${masked})`);
    }
    if (apiKey) {
      const masked = apiKey.length > 10 ? `${apiKey.slice(0, 5)}...${apiKey.slice(-5)}` : '***';
      log(`Auth: API key present (length: ${apiKey.length}, value: ${masked})`);
    }
  }
  log(`Config: EULA accepted: ${eula}, Skip permissions: ${skip}`);

  // 2. Check Permissions
  const sessionsDir = '/home/node/.claude';
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const testFile = path.join(sessionsDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    log('Permissions: .claude directory is writable');
  } catch (err) {
    log(`ERROR: .claude directory is NOT writable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Check Connectivity
  const dns = await import('dns/promises');
  const hosts = ['api.anthropic.com', 'api.telegram.org', 'google.com'];
  for (const host of hosts) {
    try {
      const addr = await dns.lookup(host);
      log(`Network: ${host} resolved to ${addr.address}`);
    } catch (err) {
      log(`Network ERROR: Failed to resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Check Claude CLI
  const { execSync } = await import('child_process');
  try {
    const version = execSync('claude --version', { encoding: 'utf8' }).trim();
    log(`Claude CLI: ${version} is available`);

    // 5. Test Run (minimal prompt)
    log('Testing Claude CLI with minimal prompt...');
    const testOutput = execSync('claude -p "hi" --allowedTools ""', {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_EULA_ACCEPTED: 'true' },
      timeout: 30000
    }).trim();
    log(`Claude CLI Test Success: ${testOutput.slice(0, 50)}...`);
  } catch (err) {
    log(`ERROR: Claude CLI check failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err && typeof err === 'object' && 'stderr' in err) {
      log(`Claude CLI Test Stderr: ${String(err.stderr)}`);
    }
  }
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);

    // Run diagnostics if requested or on error (we'll run them always for now to help debug)
    await runDoctor();
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  try {
    log('Starting agent...');

    for await (const message of query({
      prompt,
      options: {
        cwd: '/workspace/group',
        resume: input.sessionId,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'mcp__nanoclaw__*',
          'mcp__browser__*'
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: ipcMcp,
          browser: createBrowserMcp()
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook()] }]
        }
      }
    })) {
      // Verbose logging of all messages to identify where the crash happens
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      } else if (message.type === 'assistant' && 'content' in message) {
        // Just log a snippet of assistant content
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        log(`Assistant: ${content.slice(0, 50)}...`);
      } else if (message.type === 'stream_event') {
        const event = (message as any).event;
        if (event?.type === 'tool_use_start') {
          log(`Tool Use: ${event.tool_name}`);
        }
      }

      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }

    log('Agent completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    log(`Agent error: ${errorMessage}${stack ? `\n${stack}` : ''}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
