import type { DbClient } from "./db.ts";
import { broadcastStageEvent, broadcastPublicEvent } from "./events.ts";
import {
  APPLAUSE_CELEBRATION_MS,
  APPLAUSE_COUNTDOWN_MS,
  APPLAUSE_DURATION_MS,
  APPLAUSE_MIN_SAMPLES,
  IDLE_APPLAUSE_STATE,
  clamp01,
  computeApplauseScore,
  shouldAcceptApplauseUpdate,
  type ApplauseMeasurementItem,
  type ApplauseStateSnapshot,
  type RoundEvaluationSummary,
} from "../src/lib/applause-meter.ts";
import {
  computeRankDeltas,
  getSingerKey,
  performancePoints,
  sortLeaderboard,
  summedPerformancePoints,
  type LeaderboardEntry,
} from "../src/lib/singer.ts";

let currentState: ApplauseStateSnapshot = { ...IDLE_APPLAUSE_STATE };

export function resetApplauseStateForTests(): void {
  currentState = { ...IDLE_APPLAUSE_STATE };
}

export async function fetchNightLeaderboard(db: DbClient): Promise<LeaderboardEntry[]> {
  const res = await db.query<{
    singer_id: string;
    display_name: string;
    card_code: string;
    is_guest: boolean;
    likes: string | number;
    applause_points: string | number;
    total_points: string | number;
    performances: string | number;
  }>(`SELECT * FROM public.leaderboard('night')`);

  return sortLeaderboard(
    res.rows.map((r) => ({
      singer_id: String(r.singer_id),
      display_name: r.display_name,
      card_code: r.card_code ?? "",
      is_guest: Boolean(r.is_guest),
      likes: Number(r.likes),
      applause_points: Number(r.applause_points),
      total_points: Number(r.total_points),
      performances: Number(r.performances),
    })),
  );
}

export async function broadcastNightLeaderboard(
  db: DbClient,
  reason: string,
  requestId?: string | null,
): Promise<LeaderboardEntry[]> {
  const rows = await fetchNightLeaderboard(db);
  const payload = {
    period: "night",
    reason,
    requestId: requestId ?? null,
    rows,
    topRankings: rows.slice(0, 5),
    evaluation: null,
  };
  broadcastPublicEvent("leaderboard_updated", payload);
  broadcastStageEvent("leaderboard_updated", payload);
  return rows;
}

export async function evaluateRoundAndLeaderboard(
  db: DbClient,
  requestId: string,
  previousRows: readonly LeaderboardEntry[] = [],
  reason = "round_evaluated",
): Promise<{
  evaluation: RoundEvaluationSummary | null;
  rows: LeaderboardEntry[];
  topRankings: LeaderboardEntry[];
}> {
  const [reqRes, measRes, rows] = await Promise.all([
    db.query<{
      id: string;
      user_id: string | null;
      singer_name: string;
      song_title: string;
      applause_score: number | null;
      likes_count: string | number;
    }>(
      `SELECT s.id, s.user_id, s.singer_name, s.song_title, s.applause_score,
         (SELECT count(*)::int FROM public.performance_likes l WHERE l.request_id = s.id) AS likes_count
       FROM public.song_requests s
       WHERE s.id = $1
       LIMIT 1`,
      [requestId],
    ),
    db.query<{ total: string | number; cnt: string | number }>(
      `SELECT coalesce(sum(score), 0)::int AS total, count(*)::int AS cnt
       FROM public.applause_measurements
       WHERE request_id = $1 AND status = 'completed' AND score IS NOT NULL AND included = true`,
      [requestId],
    ),
    fetchNightLeaderboard(db),
  ]);

  const reqRow = reqRes.rows[0];
  const topRankings = rows.slice(0, 5);
  if (!reqRow) {
    return { evaluation: null, rows, topRankings };
  }

  const singerId = getSingerKey({
    user_id: reqRow.user_id,
    singer_name: reqRow.singer_name,
  });
  const measCount = Number(measRes.rows[0]?.cnt ?? 0);
  const applauseScore =
    measCount > 0
      ? Math.max(0, Number(measRes.rows[0]?.total ?? 0))
      : typeof reqRow.applause_score === "number"
        ? Math.max(0, Math.min(100, reqRow.applause_score))
        : 0;
  const likes = Number(reqRow.likes_count ?? 0);
  const roundPoints = summedPerformancePoints(applauseScore, likes);

  const deltas = computeRankDeltas(previousRows, rows);
  const delta = deltas[singerId];
  const matchedEntry = rows.find((r) => r.singer_id === singerId);

  const evaluation: RoundEvaluationSummary = {
    requestId: reqRow.id,
    singerId,
    singerName: matchedEntry?.display_name ?? reqRow.singer_name,
    songTitle: reqRow.song_title,
    isGuest: !reqRow.user_id,
    applauseScore,
    likes,
    roundPoints,
    totalSingerPoints: matchedEntry?.total_points ?? roundPoints,
    rank: delta?.rank ?? null,
    previousRank: delta?.previousRank ?? null,
    rankDelta: delta?.rankDelta ?? 0,
    evaluatedAt: Date.now(),
  };

  const eventPayload = {
    period: "night",
    reason,
    requestId: reqRow.id,
    evaluation,
    rows,
    topRankings,
  };
  broadcastPublicEvent("leaderboard_updated", eventPayload);
  broadcastStageEvent("leaderboard_updated", eventPayload);

  return { evaluation, rows, topRankings };
}

