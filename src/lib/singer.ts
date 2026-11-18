export const LIKE_POINTS_MULTIPLIER = 10;

/**
 * Binding formula per performance:
 * Total Points = Applause Score (0..100, missing counts as 0) + (Likes * 10)
 */
export function performancePoints(
  applauseScore: number | null | undefined,
  receivedLikes: number,
): number {
  const applause =
    typeof applauseScore === "number" && Number.isFinite(applauseScore)
      ? Math.min(100, Math.max(0, Math.round(applauseScore)))
      : 0;
  const likes = Math.max(0, Math.floor(Number.isFinite(receivedLikes) ? receivedLikes : 0));
  return applause + likes * LIKE_POINTS_MULTIPLIER;
}

/**
 * Sums total points when multiple 0..100 applause measurements are aggregated for a candidate or request.
 */
export function summedPerformancePoints(
  applauseTotal: number | null | undefined,
  receivedLikes: number,
): number {
  const applause =
    typeof applauseTotal === "number" && Number.isFinite(applauseTotal)
      ? Math.max(0, Math.round(applauseTotal))
      : 0;
  const likes = Math.max(0, Math.floor(Number.isFinite(receivedLikes) ? receivedLikes : 0));
  return applause + likes * LIKE_POINTS_MULTIPLIER;
}

export function singerPoints(receivedLikes: number, applauseScore: number | null = 0): number {
  return performancePoints(applauseScore, receivedLikes);
}

export function canLikePerformance(
  userId: string | undefined,
  singerId: string | null,
  status: string,
  updatedAt: string,
  now: number,
): boolean {
  return (
    !!userId &&
    singerId !== userId &&
    (status === "playing" || status === "done") &&
    new Date(updatedAt).getTime() > now - 12 * 3600 * 1000
  );
}

export interface LeaderboardEntry {
  singer_id: string;
  display_name: string;
  card_code: string;
  is_guest?: boolean;
  likes: number;
  applause_points: number;
  total_points: number;
  performances: number;
}

export function getSingerKey(input: { user_id?: string | null; singer_name: string }): string {
  if (input.user_id) return input.user_id;
  return `guest:${input.singer_name.trim().toLowerCase()}`;
}

export interface RankDeltaInfo {
  rank: number;
  previousRank: number | null;
  rankDelta: number;
  pointsDelta: number;
  isNew: boolean;
}

/**
 * Deterministic leaderboard tie-breaker ordering:
 * 1. total_points DESC
 * 2. applause_points DESC
 * 3. likes DESC
 * 4. performances DESC
 * 5. display_name ASC, singer_id ASC
 */
export function sortLeaderboard(rows: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...rows].sort(
    (a, b) =>
      b.total_points - a.total_points ||
      b.applause_points - a.applause_points ||
      b.likes - a.likes ||
      b.performances - a.performances ||
      a.display_name.localeCompare(b.display_name) ||
      a.singer_id.localeCompare(b.singer_id),
  );
}

/**
 * Computes 1-based rank changes and point deltas between previous and next leaderboard snapshots.
 * Positive rankDelta indicates climbing upward in the ranking (e.g. #3 -> #1 => +2).
 */
export function computeRankDeltas(
  previousRows: readonly LeaderboardEntry[],
  nextRows: readonly LeaderboardEntry[],
): Record<string, RankDeltaInfo> {
  const prevSorted = sortLeaderboard([...previousRows]);
  const nextSorted = sortLeaderboard([...nextRows]);

  const prevMap = new Map<string, { rank: number; points: number }>();
  prevSorted.forEach((row, idx) => {
    prevMap.set(row.singer_id, { rank: idx + 1, points: row.total_points });
  });

  const deltas: Record<string, RankDeltaInfo> = {};
  nextSorted.forEach((row, idx) => {
    const rank = idx + 1;
    const prev = prevMap.get(row.singer_id);
    if (!prev) {
      deltas[row.singer_id] = {
        rank,
        previousRank: null,
        rankDelta: 0,
        pointsDelta: row.total_points,
        isNew: true,
      };
      return;
    }
    deltas[row.singer_id] = {
      rank,
      previousRank: prev.rank,
      rankDelta: prev.rank - rank,
      pointsDelta: row.total_points - prev.points,
      isNew: false,
    };
  });

  return deltas;
}
