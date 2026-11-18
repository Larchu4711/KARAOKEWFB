import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { DbClient } from "./db.ts";
import {
  checkDjPassword,
  clearSingerCookie,
  endDjSession,
  getSingerUserId,
  isDjConfigured,
  setSingerCookie,
  startDjSession,
  verifyDjRequest,
} from "./auth.ts";
import {
  broadcastPublicEvent,
  broadcastStageEvent,
  registerSseClient,
  sendSseEvent,
} from "./events.ts";
import {
  beginApplauseMeasurement,
  broadcastNightLeaderboard,
  cancelApplauseMeasurement,
  completeApplauseMeasurement,
  deleteApplauseMeasurement,
  evaluateRoundAndLeaderboard,
  fetchNightLeaderboard,
  getCurrentApplauseState,
  listApplauseMeasurements,
  pushApplauseLevel,
  refreshActiveApplauseLikes,
  setApplauseMeasurementIncluded,
  startApplauseMeasurement,
} from "./applause-service.ts";
import {
  announceTtsServer,
  searchYouTubeServer,
  suggestSongsServer,
} from "./integrations.ts";
import { playOrder } from "../src/lib/queue.ts";
import { summedPerformancePoints } from "../src/lib/singer.ts";
import { defaultStageControl } from "../src/lib/stage-control.ts";

const uuidSchema = z.string().uuid();

