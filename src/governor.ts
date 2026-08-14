/**
 * The governor — is the funnel on pace for the target, and what should change?
 *
 * Runs on the 1st and 15th (or when forced). v1 is honest about its data: until
 * ≥30 data points exist per stage, it projects from the DEFAULT rates and says
 * so in every recommendation. It NEVER silently changes volume — it computes a
 * recommendation, explains the reasoning, and queues an alert for Daniel; the
 * actual volume knobs (SEQUENCES_ACTIVE, SEQUENCES_PER_CYCLE) stay under human
 * control.
 *
 * Capacity refinement (per Daniel): ~25 delivery-days/month, 1 big or 2 small
 * jobs. Deal-level delivery-day tracking arrives with deals; v1 projects closes
 * and flags the capacity ceiling in the recommendation text.
 */
import { db } from './db/index.js';
import { queueAlert } from './alerts/queue.js';
import { recordEvent } from './db/events.js';
import { getSyncState, setSyncState } from './db/index.js';
import { log } from './logger.js';
import { TARGET, BLENDED_PLAN } from '../config/funnel-model.js';

const glog = log.child('governor');

/**
 * Probability a lead in each band closes this month. Assumptions until actuals
 * exist — derived from the funnel-model defaults, marked as such in output.
 */
export const BAND_CLOSE_PROBABILITY: Record<string, number> = {
  Hot: 0.35,
  Warm: 0.1,
  Cold: 0.01,
  Nurture: 0.005,
};

export interface BandCounts {
  Hot: number;
  Warm: number;
  Cold: number;
  Nurture: number;
  closedWonThisMonth: number;
}

export interface Projection {
  projected: number;
  closedSoFar: number;
  pipelineExpectation: number;
  usingDefaults: boolean;
  dataPoints: number;
}

/** Pure projection from band counts. Exported for tests. */
export function projectCloses(counts: BandCounts, dataPoints: number): Projection {
  const pipelineExpectation =
    counts.Hot * BAND_CLOSE_PROBABILITY.Hot! +
    counts.Warm * BAND_CLOSE_PROBABILITY.Warm! +
    counts.Cold * BAND_CLOSE_PROBABILITY.Cold! +
    counts.Nurture * BAND_CLOSE_PROBABILITY.Nurture!;
  return {
    projected: counts.closedWonThisMonth + pipelineExpectation,
    closedSoFar: counts.closedWonThisMonth,
    pipelineExpectation,
    usingDefaults: dataPoints < TARGET.minDataPointsForActuals,
    dataPoints,
  };
}

export interface Recommendation {
  status: 'behind' | 'on-pace' | 'over-capacity';
  message: string;
  extraColdContacts: number;
}

/** Pure recommendation from a projection. Exported for tests. */
export function recommend(p: Projection): Recommendation {
  const basis = p.usingDefaults
    ? `Using DEFAULT conversion assumptions (${p.dataPoints}/${TARGET.minDataPointsForActuals} data points — actuals take over at ${TARGET.minDataPointsForActuals}).`
    : `Using observed conversion rates (${p.dataPoints} data points).`;

  if (p.projected < TARGET.projectedFloor) {
    const gap = TARGET.projectedFloor - p.projected;
    // Cold closes ≈ 0.26% net → contacts needed per extra close ≈ 385; scale from the plan.
    const perClose = BLENDED_PLAN.cold.volumeIn / BLENDED_PLAN.cold.expectedCloses;
    const extra = Math.ceil(gap * perClose);
    return {
      status: 'behind',
      extraColdContacts: extra,
      message:
        `Projected ${p.projected.toFixed(1)} closes this month vs target ${TARGET.closesPerMonth}. ` +
        `${basis} Gap ≈ ${gap.toFixed(1)} closes. To close it with cold volume alone: ~${extra} extra cold contacts this month — ` +
        `or (usually better) convert what's already warm: check the drafts queue and any Hot leads waiting on you. Nothing has been changed automatically.`,
    };
  }
  if (p.projected > TARGET.projectedCeiling) {
    return {
      status: 'over-capacity',
      extraColdContacts: 0,
      message:
        `Projected ${p.projected.toFixed(1)} closes vs capacity ~${TARGET.closesPerMonth} (≈${TARGET.capacityDeliveryDays} delivery-days). ` +
        `${basis} Prospecting should throttle, and this is the moment to consider raising prices rather than adding volume. Nothing has been changed automatically.`,
    };
  }
  return {
    status: 'on-pace',
    extraColdContacts: 0,
    message: `Projected ${p.projected.toFixed(1)} closes vs target ${TARGET.closesPerMonth} — on pace. ${basis}`,
  };
}

function currentBandCounts(): BandCounts {
  const rows = db().prepare('SELECT temperature, COUNT(*) c FROM leads GROUP BY temperature').all() as {
    temperature: string;
    c: number;
  }[];
  const get = (t: string) => rows.find((r) => r.temperature === t)?.c ?? 0;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const won = db()
    .prepare("SELECT COUNT(*) c FROM events WHERE type='band.changed' AND json_extract(data,'$.newBand')='Closed Won' AND created_at >= ?")
    .get(monthStart.toISOString()) as { c: number };
  return { Hot: get('Hot'), Warm: get('Warm'), Cold: get('Cold'), Nurture: get('Nurture'), closedWonThisMonth: won.c };
}

function stageDataPoints(): number {
  // Only genuine funnel evidence counts: classified replies and engagement
  // signals from real interactions. Seed and warm-start bookkeeping does not —
  // otherwise the governor would claim "observed rates" off imported history.
  const row = db()
    .prepare(
      `SELECT COUNT(*) c FROM events
       WHERE type = 'reply.classified'
          OR (type = 'score.signal' AND trigger NOT IN ('seed', 'reactivation-warm-start'))`,
    )
    .get() as { c: number };
  return row.c;
}

/** Should the governor run now? 1st and 15th, once per day; or forced. */
export function governorDue(asOf: Date, lastRunIso: string | null, force = false): boolean {
  if (force) return true;
  const day = asOf.getUTCDate();
  if (day !== 1 && day !== 15) return false;
  return !lastRunIso || lastRunIso.slice(0, 10) !== asOf.toISOString().slice(0, 10);
}

export interface GovernorSummary {
  ran: boolean;
  recommendation?: Recommendation;
  projection?: Projection;
}

export function runGovernor(asOf: Date = new Date(), force = false): GovernorSummary {
  const lastRun = getSyncState('governor.last_run_at');
  if (!governorDue(asOf, lastRun, force)) return { ran: false };

  const projection = projectCloses(currentBandCounts(), stageDataPoints());
  const rec = recommend(projection);

  recordEvent({
    type: 'governor.run',
    trigger: force ? 'forced' : 'schedule',
    reason: rec.message,
    data: { status: rec.status, projected: projection.projected, extraColdContacts: rec.extraColdContacts },
  });
  queueAlert('governor_recommendation', {
    payload: { status: rec.status, message: rec.message, projected: projection.projected },
  });
  setSyncState('governor.last_run_at', asOf.toISOString());
  glog.info('governor ran', { status: rec.status, projected: projection.projected });

  return { ran: true, recommendation: rec, projection };
}
