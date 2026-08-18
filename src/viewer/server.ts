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
import { recordEvent } from '../db/events.js';
import { eventsForLead } from '../db/events.js';
import { getLeadByEmail, getLeadById, upsertLead } from '../db/leads.js';
import { rewriteDraft } from '../copy/generate.js';
import { isFreemail } from '../ingest/normalise.js';
import { enrichCandidates } from '../prospecting/enrich.js';
import { generateDm, igHandle, type DmProspect } from '../prospecting/dm.js';
import type { Lead } from '../types.js';
import { randomUUID } from 'node:crypto';
import { renderMessage } from '../copy/render.js';
import { lintBody } from '../copy/lint.js';
import { saveDraftToMailbox, sendMail } from '../mail/client.js';

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
.err{color:var(--yellow);margin-bottom:14px}
.actions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;align-items:flex-start}
.actions form.inline{margin:0}
.actions form.grow{flex:1;min-width:260px;margin:0}
button.secondary{background:var(--card2);color:var(--ink2);border:1px solid var(--line)}
button.secondary:hover{background:#33342f;color:var(--ink)}
.btnlink{display:inline-block;padding:8px 16px;border-radius:8px;font:700 14px 'Space Grotesk',Arial;text-decoration:none;background:var(--card2);color:var(--ink2);border:1px solid var(--line)}
.btnlink:hover{background:#33342f;color:var(--ink)}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.field input[type=text],.field textarea{width:100%;background:var(--card2);border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:10px 12px;font:inherit;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:7px 10px 7px 0;border-top:1px solid var(--line);color:var(--ink2);vertical-align:top}
.muted{color:var(--muted)}
</style></head><body><div class="wrap">
<nav><span class="wordmark">vedr<i>í</i></span><a href="/">dashboard</a><a href="/drafts">drafts</a><a href="/prospects">prospects</a></nav>
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
  suppressed: number | null;
}

function draftsRows(): DraftRow[] {
  return db()
    .prepare(
      `SELECT dr.id, dr.subject, dr.body, dr.status, dr.lint_status, dr.sequence_id, dr.step, dr.created_at,
              l.email, l.company, l.temperature, l.score, l.suppressed
       FROM drafts dr LEFT JOIN leads l ON l.id = dr.lead_id
       ORDER BY dr.created_at DESC LIMIT 100`,
    )
    .all() as DraftRow[];
}

function draftActions(d: DraftRow): string {
  if (d.status === 'sent') {
    return `<div class="meta" style="margin-top:12px"><span class="chip hot">✓ sent ${esc(d.created_at.slice(0, 10))}</span></div>`;
  }
  if (d.status === 'approved') {
    return `<div class="meta" style="margin-top:12px"><span class="chip hot">✓ approved — in your mailbox Drafts, press Send there</span></div>`;
  }
  if (d.status === 'lint_failed') {
    return `<div class="actions"><a class="btnlink secondary" href="/draft?id=${esc(d.id)}">Open & fix</a></div>`;
  }
  if (d.status !== 'pending' || d.suppressed) return '';
  const approveLabel = config.approve.action === 'send' ? 'Approve & send' : 'Approve → my Drafts folder';
  return `
      <div class="actions">
        <form method="POST" action="/approve" class="inline">
          <input type="hidden" name="id" value="${esc(d.id)}">
          <button type="submit">${approveLabel}</button>
        </form>
        <a class="btnlink secondary" href="/draft?id=${esc(d.id)}">Edit</a>
        <form method="POST" action="/flag" class="grow">
          <input type="hidden" name="id" value="${esc(d.id)}">
          <input type="text" name="note" placeholder="What's wrong with this one? (tone, claim, wrong person…)" required>
          <button type="submit" class="secondary">Flag it</button>
        </form>
      </div>`;
}

function serveDrafts(res: ServerResponse, flash: { flagged?: boolean; approved?: boolean; sent?: boolean; error?: string }): void {
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
      ${draftActions(d)}
    </div>`;
    })
    .join('');
  const pending = rows.filter((r) => r.status === 'pending').length;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    page(
      'vedrí — drafts',
      `<h1>Drafts <span class="muted">· ${pending} awaiting review</span></h1>
       ${flash.flagged ? '<div class="ok">✓ Flag recorded — it will be reviewed and the engine tuned.</div>' : ''}
       ${flash.approved ? '<div class="ok">✓ Approved — the email is now in your info@vedri.studio Drafts folder. Open your mail and press Send when ready.</div>' : ''}
       ${flash.sent ? '<div class="ok">✓ Sent. The email has left info@vedri.studio — replies will be picked up by the engine automatically.</div>' : ''}
       ${flash.error ? `<div class="err">✗ ${esc(flash.error)}</div>` : ''}
       ${cards || '<div class="card">No drafts yet.</div>'}`,
    ),
  );
}

/**
 * Approve — Daniel's click IS the send decision. With APPROVE_ACTION=send
 * (his chosen default) the email goes out via SMTP immediately; with 'stage'
 * it is placed in the mailbox Drafts folder for a second manual send. Either
 * way this only ever happens on an explicit authenticated human click — the
 * automated cycle can never reach this code. Suppression is re-checked here.
 */
function handleApprove(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    void (async () => {
      const id = new URLSearchParams(raw).get('id') ?? '';
      const d = db()
        .prepare(
          `SELECT dr.id, dr.subject, dr.body, dr.status, dr.lint_status, l.id AS lead_id, l.email, l.suppressed
           FROM drafts dr LEFT JOIN leads l ON l.id = dr.lead_id WHERE dr.id = ?`,
        )
        .get(id) as
        | { id: string; subject: string; body: string; status: string; lint_status: string | null; lead_id: string | null; email: string | null; suppressed: number | null }
        | undefined;

      const fail = (msg: string) => {
        res.writeHead(303, { Location: `/drafts?error=${encodeURIComponent(msg)}` });
        res.end();
      };

      if (!d) return fail('Draft not found.');
      if (d.status !== 'pending') return fail('Only pending drafts can be approved.');
      if (!d.email || !d.lead_id) return fail('Draft has no recipient.');
      if (d.suppressed || db().prepare('SELECT 1 FROM suppression WHERE email = ?').get(d.email.toLowerCase())) {
        return fail('Recipient is suppressed — cannot approve.');
      }

      const rendered = renderMessage(d.subject, d.body);
      const sendMode = config.approve.action === 'send';
      try {
        if (sendMode) {
          await sendMail(d.email, d.subject, rendered.full);
        } else {
          await saveDraftToMailbox(d.email, d.subject, rendered.full);
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        vlog.error('approve failed at mail step', { id, sendMode, error: m });
        return fail(`Could not ${sendMode ? 'send' : 'stage'} (${m}) — nothing was changed, try again.`);
      }

      const now = new Date().toISOString();
      db().prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(sendMode ? 'sent' : 'approved', now, id);
      recordEvent({
        leadId: d.lead_id,
        type: sendMode ? 'email.sent' : 'draft.approved',
        trigger: 'viewer',
        reason: sendMode
          ? `Approved and SENT by Daniel via the viewer (${d.subject})`
          : `Approved by Daniel — staged to mailbox Drafts (${d.subject})`,
      });
      vlog.info(sendMode ? 'draft approved and sent' : 'draft approved (staged)', { id, to: d.email });
      res.writeHead(303, { Location: `/drafts?${sendMode ? 'sent' : 'approved'}=1` });
      res.end();
    })();
  });
}

/** Draft detail — read, amend (subject + body), approve or flag in one place. */
function serveDraftDetail(
  res: ServerResponse,
  id: string,
  flash: { saved?: boolean; rewritten?: boolean; flagged?: boolean; error?: string },
): void {
  const d = db()
    .prepare(
      `SELECT dr.*, l.email AS lead_email, l.company, l.temperature, l.score
       FROM drafts dr LEFT JOIN leads l ON l.id = dr.lead_id WHERE dr.id = ?`,
    )
    .get(id) as (DraftRow & { lead_email: string | null }) | undefined;
  if (!d) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('vedrí — draft', '<div class="card">Draft not found.</div>'));
    return;
  }
  const editable = d.status === 'pending' || d.status === 'lint_failed';
  const bandClass = d.temperature === 'Hot' ? 'hot' : d.temperature === 'Warm' ? 'warm' : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    page(
      'vedrí — draft',
      `<h1>Draft <span class="muted">· ${esc(d.sequence_id)} step ${d.step + 1}</span></h1>
      ${flash.saved ? '<div class="ok">✓ Changes saved and re-checked.</div>' : ''}
      ${flash.rewritten ? '<div class="ok">✓ Rewritten around your steer — read it over, tweak if needed, approve when happy.</div>' : ''}
      ${flash.flagged ? '<div class="err">The rewrite tripped the style check — its reasons are on the chip above. Edit by hand or steer again.</div>' : ''}
      ${flash.error ? `<div class="err">✗ ${esc(flash.error)}</div>` : ''}
      <div class="card">
        <div class="meta">
          <span class="chip">${esc(d.lead_email ?? '?')}</span>
          ${d.company ? `<span class="chip">${esc(d.company)}</span>` : ''}
          <span class="chip ${bandClass}">${esc(d.temperature ?? '?')} ${d.score ?? ''}</span>
          ${d.status === 'lint_failed' ? `<span class="chip flagged">${esc(d.lint_status ?? 'flagged')}</span>` : `<span class="chip">${esc(d.status)}</span>`}
        </div>
        ${
          editable
            ? `<form method="POST" action="/edit">
                <input type="hidden" name="id" value="${esc(d.id)}">
                <div class="field"><label>Subject</label>
                <input type="text" name="subject" value="${esc(d.subject)}" required></div>
                <div class="field"><label>Body <span class="muted">(the signature + unsubscribe footer is added automatically)</span></label>
                <textarea name="body" rows="14" required>${esc(d.body)}</textarea></div>
                <div class="actions"><button type="submit" class="secondary">Save changes</button></div>
              </form>
              ${d.status === 'pending' ? `<div class="actions"><form method="POST" action="/approve" class="inline"><input type="hidden" name="id" value="${esc(d.id)}"><button type="submit">${config.approve.action === 'send' ? 'Approve & send' : 'Approve → my Drafts folder'}</button></form></div>` : '<div class="meta" style="margin-top:10px"><span class="muted">Fix the issues and save — it becomes approvable once clean.</span></div>'}
              <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px">
                <div class="subject">Tell it what to say</div>
                <div class="muted" style="margin-bottom:8px">Describe what this email should say — what you know about them, an angle to take, something to mention or drop. It gets rewritten in the studio voice around your steer.</div>
                <form method="POST" action="/rewrite">
                  <input type="hidden" name="id" value="${esc(d.id)}">
                  <div class="field"><textarea name="instruction" rows="3" required placeholder="e.g. They've just opened a new studio in Cardiff — congratulate them, and ask if they shoot interviews there. Mention we spoke at BSC."></textarea></div>
                  <div class="actions"><button type="submit">Rewrite it for me</button></div>
                </form>
              </div>`
            : `<div class="subject">${esc(d.subject)}</div><pre>${esc(d.body)}</pre>`
        }
      </div>
      <p><a href="/drafts" style="color:var(--ink2)">← back to drafts</a></p>`,
    ),
  );
}

/**
 * Save an amendment. The kit-leak rule still hard-blocks (it protects the
 * business even from hand-written copy); other lint rules downgrade to a
 * warning chip — the human's words are the human's call. A lint_failed draft
 * that comes back clean returns to pending and becomes approvable.
 */
function handleEdit(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const params = new URLSearchParams(raw);
    const id = params.get('id') ?? '';
    const subject = (params.get('subject') ?? '').slice(0, 300).trim();
    const body = (params.get('body') ?? '').slice(0, 10_000).trim();
    const back = (q: string) => {
      res.writeHead(303, { Location: `/draft?id=${encodeURIComponent(id)}&${q}` });
      res.end();
    };

    const d = db().prepare('SELECT id, status, lead_id FROM drafts WHERE id = ?').get(id) as
      | { id: string; status: string; lead_id: string | null }
      | undefined;
    if (!d) return back('error=Draft%20not%20found');
    if (d.status !== 'pending' && d.status !== 'lint_failed') return back('error=This%20draft%20can%20no%20longer%20be%20edited');
    if (!subject || !body) return back('error=Subject%20and%20body%20are%20required');

    const lint = lintBody(subject, body);
    const kitLeak = lint.failures.filter((f) => f.includes('kit'));
    if (kitLeak.length) {
      return back(`error=${encodeURIComponent(`Blocked — internal kit terms must never reach a client: ${kitLeak.join('; ')}`)}`);
    }

    const now = new Date().toISOString();
    const lintStatus = lint.pass ? 'pass' : `warn (your call): ${lint.failures.join('; ')}`;
    db()
      .prepare("UPDATE drafts SET subject = ?, body = ?, status = 'pending', lint_status = ?, updated_at = ? WHERE id = ?")
      .run(subject, body, lintStatus, now, id);
    recordEvent({
      leadId: d.lead_id,
      type: 'draft.edited',
      trigger: 'viewer',
      reason: `Amended by Daniel in the viewer (${subject})${lint.pass ? '' : ' — style warnings accepted'}`,
    });
    vlog.info('draft edited', { id, lintPass: lint.pass });
    back('saved=1');
  });
}

/**
 * Daniel-steered rewrite: he says what the email should say, the generator
 * rewrites around it. His instruction is trusted as fact (he knows the
 * relationship); the machine gate (kit terms, fluff, footer) still applies to
 * the output, so even a steered rewrite cannot leak the kit list.
 */
function handleRewrite(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, async (params) => {
    const id = params.get('id') ?? '';
    const instruction = (params.get('instruction') ?? '').slice(0, 1500).trim();
    const back = (q: string) => {
      res.writeHead(303, { Location: `/draft?id=${encodeURIComponent(id)}&${q}` });
      res.end();
    };

    const d = db()
      .prepare('SELECT id, subject, body, status, lead_id FROM drafts WHERE id = ?')
      .get(id) as { id: string; subject: string; body: string; status: string; lead_id: string | null } | undefined;
    if (!d) return back('error=Draft%20not%20found');
    if (d.status !== 'pending' && d.status !== 'lint_failed') return back('error=This%20draft%20can%20no%20longer%20be%20changed');
    if (!instruction) return back('error=Tell%20it%20what%20to%20say%20first');
    const lead = d.lead_id ? getLeadById(d.lead_id) : null;
    if (!lead) return back('error=Draft%20has%20no%20lead');

    try {
      const gen = await rewriteDraft(lead, { instruction, currentSubject: d.subject, currentBody: d.body });
      const now = new Date().toISOString();
      const status = gen.lint.pass ? 'pending' : 'lint_failed';
      db()
        .prepare('UPDATE drafts SET subject = ?, body = ?, status = ?, lint_status = ?, updated_at = ? WHERE id = ?')
        .run(gen.subjects[0] ?? d.subject, gen.body, status, gen.lint.pass ? 'pass' : `fail: ${gen.lint.failures.join('; ')}`, now, id);
      recordEvent({
        leadId: lead.id,
        type: 'draft.rewritten',
        trigger: 'viewer',
        reason: `Rewritten to Daniel's steer: "${instruction.slice(0, 140)}"`,
        data: { draftId: id, lintPass: gen.lint.pass },
      });
      // The steer is a tuning signal — keep it with the flag feedback.
      mkdirSync('data', { recursive: true });
      appendFileSync(
        'data/feedback.log',
        JSON.stringify({ at: now, draftId: id, kind: 'steer', instruction }) + '\n',
      );
      vlog.info('draft rewritten to steer', { id, lintPass: gen.lint.pass });
      back(gen.lint.pass ? 'rewritten=1' : 'flagged=1');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vlog.error('steered rewrite failed', { id, error: m });
      back(`error=${encodeURIComponent(`Could not rewrite (${m}) — the draft is unchanged, try again.`)}`);
    }
  });
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

