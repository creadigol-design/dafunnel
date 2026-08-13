/**
 * `pnpm run doctor` — health check.
 *
 * Verifies the things that silently break a funnel: credentials present, DB
 * reachable, last cycle recent, suppression list loaded, contact count vs the
 * free-tier ceiling, and drafts awaiting approval. Run inside the daily digest
 * (Phase 7) and alert on any failure.
 *
 * Phase 1 implements the checks that need no live API (DB + config presence).
 * Live checks (domain SPF/DKIM/DMARC, HubSpot count, auth validity) are marked
 * `todo` and light up as their phases land.
 */
import { config } from '../config/index.js';
import { db, closeDb } from '../src/db/index.js';
import { HubSpotClient } from '../src/hubspot/client.js';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'todo';
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

function checkSecretPresent(name: string, value: string, phase: string): Check {
  return value
    ? { name, status: 'ok', detail: 'present' }
    : { name, status: 'todo', detail: `not set yet (needed by ${phase})` };
}

async function run(): Promise<Check[]> {
  const checks: Check[] = [];

  // Safety flags — surface them loudly so their state is never a surprise.
  checks.push({
    name: 'safety: AUTO_SEND_FOLLOWUPS',
    status: config.autoSendFollowups ? 'warn' : 'ok',
    detail: config.autoSendFollowups ? 'ON — emails auto-send!' : 'off (draft-and-approve)',
  });
  checks.push({
    name: 'safety: DRY_RUN',
    status: 'ok',
    detail: config.dryRun ? 'on (shadow mode)' : 'off (live)',
  });

  // Database + last cycle.
  try {
    const conn = db();
    const last = conn
      .prepare("SELECT started_at, status FROM cycle_runs ORDER BY started_at DESC LIMIT 1")
      .get() as { started_at: string; status: string } | undefined;
    checks.push({ name: 'database', status: 'ok', detail: `open at ${config.paths.db}` });
    checks.push(
      last
        ? { name: 'last cycle', status: 'ok', detail: `${last.status} at ${last.started_at}` }
        : { name: 'last cycle', status: 'warn', detail: 'no cycle has run yet' },
    );

    const suppression = conn.prepare('SELECT COUNT(*) AS n FROM suppression').get() as { n: number };
    checks.push({
      name: 'suppression list',
      status: 'ok',
      detail: `${suppression.n} entries loaded`,
    });

    const pending = conn
      .prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'")
      .get() as { n: number };
    checks.push({
      name: 'drafts awaiting approval',
      status: 'ok',
      detail: `${pending.n} pending`,
    });

    const leads = conn.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number };
    const ceiling = config.freeTier.maxContacts * config.freeTier.alertThreshold;
    checks.push({
      name: 'HubSpot free-tier headroom',
      status: leads.n >= ceiling ? 'warn' : 'ok',
      detail: `${leads.n} local leads / ${config.freeTier.maxContacts} ceiling (live count: Phase 2)`,
    });
  } catch (err) {
    checks.push({
      name: 'database',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Live HubSpot contact count vs free-tier ceiling (only when a token exists).
  if (config.hubspot.token) {
    try {
      const total = await new HubSpotClient().contactCount();
      const ceiling = config.freeTier.maxContacts * config.freeTier.alertThreshold;
      checks.push({
        name: 'HubSpot live contact count',
        status: total >= ceiling ? 'warn' : 'ok',
        detail: `${total} / ${config.freeTier.maxContacts} (warn at ${ceiling})`,
      });
    } catch (err) {
      checks.push({
        name: 'HubSpot live contact count',
        status: 'fail',
        detail: `token set but query failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Credential presence (not validity — that needs the live phases).
  checks.push(checkSecretPresent('HubSpot token', config.hubspot.token, 'Phase 2'));
  checks.push(checkSecretPresent('Google refresh token', config.google.refreshToken, 'Phase 5/6'));
  checks.push(checkSecretPresent('Anthropic API key', config.anthropic.apiKey, 'Phase 5'));
  checks.push(checkSecretPresent('Slack bot token', config.slack.botToken, 'Phase 7'));
  checks.push({
    name: 'cold sending domain',
    status: config.mailboxes.cold ? 'ok' : 'todo',
    detail: config.mailboxes.cold || 'not configured (buy + warm before cold go-live)',
  });
  checks.push({ name: 'domain SPF/DKIM/DMARC', status: 'todo', detail: 'checked in Phase 10' });

  return checks;
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', todo: '·' };
const checks = await run();
closeDb();

console.log('\nvedrí funnel — doctor\n');
for (const c of checks) {
  console.log(`  ${ICON[c.status]}  ${c.name.padEnd(34)} ${c.detail}`);
}
const failed = checks.filter((c) => c.status === 'fail').length;
const warned = checks.filter((c) => c.status === 'warn').length;
console.log(`\n${failed} failed, ${warned} warnings, ${checks.length} checks total.\n`);
process.exit(failed > 0 ? 1 : 0);
