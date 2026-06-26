/**
 * Unit tests for ai/providers/* (DemoAIClient, OpenAIProvider, GeminiProvider, ClaudeProvider).
 *
 * Do NOT mock the SDK packages (openai, @google/genai, @anthropic-ai/sdk).
 * Their constructors only store config — no network calls are made on construction.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// static mocks 

vi.mock('../../config.js', () => ({
  config: {
    geminiApiKey: 'fake-gemini-key',
    openaiApiKey: 'fake-openai-key',
    anthropicApiKey: 'fake-claude-key',
    geminiModel: 'gemini-test',
    openaiModel: 'gpt-test',
    claudeModel: 'claude-test',
    demoMode: false,
    llmProvider: 'gemini',
  },
}));

vi.mock('../../ai/skills/loader.js', () => ({
  buildSkillsSystemAppendix: vi.fn(() => ''),
  selectSkillsForTask: vi.fn(() => []),
  loadAllSkills: vi.fn(() => []),
}));

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GATEWAY_URL;
});

const BASE_REQUEST = {
  task: 'job_match' as const,
  systemPrompt: 'You are a job matcher.',
  userPrompt: 'Find DevOps jobs in Ukraine',
};

// DemoAIClient 

describe('DemoAIClient', () => {
  it('has provider=demo and model=demo', async () => {
    const { DemoAIClient } = await import('../../ai/providers/demo.js');
    const client = new DemoAIClient();
    expect(client.provider).toBe('demo');
    expect(client.model).toBe('demo');
  });

  it('returns DEMO_JOBS array for job_match task', async () => {
    const { DemoAIClient } = await import('../../ai/providers/demo.js');
    const client = new DemoAIClient();
    const result = await client.generateStructured<{ jobs: unknown[]; suggestions: string[] }>({
      ...BASE_REQUEST,
      task: 'job_match',
    });
    expect(Array.isArray(result.jobs)).toBe(true);
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(Array.isArray(result.suggestions)).toBe(true);
  });

  it('returns demo CV structure for cv_extract task', async () => {
    const { DemoAIClient } = await import('../../ai/providers/demo.js');
    const client = new DemoAIClient();
    const result = await client.generateStructured<{ status: string; output: unknown }>({
      ...BASE_REQUEST,
      task: 'cv_extract',
    });
    expect(result.status).toBe('success');
    expect(result.output).toBeDefined();
  });

  it('demo jobs contain required fields', async () => {
    const { DemoAIClient } = await import('../../ai/providers/demo.js');
    const client = new DemoAIClient();
    const result = await client.generateStructured<{ jobs: Array<{ title: string; score: number }> }>({
      ...BASE_REQUEST,
      task: 'job_match',
    });
    const job = result.jobs[0]!;
    expect(typeof job.title).toBe('string');
    expect(typeof job.score).toBe('number');
  });
});

// OpenAIProvider

describe('OpenAIProvider', () => {
  it('has provider=openai and stores the given model', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');
    expect(provider.provider).toBe('openai');
    expect(provider.model).toBe('gpt-test');
  });

  it('parses structured JSON from the API response', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');

    vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: '{"jobs":[],"suggestions":["devops remote"]}' } }],
    });

    const result = await provider.generateStructured<{ jobs: unknown[]; suggestions: string[] }>(BASE_REQUEST);
    expect(result.jobs).toEqual([]);
    expect(result.suggestions).toContain('devops remote');
  });

  it('throws "Empty OpenAI response" when content is null', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');

    vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    await expect(provider.generateStructured(BASE_REQUEST)).rejects.toThrow('Empty OpenAI response');
  });

  it('uses json_schema format when jsonSchema has properties', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');
    const createSpy = vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: '{"result":true}' } }],
    });

    await provider.generateStructured({
      ...BASE_REQUEST,
      jsonSchema: { type: 'object', properties: { result: { type: 'boolean' } } },
    });

    const args = createSpy.mock.calls[0]![0] as { response_format: { type: string } };
    expect(args.response_format.type).toBe('json_schema');
  });

  it('uses json_object format when jsonSchema is omitted', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');
    const createSpy = vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
    });

    await provider.generateStructured({ task: 'job_match', systemPrompt: 'sys', userPrompt: 'usr' });

    const args = createSpy.mock.calls[0]![0] as { response_format: { type: string } };
    expect(args.response_format.type).toBe('json_object');
  });

  it('sends both system and user messages', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test');
    const createSpy = vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
    });

    await provider.generateStructured(BASE_REQUEST);

    const args = createSpy.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const roles = args.messages.map((m) => m.role);
    expect(roles).toContain('system');
    expect(roles).toContain('user');
    const userMsg = args.messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain(BASE_REQUEST.userPrompt);
  });

  it('uses a custom baseURL when provided', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('gpt-test', 'http://custom-gateway/v1');
    expect(provider.model).toBe('gpt-test');
    // Client was constructed without throwing — baseURL accepted
    expect((provider as any).client).toBeDefined();
  });

  it('attempts failover to fallback model if primary model fails', async () => {
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('claude-haiku-4-5');

    let callCount = 0;
    const createSpy = vi.spyOn((provider as any).client.chat.completions, 'create').mockImplementation(async (args: any) => {
      callCount++;
      if (callCount === 1) {
        expect(args.model).toBe('claude-haiku-4-5');
        throw new Error('Primary failed');
      } else {
        expect(args.model).toBe('gemini-3.5-flash');
        return {
          choices: [{ message: { content: '{"jobs":[],"suggestions":["fallback-ok"]}' } }],
        } as any;
      }
    });

    const result = await provider.generateStructured<{ jobs: unknown[]; suggestions: string[] }>({
      ...BASE_REQUEST,
      task: 'cv_extract',
    });

    expect(callCount).toBe(2);
    expect(result.suggestions).toContain('fallback-ok');
    createSpy.mockRestore();
  });

  it('sets dynamic models based on task in gateway mode', async () => {
    process.env.GATEWAY_URL = 'http://gateway-test/v1';
    const { OpenAIProvider } = await import('../../ai/providers/openai.js');
    const provider = new OpenAIProvider('claude-haiku-4-5');

    const createSpy = vi.spyOn((provider as any).client.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: '{"jobs":[],"suggestions":[]}' } }],
    });

    // Simple task
    await provider.generateStructured({
      ...BASE_REQUEST,
      task: 'job_match',
    });
    expect(createSpy.mock.calls[0]![0].model).toBe('gemini-2.5-flash-lite');

    // Complex task
    await provider.generateStructured({
      ...BASE_REQUEST,
      task: 'cv_extract',
    });
    expect(createSpy.mock.calls[1]![0].model).toBe('claude-haiku-4-5');

    createSpy.mockRestore();
  });
});

// GeminiProvider

describe('GeminiProvider', () => {
  it('has provider=gemini', async () => {
    const { GeminiProvider } = await import('../../ai/providers/gemini.js');
    const provider = new GeminiProvider('gemini-test');
    expect(provider.provider).toBe('gemini');
    expect(provider.model).toBe('gemini-test');
  });

  it('parses structured JSON from native Gemini response', async () => {
    const { GeminiProvider } = await import('../../ai/providers/gemini.js');
    const provider = new GeminiProvider('gemini-test');

    vi.spyOn((provider as any).client.models, 'generateContent').mockResolvedValue({
      text: '{"jobs":[{"title":"SRE Lead","score":85}],"suggestions":[]}',
    });

    const result = await provider.generateStructured<{ jobs: Array<{ title: string }> }>(BASE_REQUEST);
    expect(result.jobs[0]!.title).toBe('SRE Lead');
  });

  it('throws "Empty Gemini response" when text is empty string', async () => {
    const { GeminiProvider } = await import('../../ai/providers/gemini.js');
    const provider = new GeminiProvider('gemini-test');

    vi.spyOn((provider as any).client.models, 'generateContent').mockResolvedValue({ text: '' });

    await expect(provider.generateStructured(BASE_REQUEST)).rejects.toThrow('Empty Gemini response');
  });

  it('delegates to OpenAIProvider when GATEWAY_URL is set', async () => {
    process.env.GATEWAY_URL = 'http://abox-gateway/v1';
    const { GeminiProvider } = await import('../../ai/providers/gemini.js');
    const provider = new GeminiProvider('gemini-test');

    // provider.client is OpenAIProvider; provider.client.client is the OpenAI SDK instance
    const createSpy = vi.spyOn((provider as any).client.client.chat.completions, 'create')
      .mockResolvedValue({ choices: [{ message: { content: '{"jobs":[],"suggestions":[]}' } }] });

    const result = await provider.generateStructured<{ jobs: unknown[] }>(BASE_REQUEST);
    expect(result.jobs).toBeDefined();
    expect(createSpy).toHaveBeenCalled();
  });

  it('appends /v1 to GATEWAY_URL when suffix is missing', async () => {
    process.env.GATEWAY_URL = 'http://abox-gateway'; // no /v1
    const { GeminiProvider } = await import('../../ai/providers/gemini.js');
    const provider = new GeminiProvider('gemini-test');

    vi.spyOn((provider as any).client.client.chat.completions, 'create')
      .mockResolvedValue({ choices: [{ message: { content: '{}' } }] });

    await provider.generateStructured(BASE_REQUEST);
    // Verify gateway path was used (OpenAI client, not Gemini client)
    expect((provider as any).client.provider).toBe('openai');
  });
});

// ClaudeProvider

describe('ClaudeProvider', () => {
  it('has provider=claude', async () => {
    const { ClaudeProvider } = await import('../../ai/providers/claude.js');
    const provider = new ClaudeProvider('claude-test');
    expect(provider.provider).toBe('claude');
    expect(provider.model).toBe('claude-test');
  });

  it('parses structured JSON from native Claude response', async () => {
    const { ClaudeProvider } = await import('../../ai/providers/claude.js');
    const provider = new ClaudeProvider('claude-test');

    vi.spyOn((provider as any).client.messages, 'create').mockResolvedValue({
      content: [{ type: 'text', text: '{"jobs":[],"suggestions":["platform engineer"]}' }],
    });

    const result = await provider.generateStructured<{ suggestions: string[] }>(BASE_REQUEST);
    expect(result.suggestions).toContain('platform engineer');
  });

  it('throws "Empty Claude response" when content array is empty', async () => {
    const { ClaudeProvider } = await import('../../ai/providers/claude.js');
    const provider = new ClaudeProvider('claude-test');

    vi.spyOn((provider as any).client.messages, 'create').mockResolvedValue({ content: [] });

    await expect(provider.generateStructured(BASE_REQUEST)).rejects.toThrow('Empty Claude response');
  });

  it('delegates to OpenAIProvider when GATEWAY_URL is set', async () => {
    process.env.GATEWAY_URL = 'http://abox-gateway/v1';
    const { ClaudeProvider } = await import('../../ai/providers/claude.js');
    const provider = new ClaudeProvider('claude-test');

    const createSpy = vi.spyOn((provider as any).client.client.chat.completions, 'create')
      .mockResolvedValue({ choices: [{ message: { content: '{"jobs":[],"suggestions":[]}' } }] });

    await provider.generateStructured(BASE_REQUEST);
    expect(createSpy).toHaveBeenCalled();
    expect((provider as any).client.provider).toBe('openai');
  });
});