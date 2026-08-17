/**
 * Dashboard — a single self-contained dashboard.html regenerated each cycle.
 *
 * Brand: dark #111118 base with radial lime glows bleeding in from corners at
 * 7–20% opacity, Space Grotesk (base64-embedded so the file is fully
 * self-contained — no external JS/CSS/font requests), lowercase vedrí wordmark.
 *
 * Colour discipline (validated): the three brand greens are NOT a categorical
 * palette (adjacent ΔE ≈ 5 — fails CVD + normal-vision floors), so one green
 * (#9FCC3B, ≥3:1 on #111118) carries all data magnitude; band identity is
 * carried by text labels and column position, colour only reinforces; the
 * lighter limes are reserved for glows and accents.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { log } from './logger.js';
import { db } from './db/index.js';
import { projectCloses, recommend, BAND_CLOSE_PROBABILITY } from './governor.js';
import { TARGET } from '../config/funnel-model.js';

const dlog = log.child('dashboard');

// ── data gathering ──────────────────────────────────────────────────────────

interface LeadRow {
  email: string;
  company: string | null;
  first_name: string | null;
  last_name: string | null;
  score: number;
  temperature: string;
  sequence_id: string | null;
  sequence_step: number | null;
  next_touch_at: string | null;
}

function gather(asOf: Date) {
  const d = db();
  const bands = Object.fromEntries(
    (d.prepare('SELECT temperature, COUNT(*) c FROM leads GROUP BY temperature').all() as { temperature: string; c: number }[]).map(
      (r) => [r.temperature, r.c],
    ),
  ) as Record<string, number>;

  const byBand = (band: string, limit: number) =>
    d
      .prepare('SELECT * FROM leads WHERE temperature = ? ORDER BY score DESC LIMIT ?')
      .all(band, limit) as LeadRow[];

  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1)).toISOString();
  const won = d
    .prepare("SELECT COUNT(*) c FROM events WHERE type='band.changed' AND json_extract(data,'$.newBand')='Closed Won' AND created_at >= ?")
    .get(monthStart) as { c: number };

  // Allow-list of genuine evidence — must match governor.stageDataPoints.
  const dataPoints = d
    .prepare(
      `SELECT COUNT(*) c FROM events WHERE type = 'reply.classified'
        OR (type = 'score.signal' AND trigger = 'reply')`,
    )
    .get() as { c: number };

  const projection = projectCloses(
    {
      Hot: bands.Hot ?? 0,
      Warm: bands.Warm ?? 0,
      Cold: bands.Cold ?? 0,
      Nurture: bands.Nurture ?? 0,
      closedWonThisMonth: won.c,
    },
    dataPoints.c,
  );
  const rec = recommend(projection);

  // This month's activity funnel, from the event log (honest counts, not model).
  const evCount = (like: string) =>
    (d.prepare(`SELECT COUNT(*) c FROM events WHERE type = ? AND created_at >= ?`).get(like, monthStart) as { c: number }).c;
  const funnel = [
    { label: 'Leads in play', n: (bands.Hot ?? 0) + (bands.Warm ?? 0) + (bands.Cold ?? 0) },
    { label: 'Drafts created', n: evCount('draft.created') },
    { label: 'Replies received', n: evCount('reply.classified') },
    { label: 'Discovery booked', n: (d.prepare(`SELECT COUNT(*) c FROM events WHERE type='score.signal' AND json_extract(data,'$.signal')='discovery_booked' AND created_at >= ?`).get(monthStart) as { c: number }).c },
    { label: 'Closed won', n: won.c },
  ];

  const drafts = d
    .prepare(
      `SELECT dr.id, dr.subject, dr.sequence_id, dr.step, dr.status, l.email, l.company
       FROM drafts dr LEFT JOIN leads l ON l.id = dr.lead_id
       WHERE dr.status IN ('pending','lint_failed') ORDER BY dr.created_at DESC LIMIT 12`,
    )
    .all() as { id: string; subject: string; sequence_id: string; step: number; status: string; email: string; company: string | null }[];

  const week = new Date(asOf.getTime() + 7 * 86_400_000).toISOString();
  const touches = d
    .prepare(
      `SELECT email, company, first_name, last_name, score, temperature, sequence_id, sequence_step, next_touch_at
       FROM leads WHERE next_touch_at IS NOT NULL AND next_touch_at <= ? AND suppressed = 0
       ORDER BY next_touch_at ASC LIMIT 15`,
    )
    .all(week) as LeadRow[];

  return { bands, byBand, projection, rec, funnel, drafts, touches, dataPoints: dataPoints.c };
}

// ── rendering ───────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fontFace(): string {
  const load = (f: string) => readFileSync(join('assets/fonts', f)).toString('base64');
  try {
    return `
@font-face{font-family:'Space Grotesk';font-weight:400;src:url(data:font/ttf;base64,${load('SpaceGrotesk-Regular.ttf')}) format('truetype')}
@font-face{font-family:'Space Grotesk';font-weight:700;src:url(data:font/ttf;base64,${load('SpaceGrotesk-Bold.ttf')}) format('truetype')}`;
  } catch {
    return ''; // fonts missing → Arial fallback still applies
  }
}

function name(l: LeadRow): string {
  const n = [l.first_name, l.last_name].filter(Boolean).join(' ');
  return n || l.email;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: config.timezone }).format(new Date(iso));
}

const BAND_ACCENTS: Record<string, string> = { Hot: '#9FCC3B', Warm: '#B8E040', Cold: '#8A8A8E', Nurture: '#8A8A8E' };

function leadCard(l: LeadRow): string {
  return `<a class="lead" title="${esc(l.email)}" href="/lead?email=${encodeURIComponent(l.email)}">
    <div class="lead-name">${esc(name(l))}</div>
    <div class="lead-co">${esc(l.company ?? '')}</div>
    <div class="lead-score">${l.score}</div>
  </a>`;
}

export function renderDashboard(asOf: Date = new Date()): string {
  const g = gather(asOf);
  const target = TARGET.closesPerMonth;
  const gaugeMax = 3;
  const pct = Math.min(100, (g.projection.projected / gaugeMax) * 100);
  const targetPct = (target / gaugeMax) * 100;
  const funnelMax = Math.max(1, ...g.funnel.map((f) => f.n));
  const updated = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: config.timezone,
  }).format(asOf);

  const bandCol = (band: string) => `
    <div class="col">
      <div class="col-head" style="--accent:${BAND_ACCENTS[band]}">
        <span class="dot"></span>${band}<span class="count">${g.bands[band] ?? 0}</span>
      </div>
      ${g.byBand(band, 6).map(leadCard).join('') || '<div class="empty">none</div>'}
    </div>`;

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vedrí — funnel</title>
<style>
${fontFace()}
:root{--bg:#111118;--card:#1A1B22;--card2:#2A2B2A;--ink:#FFFFFF;--ink2:#C2C1C0;--muted:#8A8A8E;--green:#9FCC3B;--lime:#B8E040;--yellow:#D2EF4A;--line:rgba(194,193,192,.12)}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:400 15px/1.5 'Space Grotesk',Arial,sans-serif;min-height:100vh;
background-image:radial-gradient(1100px 700px at -8% -12%,rgba(159,204,59,.16),transparent 60%),radial-gradient(900px 650px at 108% 112%,rgba(184,224,64,.11),transparent 60%),radial-gradient(700px 500px at 105% -10%,rgba(210,239,74,.07),transparent 55%)}
.wrap{max-width:1180px;margin:0 auto;padding:36px 28px 64px}
header{display:flex;align-items:baseline;gap:16px;margin-bottom:28px;flex-wrap:wrap}
.wordmark{font-weight:700;font-size:34px;letter-spacing:-.5px}
.wordmark i{font-style:normal;color:var(--green)}
.sub{color:var(--muted);font-size:13px}
.badge{font-size:12px;padding:4px 12px;border:1px solid var(--line);border-radius:999px;color:var(--ink2)}
.badge.shadow{border-color:rgba(159,204,59,.45);color:var(--lime)}
.navlink{margin-left:auto;font-size:14px;font-weight:700;color:var(--green);text-decoration:none;padding:4px 12px;border:1px solid rgba(159,204,59,.45);border-radius:999px}
.navlink:hover{color:#111118;background:var(--green)}
.navlink.small{margin-left:12px;font-size:11px;font-weight:400;letter-spacing:normal;text-transform:none;padding:2px 10px}
.rowlink{color:var(--ink2);text-decoration:none}
.rowlink:hover{color:var(--lime)}
a.lead{text-decoration:none;color:inherit;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.card h2{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.span4{grid-column:span 4}.span6{grid-column:span 6}.span8{grid-column:span 8}.span12{grid-column:span 12}
@media(max-width:900px){.span4,.span6,.span8{grid-column:span 12}}
/* pace gauge */
.hero{font-weight:700;font-size:44px;line-height:1.1}
.hero small{font-size:15px;font-weight:400;color:var(--muted);margin-left:8px}
.gauge{position:relative;height:14px;border-radius:7px;background:var(--card2);margin:18px 0 8px;overflow:visible}
.gauge .fill{position:absolute;inset:0 auto 0 0;width:${pct.toFixed(1)}%;border-radius:7px;background:linear-gradient(90deg,var(--green),var(--lime))}
.gauge .target{position:absolute;top:-5px;bottom:-5px;left:${targetPct.toFixed(1)}%;width:2px;background:var(--ink);opacity:.85}
.gauge .target::after{content:'target ${target}';position:absolute;top:-20px;left:-24px;font-size:11px;color:var(--ink2);white-space:nowrap}
.scale{display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.note{color:var(--ink2);font-size:13px;margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.note b{color:var(--lime);font-weight:700}
/* pipeline board */
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:700px){.board{grid-template-columns:1fr}}
.col-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:10px}
.col-head .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.col-head .count{margin-left:auto;color:var(--muted);font-weight:400}
.lead{background:var(--card2);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:grid;grid-template-columns:1fr auto;gap:0 10px;transition:background .15s}
.lead:hover{background:#33342f}
.lead-name{font-weight:700;font-size:13.5px;grid-column:1}
.lead-co{color:var(--muted);font-size:12px;grid-column:1}
.lead-score{grid-column:2;grid-row:1/3;align-self:center;font-weight:700;color:var(--green);font-size:16px}
.empty{color:var(--muted);font-size:13px;padding:8px 2px}
/* funnel bars — one hue, magnitude by length, counts direct-labeled */
.frow{display:grid;grid-template-columns:150px 1fr 44px;align-items:center;gap:12px;margin-bottom:10px;font-size:13.5px}
.frow .lbl{color:var(--ink2)}
.frow .bar{height:22px;border-radius:4px;background:var(--card2);position:relative;overflow:hidden}
.frow .bar i{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--green);transition:filter .15s}
.frow:hover .bar i{filter:brightness(1.15)}
.frow .n{font-weight:700;text-align:right}
/* lists */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{color:var(--muted);font-weight:400;text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:0 10px 8px 0}
td{padding:7px 10px 7px 0;border-top:1px solid var(--line);color:var(--ink2)}
td.k{color:var(--ink);font-weight:700}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;background:var(--card2);color:var(--ink2)}
.chip.flag{color:#111118;background:var(--yellow);font-weight:700}
footer{margin-top:26px;color:var(--muted);font-size:12px}
</style></head><body>
<div class="wrap">
  <header>
    <div class="wordmark">vedr<i>í</i></div>
    <div class="sub">sales funnel · updated ${esc(updated)}</div>
    <a class="navlink" href="/drafts">review drafts →</a>
    <span class="badge ${config.dryRun ? 'shadow' : ''}">${config.dryRun ? 'shadow mode — nothing sends' : 'live'}</span>
  </header>

  <div class="grid">
    <div class="card span4">
      <h2>Pace to target</h2>
      <div class="hero">${g.projection.projected.toFixed(1)}<small>projected closes / ${target} target</small></div>
      <div class="gauge"><div class="fill"></div><div class="target"></div></div>
      <div class="scale"><span>0</span><span>${gaugeMax}</span></div>
      <div class="note"><b>${esc(g.rec.status)}</b> — ${esc(g.rec.message.split('. ').slice(0, 2).join('. '))}.</div>
    </div>

    <div class="card span8">
      <h2>Pipeline by temperature</h2>
      <div class="board">
        ${bandCol('Hot')}
        ${bandCol('Warm')}
        ${bandCol('Cold')}
      </div>
    </div>

    <div class="card span4">
      <h2>This month</h2>
      ${g.funnel
        .map(
          (f) => `<div class="frow" title="${esc(f.label)}: ${f.n}">
        <span class="lbl">${esc(f.label)}</span>
        <span class="bar"><i style="width:${((f.n / funnelMax) * 100).toFixed(1)}%"></i></span>
        <span class="n">${f.n}</span></div>`,
        )
        .join('')}
      <div class="note">Counts from the event log — activity, not assumptions.</div>
    </div>

    <div class="card span8">
      <h2>Drafts awaiting approval <a class="navlink small" href="/drafts">open the review queue →</a></h2>
      ${
        g.drafts.length
          ? `<table><tr><th>To</th><th>Subject</th><th>Sequence</th><th></th></tr>${g.drafts
              .map(
                (d) => `<tr><td class="k">${esc(d.email)}${d.company ? ` <span class="chip">${esc(d.company)}</span>` : ''}</td>
              <td><a class="rowlink" href="/draft?id=${esc(d.id)}">${esc(d.subject)}</a></td><td>${esc(d.sequence_id)} · s${d.step + 1}</td>
              <td><a class="rowlink" href="/draft?id=${esc(d.id)}">${d.status === 'lint_failed' ? '<span class="chip flag">fix</span>' : 'review →'}</a></td></tr>`,
              )
              .join('')}</table>`
          : '<div class="empty">nothing waiting — inbox zero</div>'
      }
    </div>

    <div class="card span12">
      <h2>Next 7 days — scheduled touches</h2>
      ${
        g.touches.length
          ? `<table><tr><th>When</th><th>Who</th><th>Company</th><th>Sequence</th><th>Band</th></tr>${g.touches
              .map(
                (t) => `<tr><td class="k">${fmtWhen(t.next_touch_at)}</td><td>${esc(name(t))}</td>
              <td>${esc(t.company ?? '')}</td><td>${esc(t.sequence_id ?? '—')}${t.sequence_step != null ? ` · s${t.sequence_step + 1}` : ''}</td>
              <td><span class="chip">${esc(t.temperature)} ${t.score}</span></td></tr>`,
              )
              .join('')}</table>`
          : '<div class="empty">no touches due — sequences idle or awaiting approval</div>'
      }
    </div>
  </div>

  <footer>vedrí · ${esc(config.sender.postalAddress)} · generated by the funnel engine — band probabilities: Hot ${BAND_CLOSE_PROBABILITY.Hot}, Warm ${BAND_CLOSE_PROBABILITY.Warm} (assumptions until actuals)</footer>
</div>
</body></html>`;
}

/** Write dashboard.html into the output directory. Returns the path. */
export function generateDashboard(asOf: Date = new Date()): string {
  const html = renderDashboard(asOf);
  mkdirSync('output', { recursive: true });
  const path = join('output', 'dashboard.html');
  writeFileSync(path, html);
  dlog.info('dashboard generated', { path, bytes: html.length });
  return path;
}