// ── prospects (the prospector's review queue) ───────────────────────────────
interface ProspectRow {
  id: string;
  company: string;
  website: string | null;
  domain: string | null;
  location: string | null;
  category: string | null;
  track: string;
  why_fit: string | null;
  evidence_url: string;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_page_url: string | null;
  contact_source_url: string | null;
  enriched_at: string | null;
  origin: string;
  status: string;
  discovered_at: string;
  ig_dm: string | null;
  ig_dm_status: string;
  ig_dm_sent_at: string | null;
  ig_dm_count: number;
}

/** The Instagram DM panel for an instagram-origin prospect card. */
function dmPanel(p: ProspectRow): string {
  if (p.origin !== 'instagram' || p.status === 'discarded') return '';
  const handle = igHandle(p.evidence_url);
  if (!handle) return '';
  const dmLink = `https://ig.me/m/${esc(handle)}`;
  const writeLabel = p.ig_dm_count >= 1 ? 'Write the follow-up DM' : 'Write a DM';

  if (p.ig_dm_status === 'none') {
    return `<div class="actions"><form method="POST" action="/prospect-dm" class="inline"><input type="hidden" name="id" value="${esc(p.id)}"><button type="submit" class="secondary">${writeLabel}</button></form></div>`;
  }
  if (p.ig_dm_status === 'drafted' || p.ig_dm_status === 'follow_up_due') {
    return `
      ${p.ig_dm_status === 'follow_up_due' ? '<div class="meta" style="margin-top:10px"><span class="chip flagged">follow-up due — no reply to your last DM</span></div>' : ''}
      <div class="field" style="margin-top:10px"><label>Instagram DM — copy, then send it from your own account</label>
      <textarea rows="4" readonly>${esc(p.ig_dm ?? '')}</textarea></div>
      <div class="actions">
        <button type="button" onclick="navigator.clipboard.writeText(this.closest('.card').querySelector('textarea').value);this.textContent='Copied ✓'">Copy DM</button>
        <a class="btnlink" href="${dmLink}" target="_blank" rel="noopener">Open their DMs ↗</a>
        <form method="POST" action="/prospect-dm-sent" class="inline"><input type="hidden" name="id" value="${esc(p.id)}"><button type="submit" class="secondary">I've sent it</button></form>
        <form method="POST" action="/prospect-dm" class="inline"><input type="hidden" name="id" value="${esc(p.id)}"><button type="submit" class="secondary">Rewrite</button></form>
      </div>`;
  }
  if (p.ig_dm_status === 'sent') {
    return `<div class="actions">
      <span class="chip">DM sent ${esc((p.ig_dm_sent_at ?? '').slice(0, 10))} — waiting${p.ig_dm_count >= 2 ? ' (last one)' : ''}</span>
      <form method="POST" action="/prospect-dm-replied" class="inline"><input type="hidden" name="id" value="${esc(p.id)}"><button type="submit">They replied 🎉</button></form>
    </div>`;
  }
  if (p.ig_dm_status === 'replied') {
    return `<div class="meta" style="margin-top:10px"><span class="chip hot">replied on Instagram — carry the chat on there, or approve above to move to email</span></div>`;
  }
  if (p.ig_dm_status === 'done') {
    return `<div class="meta" style="margin-top:10px"><span class="muted">No reply after ${p.ig_dm_count} DMs — leaving them be.</span></div>`;
  }
  return '';
}

