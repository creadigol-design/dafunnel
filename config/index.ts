/**
 * Typed, validated configuration for the vedrí funnel.
 *
 * Loads .env, applies safe defaults, and exposes a single frozen `config`
 * object. The two safety flags (DRY_RUN, AUTO_SEND_FOLLOWUPS) are read here and
 * nowhere else — every module that could send or write consults them via this
 * object, so there is one place to reason about "can this touch the world?".
 *
 * Optional secrets (HubSpot, Google, Anthropic, Slack) are NOT required to load
 * config. Phase 1 touches no live system; later phases assert the specific
 * credentials they need at the point of use (see `requireSecret`).
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function str(name: string, fallback = ''): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface Config {
  /** Shadow mode: compute everything, write drafts to files, no sends, no HubSpot writes. */
  dryRun: boolean;
  /** When false, outbound emails are Gmail drafts a human sends. Ships false. */
  autoSendFollowups: boolean;

  timezone: string;
  currency: string;

  mailboxes: {
    /** Warm/inbound/hot inbox — replies and warm leads. */
    warm: string;
    /** Cold sending domain — cold sequences only; blank until domain is live. */
    cold: string;
  };

  hubspot: { token: string; portalId: string };
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    calendarId: string;
  };
  anthropic: { apiKey: string; model: string };

  /** Sender identity + postal address + unsubscribe — required in every email (UK PECR). */
  sender: { name: string; postalAddress: string; unsubscribeMailto: string };
  slack: { botToken: string; alertChannel: string; urgentDmUser: string };

  /** HubSpot free-tier ceilings; alert when within 20%. */
  freeTier: { maxContacts: number; alertThreshold: number };

  /** Channel policy. */
  channels: {
    /**
     * LinkedIn is Daniel's personal/professional relationship channel — the
     * system does NOT ingest connections, draft messages, or schedule touches
     * on it. `log-touch` stays available if he chooses to pull a specific
     * conversation into the email funnel by hand.
     */
    linkedinManual: boolean;
  };

  /** Universal send windows (UK time). Enforced by the sequence engine. */
  sending: {
    days: readonly number[]; // 0=Sun … 6=Sat; Tue–Thu = [2,3,4]
    windows: readonly { start: string; end: string }[];
    minGapHours: number; // never two touches within this many hours
    maxWordsPerMessage: number;
    maxColdPerDay: number;
  };

  paths: { db: string; drafts: string; logs: string };

  /** Drop-folders scanned by the ingestion adapters each cycle. */
  ingest: { prospects: string; reactivation: string; social: string };
}

export const config: Config = Object.freeze({
  dryRun: bool('DRY_RUN', true),
  autoSendFollowups: bool('AUTO_SEND_FOLLOWUPS', false),

  timezone: str('TIMEZONE', 'Europe/London'),
  currency: str('CURRENCY', 'GBP'),

  mailboxes: {
    warm: str('MAILBOX_WARM', 'info@vedri.studio'),
    cold: str('MAILBOX_COLD'),
  },

  hubspot: {
    token: str('HUBSPOT_PRIVATE_APP_TOKEN'),
    portalId: str('HUBSPOT_PORTAL_ID', '149092923'),
  },
  google: {
    clientId: str('GOOGLE_CLIENT_ID'),
    clientSecret: str('GOOGLE_CLIENT_SECRET'),
    refreshToken: str('GOOGLE_REFRESH_TOKEN'),
    calendarId: str('GOOGLE_CALENDAR_ID'),
  },
  anthropic: {
    apiKey: str('ANTHROPIC_API_KEY'),
    model: str('CLAUDE_MODEL', 'claude-sonnet-5'),
  },
  sender: {
    name: str('SENDER_NAME', 'Daniel Evans, vedrí'),
    // {{NEEDS_INPUT}} until Daniel supplies the studio's registered postal address.
    postalAddress: str('SENDER_POSTAL_ADDRESS', '{{NEEDS_INPUT: studio postal address}}'),
    unsubscribeMailto: str('UNSUBSCRIBE_MAILTO', 'info@vedri.studio'),
  },
  slack: {
    botToken: str('SLACK_BOT_TOKEN'),
    alertChannel: str('SLACK_ALERT_CHANNEL', '#vedri-funnel'),
    urgentDmUser: str('SLACK_URGENT_DM_USER'),
  },

  freeTier: { maxContacts: 1000, alertThreshold: 0.8 },

  channels: { linkedinManual: bool('LINKEDIN_MANUAL', true) },

  sending: {
    days: [2, 3, 4], // Tue, Wed, Thu
    windows: [
      { start: '08:00', end: '10:30' },
      { start: '14:00', end: '16:00' },
    ],
    minGapHours: 48,
    maxWordsPerMessage: 150,
    maxColdPerDay: 34,
  },

  paths: {
    db: str('DB_PATH', 'data/vedri-funnel.db'),
    drafts: str('DRAFTS_DIR', 'output/drafts'),
    logs: str('LOG_DIR', 'output/logs'),
  },

  ingest: {
    prospects: str('INGEST_PROSPECTS_DIR', 'data/prospects'),
    reactivation: str('INGEST_REACTIVATION_DIR', 'data/reactivation'),
    social: str('INGEST_SOCIAL_DIR', 'data/social'),
  },
});

/**
 * Assert a required secret is present at the point of use. Later phases call
 * this so a missing credential fails loudly with a clear message instead of a
 * downstream 401.
 */
export function requireSecret(value: string, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required secret ${name}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}
