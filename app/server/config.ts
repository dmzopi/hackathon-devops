import type { LlmProviderId } from './ai/types.js';

const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const geminiKey = process.env.GEMINI_API_KEY || '';
const openaiKey = process.env.OPENAI_API_KEY || '';

function detectProvider(): LlmProviderId | null {
  const forced = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  if (forced === 'demo') return null;
  if (forced === 'openai' && (openaiKey || process.env.GATEWAY_URL)) return 'openai';
  if (forced === 'gemini' && (geminiKey || process.env.GATEWAY_URL)) return 'gemini';
  if (forced === 'claude' && (anthropicKey || process.env.GATEWAY_URL)) return 'claude';
  if (forced !== 'auto') {
    console.warn(`[config] LLM_PROVIDER=${forced} but matching API key or GATEWAY_URL is missing`);
    return null;
  }
  if (anthropicKey) return 'claude';
  if (geminiKey) return 'gemini';
  if (openaiKey) return 'openai';
  if (process.env.GATEWAY_URL) return 'openai';
  return null;
}

const detectedProvider = detectProvider();
const hasLlmApiKey = Boolean(anthropicKey || geminiKey || openaiKey || process.env.GATEWAY_URL);
const llmProviderForcedDemo = (process.env.LLM_PROVIDER || '').toLowerCase() === 'demo';
/** Demo only when no LLM API key is set (or LLM_PROVIDER=demo). */
const demoMode = llmProviderForcedDemo || !hasLlmApiKey;

export const config = {
  port: Number(process.env.PORT || 3001),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5173',
  uploadDir: process.env.UPLOAD_DIR || './uploads',

  llmProvider: (demoMode ? 'demo' : detectedProvider) as LlmProviderId,
  demoMode,
  hasLlmApiKey,

  openaiApiKey: openaiKey,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  geminiApiKey: geminiKey,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',

  anthropicApiKey: anthropicKey,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',

  jobSearchConcurrency: Number(process.env.JOB_SEARCH_CONCURRENCY || 4),
  jobSearchResultsPerBoard: Number(process.env.JOB_SEARCH_RESULTS_PER_BOARD || 8),
  jobSearchFetchTimeoutMs: Number(process.env.JOB_SEARCH_FETCH_TIMEOUT_MS || 15000),
  disableAiCrawlers: process.env.DISABLE_AI_CRAWLERS === 'true',
} as const;