function serveProspects(
  res: ServerResponse,
  flash: { approved?: boolean; discarded?: boolean; added?: string; dup?: string; error?: string },
): void {
  const rows = db()
    .prepare(
      `SELECT * FROM prospects
       ORDER BY CASE status WHEN 'candidate' THEN 0 ELSE 1 END, discovered_at DESC
       LIMIT 100`,
    )
    .all() as ProspectRow[];
  const candidates = rows.filter((r) => r.status === 'candidate').length;
  const cards = rows
    .map((p) => {
      const link = (url: string | null, label: string) =>
        url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--lime)">${esc(label)}</a>` : '';
      const actions =
        p.status === 'candidate'
          ? `<div class="actions">
              <form method="POST" action="/prospect-approve" class="grow">
                <input type="hidden" name="id" value="${esc(p.id)}">
                <input type="text" name="email" value="${esc(p.contact_email ?? '')}" placeholder="contact email (find it via their site, then paste here)" required>
                <button type="submit">Approve → becomes a lead</button>
              </form>
              <form method="POST" action="/prospect-discard" class="inline">
                <input type="hidden" name="id" value="${esc(p.id)}">
                <button type="submit" class="secondary">Bin it</button>
              </form>
            </div>`
          : `<div class="meta" style="margin-top:10px"><span class="chip ${p.status === 'approved' ? 'hot' : ''}">${esc(p.status)}</span></div>`;
      return `<div class="card">
        <div class="meta">
          ${p.origin === 'instagram' ? '<span class="chip flagged">instagram</span>' : ''}
          <span class="chip">${esc(p.track)}</span>
          ${p.category ? `<span class="chip">${esc(p.category)}</span>` : ''}
          ${p.location ? `<span class="chip">${esc(p.location)}</span>` : ''}
          <span class="muted">${esc(p.discovered_at.slice(0, 10))}</span>
        </div>
        <div class="subject">${esc(p.company)}${p.website ? ` · ${link(p.website, p.domain ?? 'site')}` : ''}</div>
        <div style="color:var(--ink2)">${esc(p.why_fit ?? '')}</div>
        ${
          p.contact_name || p.contact_email
            ? `<div class="meta" style="margin-top:8px"><span class="chip warm">contact: ${esc(p.contact_name ?? 'role inbox')}${p.contact_role ? ` — ${esc(p.contact_role)}` : ''}${p.contact_email ? ` · ${esc(p.contact_email)}` : ' · no published email'}</span>${p.contact_source_url ? ' ' + link(p.contact_source_url, 'where we found it ↗') : ''}</div>`
            : p.enriched_at
              ? `<div class="meta" style="margin-top:8px"><span class="muted">No published contact found — check their site by hand.</span></div>`
              : ''
        }
        <div class="meta" style="margin-top:8px">
          ${link(p.evidence_url, 'evidence ↗')}
          ${p.contact_page_url ? '· ' + link(p.contact_page_url, 'contact page ↗') : ''}
        </div>
        ${dmPanel(p)}
        ${actions}
      </div>`;
    })
    .join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    page(
      'vedrí — prospects',
      `<h1>Prospects <span class="muted">· ${candidates} awaiting review</span></h1>
       <p class="muted" style="margin-bottom:16px">Found weekly by the prospector with live web search. Check the evidence link — approving creates a lead for your Built List; binning a company means it is never suggested again. Nobody here is contacted until you approve them AND their sequence goes live.</p>
       ${flash.approved ? '<div class="ok">✓ Approved — created as a Built List lead. An intro note will be drafted for them on the next hourly cycle; review it under drafts as usual.</div>' : ''}
       ${flash.discarded ? '<div class="ok">✓ Binned — this company will not be suggested again.</div>' : ''}
       ${flash.added ? `<div class="ok">✓ Queued ${esc(flash.added)} Instagram account(s)${flash.dup && flash.dup !== '0' ? ` (${esc(flash.dup)} already known)` : ''} — research starts now and fills in who they are within a few minutes. Refresh to see it land.</div>` : ''}
       ${flash.error ? `<div class="err">✗ ${esc(flash.error)}</div>` : ''}
       <div class="card">
         <div class="subject">Add from Instagram</div>
         <div class="muted" style="margin-bottom:8px">Seen someone liking, commenting or following vedri.studio? Paste their handle(s) here — I'll work out who they are, find their website and the best person to contact, and queue them below. Separate several with spaces or commas.</div>
         <form method="POST" action="/prospect-instagram">
           <input type="text" name="handles" placeholder="@somestudio, @another.account" required>
           <button type="submit">Research them</button>
         </form>
       </div>
       ${cards || '<div class="card">No prospects yet — the prospector runs weekly, or run <code>pnpm run prospect</code> on the VPS.</div>'}`,
    ),
  );
}

