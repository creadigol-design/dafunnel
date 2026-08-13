/**
 * Ingestion orchestrator — runs every adapter, one normalised pipeline.
 *
 * CSV drop-folders are scanned each cycle (prospects → built-list, reactivation
 * → vedri-crm, social → built-list). Live adapters (inbound Gmail, Mailchimp)
 * run when their auth is present and skip cleanly otherwise. All reports are
 * aggregated so nothing is silently dropped.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/index.js';
import { log } from '../logger.js';
import { importCsv } from './csv-import.js';
import { pollInbound } from './inbound.js';
import { pullMailchimp } from './mailchimp.js';
import type { ImportReport } from './model.js';

const ilog = log.child('ingest');

function csvFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => join(dir, f));
}

export interface IngestSummary {
  reports: ImportReport[];
  imported: number;
  rejected: number;
  needsConsent: number;
}

export async function runIngest(): Promise<IngestSummary> {
  const reports: ImportReport[] = [];

  const folders: { dir: string; profile: string }[] = [
    { dir: config.ingest.prospects, profile: 'built-list' },
    { dir: config.ingest.reactivation, profile: 'vedri-crm' },
  ];
  // LinkedIn is Daniel's personal channel — not auto-ingested. The `linkedin`
  // profile stays available for a deliberate one-off `import-csv` if he ever
  // wants it, but the cycle never scans data/social/ while linkedinManual holds.
  if (!config.channels.linkedinManual) {
    folders.push({ dir: config.ingest.social, profile: 'linkedin' });
  }
  for (const { dir, profile } of folders) {
    for (const file of csvFiles(dir)) {
      try {
        const r = importCsv(file, profile);
        reports.push(r);
        ilog.info('csv ingested', { file, imported: r.imported, rejected: r.rejected.length });
      } catch (err) {
        ilog.error('csv ingest failed', { file, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const inbound = await pollInbound();
  if (inbound) reports.push(inbound);
  const mailchimp = await pullMailchimp();
  if (mailchimp) reports.push(mailchimp);

  const summary: IngestSummary = {
    reports,
    imported: reports.reduce((n, r) => n + r.imported, 0),
    rejected: reports.reduce((n, r) => n + r.rejected.length, 0),
    needsConsent: reports.reduce((n, r) => n + r.needsConsent.length, 0),
  };
  ilog.info('ingest complete', { imported: summary.imported, rejected: summary.rejected });
  return summary;
}
