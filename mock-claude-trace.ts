
import { initDatabase, logAgentTrace, AgentTrace, AgentTraceStep } from './src/db.js';
import crypto from 'crypto';

initDatabase();

const traceId = crypto.randomUUID();
const trace: AgentTrace = {
    id: traceId,
    session_id: 'mock-claude-session-789',
    chat_jid: '123456789@s.whatsapp.net',
    provider: 'claude', // Important: testing Claude provider
    model_name: 'claude-3-5-sonnet',
    input_tokens: 2500,
    output_tokens: 1200,
    cached_content_tokens: 0,
    latency_ms: 5400,
    total_cost_usd: 0.0255, // (2.5 * 3) + (1.2 * 15) / 1000 roughly
    status: 'success',
    error: null as any,
    created_at: new Date().toISOString()
};

const steps: AgentTraceStep[] = [
    { step_type: 'thought', content: 'Analyzing the request for complex reasoning.', timestamp: new Date().toISOString() },
    { step_type: 'tool_call', content: JSON.stringify({ name: 'read_file', args: { path: '/workspace/project/src/index.ts' } }), timestamp: new Date().toISOString() },
    { step_type: 'tool_result', content: '// Code content...', timestamp: new Date().toISOString() },
    { step_type: 'thought', content: 'Found the issue in line 42.', timestamp: new Date().toISOString() }
];

logAgentTrace(trace, steps);
console.log('Mock Claude trace logged:', traceId);
