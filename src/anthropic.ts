/**
 * Thin Anthropic client wrapper. One place to construct the SDK client and make
 * a text completion, so copy generation and reply classification share config
 * and error handling.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, requireSecret } from '../config/index.js';
import { log } from './logger.js';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireSecret(config.anthropic.apiKey, 'ANTHROPIC_API_KEY') });
  }
  return client;
}

export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/** Single-turn completion returning the concatenated text. */
export async function complete(opts: CompleteOptions): Promise<string> {
  const msg = await anthropic().messages.create({
    model: config.anthropic.model,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export interface WebSearchCompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Cap on server-side web searches per request (cost control). */
  maxSearches?: number;
}

/**
 * Single-turn completion with the server-side web search tool enabled. The
 * search loop runs entirely on Anthropic's side — the response we get back is
 * the final text, with search/result blocks interleaved (we keep text only).
 */
export async function completeWithWebSearch(opts: WebSearchCompleteOptions): Promise<string> {
  // Streamed: a server-side search loop can run for many minutes, and a
  // non-streaming request would sit against the client timeout the whole way.
  const stream = anthropic().messages.stream({
    model: config.anthropic.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    // web_search_20260209 is current for the Claude 5 / 4.6+ tier; the SDK's
    // tool union may trail the API, hence the cast.
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: opts.maxSearches ?? 12,
      } as unknown as Anthropic.Messages.ToolUnion,
    ],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'max_tokens') {
    // The search loop ate the budget before the final answer — the caller will
    // see a truncated (likely unparseable) response. Raise maxTokens or lower
    // maxSearches if this recurs.
    log.warn('web-search completion truncated at max_tokens', {
      maxTokens: opts.maxTokens ?? 8192,
      maxSearches: opts.maxSearches ?? 12,
    });
  }
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Parse a JSON object out of a model response (tolerates prose/code fences). */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
