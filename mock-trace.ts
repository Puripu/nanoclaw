
import { initDatabase, logAgentTrace, AgentTrace, AgentTraceStep } from './src/db.js';
import crypto from 'crypto';

initDatabase();

const traceId = crypto.randomUUID();
const trace: AgentTrace = {
    id: traceId,
    session_id: 'mock-session-123',
    chat_jid: '123456789@s.whatsapp.net',
    provider: 'gemini',
    model_name: 'gemini-2.0-flash',
    input_tokens: 1500,
    output_tokens: 450,
    cached_content_tokens: 0,
    latency_ms: 3200,
    total_cost_usd: 0.0003,
    status: 'success',
    error: null as any, // Initialize as null
    created_at: new Date().toISOString()
};

const steps: AgentTraceStep[] = [
    { step_type: 'thought', content: 'User asked me to check the weather.', timestamp: new Date().toISOString() },
    { step_type: 'tool_call', content: JSON.stringify({ name: 'web_search', args: { query: 'weather in Tokyo' } }), timestamp: new Date().toISOString() },
    { step_type: 'tool_result', content: 'Sunny, 25°C', timestamp: new Date().toISOString() },
    { step_type: 'thought', content: 'The weather is nice.', timestamp: new Date().toISOString() }
];

logAgentTrace(trace, steps);
console.log('Mock trace logged:', traceId);
