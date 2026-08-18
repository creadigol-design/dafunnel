/**
 * Copy-lint tests — the safety net that stops bad copy reaching a prospect.
 * Deterministic (no API), so every rule is pinned.
 */
import { describe, it, expect } from 'vitest';
import { lintBody, lintMessage, lintDraft } from '../src/copy/lint.js';

const GOOD_BODY = `Hi Jo,

We do real-time compositing in-house, so the final image is on the monitors as you shoot — not three weeks later. For a multi-cam series that means every angle gets its own live output.

Worth a short call next week?

Best,
Daniel`;

const GOOD_RENDERED = `${GOOD_BODY}
—
Daniel Evans, vedrí
DocShed, Gwynedd, North Wales
Not relevant? Unsubscribe here: mailto:info@vedri.studio?subject=unsubscribe`;

describe('lintBody — model-fixable rules', () => {
  it('passes a clean, on-voice draft', () => {
    expect(lintBody('Picking up where we left off', GOOD_BODY).pass).toBe(true);
  });
  it('fails on banned fluff', () => {
    const r = lintBody('Our cutting-edge studio', GOOD_BODY);
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/fluff/);
  });
  it('fails on American spelling', () => {
    const r = lintBody('subject', 'We will optimize the color of your scene.');
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/American/);
  });
  it('fails when internal kit terminology leaks', () => {
    for (const kit of ['We run Assimilate Live FX', 'using a Mo-Sys StarTracker', 'on a Blackmagic Pyxis']) {
      const r = lintBody('subject', kit);
      expect(r.pass, kit).toBe(false);
      expect(r.failures.join()).toMatch(/kit/);
    }
  });
  it('fails when over 150 words', () => {
    const long = Array.from({ length: 160 }, () => 'word').join(' ');
    expect(lintBody('s', long).pass).toBe(false);
  });
  it('fails on more than one question mark', () => {
    const r = lintBody('s', 'Are you free? Or maybe later? ');
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/questions/);
  });
  it('fails on an unresolved body token', () => {
    expect(lintBody('s', 'We shot {{NEEDS_INPUT: their production}} last year.').pass).toBe(false);
  });
});

describe('lintMessage — config-level rules', () => {
  it('passes a rendered message with unsubscribe and no tokens', () => {
    expect(lintMessage(GOOD_RENDERED).pass).toBe(true);
  });
  it('fails when unsubscribe is missing', () => {
    expect(lintMessage('Just the body, no footer.').pass).toBe(false);
  });
  it('fails when the footer still has a NEEDS_INPUT token (e.g. postal address)', () => {
    const r = lintMessage(`${GOOD_BODY}\nUnsubscribe: mailto:x\n{{NEEDS_INPUT: studio postal address}}`);
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/postal|token/i);
  });
});

describe('lintDraft — combined gate', () => {
  it('passes only when both body and message are clean', () => {
    expect(lintDraft({ subject: 'Hello', body: GOOD_BODY, rendered: GOOD_RENDERED }).pass).toBe(true);
  });
  it('fails if either half fails', () => {
    expect(lintDraft({ subject: 'game-changing', body: GOOD_BODY, rendered: GOOD_RENDERED }).pass).toBe(false);
    expect(lintDraft({ subject: 'Hello', body: GOOD_BODY, rendered: 'no footer' }).pass).toBe(false);
  });
});

describe('buildRewritePrompt — Daniel-steered rewrites', () => {
  it('carries the instruction, current draft and approved facts', async () => {
    const { buildRewritePrompt } = await import('../src/copy/generate.js');
    const prompt = buildRewritePrompt(
      {
        firstName: 'Chris',
        company: 'Media Borne',
        track: 'Studio',
        recommendedApproach: null,
        relationship: 'a real conversation happened — it reached the "Negotiating" stage',
        research: null,
        approvedFacts: ['We do real-time compositing in-house.'],
        bookingLink: null,
      },
      {
        instruction: 'Mention their new Cardiff studio and keep it to three sentences.',
        currentSubject: 'Quick one, Chris',
        currentBody: 'Hi Chris, old body here.',
      },
    );
    expect(prompt).toContain("DANIEL'S INSTRUCTION: Mention their new Cardiff studio");
    expect(prompt).toContain('CURRENT DRAFT SUBJECT: Quick one, Chris');
    expect(prompt).toContain('counts as an approved fact');
    expect(prompt).toContain('Negotiating');
  });
});