export function createApiRouter(db: DbClient) {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  const requireDj = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ok = await verifyDjRequest(db, req);
      if (!ok) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  router.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      dbKind: db.kind,
      djConfigured: isDjConfigured(),
      youtubeConfigured: Boolean(process.env["YOUTUBE_API_KEY"]?.trim()),
      aiConfigured: Boolean(process.env["GEMINI_API_KEY"]?.trim()),
      ttsConfigured: Boolean(process.env["ELEVENLABS_API_KEY"]?.trim() && process.env["ELEVENLABS_VOICE_ID"]?.trim()),
    });
  });

  // --- Queue & Public Likes (never expose raw voter IDs) ---
  router.get("/queue", async (_req, res, next) => {
    try {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const result = await db.query(
        `WITH likes_by_req AS (
           SELECT request_id, count(*)::int AS likes_count
           FROM public.performance_likes
           GROUP BY request_id
         ),
         meas_by_req AS (
           SELECT request_id,
             coalesce(sum(score) FILTER (WHERE included = true), 0)::int AS applause_total,
             count(*) FILTER (WHERE included = true)::int AS applause_count,
             count(*)::int AS all_meas_count
           FROM public.applause_measurements
           WHERE request_id IS NOT NULL AND status = 'completed' AND score IS NOT NULL
           GROUP BY request_id
         )
         SELECT s.*,
           coalesce(l.likes_count, 0)::int AS likes_count,
           CASE
             WHEN coalesce(m.all_meas_count, 0) > 0 THEN m.applause_total
             ELSE s.applause_score
           END AS applause_total,
           coalesce(m.applause_count, CASE WHEN s.applause_score IS NOT NULL THEN 1 ELSE 0 END)::int AS applause_count
         FROM public.song_requests s
         LEFT JOIN likes_by_req l ON l.request_id = s.id
         LEFT JOIN meas_by_req m ON m.request_id = s.id
         WHERE s.created_at >= $1
         ORDER BY s.created_at ASC
         LIMIT 500`,
        [since],
      );
      res.json({ rows: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.get("/requests/:id", async (req, res, next) => {
    try {
      const idCheck = uuidSchema.safeParse(req.params["id"]);
      if (!idCheck.success) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      const result = await db.query(
        `SELECT s.*,
           (SELECT count(*)::int FROM public.performance_likes l WHERE l.request_id = s.id) AS likes_count
         FROM public.song_requests s
         WHERE s.id = $1
         LIMIT 1`,
        [idCheck.data],
      );
      res.json({ row: result.rows[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  router.post("/requests", async (req, res, next) => {
    try {
      const body = z
        .object({
          singer_name: z.string().trim().min(1).max(60),
          song_title: z.string().trim().min(1).max(200),
          video_id: z.string().trim().min(1).max(40),
          channel_title: z.string().max(200).nullable().optional(),
          thumbnail_url: z.string().max(500).nullable().optional(),
          duration: z.string().max(20).nullable().optional(),
        })
        .parse(req.body);

      const userId = getSingerUserId(req);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO public.song_requests
           (user_id, singer_name, song_title, video_id, channel_title, thumbnail_url, duration, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting')
         RETURNING *`,
        [
          userId,
          body.singer_name,
          body.song_title,
          body.video_id,
          body.channel_title ?? null,
          body.thumbnail_url ?? null,
          body.duration ?? null,
        ],
      );
      const row = inserted.rows[0];
      broadcastPublicEvent("queue_changed", { reason: "inserted", id: row?.id });
      broadcastStageEvent("queue_changed", { reason: "inserted", id: row?.id });
      res.status(201).json({ id: row?.id, row });
    } catch (err) {
      next(err);
    }
  });

  router.get("/likes/counts", async (req, res, next) => {
    try {
      const raw = String(req.query["ids"] ?? "");
      const ids = raw
        .split(",")
        .map((x) => x.trim())
        .filter((x) => uuidSchema.safeParse(x).success)
        .slice(0, 100);
      if (ids.length === 0) {
        res.json({ counts: [] });
        return;
      }
      const result = await db.query<{ request_id: string; likes: string }>(
        `SELECT request_id, count(*)::int AS likes
         FROM public.performance_likes
         WHERE request_id = ANY($1::uuid[])
         GROUP BY request_id`,
        [ids],
      );
      res.json({
        counts: result.rows.map((r) => ({ request_id: r.request_id, likes: Number(r.likes) })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/likes/mine", async (req, res, next) => {
    try {
      const requestId = uuidSchema.safeParse(req.query["requestId"]);
      if (!requestId.success) {
        res.json({ liked: false });
        return;
      }
      const userId = getSingerUserId(req);
      if (!userId) {
        res.json({ liked: false });
        return;
      }
      const result = await db.query(
        `SELECT id FROM public.performance_likes WHERE request_id = $1 AND liker_id = $2 LIMIT 1`,
        [requestId.data, userId],
      );
      res.json({ liked: result.rows.length > 0 });
    } catch (err) {
      next(err);
    }
  });

  router.post("/likes/guest", async (req, res, next) => {
    try {
      const body = z
        .object({
          requestId: z.string().uuid(),
          deviceId: z.string().regex(/^[0-9a-fA-F-]{32,36}$/),
        })
        .parse(req.body);

      const userId = getSingerUserId(req);
      const likerId =
        userId ??
        (() => {
          const hash = crypto
            .createHash("md5")
            .update(`pm-device:${body.deviceId.toLowerCase()}`)
            .digest("hex");
          return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        })();

      const reqRow = await db.query<{ user_id: string | null; ok: boolean }>(
        `SELECT user_id, (status IN ('playing', 'done') AND updated_at > now() - interval '12 hours') AS ok
         FROM public.song_requests
         WHERE id = $1`,
        [body.requestId],
      );
      const target = reqRow.rows[0];
      if (!target || !target.ok) {
        res.json({ ok: false, reason: "gone" });
        return;
      }
      if (target.user_id && target.user_id === likerId) {
        res.json({ ok: false, reason: "own" });
        return;
      }

      const inserted = await db.query(
        `INSERT INTO public.performance_likes (request_id, liker_id)
         VALUES ($1, $2)
         ON CONFLICT (request_id, liker_id) DO NOTHING
         RETURNING id`,
        [body.requestId, likerId],
      );
      const already = inserted.rows.length === 0;

      const countRes = await db.query<{ likes: string }>(
        `SELECT count(*)::int AS likes FROM public.performance_likes WHERE request_id = $1`,
        [body.requestId],
      );
      const likes = Number(countRes.rows[0]?.likes ?? 0);

      if (!already) {
        broadcastPublicEvent("like_changed", { requestId: body.requestId, likes });
        broadcastStageEvent("like_changed", { requestId: body.requestId, likes });
        void refreshActiveApplauseLikes(body.requestId, likes);
        void broadcastNightLeaderboard(db, "like_changed", body.requestId);
      }
      res.json({ ok: true, already, likes });
    } catch (err) {
      next(err);
    }
  });

  router.post("/likes/toggle", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const body = z.object({ requestId: z.string().uuid() }).parse(req.body);

      const reqRow = await db.query<{ user_id: string | null; ok: boolean }>(
        `SELECT user_id, (status IN ('playing', 'done') AND updated_at > now() - interval '12 hours') AS ok
         FROM public.song_requests WHERE id = $1`,
        [body.requestId],
      );
      const target = reqRow.rows[0];
      if (!target || !target.ok) {
        res.json({ ok: false, reason: "gone" });
        return;
      }
      if (target.user_id && target.user_id === userId) {
        res.json({ ok: false, reason: "own" });
        return;
      }

      const existing = await db.query(
        `SELECT id FROM public.performance_likes WHERE request_id = $1 AND liker_id = $2`,
        [body.requestId, userId],
      );

      let liked = false;
      if (existing.rows.length > 0) {
        await db.query(
          `DELETE FROM public.performance_likes WHERE request_id = $1 AND liker_id = $2`,
          [body.requestId, userId],
        );
        liked = false;
      } else {
        await db.query(
          `INSERT INTO public.performance_likes (request_id, liker_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [body.requestId, userId],
        );
        liked = true;
      }

      const countRes = await db.query<{ likes: string }>(
        `SELECT count(*)::int AS likes FROM public.performance_likes WHERE request_id = $1`,
        [body.requestId],
      );
      const likes = Number(countRes.rows[0]?.likes ?? 0);

      broadcastPublicEvent("like_changed", { requestId: body.requestId, likes });
      broadcastStageEvent("like_changed", { requestId: body.requestId, likes });
      void refreshActiveApplauseLikes(body.requestId, likes);
      void broadcastNightLeaderboard(db, "like_changed", body.requestId);
      res.json({ ok: true, liked, likes });
    } catch (err) {
      next(err);
    }
  });

  // --- Leaderboard ---
  router.get("/leaderboard", async (req, res, next) => {
    try {
      const period = z
        .enum(["night", "month", "all"])
        .catch("night")
        .parse(req.query["period"]);
      const result = await db.query<{
        singer_id: string;
        display_name: string;
        card_code: string;
        is_guest: boolean;
        likes: string | number;
        applause_points: string | number;
        total_points: string | number;
        performances: string | number;
      }>(`SELECT * FROM public.leaderboard($1)`, [period]);

      res.json({
        rows: result.rows.map((r) => ({
          singer_id: String(r.singer_id),
          display_name: r.display_name,
          card_code: r.card_code ?? "",
          is_guest: Boolean(r.is_guest),
          likes: Number(r.likes),
          applause_points: Number(r.applause_points),
          total_points: Number(r.total_points),
          performances: Number(r.performances),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Local Singer Auth & Account ---
  router.get("/auth/session", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.json({ user: null });
        return;
      }
      const pRes = await db.query<{ id: string; display_name: string; card_code: string }>(
        `SELECT id, display_name, card_code FROM public.profiles WHERE id = $1 LIMIT 1`,
        [userId],
      );
      const profile = pRes.rows[0];
      if (!profile) {
        res.json({ user: null });
        return;
      }
      res.json({
        user: {
          id: profile.id,
          display_name: profile.display_name,
          card_code: profile.card_code,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/local-login", async (req, res, next) => {
    try {
      const body = z
        .object({
          email: z.string().trim().email().max(120),
          displayName: z.string().trim().min(1).max(40).optional(),
        })
        .parse(req.body);

      const email = body.email.toLowerCase();
      const existing = await db.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM public.local_accounts WHERE email = $1 LIMIT 1`,
        [email],
      );

      let userId: string;
      const defaultName = (body.displayName ?? email.split("@")[0] ?? "Cantante").slice(0, 40);

      if (existing.rows[0]) {
        userId = existing.rows[0].id;
        if (body.displayName) {
          await db.query(`UPDATE public.profiles SET display_name = $2 WHERE id = $1`, [
            userId,
            defaultName,
          ]);
        }
      } else {
        userId = crypto.randomUUID();
        await db.query(
          `INSERT INTO public.local_accounts (id, email, display_name) VALUES ($1, $2, $3)`,
          [userId, email, defaultName],
        );
        await db.query(
          `INSERT INTO public.profiles (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [userId, defaultName],
        );
      }

      const profileRes = await db.query<{ id: string; display_name: string; card_code: string }>(
        `SELECT id, display_name, card_code FROM public.profiles WHERE id = $1`,
        [userId],
      );
      const profile = profileRes.rows[0];
      const token = setSingerCookie(req, res, userId);
      res.json({ ok: true, user: profile, token });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/logout", (req, res) => {
    clearSingerCookie(res, req);
    res.json({ ok: true });
  });

  router.get("/account", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const [profileRes, statsRes, favRes, histRes] = await Promise.all([
        db.query<{ display_name: string; card_code: string }>(
          `SELECT display_name, card_code FROM public.profiles WHERE id = $1 LIMIT 1`,
          [userId],
        ),
        db.query<{
          likes: string;
          applause_points: string;
          total_points: string;
          performances: string;
          requests: string;
        }>(`SELECT * FROM public.my_singer_stats($1)`, [userId]),
        db.query(
          `SELECT id, video_id, song_title, thumbnail_url, duration
           FROM public.favorite_songs WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        ),
        db.query<{
          id: string;
          song_title: string;
          status: string;
          applause_score: number | null;
          applause_total: number | null;
          applause_count: string | number;
          likes_count: string | number;
          created_at: string;
        }>(
          `SELECT s.id, s.song_title, s.status, s.applause_score, s.created_at,
             (SELECT count(*)::int FROM public.performance_likes l WHERE l.request_id = s.id) AS likes_count,
             coalesce(
               (SELECT sum(m.score)::int FROM public.applause_measurements m WHERE m.request_id = s.id AND m.status = 'completed' AND m.score IS NOT NULL AND m.included = true),
               CASE WHEN NOT EXISTS (SELECT 1 FROM public.applause_measurements m WHERE m.request_id = s.id AND m.status = 'completed' AND m.score IS NOT NULL)
                 THEN s.applause_score ELSE NULL END
             ) AS applause_total,
             (SELECT count(*)::int FROM public.applause_measurements m WHERE m.request_id = s.id AND m.status = 'completed' AND m.score IS NOT NULL AND m.included = true) AS applause_count
           FROM public.song_requests s
           WHERE s.user_id = $1
           ORDER BY s.created_at DESC
           LIMIT 20`,
          [userId],
        ),
      ]);

      const statsRow = statsRes.rows[0];
      res.json({
        profile: profileRes.rows[0] ?? null,
        stats: {
          likes: Number(statsRow?.likes ?? 0),
          applause_points: Number(statsRow?.applause_points ?? 0),
          total_points: Number(statsRow?.total_points ?? 0),
          performances: Number(statsRow?.performances ?? 0),
          requests: Number(statsRow?.requests ?? 0),
        },
        favorites: favRes.rows,
        history: histRes.rows.map((h) => {
          const likes = Number(h.likes_count ?? 0);
          const applauseVal = h.applause_total ?? h.applause_score;
          return {
            ...h,
            applause_count: Number(h.applause_count ?? 0),
            likes_count: likes,
            total_points: summedPerformancePoints(applauseVal, likes),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/account/profile", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const body = z.object({ display_name: z.string().trim().min(1).max(40) }).parse(req.body);
      await db.query(`UPDATE public.profiles SET display_name = $2 WHERE id = $1`, [
        userId,
        body.display_name,
      ]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/favorites", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const body = z
        .object({
          video_id: z.string().min(1).max(40),
          song_title: z.string().min(1).max(200),
          channel_title: z.string().max(200).nullable().optional(),
          thumbnail_url: z.string().max(500).nullable().optional(),
          duration: z.string().max(20).nullable().optional(),
        })
        .parse(req.body);

      await db.query(
        `INSERT INTO public.favorite_songs (user_id, video_id, song_title, channel_title, thumbnail_url, duration)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, video_id) DO NOTHING`,
        [
          userId,
          body.video_id,
          body.song_title,
          body.channel_title ?? null,
          body.thumbnail_url ?? null,
          body.duration ?? null,
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/favorites/:id", async (req, res, next) => {
    try {
      const userId = getSingerUserId(req);
      if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const id = uuidSchema.parse(req.params["id"]);
      await db.query(`DELETE FROM public.favorite_songs WHERE id = $1 AND user_id = $2`, [
        id,
        userId,
      ]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- DJ Auth ---
  router.get("/dj/status", async (req, res, next) => {
    try {
      res.json({
        ok: await verifyDjRequest(db, req),
        configured: isDjConfigured(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/login", async (req, res, next) => {
    try {
      const body = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
      const check = checkDjPassword(body.password);
      if (!check.ok) {
        res.status(check.reason === "config" ? 503 : 200).json({ ok: false, reason: check.reason });
        return;
      }
      const token = await startDjSession(db, req, res);
      res.json({ ok: true, token });
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/logout", async (req, res, next) => {
    try {
      await endDjSession(db, req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Protected DJ Queue & Stage Control ---
  router.post("/dj/requests/status", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          id: z.string().uuid(),
          status: z.enum(["waiting", "next", "playing", "done", "skipped"]),
        })
        .parse(req.body);
      const prevRows = body.status === "done" ? await fetchNightLeaderboard(db) : [];
      const result = await db.query<{ dj_set_status: { ok: boolean; reason?: string; advanced?: string } }>(
        `SELECT public.dj_set_status($1, $2) AS dj_set_status`,
        [body.id, body.status],
      );
      const payload = result.rows[0]?.dj_set_status ?? { ok: false };
      broadcastPublicEvent("queue_changed", { reason: "status", id: body.id });
      broadcastStageEvent("queue_changed", { reason: "status", id: body.id });
      let evaluation = null;
      if (payload.ok && body.status === "done") {
        const evalRes = await evaluateRoundAndLeaderboard(db, body.id, prevRows, "round_done");
        evaluation = evalRes.evaluation;
      } else if (payload.ok && body.status === "playing") {
        await broadcastNightLeaderboard(db, "round_started", body.id);
      }
      res.json({ ...payload, evaluation });
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/requests/reorder", requireDj, async (req, res, next) => {
    try {
      const body = z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(req.body);
      const result = await db.query<{ dj_reorder: { ok: boolean; reason?: string } }>(
        `SELECT public.dj_reorder($1::uuid[]) AS dj_reorder`,
        [body.ids],
      );
      const payload = result.rows[0]?.dj_reorder ?? { ok: false };
      broadcastPublicEvent("queue_changed", { reason: "reorder" });
      broadcastStageEvent("queue_changed", { reason: "reorder" });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/dj/requests/:id", requireDj, async (req, res, next) => {
    try {
      const id = uuidSchema.parse(req.params["id"]);
      await db.query(`DELETE FROM public.song_requests WHERE id = $1`, [id]);
      broadcastPublicEvent("queue_changed", { reason: "deleted", id });
      broadcastStageEvent("queue_changed", { reason: "deleted", id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/requests/complete-current", requireDj, async (req, res, next) => {
    try {
      const body = z.object({ id: z.string().uuid() }).parse(req.body);
      const prevRows = await fetchNightLeaderboard(db);
      const result = await db.query<{ dj_complete_current: { ok: boolean; reason?: string; advanced?: string } }>(
        `SELECT public.dj_complete_current($1) AS dj_complete_current`,
        [body.id],
      );
      const payload = result.rows[0]?.dj_complete_current ?? { ok: false };
      let evaluation = null;
      if (payload.ok) {
        broadcastPublicEvent("queue_changed", { reason: "completed", id: body.id });
        broadcastStageEvent("queue_changed", { reason: "completed", id: body.id });
        const evalRes = await evaluateRoundAndLeaderboard(db, body.id, prevRows, "round_completed");
        evaluation = evalRes.evaluation;
      }
      res.json({ ...payload, evaluation });
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/requests/add", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          singer: z.string().trim().min(1).max(60),
          title: z.string().min(1).max(200),
          videoId: z.string().regex(/^[\w-]{6,20}$/),
          channel: z.string().max(200).nullable(),
          thumbnail: z.string().max(500).nullable(),
          duration: z.string().max(20).nullable(),
          index: z.number().int().min(0).max(500).nullable(),
        })
        .parse(req.body);

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO public.song_requests
           (singer_name, song_title, video_id, channel_title, thumbnail_url, duration, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'waiting')
         RETURNING id`,
        [body.singer, body.title, body.videoId, body.channel, body.thumbnail, body.duration],
      );
      const rowId = inserted.rows[0]?.id;

      if (body.index !== null && rowId) {
        const activeRows = await db.query<{
          id: string;
          status: string;
          position: number;
          created_at: string;
        }>(
          `SELECT id, status, position, created_at FROM public.song_requests
           WHERE status IN ('playing', 'next', 'waiting')`,
        );
        const ids = playOrder(activeRows.rows)
          .map((r) => r.id)
          .filter((id) => id !== rowId);
        ids.splice(Math.min(body.index, ids.length), 0, rowId);
        await db.query(`SELECT public.dj_reorder($1::uuid[])`, [ids]);
      }

      broadcastPublicEvent("queue_changed", { reason: "dj_added", id: rowId });
      broadcastStageEvent("queue_changed", { reason: "dj_added", id: rowId });
      res.json({ ok: true, id: rowId });
    } catch (err) {
      next(err);
    }
  });

  router.get("/dj/stage", requireDj, async (_req, res, next) => {
    try {
      const result = await db.query(
        `SELECT paused, volume, revision, restart_revision, external, lang FROM public.stage_control WHERE id = true LIMIT 1`,
      );
      res.json(result.rows[0] ?? defaultStageControl);
    } catch (err) {
      next(err);
    }
  });

  router.post("/dj/stage/command", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          command: z.enum(["play", "pause", "restart", "volume", "external", "local", "lang"]),
          volume: z.number().int().min(0).max(100).default(100),
          lang: z.enum(["es", "de", "en"]).optional(),
        })
        .parse(req.body);
      const result = await db.query<{ dj_stage_command: Record<string, unknown> }>(
        `SELECT public.dj_stage_command($1, $2, $3) AS dj_stage_command`,
        [body.command, body.volume, body.lang ?? null],
      );
      const nextState = result.rows[0]?.dj_stage_command ?? defaultStageControl;
      broadcastStageEvent("stage_control", nextState);
      res.json(nextState);
    } catch (err) {
      next(err);
    }
  });

  // --- Protected 10-Second Applausometer Endpoints ---
  router.get("/applause/state", requireDj, async (_req, res, next) => {
    try {
      const state = await getCurrentApplauseState(db);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.get("/applause/measurements", requireDj, async (_req, res, next) => {
    try {
      const rows = await listApplauseMeasurements(db, 80);
      res.json({ rows });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/applause/measurements/:id", requireDj, async (req, res, next) => {
    try {
      const id = uuidSchema.parse(req.params["id"]);
      const body = z.object({ included: z.boolean() }).parse(req.body);
      const result = await setApplauseMeasurementIncluded(db, id, body.included);
      if (!result.ok) {
        res.status(404).json({ ok: false, reason: "not_found" });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/applause/measurements/:id", requireDj, async (req, res, next) => {
    try {
      const id = uuidSchema.parse(req.params["id"]);
      const result = await deleteApplauseMeasurement(db, id);
      if (!result.ok) {
        res.status(404).json({ ok: false, reason: "not_found" });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/applause/start", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          requestId: z.string().uuid().nullable().optional(),
          singerName: z.string().trim().min(1).max(60).optional(),
          singerUserId: z.string().uuid().nullable().optional(),
          measurementId: z.string().uuid(),
          durationMs: z.number().int().min(1000).max(30000).optional(),
          countdownMs: z.number().int().min(0).max(15000).optional(),
        })
        .refine((b) => Boolean(b.requestId || b.singerName), {
          message: "Either requestId or singerName is required",
        })
        .parse(req.body);
      const result = await startApplauseMeasurement(db, body);
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/applause/begin", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          measurementId: z.string().uuid(),
          requestId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      const result = await beginApplauseMeasurement(db, body);
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/applause/level", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          measurementId: z.string().uuid(),
          requestId: z.string().uuid().nullable().optional(),
          seq: z.number().int().min(1),
          level: z.number().min(0).max(1),
          peak: z.number().min(0).max(1),
          bands: z.array(z.number().min(0).max(1)).max(64).optional(),
        })
        .parse(req.body);
      const result = await pushApplauseLevel(db, body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/applause/complete", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          measurementId: z.string().uuid(),
          requestId: z.string().uuid().nullable().optional(),
          samples: z.array(z.number().min(0).max(1)).min(1).max(2000),
        })
        .parse(req.body);
      const result = await completeApplauseMeasurement(db, body);
      if (!result.ok) {
        res.status(result.status).json({ ok: false, reason: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/applause/cancel", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          measurementId: z.string().uuid(),
          requestId: z.string().uuid().nullable().optional(),
          reason: z.enum(["cancelled", "failed"]).optional(),
        })
        .parse(req.body);
      const result = await cancelApplauseMeasurement(db, body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- Server-Side External Integrations ---
  router.post("/youtube/search", async (req, res, next) => {
    try {
      const body = z.object({ q: z.string().trim().min(1).max(150) }).parse(req.body);
      const result = await searchYouTubeServer(body.q);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/ai/suggest", async (req, res, next) => {
    try {
      const body = z.object({ text: z.string().trim().min(2).max(500) }).parse(req.body);
      const result = await suggestSongsServer(body.text);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/tts/announce", requireDj, async (req, res, next) => {
    try {
      const body = z
        .object({
          text: z.string().trim().min(1).max(400),
          lang: z.enum(["es", "de", "en"]).optional(),
        })
        .parse(req.body);
      const result = await announceTtsServer(body.text, body.lang);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- SSE Streams ---
  router.get("/stream/queue", (req, res) => {
    const unregister = registerSseClient(res, false);
    sendSseEvent(res, "ready", { ok: true });
    req.on("close", unregister);
  });

  router.get("/stream/stage", requireDj, async (req, res, next) => {
    try {
      const unregister = registerSseClient(res, true);
      const [stageRes, applauseState] = await Promise.all([
        db.query(
          `SELECT paused, volume, revision, restart_revision, external, lang FROM public.stage_control WHERE id = true LIMIT 1`,
        ),
        getCurrentApplauseState(db),
      ]);
      sendSseEvent(res, "stage_control", stageRes.rows[0] ?? defaultStageControl);
      sendSseEvent(res, "applause_state", applauseState);
      req.on("close", unregister);
    } catch (err) {
      next(err);
    }
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "validation", issues: err.issues });
      return;
    }
    console.error("[api] error:", err);
    res.status(500).json({ error: "internal" });
  });

  return router;
}

export function createExpressApp(db: DbClient) {
  const app = express();
  app.set("trust proxy", true);
  app.use("/api", createApiRouter(db));
  return app;
}
