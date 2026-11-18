/**
 * Pure, deterministic 10-second Applausometer signal processing and state helpers.
 *
 * Calibration & Normalization (High-Sensitivity Room Mic Tuning):
 * - Time-domain PCM samples x[i] in [-1, 1] yield frame RMS and transient peak crest.
 * - Blended energy = min(1, max(rms, 0.62 * rms + 0.38 * peak)) captures sharp hand claps.
 * - Converted to dBFS = 20 * log10(max(energy, 1e-5)), bounded to [-100, 0].
 * - Normalized over [NOISE_FLOOR_DB = -66 dBFS, CEILING_DB = -18 dBFS] -> [0, 1].
 * - Perceptual gamma exponent 0.68 boosts room clapping responsiveness cleanly.
 * - Live UI bar applies asymmetric instant-attack / smooth-release filtering
 *   (attackAlpha = 0.90, releaseAlpha = 0.25) so louder claps register with zero lag.
 *
 * Final Score (0..100) over the full 10-second measurement period:
 * - mean (55%): arithmetic mean across all captured frames (rewards sustained cheering).
 * - p75  (30%): 75th percentile frame level (captures peaks without letting one short
 *               100ms clap/mic-bump dominate the whole score).
 * - activeRatio (15%): fraction of frames >= 0.15 normalized level (rewards continuous applause).
 * - score = clamp(0, 100, round((0.55 * mean + 0.30 * p75 + 0.15 * activeRatio) * 100)).
 */

import type { LeaderboardEntry } from "./singer";

export const APPLAUSE_COUNTDOWN_MS = 5_000;
export const APPLAUSE_DURATION_MS = 10_000;
export const APPLAUSE_CELEBRATION_MS = 8_000;
export const APPLAUSE_NOISE_FLOOR_DB = -66;
export const APPLAUSE_CEILING_DB = -18;
export const APPLAUSE_MIN_SAMPLES = 5;

export type ApplauseMeasurementStatus =
  | "idle"
  | "countdown"
  | "measuring"
  | "completed"
  | "cancelled"
  | "failed";

export interface RoundEvaluationSummary {
  requestId: string | null;
  singerId: string;
  singerName: string;
  songTitle: string | null;
  isGuest: boolean;
  applauseScore: number;
  likes: number;
  roundPoints: number;
  totalSingerPoints: number;
  rank: number | null;
  previousRank: number | null;
  rankDelta: number;
  evaluatedAt: number;
}

export interface ApplauseMeasurementItem {
  id: string;
  request_id: string | null;
  singer_user_id: string | null;
  singer_name: string;
  song_title: string | null;
  score: number;
  included: boolean;
  completed_at: string;
  started_at: string;
}

export interface ApplauseStateSnapshot {
  measurementId: string | null;
  requestId: string | null;
  singerUserId?: string | null;
  singerName: string | null;
  songTitle: string | null;
  status: ApplauseMeasurementStatus;
  startedAt: number | null;
  countdownEndsAt: number | null;
  endsAt: number | null;
  durationMs: number;
  latestLevel: number;
  latestPeak: number;
  latestBands?: number[];
  lastSeq: number;
  score: number | null;
  likes: number;
  totalPoints: number | null;
  rank?: number | null;
  previousRank?: number | null;
  rankDelta?: number;
  totalSingerPoints?: number | null;
  topRankings?: LeaderboardEntry[];
  updatedAt: number;
}

