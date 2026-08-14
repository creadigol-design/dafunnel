/**
 * Dashboard render smoke test — the generator must produce a self-contained
 * page with every section present, with no external resource requests.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vedri-dash-'));
process.env.DB_PATH = join(tmp, 'dash.db');
process.env.LOG_DIR = join(tmp, 'logs');
process.env.HUBSPOT_PRIVATE_APP_TOKEN = '';
process.env.ANTHROPIC_API_KEY = '';

const { closeDb } = await import('../src/db/index.js');
const { upsertLead } = await import('../src/db/leads.js');
const { renderDashboard } = await import('../src/dashboard.js');

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('renderDashboard', () => {
  it('renders every section with data present', () => {
    upsertLead({ email: 'a@x.co.uk', firstName: 'Ann', company: 'XCo', temperature: 'Warm', score: 40 });
    const html = renderDashboard(new Date('2026-08-14T10:00:00Z'));
    for (const section of [
      'Pace to target',
      'Pipeline by temperature',
      'This month',
      'Drafts awaiting approval',
      'Next 7 days',
      'vedr<i>í</i>',
      'shadow mode',
    ]) {
      expect(html).toContain(section);
    }
    expect(html).toContain('Ann');
  });

  it('is self-contained: no external http(s) resource loads', () => {
    const html = renderDashboard();
    // No <script src>, <link href>, or url(http...) — fonts are data: URIs.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it('escapes untrusted lead data', () => {
    upsertLead({ email: 'evil@x.co.uk', firstName: '<script>alert(1)</script>', company: 'XCo' });
    const html = renderDashboard();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
