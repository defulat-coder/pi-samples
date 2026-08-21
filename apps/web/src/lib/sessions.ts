import type { SessionSummary } from '@pi-workbench/contracts';

export type SessionGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';

export type SessionGroup = { key: SessionGroupKey; label: string; items: SessionSummary[] };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Newest first by updatedAt, then createdAt. */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
}

/** Groups sessions by recency: 今天 / 昨天 / 本周（近 7 天）/ 更早. Empty groups are dropped. */
export function groupSessions(sessions: SessionSummary[], now: Date): SessionGroup[] {
  const todayStart = startOfDay(now);
  const buckets: Record<SessionGroupKey, SessionSummary[]> = { today: [], yesterday: [], week: [], earlier: [] };
  for (const session of sortSessions(sessions)) {
    const time = new Date(session.updatedAt).getTime();
    if (Number.isNaN(time)) {
      buckets.earlier.push(session);
      continue;
    }
    if (time >= todayStart) buckets.today.push(session);
    else if (time >= todayStart - DAY_MS) buckets.yesterday.push(session);
    else if (time >= todayStart - 7 * DAY_MS) buckets.week.push(session);
    else buckets.earlier.push(session);
  }
  const labels: Record<SessionGroupKey, string> = { today: '今天', yesterday: '昨天', week: '本周', earlier: '更早' };
  return (Object.keys(buckets) as SessionGroupKey[])
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: labels[key], items: buckets[key] }));
}

/** Sidebar search: matches agents and sessions by name/title, case-insensitive. */
export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}