/** Approve a candidate → create a Built List lead (email is Daniel-confirmed). */
function handleProspectApprove(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const params = new URLSearchParams(raw);
    const id = params.get('id') ?? '';
    const email = (params.get('email') ?? '').trim().toLowerCase();
    const fail = (msg: string) => {
      res.writeHead(303, { Location: `/prospects?error=${encodeURIComponent(msg)}` });
      res.end();
    };

    const p = db().prepare("SELECT * FROM prospects WHERE id = ? AND status = 'candidate'").get(id) as
      | ProspectRow
      | undefined;
    if (!p) return fail('Prospect not found or already reviewed.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('A valid contact email is needed to create the lead.');
    if (db().prepare('SELECT 1 FROM suppression WHERE email = ?').get(email)) {
      return fail('That email is on the suppression list — cannot create a lead for it.');
    }

    const lead = upsertLead({
      email,
      company: p.company,
      companyDomain: p.domain,
      firstName: p.contact_name ? p.contact_name.split(/\s+/)[0]! : null,
      lastName: p.contact_name ? p.contact_name.split(/\s+/).slice(1).join(' ') || null : null,
      track: (p.track === 'Studio' || p.track === 'VFX' ? p.track : 'Both') as Lead['track'],
      source: 'Built List',
      internalNotes: `Prospector: ${p.why_fit ?? ''} · evidence: ${p.evidence_url}${p.contact_role ? ` · contact role: ${p.contact_role}` : ''}`,
      liaBasis: `Legitimate interest (B2B relevance) — prospector candidate approved by Daniel; evidence: ${p.evidence_url}`,
      needsConsent: isFreemail(email),
    });
    const now = new Date().toISOString();
    db()
      .prepare("UPDATE prospects SET status = 'approved', lead_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(lead.id, now, now, id);
    recordEvent({
      leadId: lead.id,
      type: 'prospect.approved',
      trigger: 'viewer',
      reason: `Prospect ${p.company} approved by Daniel → Built List lead (${email})`,
      data: { prospectId: id, company: p.company, domain: p.domain },
    });
    vlog.info('prospect approved', { id, company: p.company, email });
    res.writeHead(303, { Location: '/prospects?approved=1' });
    res.end();
  });
}

