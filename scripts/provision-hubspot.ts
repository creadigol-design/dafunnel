/**
 * `pnpm run provision-hubspot` — idempotently create the vedrí schema.
 *
 * Creates (or skips, if present) the vedri_ property group, all custom contact +
 * deal properties, and the shared pipeline stages. Safe to run repeatedly.
 *
 *   --plan        print what would change, make no writes (implied by DRY_RUN)
 *   --smoketest   after provisioning, create 5 dummy contacts exercising the
 *                 vedri_ fields, read them back, then DELETE them. This is the
 *                 "test against 5 dummy contacts before real data" gate.
 *
 * Requires HUBSPOT_PRIVATE_APP_TOKEN. If it's missing the script explains how to
 * create the Private App and exits cleanly.
 */
import { config } from '../config/index.js';
import { log } from '../src/logger.js';
import { HubSpotClient } from '../src/hubspot/client.js';
import {
  CONTACT_GROUP,
  DEAL_GROUP,
  CONTACT_PROPERTIES,
  DEAL_PROPERTIES,
  PIPELINE_LABEL,
  PIPELINE_STAGES,
  type PropertyDef,
} from '../src/hubspot/schema-def.js';

const clog = log.child('provision');
const argv = new Set(process.argv.slice(2));
const plan = argv.has('--plan') || config.dryRun;
const smoketest = argv.has('--smoketest');

function propertyPayload(def: PropertyDef, groupName: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: def.name,
    label: def.label,
    description: def.description,
    groupName,
    type: def.spec.type,
    fieldType: def.spec.fieldType,
  };
  if (def.spec.type === 'enumeration') {
    base.options = def.spec.options.map((label, i) => ({ label, value: label, displayOrder: i }));
  }
  if (def.spec.type === 'bool') {
    // HubSpot requires exactly two options for boolean properties.
    base.options = [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ];
  }
  return base;
}

async function ensureGroup(
  client: HubSpotClient,
  objectType: string,
  group: { name: string; label: string },
): Promise<void> {
  const existing = await client.getPropertyGroups(objectType);
  if (existing.some((g) => g.name === group.name)) {
    clog.info('group exists', { objectType, group: group.name });
    return;
  }
  if (plan) {
    clog.info('[plan] would create group', { objectType, group: group.name });
    return;
  }
  await client.createPropertyGroup(objectType, group.name, group.label);
  clog.info('created group', { objectType, group: group.name });
}

async function ensureProperties(
  client: HubSpotClient,
  objectType: string,
  groupName: string,
  defs: PropertyDef[],
): Promise<{ created: number; skipped: number }> {
  const existing = new Set((await client.listProperties(objectType)).map((p) => p.name));
  let created = 0;
  let skipped = 0;
  for (const def of defs) {
    if (existing.has(def.name)) {
      skipped++;
      continue;
    }
    if (plan) {
      clog.info('[plan] would create property', { objectType, name: def.name });
      created++;
      continue;
    }
    await client.createProperty(objectType, propertyPayload(def, groupName));
    clog.info('created property', { objectType, name: def.name });
    created++;
  }
  return { created, skipped };
}

async function ensurePipeline(client: HubSpotClient): Promise<void> {
  const pipelines = await client.getPipelines('deals');
  if (pipelines.length === 0) {
    clog.error('no deal pipeline found — cannot provision stages');
    return;
  }
  if (pipelines.length > 1) {
    clog.warn('multiple pipelines present; provisioning stages on the first only', {
      count: pipelines.length,
    });
  }
  const pipeline = pipelines[0]!;
  const existingLabels = new Set(pipeline.stages.map((s) => s.label));

  if (pipeline.label !== PIPELINE_LABEL) {
    if (plan) clog.info('[plan] would rename pipeline', { from: pipeline.label, to: PIPELINE_LABEL });
    else {
      await client.updatePipelineLabel('deals', pipeline.id, PIPELINE_LABEL);
      clog.info('renamed pipeline', { to: PIPELINE_LABEL });
    }
  }

  for (const [i, stage] of PIPELINE_STAGES.entries()) {
    if (existingLabels.has(stage.label)) {
      clog.info('stage exists', { label: stage.label });
      continue;
    }
    const metadata: Record<string, string> = {
      isClosed: stage.closed ? 'true' : 'false',
      probability: String(stage.probability),
    };
    if (plan) {
      clog.info('[plan] would create stage', { label: stage.label });
      continue;
    }
    await client.createPipelineStage('deals', pipeline.id, {
      label: stage.label,
      displayOrder: i,
      metadata,
    });
    clog.info('created stage', { label: stage.label });
  }
}

