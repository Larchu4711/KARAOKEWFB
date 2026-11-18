import {
  boolean,
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const songRequests = pgTable(
  "song_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id"),
    singerName: text("singer_name").notNull(),
    songTitle: text("song_title").notNull(),
    videoId: text("video_id").notNull(),
    channelTitle: text("channel_title"),
    thumbnailUrl: text("thumbnail_url"),
    duration: text("duration"),
    status: text("status").notNull().default("waiting"),
    position: doublePrecision("position")
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)`),
    applauseScore: integer("applause_score"),
    applauseMeasuredAt: timestamp("applause_measured_at", { withTimezone: true }),
    applauseMeasurementId: uuid("applause_measurement_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("song_requests_order_idx").on(t.status, t.position, t.createdAt),
    index("song_requests_user_idx").on(t.userId),
    check(
      "song_requests_applause_score_range",
      sql`${t.applauseScore} IS NULL OR (${t.applauseScore} >= 0 AND ${t.applauseScore} <= 100)`,
    ),
  ],
);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull().default("Cantante"),
    cardCode: text("card_code")
      .notNull()
      .unique()
      .default(sql`('PM-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)))`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("display_name_len", sql`length(trim(${t.displayName})) BETWEEN 1 AND 40`),
  ],
);

export const localAccounts = pgTable("local_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const performanceLikes = pgTable(
  "performance_likes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => songRequests.id, { onDelete: "cascade" }),
    likerId: uuid("liker_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("performance_likes_request_liker_unique").on(t.requestId, t.likerId)],
);

export const favoriteSongs = pgTable(
  "favorite_songs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    videoId: text("video_id").notNull(),
    songTitle: text("song_title").notNull(),
    channelTitle: text("channel_title"),
    thumbnailUrl: text("thumbnail_url"),
    duration: text("duration"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("favorite_songs_user_video_unique").on(t.userId, t.videoId)],
);

export const djSessions = pgTable("dj_sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stageControl = pgTable(
  "stage_control",
  {
    id: boolean("id").primaryKey().default(true),
    paused: boolean("paused").notNull().default(false),
    volume: integer("volume").notNull().default(100),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    restartRevision: bigint("restart_revision", { mode: "number" }).notNull().default(0),
    external: boolean("external").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("stage_control_singleton", sql`${t.id} = true`),
    check("stage_control_volume_range", sql`${t.volume} BETWEEN 0 AND 100`),
  ],
);

export const applauseMeasurements = pgTable(
  "applause_measurements",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").references(() => songRequests.id, { onDelete: "cascade" }),
    singerUserId: uuid("singer_user_id"),
    singerName: text("singer_name"),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    countdownEndsAt: timestamp("countdown_ends_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull().default(10000),
    latestLevel: doublePrecision("latest_level").notNull().default(0),
    latestPeak: doublePrecision("latest_peak").notNull().default(0),
    lastSeq: integer("last_seq").notNull().default(0),
    score: integer("score"),
    samplesCount: integer("samples_count").notNull().default(0),
    included: boolean("included").notNull().default(true),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("applause_measurements_request_idx").on(t.requestId, t.startedAt),
    index("applause_measurements_singer_user_idx").on(t.singerUserId, t.completedAt),
    check(
      "applause_measurements_score_range",
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`,
    ),
  ],
);