/**
 * Instagram intake — Daniel pastes handles of accounts engaging with
 * vedri.studio; each becomes a candidate and the research (who are they, best
 * contact, published email) kicks off in the background. We never automate
 * Instagram itself — that's how accounts get banned.
 */
function handleProspectInstagram(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const input = (new URLSearchParams(raw).get('handles') ?? '').slice(0, 2000);
    const handles = [
      ...new Set(
        input
          .split(/[\s,;]+/)
          .map((h) => h.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '').toLowerCase())
          .filter((h) => /^[a-z0-9._]{1,30}$/.test(h)),
      ),
    ];
    if (handles.length === 0) {
      res.writeHead(303, { Location: `/prospects?error=${encodeURIComponent('No valid Instagram handles found in that — paste them like @somestudio.')}` });
      res.end();
      return;
    }

    const now = new Date().toISOString();
    let added = 0;
    let dup = 0;
    for (const h of handles) {
      const evidenceUrl = `https://www.instagram.com/${h}/`;
      if (db().prepare('SELECT 1 FROM prospects WHERE evidence_url = ?').get(evidenceUrl)) {
        dup++;
        continue;
      }
      const id = randomUUID();
      db()
        .prepare(
          `INSERT INTO prospects (id, company, track, why_fit, evidence_url, status, origin, discovered_at, created_at, updated_at)
           VALUES (?, ?, 'Both', ?, ?, 'candidate', 'instagram', ?, ?, ?)`,
        )
        .run(id, `@${h}`, 'Engaged with vedri.studio on Instagram — research pending.', evidenceUrl, now, now, now);
      recordEvent({
        type: 'prospect.discovered',
        trigger: 'instagram-intake',
        reason: `Instagram account @${h} added by Daniel from vedri.studio engagement — research queued.`,
        data: { prospectId: id, handle: h },
      });
      added++;
    }

    if (added > 0) {
      // Fire-and-forget: the research runs in this process while Daniel gets
      // an immediate response; refreshing the page shows results as they land.
      enrichCandidates(added).catch((err) =>
        vlog.warn('instagram research failed — the hourly cycle will retry', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    vlog.info('instagram handles queued', { added, dup });
    res.writeHead(303, { Location: `/prospects?added=${added}&dup=${dup}` });
    res.end();
  });
}

