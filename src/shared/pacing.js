// Usage pacing (SPEC §2.4): a usage reading + settings -> advice ("use it", "slow down", "near limit", "on track").
// Pure (no chrome APIs), so it can be tested in Node.
// "Projected" = share of the allowance used / share of the period gone, i.e. how much of the allowance
// will be used by the reset at the current rate (100 = all of it, exactly at the reset).
import { unusedAllowanceLost } from './settings.js';

const HOUR = 36e5;
const PERIOD_MS = { session: 5 * HOUR, week: 7 * 24 * HOUR };
const PERIOD_NAME = { session: 'the session', week: 'the week', month: 'the month' };
const MIN_ELAPSED = 0.1;  // earlier than this in a period the pace is mostly noise
const USE_IT_FROM = 0.5;  // "use it" only in the second half of a period, when there's little time left to catch up
const SEVERITY = { limit: 4, slow: 3, use: 2, ok: 1 };

const SLOW_TIPS = [
  'Use a smaller model and low effort for simple questions (Evaluate tells you which).',
  'Start a new chat for a new topic: long threads are re-read with every message.',
  'Leave web search and research off unless you need current facts.',
];
const USE_TIPS = [
  'Use a bigger model or higher effort for work where quality matters.',
  'Clear the backlog: reviews, documentation, test cases, a topic you meant to learn.',
  'Do the bigger jobs before the reset rather than after it.',
];

function periodStart(meter) {
  const end = new Date(meter.resetsAt);
  if (meter.period === 'month') {
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    return start.getTime();
  }
  return end.getTime() - PERIOD_MS[meter.period];
}

// One meter, as of the time it was read.
export function meterPace(meter, readAt) {
  const start = periodStart(meter);
  const end = new Date(meter.resetsAt).getTime();
  const elapsed = Math.min(1, Math.max(0, (readAt - start) / (end - start)));
  const projectedPct = elapsed >= MIN_ELAPSED ? meter.usedPct / elapsed : null;
  // When the limit is reached at the current rate (only if that's before the reset).
  const limitAt = projectedPct > 100 ? start + ((readAt - start) * 100) / meter.usedPct : null;
  return { ...meter, start, end, elapsed, projectedPct, limitAt };
}

function meterStatus(p, alerts, useItAllowed) {
  if (p.usedPct >= alerts.nearLimitPct) return 'limit';
  if (p.projectedPct == null) return 'ok';
  if (p.projectedPct > alerts.slowDownPace) return 'slow';
  // Sessions are short and come back soon: "use it" nudges are for weekly/monthly allowances only.
  if (useItAllowed && p.period !== 'session' && p.elapsed >= USE_IT_FROM && p.projectedPct < alerts.useItPace) return 'use';
  return 'ok';
}

export function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
const day = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const pct = (x) => `${Math.round(x)}%`;

/**
 * reading: { meters: [{ id, label, usedPct, used?, limit?, currency?, resetsAt, period }], readAt, source } or null.
 * Returns { status, title, text, tips, badge, readAt, source, forPrompt }.
 * status: 'limit' | 'slow' | 'use' | 'ok' | 'unknown'.
 */
export function adviseUsage(reading, settings, now = Date.now()) {
  const unknown = (title, text) => ({ status: 'unknown', title, text, tips: [], badge: '', readAt: reading?.readAt ?? null, source: reading?.source ?? null, forPrompt: null });
  if (!reading?.meters?.length) {
    return unknown('Usage not read yet', 'Open Settings → Usage on claude.ai once so TokenMileage can read your limits.');
  }
  const readAt = new Date(reading.readAt).getTime();
  const live = reading.meters.filter((m) => new Date(m.resetsAt).getTime() > now);
  if (!live.length) {
    return unknown('Usage reading is out of date', `Your allowance has reset since TokenMileage last read it (${day(readAt)}). Open Settings → Usage to update it.`);
  }

  const useItAllowed = unusedAllowanceLost(settings);
  const meters = live
    .map((m) => meterPace(m, readAt))
    .map((p) => ({ ...p, status: meterStatus(p, settings.alerts, useItAllowed) }))
    .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || (b.projectedPct ?? 0) - (a.projectedPct ?? 0));
  const m = meters[0];

  // "$76 of $500 used (15%)" for spend limits, "Weekly: 40% used" for percentage limits.
  const money = (share) => `${m.currency}${Math.round((m.limit * share) / 100).toLocaleString()}`;
  const used = m.limit ? `${money(m.usedPct)} of ${money(100)} used (${pct(m.usedPct)})` : `${m.label}: ${pct(m.usedPct)} used`;
  const gone = `${pct(m.elapsed * 100)} of ${PERIOD_NAME[m.period]} gone`;
  const resets = `resets ${m.period === 'session' ? '' : `${day(m.end)}, `}in ${duration(m.end - now)}`;

  let title;
  let text;
  let tips;
  if (m.status === 'limit') {
    title = `Near your ${m.label.toLowerCase()} limit`;
    text = `${used}; ${resets}. Save what's left for the work that matters.`;
    tips = SLOW_TIPS;
  } else if (m.status === 'slow') {
    title = 'Slow down';
    const at = m.period === 'session'
      ? new Date(m.limitAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : day(m.limitAt);
    text = `${used} with ${gone}. At this pace you'll reach the limit around ${at}, ${duration(m.end - m.limitAt)} before it resets.`;
    tips = SLOW_TIPS;
  } else if (m.status === 'use') {
    const unused = 100 - m.projectedPct;
    title = 'Use it before it resets';
    text = `${used} with ${gone}. At this pace about ${m.limit ? `${money(unused)} (${pct(unused)})` : pct(unused)} will go unused when it ${resets}.`;
    tips = settings.planType === 'spend' ? [...USE_TIPS.slice(0, 2), 'Your plan is a fixed fee: budget left at the reset is paid for but lost.'] : USE_TIPS;
  } else {
    title = 'On track';
    text = `${used} with ${gone}; ${resets}.`;
    tips = [];
  }

  // One line for the pill next to Evaluate, e.g. "$122 of $500 · 24% · resets Sun, Nov 1".
  const short = [
    m.limit ? `${money(m.usedPct)} of ${money(100)}` : m.label,
    pct(m.usedPct),
    m.period === 'session' ? `resets in ${duration(m.end - now)}` : `resets ${day(m.end)}`,
  ].join(' · ');

  return {
    status: m.status,
    title,
    text,
    short,
    tips,
    badge: pct(m.usedPct),
    readAt: reading.readAt,
    source: reading.source ?? null,
    // What Evaluate's model sees (SPEC §2.1 "budget-aware"): numbers only.
    forPrompt: {
      status: m.status,
      meter: m.id,
      used_pct: Math.round(m.usedPct),
      period_elapsed_pct: Math.round(m.elapsed * 100),
      projected_pct_at_reset: m.projectedPct == null ? null : Math.round(m.projectedPct),
      resets_in_hours: Math.round((m.end - now) / HOUR),
    },
  };
}
