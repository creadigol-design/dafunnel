/**
 * Render a generated draft into a final message with the legally-required
 * compliance footer (sender identity, postal address, one-click unsubscribe).
 *
 * The footer is added here, not by the model, so it's always present and
 * correct — the lint pass then verifies unsubscribe is in the rendered output.
 */
import { config } from '../../config/index.js';

export interface RenderedMessage {
  subject: string;
  /** The model-written body, unchanged. */
  body: string;
  /** Body + signature + compliance footer — what actually gets sent. */
  full: string;
}

export function renderMessage(subject: string, body: string): RenderedMessage {
  const unsubscribe = `mailto:${config.sender.unsubscribeMailto}?subject=unsubscribe`;
  const footer = [
    '',
    '—',
    config.sender.name,
    config.sender.postalAddress,
    `Not relevant? Unsubscribe here: ${unsubscribe} (one click and we won't email you again).`,
  ].join('\n');

  return { subject, body, full: `${body.trimEnd()}\n${footer}\n` };
}