function handleProspectDiscard(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const id = new URLSearchParams(raw).get('id') ?? '';
    const now = new Date().toISOString();
    const p = db().prepare("SELECT company FROM prospects WHERE id = ? AND status = 'candidate'").get(id) as
      | { company: string }
      | undefined;
    if (p) {
      db()
        .prepare("UPDATE prospects SET status = 'discarded', reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      recordEvent({
        type: 'prospect.discarded',
        trigger: 'viewer',
        reason: `Prospect ${p.company} binned by Daniel — will not be suggested again.`,
        data: { prospectId: id },
      });
      vlog.info('prospect discarded', { id, company: p.company });
    }
    res.writeHead(303, { Location: '/prospects?discarded=1' });
    res.end();
  });
}

// ── Instagram DM assist (draft/track only — Daniel's thumb does the sends) ──
function readBody(req: IncomingMessage, cb: (params: URLSearchParams) => void | Promise<void>): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => void cb(new URLSearchParams(raw)));
}

function handleDmWrite(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, async (params) => {
    const id = params.get('id') ?? '';
    const p = db()
      .prepare(
        `SELECT id, company, category, location, why_fit, contact_name, track, ig_dm_count FROM prospects
         WHERE id = ? AND origin = 'instagram' AND status != 'discarded'`,
      )
      .get(id) as (DmProspect & { ig_dm_count: number }) | undefined;
    if (!p) {
      res.writeHead(303, { Location: '/prospects?error=Prospect%20not%20found' });
      res.end();
      return;
    }
    try {
      const dm = await generateDm(p, p.ig_dm_count >= 1 ? 'follow_up' : 'intro');
      const now = new Date().toISOString();
      db().prepare("UPDATE prospects SET ig_dm = ?, ig_dm_status = 'drafted', updated_at = ? WHERE id = ?").run(dm, now, id);
      recordEvent({
        type: 'prospect.dm',
        trigger: 'viewer',
        reason: `DM drafted for ${p.company} (${p.ig_dm_count >= 1 ? 'follow-up' : 'intro'})`,
        data: { prospectId: id, status: 'drafted' },
      });
      res.writeHead(303, { Location: '/prospects' });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vlog.error('dm draft failed', { id, error: m });
      res.writeHead(303, { Location: `/prospects?error=${encodeURIComponent(`Could not draft the DM (${m}) — try again.`)}` });
    }
    res.end();
  });
}