export interface ApplauseScoreBreakdown {
  score: number;
  mean: number;
  p75: number;
  activeRatio: number;
  peak: number;
  samplesCount: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function computeRmsFromFloatSamples(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Computes RMS, absolute transient peak, and clap-sensitive blended energy
 * so sharp hand claps in real rooms register immediately instead of averaging down.
 */
export function computeFrameEnergyFromFloatSamples(samples: ArrayLike<number>): {
  rms: number;
  peak: number;
  energy: number;
} {
  if (!samples.length) return { rms: 0, peak: 0, energy: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const energy = Math.min(1, Math.max(rms, 0.62 * rms + 0.38 * peak));
  return { rms, peak, energy };
}

export function computeRmsFromByteTimeDomain(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const centered = ((samples[i] ?? 128) - 128) / 128;
    sumSq += centered * centered;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function rmsToDbfs(rms: number): number {
  const safe = Math.max(rms, 1e-5);
  return Math.max(-100, Math.min(0, 20 * Math.log10(safe)));
}

export function normalizeDbfs(
  dbfs: number,
  floorDb = APPLAUSE_NOISE_FLOOR_DB,
  ceilingDb = APPLAUSE_CEILING_DB,
): number {
  if (!Number.isFinite(dbfs)) return 0;
  const span = Math.max(1, ceilingDb - floorDb);
  const linear = clamp01((dbfs - floorDb) / span);
  if (linear <= 0.015) return 0;
  return clamp01(Math.pow(linear, 0.68));
}

export function normalizeRmsLevel(rms: number): number {
  return normalizeDbfs(rmsToDbfs(rms));
}

export function smoothLevel(previous: number, raw: number, alpha = 0.35): number {
  const prev = clamp01(previous);
  const next = clamp01(raw);
  const a = clamp01(alpha);
  return clamp01(prev * (1 - a) + next * a);
}

/**
 * Asymmetric instant-attack / smooth-release envelope:
 * Rising claps jump immediately (attackAlpha = 0.90), while drops decay cleanly.
 */
export function smoothLevelAsymmetric(
  previous: number,
  raw: number,
  attackAlpha = 0.9,
  releaseAlpha = 0.25,
): number {
  const prev = clamp01(previous);
  const next = clamp01(raw);
  const alpha = next >= prev ? clamp01(attackAlpha) : clamp01(releaseAlpha);
  return clamp01(prev * (1 - alpha) + next * alpha);
}

/**
 * Downsamples FFT byte frequency bins (0..255) into log-spaced normalized bands [0, 1]
 * spanning vocal cheers & hand-clap transients for fine real-time spectrum bars.
 */
export function extractFrequencyBands(
  frequencyBytes: ArrayLike<number>,
  bandCount = 48,
  overallLevel = 0,
): number[] {
  const safeCount = Math.max(8, Math.min(64, Math.floor(bandCount)));
  const len = frequencyBytes.length;
  if (!len) {
    return Array.from({ length: safeCount }, () => 0);
  }

  const lvl = clamp01(overallLevel);
  const minBin = 1;
  const maxBin = Math.max(minBin + 1, Math.min(len - 1, Math.floor(len * 0.55)));
  const ratio = maxBin / minBin;

  return Array.from({ length: safeCount }, (_, i) => {
    const startFrac = i / safeCount;
    const endFrac = (i + 1) / safeCount;
    const lo = Math.floor(minBin * Math.pow(ratio, startFrac));
    const hi = Math.max(lo, Math.ceil(minBin * Math.pow(ratio, endFrac)));

    let sum = 0;
    let peak = 0;
    let count = 0;
    for (let b = lo; b <= hi && b < len; b++) {
      const val = (frequencyBytes[b] ?? 0) / 255;
      sum += val;
      if (val > peak) peak = val;
      count++;
    }
    const rawBand = count > 0 ? 0.55 * (sum / count) + 0.45 * peak : 0;
    const perceptual = rawBand > 0.02 ? Math.pow(clamp01(rawBand), 0.72) : 0;
    const boosted = clamp01(Math.max(perceptual, lvl * 0.35 * perceptual + perceptual * 0.65));
    return Math.round(boosted * 1000) / 1000;
  });
}

export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const clampedP = clamp01(p);
  const idx = clampedP * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo] ?? 0;
  const frac = idx - lo;
  return (sortedValues[lo] ?? 0) * (1 - frac) + (sortedValues[hi] ?? 0) * frac;
}

export function computeApplauseScore(samples: readonly number[]): ApplauseScoreBreakdown {
  const clean = samples.map(clamp01);
  const count = clean.length;
  if (count === 0) {
    return { score: 0, mean: 0, p75: 0, activeRatio: 0, peak: 0, samplesCount: 0 };
  }

  let sum = 0;
  let active = 0;
  let peak = 0;
  for (const s of clean) {
    sum += s;
    if (s >= 0.15) active++;
    if (s > peak) peak = s;
  }

  const mean = sum / count;
  const sorted = [...clean].sort((a, b) => a - b);
  const p75 = percentile(sorted, 0.75);
  const activeRatio = active / count;

  const composite = 0.55 * mean + 0.3 * p75 + 0.15 * activeRatio;
  const score = Math.min(100, Math.max(0, Math.round(composite * 100)));

  return {
    score,
    mean,
    p75,
    activeRatio,
    peak,
    samplesCount: count,
  };
}

export function remainingCountdownSeconds(countdownEndsAtMs: number | null, nowMs: number): number {
  if (!countdownEndsAtMs || !Number.isFinite(countdownEndsAtMs)) return 0;
  const diff = Math.max(0, countdownEndsAtMs - nowMs);
  return Math.min(5, Math.ceil(diff / 1000));
}

export function remainingApplauseSeconds(endsAtMs: number | null, nowMs: number): number {
  if (!endsAtMs || !Number.isFinite(endsAtMs)) return 0;
  const diff = Math.max(0, endsAtMs - nowMs);
  return Math.min(30, Math.ceil(diff / 1000));
}

/**
 * Generates deterministic multi-band VU meter column heights in [0, 1]
 * strictly synchronized with the live measured microphone level.
 * Returns all 0s when audio level is effectively silent.
 */
export function computeSpectrumColumns(
  level: number,
  peak: number,
  seq: number,
  count = 48,
): number[] {
  const lvl = clamp01(level);
  const safeCount = Math.max(4, Math.floor(count));
  if (lvl <= 0.01) {
    return Array.from({ length: safeCount }, () => 0);
  }
  const pk = clamp01(Math.max(lvl, peak));
  const mid = (safeCount - 1) / 2;
  return Array.from({ length: safeCount }, (_, i) => {
    const distFromCenter = Math.abs(i - mid) / Math.max(1, mid);
    const arch = 1 - 0.28 * distFromCenter * distFromCenter;
    const harmonic = 0.14 * Math.sin(seq * 0.9 + i * 0.52) + 0.08 * Math.cos(seq * 1.5 - i * 0.85);
    const col = lvl * arch + harmonic * Math.max(0.25, lvl);
    return clamp01(Math.min(Math.max(0.06, pk), col));
  });
}

export interface ScoreDistribution {
  applausePoints: number;
  likesCount: number;
  likesPoints: number;
  totalPoints: number;
  applauseSharePct: number;
  likesSharePct: number;
}

export function computeScoreDistribution(
  applauseScore: number | null | undefined,
  likes: number,
): ScoreDistribution {
  const applausePoints = Math.max(0, Math.min(100, Math.round(applauseScore ?? 0)));
  const likesCount = Math.max(0, Math.floor(likes));
  const likesPoints = likesCount * 10;
  const totalPoints = applausePoints + likesPoints;
  if (totalPoints === 0) {
    return {
      applausePoints,
      likesCount,
      likesPoints,
      totalPoints: 0,
      applauseSharePct: 50,
      likesSharePct: 50,
    };
  }
  const applauseSharePct = Math.round((applausePoints / totalPoints) * 100);
  const likesSharePct = 100 - applauseSharePct;
  return {
    applausePoints,
    likesCount,
    likesPoints,
    totalPoints,
    applauseSharePct,
    likesSharePct,
  };
}

export function shouldAcceptApplauseUpdate(
  current: Pick<ApplauseStateSnapshot, "measurementId" | "requestId" | "lastSeq" | "updatedAt" | "status">,
  incoming: {
    measurementId: string;
    requestId?: string | null;
    status?: ApplauseMeasurementStatus;
    seq?: number;
    updatedAt?: number;
  },
): boolean {
  if (!incoming.measurementId) return false;
  if (current.measurementId && current.measurementId !== incoming.measurementId) {
    // Allow newer measurement only if its updatedAt is strictly newer than current
    if (
      typeof incoming.updatedAt === "number" &&
      incoming.updatedAt > current.updatedAt &&
      (incoming.seq ?? 0) === 0
    ) {
      return true;
    }
    return false;
  }
  const currReq = current.requestId ?? null;
  const incReq = incoming.requestId ?? null;
  if (current.measurementId === incoming.measurementId && currReq !== incReq) return false;
  if (typeof incoming.updatedAt === "number" && incoming.updatedAt < current.updatedAt) {
    return false;
  }
  const statusChanged =
    incoming.status !== undefined &&
    incoming.status !== current.status &&
    (current.status === "countdown" || incoming.status === "completed");
  if (
    !statusChanged &&
    typeof incoming.seq === "number" &&
    current.measurementId === incoming.measurementId
  ) {
    if (incoming.seq <= current.lastSeq) return false;
  }
  return true;
}

export const IDLE_APPLAUSE_STATE: ApplauseStateSnapshot = {
  measurementId: null,
  requestId: null,
  singerUserId: null,
  singerName: null,
  songTitle: null,
  status: "idle",
  startedAt: null,
  countdownEndsAt: null,
  endsAt: null,
  durationMs: APPLAUSE_DURATION_MS,
  latestLevel: 0,
  latestPeak: 0,
  lastSeq: 0,
  score: null,
  likes: 0,
  totalPoints: null,
  updatedAt: 0,
};
