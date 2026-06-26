import { config } from '../config.js';
import { resolveLlmConfig } from '../ai/resolve.js';
import type { JobMatchResult } from '../types.js';
import { selectBoardsForCountry } from './boards.js';
import type { AgentToolCallLog, JobSearchAgentInput, RawJobListing } from './types.js';
import { fetchJobBoard } from './tools/fetch-board.js';
import { webSearchJobs } from './tools/web-search.js';
import { rankListingsWithLlm } from './synthesize.js';

const MAX_BOARDS_PER_SEARCH = 12;

function assertJobSearchReady(): void {
  const llm = resolveLlmConfig();
  if (llm.demoMode || llm.provider === 'demo') {
    throw new Error(
      'Job search requires a real LLM provider. Set OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY and DEMO_MODE=false.'
    );
  }
}

function dedupeListings(listings: RawJobListing[]): RawJobListing[] {
  const seen = new Set<string>();
  const out: RawJobListing[] = [];
  for (const l of listings) {
    const key = l.applyUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

async function runBoardTool(
  board: import('./types.js').JobBoardDefinition,
  query: string,
  logs: AgentToolCallLog[]
): Promise<RawJobListing[]> {
  const logBase = {
    boardId: board.id,
    boardName: board.name,
  };

  try {
    if (board.parser !== 'web-only' && board.searchUrlTemplate) {
      const fetched = await fetchJobBoard(board, query);
      logs.push({
        ...logBase,
        tool: 'fetch_job_board',
        status: fetched.length ? 'ok' : 'ok',
        found: fetched.length,
        message: fetched.length ? undefined : 'No parseable listings',
      });
      if (fetched.length > 0) return fetched;
    }

    if (config.disableAiCrawlers) {
      logs.push({
        ...logBase,
        tool: 'web_search_jobs',
        status: 'ok',
        found: 0,
        message: 'AI web search fallback disabled via DISABLE_AI_CRAWLERS config',
      });
      return [];
    }

    const fromWeb = await webSearchJobs(board, query, config.jobSearchResultsPerBoard);
    logs.push({
      ...logBase,
      tool: 'web_search_jobs',
      status: fromWeb.length ? 'ok' : 'ok',
      found: fromWeb.length,
    });
    return fromWeb;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] Error fetching board ${board.name} (${board.id}):`, err);
    logs.push({
      ...logBase,
      tool: board.parser === 'web-only' ? 'web_search_jobs' : 'fetch_job_board',
      status: 'error',
      found: 0,
      message,
    });
    return [];
  }
}

export async function runJobSearchAgent(
  input: JobSearchAgentInput
): Promise<JobMatchResult & { agentMeta?: { toolCalls: AgentToolCallLog[]; boardsQueried: number; listingsFound: number } }> {
  assertJobSearchReady();

  const boards = selectBoardsForCountry(
    input.countryCode,
    MAX_BOARDS_PER_SEARCH
  );

  if (boards.length === 0) {
    throw new Error(`No job boards configured for country: ${input.countryCode}`);
  }

  console.info(
    `[agent] job search query="${input.query}" country=${input.countryCode} boards=${boards.length}`
  );

  const logs: AgentToolCallLog[] = [];
  const batchSize = config.jobSearchConcurrency;
  const collected: RawJobListing[] = [];

  for (let i = 0; i < boards.length; i += batchSize) {
    const chunk = boards.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map((board) => runBoardTool(board, input.query, logs))
    );
    for (const list of chunkResults) {
      collected.push(...list);
    }
  }

  const merged = dedupeListings(collected);

  console.info(
    `[agent] collected ${merged.length} unique listings from ${boards.length} boards`
  );

  if (merged.length === 0) {
    throw new Error(
      'No job listings found across selected boards. Try a broader query, another country, or check board availability.'
    );
  }

  const ranked = await rankListingsWithLlm(merged, boards, {
    userPrompt: input.userPrompt,
    cvSummary: input.cvSummary,
    cvSkills: input.cvSkills,
    jsonSchema: input.jsonSchema,
  });

  return {
    ...ranked,
    agentMeta: {
      toolCalls: logs,
      boardsQueried: boards.length,
      listingsFound: merged.length,
    },
  };
}

export async function searchRawJobs(
  query: string,
  countryCode: string = 'WORLDWIDE'
): Promise<RawJobListing[]> {
  assertJobSearchReady();

  const boards = selectBoardsForCountry(
    countryCode,
    MAX_BOARDS_PER_SEARCH
  );

  if (boards.length === 0) {
    return [];
  }

  const logs: AgentToolCallLog[] = [];
  const batchSize = config.jobSearchConcurrency;
  const collected: RawJobListing[] = [];

  for (let i = 0; i < boards.length; i += batchSize) {
    const chunk = boards.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map((board) => runBoardTool(board, query, logs))
    );
    for (const list of chunkResults) {
      collected.push(...list);
    }
  }

  return dedupeListings(collected);
}