function handleDmSent(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (params) => {
    const id = params.get('id') ?? '';
    const now = new Date().toISOString();
    const p = db()
      .prepare("SELECT company FROM prospects WHERE id = ? AND ig_dm_status IN ('drafted','follow_up_due')")
      .get(id) as { company: string } | undefined;
    if (p) {
      db()
        .prepare(
          "UPDATE prospects SET ig_dm_status = 'sent', ig_dm_sent_at = ?, ig_dm_count = ig_dm_count + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
      recordEvent({
        type: 'prospect.dm',
        trigger: 'viewer',
        reason: `Daniel sent the Instagram DM to ${p.company} from his own account.`,
        data: { prospectId: id, status: 'sent' },
      });
    }
    res.writeHead(303, { Location: '/prospects' });
    res.end();
  });
}

function handleDmReplied(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (params) => {
    const id = params.get('id') ?? '';
    const now = new Date().toISOString();
    const p = db().prepare('SELECT company FROM prospects WHERE id = ?').get(id) as { company: string } | undefined;
    if (p) {
      db().prepare("UPDATE prospects SET ig_dm_status = 'replied', updated_at = ? WHERE id = ?").run(now, id);
      recordEvent({
        type: 'prospect.dm',
        trigger: 'viewer',
        reason: `${p.company} replied on Instagram — conversation is live.`,
        data: { prospectId: id, status: 'replied' },
      });
    }
    res.writeHead(303, { Location: '/prospects' });
    res.end();
  });
}

