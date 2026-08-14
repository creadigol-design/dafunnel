/**
 * Thin Anthropic client wrapper. One place to construct the SDK client and make
 * a text completion, so copy generation and reply classification share config
 * and error handling.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, requireSecret } from '../config/index.js';

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

/** Parse a JSON object out of a model response (tolerates prose/code fences). */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
