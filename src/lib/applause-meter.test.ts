import { describe, expect, it } from "vitest";
import {
  computeApplauseScore,
  computeFrameEnergyFromFloatSamples,
  computeRmsFromFloatSamples,
  computeScoreDistribution,
  computeSpectrumColumns,
  extractFrequencyBands,
  normalizeDbfs,
  normalizeRmsLevel,
  remainingApplauseSeconds,
  remainingCountdownSeconds,
  rmsToDbfs,
  shouldAcceptApplauseUpdate,
  smoothLevel,
  smoothLevelAsymmetric,
} from "./applause-meter";

describe("applause meter signal processing & state rules", () => {
  it("computes accurate RMS, transient clap sensitivity, and dBFS scaling", () => {
    const silent = new Float32Array(256).fill(0);
    expect(computeRmsFromFloatSamples(silent)).toBe(0);
    expect(normalizeRmsLevel(0)).toBe(0);

    const loud = new Float32Array(256).fill(0.5);
    const rms = computeRmsFromFloatSamples(loud);
    expect(rms).toBeCloseTo(0.5, 4);
    expect(rmsToDbfs(rms)).toBeCloseTo(-6.02, 1);
    expect(normalizeDbfs(-6)).toBe(1);

    // Room-level clapping around -40 dBFS reads responsively (> 0.6)
    expect(normalizeDbfs(-40)).toBeGreaterThan(0.6);

    // Sharp transient hand clap impulse registers significantly higher than raw RMS alone
    const clapBurst = new Float32Array(512).fill(0);
    for (let i = 0; i < 24; i++) clapBurst[i] = 0.75;
    const frame = computeFrameEnergyFromFloatSamples(clapBurst);
    expect(frame.energy).toBeGreaterThan(frame.rms * 1.5);
  });

  it("prevents a single brief spike from dominating the full 10s score", () => {
    // 149 silent frames + 1 brief 1.0 spike (~10 seconds @ 15Hz)
    const spikeOnly = [...Array(149).fill(0), 1.0];
    const sustained = Array(150).fill(0.75);

    const spikeResult = computeApplauseScore(spikeOnly);
    const sustainedResult = computeApplauseScore(sustained);

    expect(spikeResult.score).toBeLessThan(10);
    expect(sustainedResult.score).toBeGreaterThanOrEqual(75);
    expect(sustainedResult.score).toBeLessThanOrEqual(100);
  });

  it("smooths live meter with instant attack and smooth release", () => {
    expect(smoothLevel(0, 1, 0.35)).toBeCloseTo(0.35, 3);
    // Rising clap jumps immediately (attackAlpha = 0.90)
    expect(smoothLevelAsymmetric(0.1, 0.9, 0.9, 0.25)).toBeCloseTo(0.82, 2);
    // Falling level decays smoothly (releaseAlpha = 0.25)
    expect(smoothLevelAsymmetric(0.9, 0.1, 0.9, 0.25)).toBeCloseTo(0.7, 2);

    expect(remainingCountdownSeconds(5_000, 1)).toBe(5);
    expect(remainingCountdownSeconds(5_000, 4_200)).toBe(1);
    expect(remainingCountdownSeconds(5_000, 5_100)).toBe(0);
    expect(remainingApplauseSeconds(10_000, 1)).toBe(10);
    expect(remainingApplauseSeconds(15_000, 1)).toBe(15);
    expect(remainingApplauseSeconds(10_000, 9_500)).toBe(1);
    expect(remainingApplauseSeconds(10_000, 11_000)).toBe(0);
  });

  it("synchronizes 48-band spectrum and FFT frequency extraction accurately", () => {
    const silentCols = computeSpectrumColumns(0, 0, 1, 48);
    expect(silentCols).toHaveLength(48);
    expect(silentCols.every((v) => v === 0)).toBe(true);

    const activeCols = computeSpectrumColumns(0.75, 0.85, 5, 48);
    expect(activeCols).toHaveLength(48);
    const avg = activeCols.reduce((a, b) => a + b, 0) / activeCols.length;
    expect(avg).toBeGreaterThan(0.4);
    expect(activeCols.every((v) => v >= 0 && v <= 1)).toBe(true);

    const fakeFft = new Uint8Array(1024);
    fakeFft.fill(160, 4, 240);
    const bands = extractFrequencyBands(fakeFft, 48, 0.6);
    expect(bands).toHaveLength(48);
    expect(bands.every((b) => b >= 0 && b <= 1)).toBe(true);
    expect(bands.some((b) => b > 0.5)).toBe(true);
  });

  it("computes total score breakdown shares accurately", () => {
    const d1 = computeScoreDistribution(80, 4);
    expect(d1).toEqual({
      applausePoints: 80,
      likesCount: 4,
      likesPoints: 40,
      totalPoints: 120,
      applauseSharePct: 67,
      likesSharePct: 33,
    });

    const dZero = computeScoreDistribution(0, 0);
    expect(dZero.totalPoints).toBe(0);
    expect(dZero.applauseSharePct + dZero.likesSharePct).toBe(100);
  });

  it("rejects out-of-order updates while allowing countdown -> measuring transition", () => {
    const current = {
      measurementId: "m1",
      requestId: "r1",
      lastSeq: 12,
      updatedAt: 5000,
      status: "measuring" as const,
    };

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r1",
        seq: 11,
        updatedAt: 5100,
      }),
    ).toBe(false);

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r2",
        seq: 13,
        updatedAt: 5100,
      }),
    ).toBe(false);

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r1",
        seq: 13,
        updatedAt: 5100,
      }),
    ).toBe(true);

    expect(
      shouldAcceptApplauseUpdate(
        {
          measurementId: "m1",
          requestId: "r1",
          lastSeq: 0,
          updatedAt: 1000,
          status: "countdown",
        },
        {
          measurementId: "m1",
          requestId: "r1",
          status: "measuring",
          seq: 0,
          updatedAt: 6000,
        },
      ),
    ).toBe(true);

    // Standalone candidate measurements (requestId: null) are accepted when consistent
    expect(
      shouldAcceptApplauseUpdate(
        {
          measurementId: "m2",
          requestId: null,
          lastSeq: 1,
          updatedAt: 1000,
          status: "measuring",
        },
        {
          measurementId: "m2",
          requestId: null,
          seq: 2,
          updatedAt: 1100,
        },
      ),
    ).toBe(true);

    expect(
      shouldAcceptApplauseUpdate(
        {
          measurementId: "m2",
          requestId: null,
          lastSeq: 1,
          updatedAt: 1000,
          status: "measuring",
        },
        {
          measurementId: "m2",
          requestId: "r1",
          seq: 2,
          updatedAt: 1100,
        },
      ),
    ).toBe(false);
  });
});
