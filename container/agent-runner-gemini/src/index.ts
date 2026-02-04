/**
 * NanoClaw Gemini Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses Google Generative AI SDK with function calling
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';
import { GoogleGenerativeAI, FunctionDeclaration, SchemaType, Part, Content } from '@google/generative-ai';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  provider?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  output: string | null;
  sessionId?: string;
  error?: string;
}

interface ConversationMessage {
  role: 'user' | 'model';
  parts: Part[];
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

/**
 * Helper to sleep for a given number of milliseconds
 */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps an API call with retry logic for 429 (Rate Limit) errors
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (err.message?.includes('429') || err.message?.includes('Resource exhausted')) {
        const delay = Math.pow(2, i) * 2000; // 2s, 4s, 8s
        log(`Rate limited (429). Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function writeOutput(output: ContainerOutput): void {
  console.log(JSON.stringify(output));
}

function log(message: string): void {
  console.error(`[gemini-agent] ${message}`);
}

// HTTP fetch helper
function fetchUrl(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const timeout = 30000;

    const makeRequest = (targetUrl: string, redirectsLeft: number) => {
      const req = protocol.get(targetUrl, { timeout }, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            const parsedUrl = new URL(targetUrl);
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
          }
          makeRequest(redirectUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    };

    makeRequest(url, maxRedirects);
  });
}

// Simple HTML to text converter
function htmlToText(html: string): string {
  return html
    // Remove script and style elements
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Replace common block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Session management
function getSessionPath(groupFolder: string): string {
  // Store session in the mounted group directory so it persists across container runs
  return `/workspace/group/.gemini-session.json`;
}

function loadSession(groupFolder: string): ConversationMessage[] {
  const sessionPath = getSessionPath(groupFolder);
  try {
    if (fs.existsSync(sessionPath)) {
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      const rawMessages = data.messages || [];
      
      // Filter and validate history
      const cleanHistory: ConversationMessage[] = [];
      let expectedRole: 'user' | 'model' = 'user';

      for (const msg of rawMessages) {
        // Only accept user/model roles and ensure they alternate
        if (msg.role === expectedRole) {
          // Ensure user messages have text
          if (msg.role === 'user' && !msg.parts.some((p: any) => 'text' in p)) {
            continue;
          }
          cleanHistory.push(msg);
          expectedRole = expectedRole === 'user' ? 'model' : 'user';
        }
      }

      // History must end with a 'model' message so the next turn can be 'user'
      while (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role !== 'model') {
        cleanHistory.pop();
      }

      // Keep only last 20 messages (10 turns) to avoid context overflow
      return cleanHistory.slice(-20);
    }
  } catch (err) {
    log(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

function saveSession(groupFolder: string, messages: ConversationMessage[]): void {
  const sessionPath = getSessionPath(groupFolder);
  const sessionDir = path.dirname(sessionPath);
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ messages }, null, 2));
  } catch (err) {
    log(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Tool definitions for Gemini function calling
const tools: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: 'Path to the file to read'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: 'Path to the file to write'
        },
        content: {
          type: SchemaType.STRING,
          description: 'Content to write to the file'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return output',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        command: {
          type: SchemaType.STRING,
          description: 'The shell command to execute'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: 'Path to the directory to list'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'send_message',
    description: 'Send a message back to the chat',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        text: {
          type: SchemaType.STRING,
          description: 'The message text to send'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Returns search results with titles, URLs, and snippets.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'The search query'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns the text content of the webpage.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: {
          type: SchemaType.STRING,
          description: 'The URL to fetch'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'use_browser',
    description: 'Interact with a web browser to search, click, type, or read pages. Use this for any web-based tasks.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        command: {
          type: SchemaType.STRING,
          description: "The agent-browser command (e.g., 'search for weather in London', 'click @e1', 'go to https://github.com')"
        }
      },
      required: ['command']
    }
  }
];

// Tool implementations
async function executeToolCall(name: string, args: Record<string, string>, chatJid: string, groupFolder: string): Promise<string> {
  try {
    switch (name) {
      case 'read_file': {
        const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
        if (!fs.existsSync(filePath)) {
          return `Error: File not found: ${filePath}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.length > 10000 ? content.slice(0, 10000) + '\n...(truncated)' : content;
      }

      case 'write_file': {
        const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, args.content);
        return `File written successfully: ${filePath}`;
      }

      case 'run_command': {
        try {
          const output = execSync(args.command, {
            encoding: 'utf-8',
            timeout: 30000,
            cwd: '/workspace/group',
            maxBuffer: 1024 * 1024
          });
          return output.length > 5000 ? output.slice(0, 5000) + '\n...(truncated)' : output;
        } catch (err: unknown) {
          const execError = err as { stderr?: string; message: string };
          return `Command error: ${execError.stderr || execError.message}`;
        }
      }

      case 'list_files': {
        const dirPath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
        if (!fs.existsSync(dirPath)) {
          return `Error: Directory not found: ${dirPath}`;
        }
        const files = fs.readdirSync(dirPath);
        return files.join('\n');
      }

      case 'send_message': {
        // Write to IPC for the router to pick up
        const ipcDir = '/workspace/ipc/messages';
        fs.mkdirSync(ipcDir, { recursive: true });
        const filename = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        fs.writeFileSync(path.join(ipcDir, filename), JSON.stringify({
          type: 'message',
          chatJid,
          text: args.text
        }));
        return `Message queued for sending`;
      }

      case 'use_browser': {
        try {
          const output = execSync(`agent-browser "${args.command}"`, {
            encoding: 'utf-8',
            timeout: 60000,
            cwd: '/workspace/group',
            maxBuffer: 10 * 1024 * 1024
          });
          return output;
        } catch (err: unknown) {
          const execError = err as { stderr?: string; message: string };
          return `Browser error: ${execError.stderr || execError.message}`;
        }
      }

      case 'web_search': {
        try {
          // Use agent-browser for search as it's more reliable than simple fetch
          const output = execSync(`agent-browser "search for ${args.query}"`, {
            encoding: 'utf-8',
            timeout: 60000,
            cwd: '/workspace/group'
          });
          return output;
        } catch (err: unknown) {
          const execError = err as { stderr?: string; message: string };
          return `Search error: ${execError.stderr || execError.message}`;
        }
      }

      case 'web_fetch': {
        try {
          const html = await fetchUrl(args.url);
          return htmlToText(html);
        } catch (err) {
          return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      output: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Get API key
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    writeOutput({
      status: 'error',
      output: null,
      error: 'GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set'
    });
    process.exit(1);
  }

  // Initialize Gemini
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  log(`Using model: ${modelName}`);

  const model = genAI.getGenerativeModel({
    model: modelName,
    tools: [{ functionDeclarations: tools }],
    systemInstruction: getSystemPrompt(input.groupFolder, input.isMain, input.isScheduledTask || false)
  });

  // Load conversation history
  const history = loadSession(input.groupFolder);

  // Build prompt with context
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically. Use send_message tool to communicate with the user.]\n\n${input.prompt}`;
  }

  // Add user message to history
  history.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  try {
    log('Starting Gemini agent...');

    // Start chat with history
    const chat = model.startChat({
      history: history.slice(0, -1) as Content[] // Exclude the last message since we'll send it
    });

    // Send message and handle tool calls
    let response = await withRetry(() => chat.sendMessage(prompt));
    let result = '';
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;
      const candidate = response.response.candidates?.[0];

      if (!candidate) {
        log('No response candidate');
        break;
      }

      // Check for function calls
      const functionCalls = candidate.content.parts.filter(p => 'functionCall' in p);

      if (functionCalls.length > 0) {
        log(`Executing ${functionCalls.length} tool calls...`);

        const toolResults: Part[] = [];
        for (const part of functionCalls) {
          if ('functionCall' in part && part.functionCall) {
            const fc = part.functionCall;
            log(`Tool: ${fc.name}`);
            const toolResult = await executeToolCall(
              fc.name,
              fc.args as Record<string, string>,
              input.chatJid,
              input.groupFolder
            );
            toolResults.push({
              functionResponse: {
                name: fc.name,
                response: { result: toolResult }
              }
            });
          }
        }

        // Send tool results back
        response = await withRetry(() => chat.sendMessage(toolResults));
      } else {
        // No function calls, get text response
        const textParts = candidate.content.parts.filter(p => 'text' in p);
        result = textParts.map(p => 'text' in p ? p.text : '').join('');
        break;
      }
    }

    // Save updated session
    const finalHistory = await chat.getHistory();
    saveSession(input.groupFolder, finalHistory as ConversationMessage[]);

    log('Gemini agent completed successfully');
    writeOutput({
      status: 'success',
      output: result || null,
      sessionId: `gemini-${input.groupFolder}`
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Gemini error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      output: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

function getSystemPrompt(groupFolder: string, isMain: boolean, isScheduledTask: boolean): string {
  // Read CLAUDE.md for context
  let claudeMd = '';
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  return `You are a helpful AI assistant running in the NanoClaw system.

Your workspace is at /workspace/group - you can read and write files there.
${isMain ? 'You have access to the project at /workspace/project.' : ''}

You have these tools available:
- read_file: Read file contents
- write_file: Write content to files
- run_command: Execute shell commands
- list_files: List directory contents
- send_message: Send a message to the chat (useful for scheduled tasks)
- use_browser: Interact with a web browser (search, click, type, read)
- web_search: Search the web for information
- web_fetch: Fetch and read the text content of a webpage

Keep responses concise but helpful. Use tools when needed to accomplish tasks.

${claudeMd ? `\n--- Group Memory (CLAUDE.md) ---\n${claudeMd}\n---` : ''}`;
}

main();