async function evaluateMeasurementAndLeaderboard(
  db: DbClient,
  input: {
    requestId: string | null;
    singerUserId: string | null;
    singerName: string;
    songTitle: string | null;
    score: number;
    likes: number;
  },
  previousRows: readonly LeaderboardEntry[],
  reason = "applause_saved",
): Promise<{
  evaluation: RoundEvaluationSummary;
  rows: LeaderboardEntry[];
  topRankings: LeaderboardEntry[];
}> {
  const rows = await fetchNightLeaderboard(db);
  const topRankings = rows.slice(0, 5);
  const singerId = getSingerKey({
    user_id: input.singerUserId,
    singer_name: input.singerName,
  });
  const roundPoints = performancePoints(input.score, input.likes);
  const deltas = computeRankDeltas(previousRows, rows);
  const delta = deltas[singerId];
  const matchedEntry = rows.find((r) => r.singer_id === singerId);

  const evaluation: RoundEvaluationSummary = {
    requestId: input.requestId,
    singerId,
    singerName: matchedEntry?.display_name ?? input.singerName,
    songTitle: input.songTitle,
    isGuest: !input.singerUserId,
    applauseScore: input.score,
    likes: input.likes,
    roundPoints,
    totalSingerPoints: matchedEntry?.total_points ?? roundPoints,
    rank: delta?.rank ?? null,
    previousRank: delta?.previousRank ?? null,
    rankDelta: delta?.rankDelta ?? 0,
    evaluatedAt: Date.now(),
  };

  const eventPayload = {
    period: "night",
    reason,
    requestId: input.requestId,
    evaluation,
    rows,
    topRankings,
  };
  broadcastPublicEvent("leaderboard_updated", eventPayload);
  broadcastStageEvent("leaderboard_updated", eventPayload);

  return { evaluation, rows, topRankings };
}