async function runSmoketest(client: HubSpotClient): Promise<void> {
  clog.info('smoketest: creating 5 dummy contacts');
  const created: string[] = [];
  try {
    for (let i = 1; i <= 5; i++) {
      const c = await client.createContact({
        email: `vedri-smoketest-${i}@example.com`,
        firstname: `Dummy${i}`,
        lastname: 'Test',
        company: `Test Co ${i}`,
        vedri_track: i % 2 === 0 ? 'VFX' : 'Studio',
        vedri_temperature: 'Cold',
        vedri_score: String(i * 5),
        vedri_source: 'Built List',
        vedri_icp_fit: 'Medium',
        vedri_suppressed: 'false',
      });
      created.push(c.id);
    }
    clog.info('smoketest: created', { ids: created });

    // Read one back to confirm the vedri_ fields round-trip.
    const check = await client.searchContactByEmail('vedri-smoketest-1@example.com', [
      'email',
      'vedri_track',
      'vedri_score',
      'vedri_temperature',
    ]);
    clog.info('smoketest: read-back', { properties: check?.properties });
  } finally {
    for (const id of created) {
      await client.deleteContact(id);
    }
    clog.info('smoketest: deleted all dummy contacts', { count: created.length });
  }
}

async function main(): Promise<void> {
  const client = new HubSpotClient();
  if (!client.configured) {
    console.log(
      [
        '',
        'HUBSPOT_PRIVATE_APP_TOKEN is not set — cannot provision.',
        '',
        'Create the Private App (one-time, ~2 minutes):',
        '  1. HubSpot → Settings → Integrations → Private Apps → Create a private app',
        '  2. Name it "vedrí Funnel Engine".',
        '  3. Scopes: crm.objects.contacts.read/write, crm.objects.deals.read/write,',
        '     crm.objects.companies.read/write, crm.schemas.contacts.read/write,',
        '     crm.schemas.deals.read/write, crm.pipelines.deals.read/write (as available',
        '     on the free tier), plus tickets/notes read/write.',
        '  4. Create it, copy the access token, and put it in .env as',
        '     HUBSPOT_PRIVATE_APP_TOKEN=...',
        '  5. Re-run: pnpm run provision-hubspot --smoketest',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  clog.info('provisioning HubSpot schema', { plan, portalId: config.hubspot.portalId });

  await ensureGroup(client, 'contacts', CONTACT_GROUP);
  await ensureGroup(client, 'deals', DEAL_GROUP);
  const c = await ensureProperties(client, 'contacts', CONTACT_GROUP.name, CONTACT_PROPERTIES);
  const d = await ensureProperties(client, 'deals', DEAL_GROUP.name, DEAL_PROPERTIES);
  await ensurePipeline(client);

  clog.info('provisioning complete', {
    contactProps: c,
    dealProps: d,
    plan,
  });

  if (smoketest && !plan) {
    await runSmoketest(client);
  } else if (smoketest && plan) {
    clog.warn('smoketest skipped in plan/DRY_RUN mode (it would create real contacts)');
  }
}

main().catch((err) => {
  clog.error('provisioning failed', { error: err instanceof Error ? err.message : String(err) });
  // Surface HubSpot's missing-scope list so the fix is obvious.
  const body = (err as { body?: unknown }).body as
    | { category?: string; errors?: { context?: { requiredGranularScopes?: string[] } }[] }
    | undefined;
  if (body?.category === 'MISSING_SCOPES') {
    console.error(
      '\nThe Private App is missing scopes. Edit it in HubSpot → Private Apps → Scopes,',
      '\nadd the CRM schema + object write scopes below, save, and re-run (the token is unchanged):',
      '\n  crm.schemas.contacts.write, crm.schemas.deals.write,',
      '\n  crm.objects.contacts.read/write, crm.objects.deals.read/write,',
      '\n  crm.objects.companies.read/write\n',
    );
  }
  process.exit(1);
});
