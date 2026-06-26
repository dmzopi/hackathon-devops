/**
 * Unit tests for JobSearchAgent.
 * All external I/O (fetchJobBoard, webSearchJobs, rankListingsWithLlm,
 * selectBoardsForCountry) is mocked, no network or LLM keys needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RawJobListing, JobBoardDefinition } from '../../agent/types.js';
import { RAW_LISTINGS, BOARD_DOU, BOARD_DJINNI } from '../fixtures/boards.js';

// Module mocks

vi.mock('../../agent/boards.js', () => ({
  selectBoardsForCountry: vi.fn(),
  formatBoardsForPrompt: vi.fn(() => ''),
  loadJobBoardCatalog: vi.fn(() => []),
}));

vi.mock('../../agent/tools/fetch-board.js', () => ({
  fetchJobBoard: vi.fn(),
}));

vi.mock('../../agent/tools/web-search.js', () => ({
  webSearchJobs: vi.fn(),
  webSearchBackend: vi.fn(() => null),
}));

vi.mock('../../agent/synthesize.js', () => ({
  rankListingsWithLlm: vi.fn(),
}));

// Satisfy the demo-mode guard in assertJobSearchReady()
vi.mock('../../ai/resolve.js', () => ({
  resolveLlmConfig: vi.fn(() => ({
    provider: 'gemini',
    model: 'gemini-test',
    demoMode: false,
  })),
}));

// get typed mocks

async function mocks() {
  const boards = await import('../../agent/boards.js');
  const fetchMod = await import('../../agent/tools/fetch-board.js');
  const webMod = await import('../../agent/tools/web-search.js');
  const synthMod = await import('../../agent/synthesize.js');
  return {
    selectBoardsForCountry: vi.mocked(boards.selectBoardsForCountry),
    fetchJobBoard: vi.mocked(fetchMod.fetchJobBoard),
    webSearchJobs: vi.mocked(webMod.webSearchJobs),
    rankListingsWithLlm: vi.mocked(synthMod.rankListingsWithLlm),
  };
}

const AGENT_INPUT = {
  query: 'DevOps Engineer',
  countryCode: 'UA',
  countryName: 'Ukraine',
  userPrompt: 'Find DevOps jobs in Ukraine',
  jsonSchema: {},
};

afterEach(() => {
  vi.clearAllMocks();
});

// runJobSearchAgent

describe('runJobSearchAgent', () => {
  it('throws when no boards are configured for the country', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([]);

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await expect(runJobSearchAgent(AGENT_INPUT)).rejects.toThrow(
      'No job boards configured for country'
    );
  });

  it('deduplicates listings with the same applyUrl before calling LLM', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU]);
    // raw listeting contains 3 items but only 2 unique URLs
    m.fetchJobBoard.mockResolvedValue(RAW_LISTINGS);
    m.rankListingsWithLlm.mockResolvedValue({ jobs: [], suggestions: [] });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await runJobSearchAgent(AGENT_INPUT);

    const calledListings = m.rankListingsWithLlm.mock.calls[0]![0] as RawJobListing[];
    expect(calledListings.length).toBe(2);
  });

  it('throws when all boards return zero listings', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU]);
    m.fetchJobBoard.mockResolvedValue([]);
    m.webSearchJobs.mockResolvedValue([]);

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await expect(runJobSearchAgent(AGENT_INPUT)).rejects.toThrow(
      'No job listings found'
    );
  });

  it('returns agentMeta with tool call logs and board count', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU, BOARD_DJINNI]);
    m.fetchJobBoard.mockResolvedValue([RAW_LISTINGS[0]!]);
    m.rankListingsWithLlm.mockResolvedValue({
      jobs: [
        {
          title: 'Senior DevOps Engineer',
          company: 'Acme Corp',
          location: 'Ukraine',
          applyUrl: 'https://jobs.dou.ua/vacancies/123/',
          score: 90,
          rationale: 'Great match',
          tags: ['kubernetes'],
        },
      ],
      suggestions: ['devops remote'],
    });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    const result = await runJobSearchAgent(AGENT_INPUT);

    expect(result.agentMeta).toBeDefined();
    expect(result.agentMeta!.boardsQueried).toBe(2);
    expect(result.agentMeta!.toolCalls.length).toBeGreaterThan(0);
  });

  it('falls back to webSearchJobs when fetchJobBoard returns empty', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU]);
    m.fetchJobBoard.mockResolvedValue([]);
    m.webSearchJobs.mockResolvedValue([RAW_LISTINGS[0]!]);
    m.rankListingsWithLlm.mockResolvedValue({ jobs: [], suggestions: [] });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await runJobSearchAgent(AGENT_INPUT);

    expect(m.webSearchJobs).toHaveBeenCalledOnce();
  });

  it('skips webSearchJobs when DISABLE_AI_CRAWLERS is true', async () => {
    process.env.DISABLE_AI_CRAWLERS = 'true';
    vi.resetModules();

    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU]);
    m.fetchJobBoard.mockResolvedValue([]);
    m.webSearchJobs.mockResolvedValue([RAW_LISTINGS[0]!]);
    m.rankListingsWithLlm.mockResolvedValue({ jobs: [], suggestions: [] });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await expect(runJobSearchAgent(AGENT_INPUT)).rejects.toThrow(
      'No job listings found'
    );

    expect(m.webSearchJobs).not.toHaveBeenCalled();

    delete process.env.DISABLE_AI_CRAWLERS;
    vi.resetModules();
  });

  it('logs error status when a board tool throws, but continues', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU, BOARD_DJINNI]);
    // first board throws, second returns a listing
    m.fetchJobBoard
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce([RAW_LISTINGS[1]!]);
    m.rankListingsWithLlm.mockResolvedValue({ jobs: [], suggestions: [] });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    const result = await runJobSearchAgent(AGENT_INPUT);

    const errorLog = result.agentMeta!.toolCalls.find((l) => l.status === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog!.message).toContain('Network timeout');
  });

  it('queries all boards (parallel batch execution)', async () => {
    const calledBoardIds: string[] = [];
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU, BOARD_DJINNI, BOARD_DOU, BOARD_DJINNI]);
    m.fetchJobBoard.mockImplementation(async (board: JobBoardDefinition) => {
      calledBoardIds.push(board.id);
      return [RAW_LISTINGS[0]!];
    });
    m.rankListingsWithLlm.mockResolvedValue({ jobs: [], suggestions: [] });

    const { runJobSearchAgent } = await import('../../agent/JobSearchAgent.js');
    await runJobSearchAgent(AGENT_INPUT);

    expect(calledBoardIds.length).toBe(4);
  });
});

// searchRawJobs

describe('searchRawJobs', () => {
  it('returns empty array when no boards match the country', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([]);

    const { searchRawJobs } = await import('../../agent/JobSearchAgent.js');
    const result = await searchRawJobs('DevOps', 'XX');
    expect(result).toEqual([]);
  });

  it('deduplicates listings from multiple boards with the same URL', async () => {
    const m = await mocks();
    m.selectBoardsForCountry.mockReturnValue([BOARD_DOU, BOARD_DJINNI]);
    // both boards return the same listing URL
    m.fetchJobBoard.mockResolvedValue([RAW_LISTINGS[0]!]);

    const { searchRawJobs } = await import('../../agent/JobSearchAgent.js');
    const result = await searchRawJobs('DevOps', 'UA');

    expect(result.length).toBe(1);
  });
});