import { getFile } from '@/lib/server/gitea';

export interface SecureScoreHistoryPoint {
  date: string;
  currentScore: number;
  maxScore: number;
  percent: number;
  createdDateTime?: string;
  backedUpAt?: string;
}

/** Build a YYYY-MM-DD string for a date offset by -n days from today (UTC). */
export function secureScoreDateLabel(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Read daily secure score history files from a tenant Gitea repo.
 * Files live at backups/secure-score/history/YYYY-MM-DD.json.
 */
export async function getSecureScoreHistory(
  org: string,
  repo: string,
  days: number,
): Promise<{ points: SecureScoreHistoryPoint[]; availableDates: string[] }> {
  const clampedDays = Math.min(Math.max(days, 1), 365);
  const dates = Array.from({ length: clampedDays }, (_, i) => secureScoreDateLabel(i));

  const fileResults = await Promise.allSettled(
    dates.map(async (date) => {
      const result = await getFile(org, repo, `backups/secure-score/history/${date}.json`);
      if (!result.exists) return null;
      try {
        return JSON.parse(result.content) as SecureScoreHistoryPoint;
      } catch {
        return null;
      }
    }),
  );

  const points: SecureScoreHistoryPoint[] = [];
  const availableDates: string[] = [];

  for (const r of fileResults) {
    if (r.status === 'fulfilled' && r.value?.date) {
      availableDates.push(r.value.date);
      points.push(r.value);
    }
  }

  points.sort((a, b) => a.date.localeCompare(b.date));
  availableDates.sort();

  return { points, availableDates };
}

/** Compute MSP-wide average percent per date from tenant history series. */
export function aggregateSecureScoreHistory(
  tenantHistories: SecureScoreHistoryPoint[][],
): SecureScoreHistoryPoint[] {
  const byDate = new Map<string, { totalPct: number; count: number }>();

  for (const history of tenantHistories) {
    for (const point of history) {
      const pct = point.percent ?? (point.maxScore > 0 ? (point.currentScore / point.maxScore) * 100 : 0);
      const existing = byDate.get(point.date) ?? { totalPct: 0, count: 0 };
      existing.totalPct += pct;
      existing.count += 1;
      byDate.set(point.date, existing);
    }
  }

  return Array.from(byDate.entries())
    .map(([date, { totalPct, count }]) => ({
      date,
      currentScore: 0,
      maxScore: 100,
      percent: Math.round((totalPct / count) * 10) / 10,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
