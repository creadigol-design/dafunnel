/**
 * Viewer — the funnel's web interface, served from the VPS.
 *
 * Zero dependencies (Node http only). Password-protected (HTTP Basic auth,
 * VIEWER_PASSWORD in .env). Read-only over the funnel's state, plus one write:
 * flagging a draft with a note, which lands in the feedback log for review.
 *
 * Routes:
 *   /            → the brand dashboard (output/dashboard.html, rebuilt hourly)
 *   /drafts      → every draft as a readable card, newest first, flag buttons
 *   /lead?email= → a lead's full event history ("why is this hot?")
 *   /flag (POST) → record feedback on a draft
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { db } from '../db/index.js';
import { eventsForLead } from '../db/events.js';
import { getLeadByEmail } from '../db/leads.js';

const vlog = log.child('viewer');
const PORT = Number(process.env.VIEWER_PORT ?? '8080');
const PASSWORD = process.env.VIEWER_PASSWORD ?? '';

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── auth ────────────────────────────────────────────────────────────────────
function authorised(req: IncomingMessage): boolean {
  if (!PASSWORD) return false; // no password configured → locked shut, not open
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return user === 'vedri' && pass === PASSWORD;
}

function unauthorised(res: ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="vedri funnel"' });
  res.end('Authentication required.');
}

// ── shared page chrome (brand) ──────────────────────────────────────────────
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#111118;--card:#1A1B22;--card2:#2A2B2A;--ink:#FFF;--ink2:#C2C1C0;--muted:#8A8A8E;--green:#9FCC3B;--lime:#B8E040;--yellow:#D2EF4A;--line:rgba(194,193,192,.12)}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:400 15px/1.55 'Space Grotesk',Arial,sans-serif;min-height:100vh;
background-image:radial-gradient(1000px 650px at -8% -12%,rgba(159,204,59,.14),transparent 60%),radial-gradient(800px 600px at 108% 112%,rgba(184,224,64,.09),transparent 60%)}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 60px}
nav{display:flex;gap:18px;align-items:baseline;margin-bottom:26px;flex-wrap:wrap}
.wordmark{font-weight:700;font-size:26px}.wordmark i{font-style:normal;color:var(--green)}
nav a{color:var(--ink2);text-decoration:none;font-size:14px}nav a:hover{color:var(--lime)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:14px}
.meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--muted)}
.chip{padding:2px 10px;border-radius:999px;background:var(--card2);color:var(--ink2)}
.chip.warm{color:#111118;background:var(--lime);font-weight:700}
.chip.hot{color:#111118;background:var(--green);font-weight:700}
.chip.flagged{color:#111118;background:var(--yellow);font-weight:700}
.subject{font-weight:700;margin-bottom:8px}
pre{white-space:pre-wrap;font:inherit;color:var(--ink2);border-top:1px solid var(--line);padding-top:12px}
h1{font-size:20px;margin-bottom:16px}
form{margin-top:12px;display:flex;gap:8px}
input[type=text]{flex:1;background:var(--card2);border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:8px 12px;font:inherit}
button{background:var(--green);color:#111118;border:0;border-radius:8px;padding:8px 16px;font:700 14px 'Space Grotesk',Arial;cursor:pointer}
button:hover{background:var(--lime)}
.ok{color:var(--lime);margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:7px 10px 7px 0;border-top:1px solid var(--line);color:var(--ink2);vertical-align:top}
.muted{color:var(--muted)}
</style></head><body><div class="wrap">
<nav><span class="wordmark">vedr<i>í</i></span><a href="/">dashboard</a><a href="/drafts">drafts</a></nav>
${body}</div></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────────
function serveDashboard(res: ServerResponse): void {
  if (existsSync('output/dashboard.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync('output/dashboard.html'));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('vedrí — funnel', '<div class="card">No dashboard yet — it appears after the first cycle.</div>'));
  }
}

interface DraftRow {
  id: string;
  subject: string;
  body: string;
  status: string;
  lint_status: string | null;
  sequence_id: string;
  step: number;
  created_at: string;
  email: string | null;
  company: string | null;
  temperature: string | null;
  score: number | null;
}

function draftsRows(): DraftRow[] {
  return db()
    .prepare(
      `SELECT dr.id, dr.subject, dr.body, dr.status, dr.lint_status, dr.sequence_id, dr.step, dr.created_at,
              l.email, l.company, l.temperature, l.score
       FROM drafts dr LEFT JOIN leads l ON l.id = dr.lead_id
       ORDER BY dr.created_at DESC LIMIT 100`,
    )
    .all() as DraftRow[];
}

function serveDrafts(res: ServerResponse, flashed: boolean): void {
  const rows = draftsRows();
  const cards = rows
    .map((d) => {
      const bandClass = d.temperature === 'Hot' ? 'hot' : d.temperature === 'Warm' ? 'warm' : '';
      return `<div class="card">
      <div class="meta">
        <span class="chip">${esc(d.email ?? '?')}</span>
        ${d.company ? `<span class="chip">${esc(d.company)}</span>` : ''}
        <span class="chip ${bandClass}">${esc(d.temperature ?? '?')} ${d.score ?? ''}</span>
        <span class="chip">${esc(d.sequence_id)} · step ${d.step + 1}</span>
        ${d.status === 'lint_failed' ? `<span class="chip flagged">lint: ${esc(d.lint_status ?? '')}</span>` : ''}
        <span class="muted">${esc(d.created_at.slice(0, 16).replace('T', ' '))}</span>
      </div>
      <div class="subject">${esc(d.subject)}</div>
      <pre>${esc(d.body)}</pre>
      <form method="POST" action="/flag">
        <input type="hidden" name="id" value="${esc(d.id)}">
        <input type="text" name="note" placeholder="What's wrong with this one? (tone, claim, wrong person…)" required>
        <button type="submit">Flag it</button>
      </form>
    </div>`;
    })
    .join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    page(
      'vedrí — drafts',
      `<h1>Drafts (${rows.length})</h1>
       ${flashed ? '<div class="ok">✓ Flag recorded — it will be reviewed and the engine tuned.</div>' : ''}
       ${cards || '<div class="card">No drafts yet.</div>'}`,
    ),
  );
}

function serveLead(res: ServerResponse, email: string): void {
  const lead = getLeadByEmail(email.toLowerCase());
  if (!lead) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('vedrí — lead', `<div class="card">No lead found for ${esc(email)}.</div>`));
    return;
  }
  const events = eventsForLead(lead.id);
  const rows = events
    .map(
      (e) => `<tr><td class="muted">${esc(e.createdAt.slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(e.type)}${e.oldScore != null && e.newScore != null ? ` <span class="muted">[${e.oldScore} → ${e.newScore}]</span>` : ''}<br>
      <span class="muted">${esc(e.reason)}</span></td></tr>`,
    )
    .join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    page(
      `vedrí — ${lead.email}`,
      `<h1>${esc([lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email)}
        <span class="muted">· ${esc(lead.company ?? '')}</span></h1>
       <div class="meta"><span class="chip ${lead.temperature === 'Hot' ? 'hot' : lead.temperature === 'Warm' ? 'warm' : ''}">${esc(lead.temperature)} ${lead.score}</span>
       <span class="chip">${esc(lead.source)}</span><span class="chip">${esc(lead.track)}</span></div>
       <div class="card"><table>${rows || '<tr><td>No events.</td></tr>'}</table></div>`,
    ),
  );
}

function handleFlag(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const params = new URLSearchParams(raw);
    const id = params.get('id') ?? '';
    const note = (params.get('note') ?? '').slice(0, 2000);
    const draft = db().prepare('SELECT lead_id, subject FROM drafts WHERE id = ?').get(id) as
      | { lead_id: string | null; subject: string }
      | undefined;
    if (draft && note) {
      mkdirSync('data', { recursive: true });
      appendFileSync(
        'data/feedback.log',
        JSON.stringify({ at: new Date().toISOString(), draftId: id, subject: draft.subject, note }) + '\n',
      );
      db().prepare("UPDATE drafts SET status = 'lint_failed', lint_status = ? WHERE id = ?").run(`flagged by Daniel: ${note}`, id);
      vlog.info('draft flagged', { id, note });
    }
    res.writeHead(303, { Location: '/drafts?flagged=1' });
    res.end();
  });
}

// ── server ──────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (!authorised(req)) return unauthorised(res);
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/flag') return handleFlag(req, res);
    if (url.pathname === '/' || url.pathname === '/dashboard') return serveDashboard(res);
    if (url.pathname === '/drafts') return serveDrafts(res, url.searchParams.has('flagged'));
    if (url.pathname === '/lead') return serveLead(res, url.searchParams.get('email') ?? '');
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    vlog.error('viewer error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something broke — check the logs.');
  }
});

server.listen(PORT, () => {
  vlog.info('viewer listening', { port: PORT, passwordSet: Boolean(PASSWORD) });
  if (!PASSWORD) vlog.warn('VIEWER_PASSWORD not set — all requests will be rejected');
});
