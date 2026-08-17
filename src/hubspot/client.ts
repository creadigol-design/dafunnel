/**
 * Minimal HubSpot REST API v3 client.
 *
 * The deployed cron system authenticates with a Private App token (the claude.ai
 * HubSpot connector is not present in headless runs), so all live HubSpot access
 * goes through this fetch-based client — never through an MCP tool.
 *
 * Only the surface the funnel needs is implemented: property + pipeline
 * provisioning, and contact read/search/write. Retries once on 429/5xx with a
 * short backoff (HubSpot free tier: ~100 req / 10s).
 */
import { config, requireSecret } from '../../config/index.js';
import { log } from '../logger.js';

const clog = log.child('hubspot');
const BASE = 'https://api.hubapi.com';

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  updatedAt?: string;
}

export class HubSpotClient {
  constructor(private readonly token = config.hubspot.token) {}

  /** True when a token is configured; callers skip live sync when false. */
  get configured(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = requireSecret(this.token, 'HUBSPOT_PRIVATE_APP_TOKEN');
    const url = `${BASE}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        const wait = 500 * 2 ** attempt;
        clog.warn('HubSpot throttled/erroring, backing off', { status: res.status, wait, path });
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new HubSpotError(`${method} ${path} → ${res.status}`, res.status, json);
      }
      return json as T;
    }
    throw new HubSpotError(`${method} ${path} exhausted retries`, 429, null);
  }

  // ── Properties ────────────────────────────────────────────────────────────
  async getPropertyGroups(objectType: string): Promise<{ name: string }[]> {
    const r = await this.request<{ results: { name: string }[] }>('GET', `/crm/v3/properties/${objectType}/groups`);
    return r.results;
  }

  async createPropertyGroup(objectType: string, name: string, label: string): Promise<void> {
    await this.request('POST', `/crm/v3/properties/${objectType}/groups`, { name, label });
  }

  async listProperties(objectType: string): Promise<{ name: string }[]> {
    const r = await this.request<{ results: { name: string }[] }>('GET', `/crm/v3/properties/${objectType}`);
    return r.results;
  }

  async createProperty(objectType: string, payload: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/crm/v3/properties/${objectType}`, payload);
  }

  // ── Pipelines ─────────────────────────────────────────────────────────────
  async getPipelines(objectType: string): Promise<
    { id: string; label: string; stages: { id: string; label: string; displayOrder: number }[] }[]
  > {
    const r = await this.request<{
      results: { id: string; label: string; stages: { id: string; label: string; displayOrder: number }[] }[];
    }>('GET', `/crm/v3/pipelines/${objectType}`);
    return r.results;
  }

  async updatePipelineLabel(objectType: string, pipelineId: string, label: string): Promise<void> {
    await this.request('PATCH', `/crm/v3/pipelines/${objectType}/${pipelineId}`, { label });
  }

  async createPipelineStage(
    objectType: string,
    pipelineId: string,
    stage: { label: string; displayOrder: number; metadata: Record<string, string> },
  ): Promise<void> {
    await this.request('POST', `/crm/v3/pipelines/${objectType}/${pipelineId}/stages`, stage);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  /** List all contacts (paginated). Used to hydrate the local mirror from HubSpot. */
  async listAllContacts(properties: string[]): Promise<HubSpotContact[]> {
    const out: HubSpotContact[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{
        results: HubSpotContact[];
        paging?: { next?: { after?: string } };
      }>('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [],
        properties,
        limit: 200,
        ...(after ? { after } : {}),
      });
      out.push(...r.results);
      after = r.paging?.next?.after;
      if (!after) break;
    }
    return out;
  }

  async searchContactByEmail(email: string, properties: string[]): Promise<HubSpotContact | null> {
    const r = await this.request<{ results: HubSpotContact[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties,
      limit: 1,
    });
    return r.results[0] ?? null;
  }

  async createContact(properties: Record<string, string>): Promise<HubSpotContact> {
    return this.request<HubSpotContact>('POST', '/crm/v3/objects/contacts', { properties });
  }

  async updateContact(id: string, properties: Record<string, string>): Promise<HubSpotContact> {
    return this.request<HubSpotContact>('PATCH', `/crm/v3/objects/contacts/${id}`, { properties });
  }

  async deleteContact(id: string): Promise<void> {
    await this.request('DELETE', `/crm/v3/objects/contacts/${id}`);
  }

  /** Total contact count — for the free-tier ceiling check in the doctor. */
  async contactCount(): Promise<number> {
    const r = await this.request<{ total: number }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [],
      limit: 1,
    });
    return r.total;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