function hydrateFromRow(row: {
  id: string;
  request_id: string | null;
  singer_user_id: string | null;
  singer_name: string | null;
  song_title: string | null;
  status: string;
  started_at: string | Date;
  countdown_ends_at?: string | Date | null;
  ends_at: string | Date;
  duration_ms: number;
  latest_level: number;
  latest_peak: number;
  last_seq: number;
  score: number | null;
  likes_count: string | number;
  completed_at: string | Date | null;
  updated_at: string | Date;
}): ApplauseStateSnapshot {
  const likes = Number(row.likes_count ?? 0);
  const score = row.score === null || row.score === undefined ? null : Number(row.score);
  return {
    measurementId: row.id,
    requestId: row.request_id ?? null,
    singerUserId: row.singer_user_id ?? null,
    singerName: row.singer_name ?? null,
    songTitle: row.song_title ?? null,
    status: row.status as ApplauseStateSnapshot["status"],
    startedAt: new Date(row.started_at).getTime(),
    countdownEndsAt: row.countdown_ends_at ? new Date(row.countdown_ends_at).getTime() : null,
    endsAt: new Date(row.ends_at).getTime(),
    durationMs: Number(row.duration_ms),
    latestLevel: Number(row.latest_level ?? 0),
    latestPeak: Number(row.latest_peak ?? 0),
    lastSeq: Number(row.last_seq ?? 0),
    score,
    likes,
    totalPoints: score !== null ? performancePoints(score, likes) : null,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

export async function getCurrentApplauseState(db: DbClient): Promise<ApplauseStateSnapshot> {
  const res = await db.query<{
    id: string;
    request_id: string | null;
    singer_user_id: string | null;
    singer_name: string | null;
    song_title: string | null;
    status: string;
    started_at: string;
    countdown_ends_at: string | null;
    ends_at: string;
    duration_ms: number;
    latest_level: number;
    latest_peak: number;
    last_seq: number;
    score: number | null;
    likes_count: string;
    completed_at: string | null;
    updated_at: string;
  }>(
    `SELECT m.*,
       coalesce(m.singer_user_id, s.user_id) AS singer_user_id,
       coalesce(nullif(trim(m.singer_name), ''), s.singer_name) AS singer_name,
       s.song_title,
       CASE
         WHEN m.request_id IS NOT NULL THEN (
           SELECT count(*) FROM public.performance_likes l WHERE l.request_id = m.request_id
         )
         ELSE 0
       END AS likes_count
     FROM public.applause_measurements m
     LEFT JOIN public.song_requests s ON s.id = m.request_id
     ORDER BY m.started_at DESC
     LIMIT 1`,
  );

  const row = res.rows[0];
  if (!row) {
    currentState = { ...IDLE_APPLAUSE_STATE };
    return currentState;
  }

  const now = Date.now();
  const hydrated = hydrateFromRow(row);

  // If a countdown or measuring session timed out without completion (> endsAt + 15s), mark failed cleanly without touching song_requests.applause_score
  if (
    (hydrated.status === "measuring" || hydrated.status === "countdown") &&
    hydrated.endsAt &&
    now > hydrated.endsAt + 15000
  ) {
    await db.query(
      `UPDATE public.applause_measurements SET status = 'failed', updated_at = now() WHERE id = $1 AND status IN ('countdown', 'measuring')`,
      [hydrated.measurementId],
    );
    hydrated.status = "failed";
    hydrated.updatedAt = now;
  }

  // Keep in-memory level and live FFT spectrum bands freshest if same measurement
  if (currentState.measurementId === hydrated.measurementId) {
    if (currentState.lastSeq > hydrated.lastSeq) {
      hydrated.latestLevel = currentState.latestLevel;
      hydrated.latestPeak = currentState.latestPeak;
      hydrated.lastSeq = currentState.lastSeq;
    }
    if (currentState.latestBands && currentState.lastSeq >= hydrated.lastSeq) {
      hydrated.latestBands = currentState.latestBands;
    }
  }

  // If celebration window already elapsed, return idle unless active
  if (
    hydrated.status === "completed" &&
    row.completed_at &&
    now - new Date(row.completed_at).getTime() > APPLAUSE_CELEBRATION_MS + 1000
  ) {
    currentState = { ...IDLE_APPLAUSE_STATE, updatedAt: hydrated.updatedAt };
    return currentState;
  }

  if (hydrated.status === "cancelled" || hydrated.status === "failed") {
    currentState = { ...IDLE_APPLAUSE_STATE, updatedAt: hydrated.updatedAt };
    return currentState;
  }

  currentState = hydrated;
  return currentState;
}

export async function startApplauseMeasurement(
  db: DbClient,
  input: {
    requestId?: string | null;
    singerName?: string;
    singerUserId?: string | null;
    measurementId: string;
    durationMs?: number;
    countdownMs?: number;
  },
): Promise<{ ok: true; state: ApplauseStateSnapshot } | { ok: false; status: number; reason: string }> {
  const existing = await getCurrentApplauseState(db);
  const now = Date.now();

  if (
    (existing.status === "measuring" || existing.status === "countdown") &&
    existing.endsAt &&
    now < existing.endsAt + 2000
  ) {
    return { ok: false, status: 409, reason: "busy" };
  }

  let resolvedRequestId: string | null = input.requestId ?? null;
  let resolvedSingerUserId: string | null = input.singerUserId ?? null;
  let resolvedSingerName = input.singerName?.trim() ?? "";
  let resolvedSongTitle: string | null = null;
  let likes = 0;

  if (resolvedRequestId) {
    const reqRes = await db.query<{
      id: string;
      user_id: string | null;
      singer_name: string;
      song_title: string;
      status: string;
      likes_count: string;
    }>(
      `SELECT s.id, s.user_id, s.singer_name, s.song_title, s.status,
         (SELECT count(*) FROM public.performance_likes l WHERE l.request_id = s.id) AS likes_count
       FROM public.song_requests s
       WHERE s.id = $1
       LIMIT 1`,
      [resolvedRequestId],
    );

    const reqRow = reqRes.rows[0];
    if (!reqRow) {
      return { ok: false, status: 404, reason: "not_found" };
    }

    resolvedSingerUserId = reqRow.user_id;
    resolvedSingerName = reqRow.singer_name;
    resolvedSongTitle = reqRow.song_title;
    likes = Number(reqRow.likes_count ?? 0);
  } else {
    if (!resolvedSingerName) {
      return { ok: false, status: 400, reason: "missing_candidate" };
    }
    resolvedRequestId = null;
  }

  const durationMs = Math.min(30000, Math.max(1000, input.durationMs ?? APPLAUSE_DURATION_MS));
  const countdownMs = Math.min(15000, Math.max(0, input.countdownMs ?? APPLAUSE_COUNTDOWN_MS));
  const startedAt = now;
  const countdownEndsAt = countdownMs > 0 ? startedAt + countdownMs : null;
  const endsAt = (countdownEndsAt ?? startedAt) + durationMs;
  const initialStatus = countdownMs > 0 ? "countdown" : "measuring";

  await db.query(
    `INSERT INTO public.applause_measurements
       (id, request_id, singer_user_id, singer_name, status, started_at, countdown_ends_at, ends_at, duration_ms, latest_level, latest_peak, last_seq, included)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.measurementId,
      resolvedRequestId,
      resolvedSingerUserId,
      resolvedSingerName,
      initialStatus,
      new Date(startedAt).toISOString(),
      countdownEndsAt ? new Date(countdownEndsAt).toISOString() : null,
      new Date(endsAt).toISOString(),
      durationMs,
    ],
  );

  currentState = {
    measurementId: input.measurementId,
    requestId: resolvedRequestId,
    singerUserId: resolvedSingerUserId,
    singerName: resolvedSingerName,
    songTitle: resolvedSongTitle,
    status: initialStatus,
    startedAt,
    countdownEndsAt,
    endsAt,
    durationMs,
    latestLevel: 0,
    latestPeak: 0,
    lastSeq: 0,
    score: null,
    likes,
    totalPoints: null,
    updatedAt: now,
  };

  broadcastStageEvent("applause_state", currentState);
  return { ok: true, state: currentState };
}

export async function beginApplauseMeasurement(
  db: DbClient,
  input: { measurementId: string; requestId?: string | null },
): Promise<{ ok: true; state: ApplauseStateSnapshot } | { ok: false; status: number; reason: string }> {
  if (currentState.measurementId !== input.measurementId) {
    await getCurrentApplauseState(db);
  }

  const mRes = await db.query<{
    id: string;
    request_id: string | null;
    status: string;
    duration_ms: number;
  }>(
    `SELECT id, request_id, status, duration_ms FROM public.applause_measurements WHERE id = $1 LIMIT 1`,
    [input.measurementId],
  );
  const mRow = mRes.rows[0];
  if (!mRow) {
    return { ok: false, status: 404, reason: "measurement_not_found" };
  }
  if (input.requestId !== undefined && (mRow.request_id ?? null) !== (input.requestId ?? null)) {
    return { ok: false, status: 404, reason: "measurement_not_found" };
  }
  if (mRow.status === "measuring" && currentState.measurementId === input.measurementId) {
    return { ok: true, state: currentState };
  }
  if (mRow.status !== "countdown") {
    return { ok: false, status: 409, reason: "not_countdown" };
  }

  const now = Date.now();
  const endsAt = now + Number(mRow.duration_ms);
  await db.query(
    `UPDATE public.applause_measurements
     SET status = 'measuring',
         ends_at = $2,
         updated_at = now()
     WHERE id = $1 AND status = 'countdown'`,
    [input.measurementId, new Date(endsAt).toISOString()],
  );

  let likes = 0;
  if (mRow.request_id) {
    const likesRes = await db.query<{ likes: string }>(
      `SELECT count(*)::int AS likes FROM public.performance_likes WHERE request_id = $1`,
      [mRow.request_id],
    );
    likes = Number(likesRes.rows[0]?.likes ?? currentState.likes ?? 0);
  }

  currentState = {
    ...currentState,
    status: "measuring",
    startedAt: now,
    endsAt,
    likes,
    updatedAt: now,
  };

  broadcastStageEvent("applause_state", currentState);
  return { ok: true, state: currentState };
}

export async function pushApplauseLevel(
  db: DbClient,
  input: {
    measurementId: string;
    requestId?: string | null;
    seq: number;
    level: number;
    peak: number;
    bands?: number[];
  },
): Promise<{ accepted: boolean; reason?: string }> {
  if (currentState.measurementId !== input.measurementId) {
    await getCurrentApplauseState(db);
  }

  // Safety promotion if a frame arrives right as the 5s countdown finishes
  if (
    currentState.status === "countdown" &&
    currentState.measurementId === input.measurementId &&
    (!currentState.countdownEndsAt || Date.now() >= currentState.countdownEndsAt - 300)
  ) {
    await beginApplauseMeasurement(db, {
      measurementId: input.measurementId,
      requestId: input.requestId ?? currentState.requestId,
    });
  }

  if (currentState.status !== "measuring") {
    return { accepted: false, reason: "not_measuring" };
  }

  const now = Date.now();
  if (
    !shouldAcceptApplauseUpdate(currentState, {
      measurementId: input.measurementId,
      requestId: input.requestId !== undefined ? input.requestId : currentState.requestId,
      seq: input.seq,
      updatedAt: now,
    })
  ) {
    return { accepted: false, reason: "stale" };
  }

  const level = clamp01(input.level);
  const peak = clamp01(Math.max(input.peak, currentState.latestPeak));
  const bands =
    input.bands && input.bands.length > 0
      ? input.bands.slice(0, 64).map(clamp01)
      : currentState.latestBands;

  currentState = {
    ...currentState,
    latestLevel: level,
    latestPeak: peak,
    latestBands: bands,
    lastSeq: input.seq,
    updatedAt: now,
  };

  // Broadcast immediately via SSE before async checkpointing so Beamer reacts with zero DB delay
  broadcastStageEvent("applause_state", currentState);

  // Checkpoint periodically in background so page reload restores latest level without blocking live frames
  if (input.seq % 8 === 0) {
    void db
      .query(
        `UPDATE public.applause_measurements
         SET latest_level = $2, latest_peak = $3, last_seq = $4, updated_at = now()
         WHERE id = $1 AND status = 'measuring' AND last_seq < $4`,
        [input.measurementId, level, peak, input.seq],
      )
      .catch(() => {});
  }

  return { accepted: true };
}

export async function completeApplauseMeasurement(
  db: DbClient,
  input: {
    measurementId: string;
    requestId?: string | null;
    samples: number[];
  },
): Promise<
  | { ok: true; state: ApplauseStateSnapshot; breakdown: ReturnType<typeof computeApplauseScore> }
  | { ok: false; status: number; reason: string }
> {
  if (currentState.measurementId !== input.measurementId) {
    await getCurrentApplauseState(db);
  }

  const mRes = await db.query<{
    id: string;
    request_id: string | null;
    singer_user_id: string | null;
    singer_name: string | null;
    status: string;
  }>(
    `SELECT id, request_id, singer_user_id, singer_name, status
     FROM public.applause_measurements
     WHERE id = $1
     LIMIT 1`,
    [input.measurementId],
  );
  const mRow = mRes.rows[0];
  if (!mRow) {
    return { ok: false, status: 404, reason: "measurement_not_found" };
  }
  if (input.requestId !== undefined && (mRow.request_id ?? null) !== (input.requestId ?? null)) {
    return { ok: false, status: 404, reason: "measurement_not_found" };
  }
  if (mRow.status !== "measuring") {
    return { ok: false, status: 409, reason: "not_measuring" };
  }

  if (input.samples.length < APPLAUSE_MIN_SAMPLES) {
    await db.query(
      `UPDATE public.applause_measurements SET status = 'failed', updated_at = now() WHERE id = $1`,
      [input.measurementId],
    );
    return { ok: false, status: 400, reason: "insufficient_samples" };
  }

  const prevRows = await fetchNightLeaderboard(db);
  const breakdown = computeApplauseScore(input.samples);
  const rpcRes = await db.query<{
    dj_record_applause: { ok: boolean; reason?: string; likes?: number; total_points?: number };
  }>(`SELECT public.dj_record_applause($1, $2, $3) AS dj_record_applause`, [
    mRow.request_id,
    input.measurementId,
    breakdown.score,
  ]);
  const rpc = rpcRes.rows[0]?.dj_record_applause;
  if (!rpc?.ok) {
    return { ok: false, status: 400, reason: rpc?.reason ?? "save_failed" };
  }

  await db.query(
    `UPDATE public.applause_measurements
     SET status = 'completed',
         score = $2,
         samples_count = $3,
         latest_level = $4,
         latest_peak = $5,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [
      input.measurementId,
      breakdown.score,
      breakdown.samplesCount,
      currentState.latestLevel,
      Math.max(currentState.latestPeak, breakdown.peak),
    ],
  );

  let resolvedSingerUserId = mRow.singer_user_id;
  let resolvedSingerName = mRow.singer_name ?? currentState.singerName ?? "";
  let resolvedSongTitle: string | null = currentState.songTitle ?? null;

  if (mRow.request_id) {
    const reqInfo = await db.query<{
      user_id: string | null;
      singer_name: string;
      song_title: string;
    }>(`SELECT user_id, singer_name, song_title FROM public.song_requests WHERE id = $1`, [
      mRow.request_id,
    ]);
    if (reqInfo.rows[0]) {
      resolvedSingerUserId = reqInfo.rows[0].user_id;
      resolvedSingerName = reqInfo.rows[0].singer_name;
      resolvedSongTitle = reqInfo.rows[0].song_title;
    }
  }

  const likes = Number(rpc.likes ?? currentState.likes ?? 0);
  const totalPoints = Number(rpc.total_points ?? performancePoints(breakdown.score, likes));
  const evalResult = await evaluateMeasurementAndLeaderboard(
    db,
    {
      requestId: mRow.request_id,
      singerUserId: resolvedSingerUserId,
      singerName: resolvedSingerName,
      songTitle: resolvedSongTitle,
      score: breakdown.score,
      likes,
    },
    prevRows,
    "applause_saved",
  );
  const now = Date.now();

  currentState = {
    measurementId: input.measurementId,
    requestId: mRow.request_id,
    singerUserId: resolvedSingerUserId,
    singerName: resolvedSingerName,
    songTitle: resolvedSongTitle,
    status: "completed",
    startedAt: currentState.startedAt,
    countdownEndsAt: currentState.countdownEndsAt,
    endsAt: currentState.endsAt,
    durationMs: currentState.durationMs,
    latestLevel: 0,
    latestPeak: Math.max(currentState.latestPeak, breakdown.peak),
    lastSeq: currentState.lastSeq + 1,
    score: breakdown.score,
    likes,
    totalPoints,
    rank: evalResult.evaluation.rank,
    previousRank: evalResult.evaluation.previousRank,
    rankDelta: evalResult.evaluation.rankDelta,
    totalSingerPoints: evalResult.evaluation.totalSingerPoints,
    topRankings: evalResult.topRankings,
    updatedAt: now,
  };

  broadcastStageEvent("applause_state", currentState);
  broadcastPublicEvent("queue_changed", {
    reason: "applause_saved",
    requestId: mRow.request_id,
  });

  return { ok: true, state: currentState, breakdown };
}

export async function refreshActiveApplauseLikes(
  requestId: string,
  likes: number,
): Promise<void> {
  if (
    currentState.requestId === requestId &&
    (currentState.status === "countdown" || currentState.status === "measuring")
  ) {
    currentState = {
      ...currentState,
      likes,
      updatedAt: Math.max(Date.now(), currentState.updatedAt + 1),
    };
    broadcastStageEvent("applause_state", currentState);
  }
}

export async function cancelApplauseMeasurement(
  db: DbClient,
  input: { measurementId: string; requestId?: string | null; reason?: "cancelled" | "failed" },
): Promise<{ ok: boolean; state: ApplauseStateSnapshot }> {
  const nextStatus = input.reason === "failed" ? "failed" : "cancelled";
  await db.query(
    `UPDATE public.applause_measurements
     SET status = $2, updated_at = now()
     WHERE id = $1 AND status IN ('countdown', 'measuring')`,
    [input.measurementId, nextStatus],
  );

  const now = Date.now();
  currentState = {
    ...IDLE_APPLAUSE_STATE,
    status: "idle",
    updatedAt: now,
  };

  broadcastStageEvent("applause_state", currentState);
  return { ok: true, state: currentState };
}

async function syncRequestApplauseCache(db: DbClient, requestId: string | null): Promise<void> {
  if (!requestId) return;
  const latest = await db.query<{ id: string; score: number; completed_at: string | null }>(
    `SELECT id, score, completed_at
     FROM public.applause_measurements
     WHERE request_id = $1 AND status = 'completed' AND score IS NOT NULL AND included = true
     ORDER BY completed_at DESC NULLS LAST, started_at DESC
     LIMIT 1`,
    [requestId],
  );
  const row = latest.rows[0];
  if (row) {
    await db.query(
      `UPDATE public.song_requests
       SET applause_score = $2, applause_measured_at = $3, applause_measurement_id = $4
       WHERE id = $1`,
      [requestId, row.score, row.completed_at ?? new Date().toISOString(), row.id],
    );
  } else {
    await db.query(
      `UPDATE public.song_requests
       SET applause_score = NULL, applause_measured_at = NULL, applause_measurement_id = NULL
       WHERE id = $1`,
      [requestId],
    );
  }
}

export async function listApplauseMeasurements(
  db: DbClient,
  limit = 60,
): Promise<ApplauseMeasurementItem[]> {
  const res = await db.query<{
    id: string;
    request_id: string | null;
    singer_user_id: string | null;
    singer_name: string | null;
    song_title: string | null;
    score: number;
    included: boolean;
    completed_at: string;
    started_at: string;
  }>(
    `SELECT m.id,
       m.request_id,
       coalesce(m.singer_user_id, s.user_id) AS singer_user_id,
       coalesce(nullif(trim(m.singer_name), ''), s.singer_name, '') AS singer_name,
       s.song_title,
       m.score,
       m.included,
       coalesce(m.completed_at, m.updated_at, m.started_at) AS completed_at,
       m.started_at
     FROM public.applause_measurements m
     LEFT JOIN public.song_requests s ON s.id = m.request_id
     WHERE m.status = 'completed' AND m.score IS NOT NULL
     ORDER BY coalesce(m.completed_at, m.started_at) DESC
     LIMIT $1`,
    [limit],
  );

  return res.rows.map((r) => ({
    id: r.id,
    request_id: r.request_id ?? null,
    singer_user_id: r.singer_user_id ?? null,
    singer_name: r.singer_name ?? "",
    song_title: r.song_title ?? null,
    score: Number(r.score),
    included: Boolean(r.included),
    completed_at: new Date(r.completed_at).toISOString(),
    started_at: new Date(r.started_at).toISOString(),
  }));
}

export async function setApplauseMeasurementIncluded(
  db: DbClient,
  id: string,
  included: boolean,
): Promise<{ ok: boolean; row?: ApplauseMeasurementItem }> {
  const upd = await db.query<{ id: string; request_id: string | null }>(
    `UPDATE public.applause_measurements
     SET included = $2, updated_at = now()
     WHERE id = $1 AND status = 'completed' AND score IS NOT NULL
     RETURNING id, request_id`,
    [id, included],
  );
  const updated = upd.rows[0];
  if (!updated) {
    return { ok: false };
  }

  await syncRequestApplauseCache(db, updated.request_id);
  await broadcastNightLeaderboard(db, "measurement_toggled", updated.request_id);
  broadcastPublicEvent("queue_changed", { reason: "measurement_toggled", requestId: updated.request_id });

  const all = await listApplauseMeasurements(db, 60);
  const row = all.find((item) => item.id === id);
  return { ok: true, row };
}

export async function deleteApplauseMeasurement(
  db: DbClient,
  id: string,
): Promise<{ ok: boolean }> {
  const del = await db.query<{ id: string; request_id: string | null }>(
    `DELETE FROM public.applause_measurements WHERE id = $1 RETURNING id, request_id`,
    [id],
  );
  const removed = del.rows[0];
  if (!removed) {
    return { ok: false };
  }

  await syncRequestApplauseCache(db, removed.request_id);
  await broadcastNightLeaderboard(db, "measurement_deleted", removed.request_id);
  broadcastPublicEvent("queue_changed", { reason: "measurement_deleted", requestId: removed.request_id });
  return { ok: true };
}