// ── server ──────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (!authorised(req)) return unauthorised(res);
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/flag') return handleFlag(req, res);
    if (req.method === 'POST' && url.pathname === '/approve') return handleApprove(req, res);
    if (req.method === 'POST' && url.pathname === '/edit') return handleEdit(req, res);
    if (req.method === 'POST' && url.pathname === '/rewrite') return handleRewrite(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-approve') return handleProspectApprove(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-discard') return handleProspectDiscard(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-instagram') return handleProspectInstagram(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-dm') return handleDmWrite(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-dm-sent') return handleDmSent(req, res);
    if (req.method === 'POST' && url.pathname === '/prospect-dm-replied') return handleDmReplied(req, res);
    if (url.pathname === '/prospects')
      return serveProspects(res, {
        approved: url.searchParams.has('approved'),
        discarded: url.searchParams.has('discarded'),
        added: url.searchParams.get('added') ?? undefined,
        dup: url.searchParams.get('dup') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
      });
    if (url.pathname === '/' || url.pathname === '/dashboard') return serveDashboard(res);
    if (url.pathname === '/draft')
      return serveDraftDetail(res, url.searchParams.get('id') ?? '', {
        saved: url.searchParams.has('saved'),
        rewritten: url.searchParams.has('rewritten'),
        flagged: url.searchParams.has('flagged'),
        error: url.searchParams.get('error') ?? undefined,
      });
    if (url.pathname === '/drafts')
      return serveDrafts(res, {
        flagged: url.searchParams.has('flagged'),
        approved: url.searchParams.has('approved'),
        sent: url.searchParams.has('sent'),
        error: url.searchParams.get('error') ?? undefined,
      });
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
