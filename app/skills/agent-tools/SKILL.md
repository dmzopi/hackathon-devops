# Job search agent tools

> Production job matching uses tools first, then LLM ranking on verified URLs only.

## Tools (server/agent/tools)

| Tool | Purpose |
|------|---------|
| `fetch_job_board` | HTTP fetch + HTML parser for boards with `searchUrlTemplate` (DOU, Work.ua, Djinni, generic) |
| `web_search_jobs` | Site-scoped search via the active LLM provider's native web search for LinkedIn, Indeed, Glassdoor, etc. |

## Flow

1. Select boards from catalog for `countryCode`.
2. Run `fetch_job_board` and `web_search_jobs` in parallel (with timeouts).
3. Deduplicate by `applyUrl`.
4. LLM ranks only listings from tool output; drop any URL not in the allow-list.

## Requirements

- A configured LLM provider (`OPENAI`, `GEMINI`, or `ANTHROPIC` key) with native web search
- `DEMO_MODE` must not be used for job search (no mock listings)

## Web search by provider

| Provider | Mechanism                                     |
| ----------| -----------------------------------------------|
| Gemini   | Google Search grounding (`googleSearch` tool) |
| OpenAI   | Responses API `web_search` tool               |
| Claude   | Messages API `web_search_20250305` tool       |
