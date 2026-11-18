import { describe, expect, it } from "vitest";
import {
  canLikePerformance,
  computeRankDeltas,
  getSingerKey,
  performancePoints,
  sortLeaderboard,
  summedPerformancePoints,
  type LeaderboardEntry,
} from "./singer";

describe("scoring and leaderboard helpers", () => {
  it("computes binding formula examples: Gesamtpunkte = Applaus-Score + (Likes * 10)", () => {
    expect(performancePoints(0, 0)).toBe(0);
    expect(performancePoints(70, 3)).toBe(100);
    expect(performancePoints(100, 20)).toBe(300);
    // Missing applause score counts mathematically as 0
    expect(performancePoints(null, 3)).toBe(30);
    expect(performancePoints(undefined, 0)).toBe(0);
  });

  it("clamps single-round applause score cleanly to 0..100 and sums multi-measurement totals without 100 cap", () => {
    expect(performancePoints(-15, 2)).toBe(20);
    expect(performancePoints(150, 2)).toBe(120);
    expect(summedPerformancePoints(180, 3)).toBe(210);
    expect(summedPerformancePoints(null, 2)).toBe(20);
    expect(summedPerformancePoints(-10, 1)).toBe(10);
  });

  it("applies deterministic tie-breakers cleanly including guest entries", () => {
    const a: LeaderboardEntry = {
      singer_id: "2",
      display_name: "Bea",
      card_code: "WF-002",
      is_guest: false,
      likes: 5,
      applause_points: 50,
      total_points: 100,
      performances: 1,
    };
    const b: LeaderboardEntry = {
      singer_id: "guest:alex",
      display_name: "Alex",
      card_code: "",
      is_guest: true,
      likes: 3,
      applause_points: 70,
      total_points: 100,
      performances: 1,
    };
    // Both have 100 total_points; higher applause_points wins tie
    expect(sortLeaderboard([a, b]).map((r) => r.singer_id)).toEqual(["guest:alex", "2"]);
  });

  it("builds stable singer keys for registered and unregistered guest singers", () => {
    expect(getSingerKey({ user_id: "u-123", singer_name: "Mia" })).toBe("u-123");
    expect(getSingerKey({ user_id: null, singer_name: "  Lukas  " })).toBe("guest:lukas");
  });

  it("computes rank deltas and new entries after round evaluation", () => {
    const prev: LeaderboardEntry[] = [
      {
        singer_id: "u1",
        display_name: "Ana",
        card_code: "WF-001",
        likes: 2,
        applause_points: 60,
        total_points: 80,
        performances: 1,
      },
      {
        singer_id: "guest:tom",
        display_name: "Tom",
        card_code: "",
        is_guest: true,
        likes: 1,
        applause_points: 40,
        total_points: 50,
        performances: 1,
      },
    ];
    const next: LeaderboardEntry[] = [
      {
        singer_id: "guest:tom",
        display_name: "Tom",
        card_code: "",
        is_guest: true,
        likes: 3,
        applause_points: 90,
        total_points: 120,
        performances: 2,
      },
      {
        singer_id: "u1",
        display_name: "Ana",
        card_code: "WF-001",
        likes: 2,
        applause_points: 60,
        total_points: 80,
        performances: 1,
      },
      {
        singer_id: "guest:sara",
        display_name: "Sara",
        card_code: "",
        is_guest: true,
        likes: 0,
        applause_points: 75,
        total_points: 75,
        performances: 1,
      },
    ];

    const deltas = computeRankDeltas(prev, next);
    expect(deltas["guest:tom"]).toEqual({
      rank: 1,
      previousRank: 2,
      rankDelta: 1,
      pointsDelta: 70,
      isNew: false,
    });
    expect(deltas["u1"]).toEqual({
      rank: 2,
      previousRank: 1,
      rankDelta: -1,
      pointsDelta: 0,
      isNew: false,
    });
    expect(deltas["guest:sara"]).toEqual({
      rank: 3,
      previousRank: null,
      rankDelta: 0,
      pointsDelta: 75,
      isNew: true,
    });
  });

  it("checks like eligibility", () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 13 * 3600 * 1000).toISOString();
    expect(canLikePerformance("u1", "u2", "playing", recent, now)).toBe(true);
    expect(canLikePerformance("u1", "u1", "playing", recent, now)).toBe(false);
    expect(canLikePerformance("u1", "u2", "waiting", recent, now)).toBe(false);
    expect(canLikePerformance("u1", "u2", "done", old, now)).toBe(false);
  });
});
