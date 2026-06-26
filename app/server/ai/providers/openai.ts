import OpenAI from 'openai';
import { config } from '../../config.js';
import { schemaInstruction, parseJsonFromModelText } from '../json.js';
import { buildSkillsSystemAppendix } from '../skills/loader.js';
import type { AIClient, LlmProviderId, StructuredGenerateRequest } from '../types.js';

const FALLBACK_MODELS: Record<string, string> = {
  'claude-haiku-4-5': 'gemini-3.5-flash',
  'gemini-2.5-flash-lite': 'gpt-5.4-nano',
};

export class OpenAIProvider implements AIClient {
  readonly provider: LlmProviderId = 'openai';
  readonly model: string;
  private readonly client: OpenAI;

  constructor(model?: string, baseURL?: string) {
    this.model = model ?? config.openaiModel;
    const resolvedBaseURL = baseURL || (process.env.GATEWAY_URL
      ? (process.env.GATEWAY_URL.endsWith('/v1') ? process.env.GATEWAY_URL : `${process.env.GATEWAY_URL}/v1`)
      : undefined);
    this.client = new OpenAI({
      apiKey: config.openaiApiKey || 'mock-key',
      baseURL: resolvedBaseURL,
      fetch: (async (url: any, init: any) => {
        if (init && init.headers) {
          if (typeof init.headers.delete === 'function') {
            init.headers.delete('content-length');
            init.headers.delete('Content-Length');
          } else if (typeof init.headers === 'object') {
            delete init.headers['content-length'];
            delete init.headers['Content-Length'];
          }
        }
        const response = await fetch(url, init);
        if (!response.ok) {
          try {
            const cloned = response.clone();
            const text = await cloned.text();
            console.error(`[ai] RAW ERROR RESPONSE FROM LLM API (Status: ${response.status}):\n${text}\n`);
          } catch (e) {
            console.error('[ai] Failed to read raw error response body inside fetch interceptor:', e);
          }
        }
        return response;
      }) as any
    });
  }

  async generateStructured<T>(request: StructuredGenerateRequest): Promise<T> {
    const selectedRoute = request.task === 'job_match' ? 'llm-for-simple-task' : 'llm-for-complex-task';
    console.info(`[ai] Routing request for task "${request.task}" via Agent Gateway route "${selectedRoute}"`);

    const processedSchema = request.jsonSchema
      ? enforceNoAdditionalProperties(request.jsonSchema)
      : undefined;

    const skills = buildSkillsSystemAppendix(request.task);
    const system =
      request.systemPrompt +
      skills +
      '\n\n' +
      schemaInstruction(processedSchema);

    let modelToUse = this.model;
    if (process.env.GATEWAY_URL) {
      modelToUse = request.task === 'job_match' ? 'gemini-2.5-flash-lite' : 'claude-haiku-4-5';
    }

    try {
      const response = await this.client.chat.completions.create({
        model: modelToUse,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: request.userPrompt },
        ],
        response_format: processedSchema
          ? {
              type: 'json_schema',
              json_schema: {
                name: `${request.task}_response`,
                strict: false,
                schema: processedSchema,
              },
            }
          : { type: 'json_object' },
      }, {
        headers: {
          'x-gateway-task-name': request.task,
        }
      });

      const text = response.choices[0]?.message?.content;
      if (!text) throw new Error('Empty OpenAI response');
      return parseJsonFromModelText<T>(text);
    } catch (err: any) {
      const fallbackModel = FALLBACK_MODELS[modelToUse];
      if (fallbackModel) {
        console.warn(`[ai] Request failed with model "${modelToUse}"... Falling back to "${fallbackModel}"...`);
        try {
          const response = await this.client.chat.completions.create({
            model: fallbackModel,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: request.userPrompt },
            ],
            response_format: processedSchema
              ? {
                  type: 'json_schema',
                  json_schema: {
                    name: `${request.task}_response`,
                    strict: false,
                    schema: processedSchema,
                  },
                }
              : { type: 'json_object' },
          }, {
            headers: {
              'x-gateway-task-name': request.task,
            }
          });

          const text = response.choices[0]?.message?.content;
          if (!text) throw new Error('Empty OpenAI response');
          return parseJsonFromModelText<T>(text);
        } catch (fallbackErr: any) {
          console.error(`[ai] generateStructured fallback failed: status=${fallbackErr.status} code=${fallbackErr.code} type=${fallbackErr.type} message="${fallbackErr.message}" parsedError=${JSON.stringify(fallbackErr.error)}`);
          throw fallbackErr;
        }
      }
      console.error(`[ai] generateStructured failed: status=${err.status} code=${err.code} type=${err.type} message="${err.message}" parsedError=${JSON.stringify(err.error)}`);
      throw err;
    }
  }
}

function enforceNoAdditionalProperties(schema: any): any {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const result = { ...schema };
  if (result.type === 'object') {
    if (result.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
  }
  if (result.properties) {
    const newProperties: Record<string, any> = {};
    for (const key of Object.keys(result.properties)) {
      newProperties[key] = enforceNoAdditionalProperties(result.properties[key]);
    }
    result.properties = newProperties;
  }
  if (result.items) {
    if (Array.isArray(result.items)) {
      result.items = result.items.map(enforceNoAdditionalProperties);
    } else {
      result.items = enforceNoAdditionalProperties(result.items);
    }
  }
  if (result.anyOf) {
    result.anyOf = result.anyOf.map(enforceNoAdditionalProperties);
  }
  if (result.allOf) {
    result.allOf = result.allOf.map(enforceNoAdditionalProperties);
  }
  if (result.oneOf) {
    result.oneOf = result.oneOf.map(enforceNoAdditionalProperties);
  }
  return result;
}

