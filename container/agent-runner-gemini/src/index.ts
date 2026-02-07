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
import { chromium, BrowserContext, Page } from 'playwright';

let browserContext: BrowserContext | null = null;
let page: Page | null = null;

async function ensureBrowser(): Promise<Page> {
  if (!browserContext) {
    const userDataDir = '/workspace/group/.gemini_browser_profile';
    // Ensure directory exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    page = browserContext.pages()[0] || await browserContext.newPage();
  }
  return page!;
}

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
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    cachedContentTokens?: number;
    latencyMs: number;
  };
  trace?: Array<{
    type: 'thought' | 'tool_call' | 'tool_result';
    content: string;
    timestamp: string;
  }>;
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

// Brave Search API helper
interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

async function braveSearch(query: string): Promise<BraveSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY not configured');
  }

  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&count=10`;

    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Brave API error: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results: BraveSearchResult[] = (json.web?.results || []).map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            description: r.description || ''
          }));
          resolve(results);
        } catch (err) {
          reject(new Error(`Failed to parse Brave response: ${err}`));
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Brave search timed out'));
    });
  });
}

// Overseerr API helper
interface OverseerrMedia {
  id: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  name?: string;
  overview?: string;
  releaseDate?: string;
  firstAirDate?: string;
}

async function overseerrCall(endpoint: string, method = 'GET', body?: any): Promise<any> {
  const baseUrl = process.env.OVERSEER_URL || process.env.OVERSEERR_URL;
  const apiKey = process.env.OVERSEER_API || process.env.OVERSEERR_API || process.env.OVERSEERR_API_KEY;

  if (!baseUrl) {
    throw new Error('Overseerr URL is missing. Please check OVERSEER_URL in .env');
  }
  if (!apiKey) {
    throw new Error('Overseerr API Key is missing. Please check OVERSEER_API in .env');
  }

  // Ensure plain URL (no /api suffix needed if we add it, typically v1/api)
  // Overseerr API is usually /api/v1/...
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  const url = `${cleanBaseUrl}/api/v1${endpoint}`;

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      method,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    };

    const req = https.request(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Overseerr API error: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (!data) resolve(null);
          else resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse Overseerr response: ${err}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Overseerr request timed out'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
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
    description: 'Search the web using the official Brave Search API. This is the preferred way to find information.',
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
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: SchemaType.STRING, description: 'The URL to navigate to' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page using a CSS selector',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        selector: { type: SchemaType.STRING, description: 'CSS selector for the element' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_input',
    description: 'Fill a form field with text',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        selector: { type: SchemaType.STRING, description: 'CSS selector for the input field' },
        value: { type: SchemaType.STRING, description: 'The text value to enter' }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'Path to save the screenshot (e.g., screenshot.png)' }
      },
      required: ['path']
    }
  },
  {
    name: 'browser_content',
    description: 'Get the text content of the current page (simplified for reading)',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
      required: []
    }
  },
  {
    name: 'overseerr_search',
    description: 'Search for movies or TV shows in Overseerr. Returns list of available media with IDs. If configuration is missing, returns a specific error.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'Search term (e.g., "Inception", "Breaking Bad")' }
      },
      required: ['query']
    }
  },
  {
    name: 'overseerr_request',
    description: 'Request a movie or TV show in Overseerr by ID.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        mediaId: { type: SchemaType.NUMBER, description: 'The ID of the media to request (found via search)' },
        mediaType: { type: SchemaType.STRING, description: 'Type of media: "movie" or "tv"' }
      },
      required: ['mediaId', 'mediaType']
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

      case 'browser_navigate': {
        try {
          const page = await ensureBrowser();
          await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          return `Navigated to ${args.url}`;
        } catch (err) {
          return `Navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'browser_click': {
        try {
          const page = await ensureBrowser();
          await page.click(args.selector, { timeout: 10000 });
          return `Clicked ${args.selector}`;
        } catch (err) {
          return `Click failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'browser_input': {
        try {
          const page = await ensureBrowser();
          await page.fill(args.selector, args.value, { timeout: 10000 });
          return `Filled ${args.selector} with "${args.value}"`;
        } catch (err) {
          return `Input failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'browser_screenshot': {
        try {
          const page = await ensureBrowser();
          const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
          await page.screenshot({ path: filePath, fullPage: true });
          return `Screenshot saved to ${filePath}`;
        } catch (err) {
          return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'browser_content': {
        try {
          const page = await ensureBrowser();
          const content = await page.innerText('body');
          return content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content;
        } catch (err) {
          return `Get content failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'web_search': {
        // Use Brave Search API (reliable, paid/official API)
        try {
          log(`Searching with Brave API: ${args.query}`);
          const results = await braveSearch(args.query);

          if (results.length > 0) {
            const formatted = results.map((r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}`
            ).join('\n\n');
            return `Search results for "${args.query}" (via Brave API):\n\n${formatted}`;
          } else {
            return `No results found for "${args.query}" via Brave API.`;
          }
        } catch (err) {
          const msg = `Brave Search API failed: ${err instanceof Error ? err.message : String(err)}`;
          log(msg);
          return `Error: ${msg}\n\nPlease check if BRAVE_API_KEY is configured correctly in the environment.`;
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

      case 'overseerr_search': {
        try {
          log(`Searching Overseerr for: ${args.query}`);
          const data = await overseerrCall(`/search?query=${encodeURIComponent(args.query)}`);
          const results = (data.results || []).slice(0, 5).map((r: any) =>
            `ID: ${r.id}\nType: ${r.mediaType}\nTitle: ${r.originalTitle || r.originalName || r.title || r.name}\nYear: ${(r.releaseDate || r.firstAirDate || '').split('-')[0]}\nOverview: ${r.overview?.slice(0, 100)}...`
          ).join('\n---\n');
          return results ? `Overseerr Search Results:\n${results}` : 'No results found.';
        } catch (err) {
          return `Overseerr search failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'overseerr_request': {
        try {
          log(`Requesting media ${args.mediaId} (${args.mediaType})`);
          // Request endpoint: /request
          await overseerrCall('/request', 'POST', {
            mediaId: Number(args.mediaId),
            mediaType: args.mediaType,
            is4k: false,
            serverId: 0, // Default server
            profileId: 0 // Default profile? Usually defaults work, or might need query. 
            // Minimal payload usually works or we might need to find root folder.
            // Let's try basic payload first.
          });
          return `Successfully requested ${args.mediaType} with ID ${args.mediaId}.`;
        } catch (err) {
          return `Overseerr request failed: ${err instanceof Error ? err.message : String(err)}`;
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

    // Metrics for observability
    const metrics = {
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0
    };
    const startTime = Date.now();
    const traceSteps: NonNullable<ContainerOutput['trace']> = [];

    // Send message and handle tool calls
    let response = await withRetry(() => chat.sendMessage(prompt));

    // Aggregate initial tokens
    if (response.response.usageMetadata) {
      metrics.inputTokens += response.response.usageMetadata.promptTokenCount || 0;
      metrics.outputTokens += response.response.usageMetadata.candidatesTokenCount || 0;
    }

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

      // Safely get parts array (may be undefined in some responses)
      const parts = candidate.content?.parts || [];

      if (parts.length === 0) {
        log('No parts in response, ending');
        break;
      }

      // Check for function calls
      const functionCalls = parts.filter(p => 'functionCall' in p);

      if (functionCalls.length > 0) {
        log(`Executing ${functionCalls.length} tool calls...`);

        const toolResults: Part[] = [];
        for (const part of functionCalls) {
          if ('functionCall' in part && part.functionCall) {
            const fc = part.functionCall;
            const toolCallRaw = JSON.stringify(fc.args);

            traceSteps.push({
              type: 'tool_call',
              content: JSON.stringify({ name: fc.name, args: fc.args }),
              timestamp: new Date().toISOString()
            });

            log(`Tool: ${fc.name}`);
            const toolResult = await executeToolCall(
              fc.name,
              fc.args as Record<string, string>,
              input.chatJid,
              input.groupFolder
            );

            traceSteps.push({
              type: 'tool_result',
              content: JSON.stringify({ name: fc.name, result: toolResult.slice(0, 1000) }), // Truncate for trace
              timestamp: new Date().toISOString()
            });

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

        // Aggregate tool turn tokens
        if (response.response.usageMetadata) {
          metrics.inputTokens += response.response.usageMetadata.promptTokenCount || 0;
          metrics.outputTokens += response.response.usageMetadata.candidatesTokenCount || 0;
        }

      } else {
        // No function calls, get text response
        const textParts = parts.filter(p => 'text' in p);
        result = textParts.map(p => 'text' in p ? p.text : '').join('');

        if (result) {
          traceSteps.push({
            type: 'thought',
            content: result,
            timestamp: new Date().toISOString()
          });
        }
        break;
      }
    }

    // Save updated session
    const finalHistory = await chat.getHistory();
    saveSession(input.groupFolder, finalHistory as ConversationMessage[]);

    metrics.latencyMs = Date.now() - startTime;

    log('Gemini agent completed successfully');
    writeOutput({
      status: 'success',
      output: result || null,
      sessionId: `gemini-${input.groupFolder}`,
      metrics,
      trace: traceSteps
    });

    if (browserContext) {
      await browserContext.close();
    }

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

  let projectInfo = '';
  if (isMain) {
    projectInfo = `
You have FULL ACCESS to the NanoClaw project at /workspace/project.
You can read, modify, and improve the codebase:
- Source code is in /workspace/project/src/
- Container agents are in /workspace/project/container/
- After modifying TypeScript files, run "npm run build" in /workspace/project
- After modifying container code, rebuild with "./build-all.sh" in /workspace/project/container

`;
  }

  return `You are a helpful AI assistant running in the NanoClaw system.

Your workspace is at /workspace/group - you can read and write files there.
${projectInfo}
You have these tools available:
- read_file: Read file contents
- write_file: Write content to files
- run_command: Execute shell commands
- list_files: List directory contents
- send_message: Send a message to the chat (useful for scheduled tasks)
- browser_navigate: Open a URL
- browser_click: Click an element (CSS selector)
- browser_input: Fill a form field (CSS selector)
- browser_screenshot: Take a screenshot
- browser_content: Read page text
- web_search: Search the web using Brave Search API (PREFERRED for information gathering)
- web_fetch: Fetch and read the text content of a webpage
- overseerr_search: Search for media to request on Overseerr
- overseerr_request: Request media (Movie/TV) on Overseerr by ID

Keep responses concise but helpful. Use tools when needed to accomplish tasks.

${claudeMd ? `\n--- Group Memory (CLAUDE.md) ---\n${claudeMd}\n---` : ''}`;
}

main();
