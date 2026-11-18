-- Enable multiple applause measurements per candidate (with or without a song_request),
-- individual inclusion control for total score calculation, and persistent guest rankings
-- across all leaderboard periods ('night', 'month', 'all').

ALTER TABLE public.applause_measurements
  ALTER COLUMN request_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS singer_user_id UUID,
  ADD COLUMN IF NOT EXISTS singer_name TEXT,
  ADD COLUMN IF NOT EXISTS included BOOLEAN NOT NULL DEFAULT true;

UPDATE public.applause_measurements m
SET singer_user_id = COALESCE(m.singer_user_id, s.user_id),
    singer_name = COALESCE(NULLIF(trim(m.singer_name), ''), s.singer_name)
FROM public.song_requests s
WHERE m.request_id = s.id
  AND (m.singer_name IS NULL OR (m.singer_user_id IS NULL AND s.user_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS applause_measurements_singer_user_idx
  ON public.applause_measurements (singer_user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS applause_measurements_singer_name_idx
  ON public.applause_measurements ((lower(trim(singer_name))), completed_at DESC);

-- Atomically save a validated 0..100 applause score for either a song request
-- or a standalone candidate measurement without overwriting prior measurements.
CREATE OR REPLACE FUNCTION public.dj_record_applause(
  p_request_id uuid,
  p_measurement_id uuid,
  p_score integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.song_requests;
  v_meas public.applause_measurements;
  v_likes bigint := 0;
  v_req_applause bigint := 0;
  v_singer_user_id uuid;
  v_singer_name text;
BEGIN
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_score');
  END IF;

  IF p_request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('applause_' || p_request_id::text));

    SELECT * INTO v_req FROM public.song_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    v_singer_user_id := v_req.user_id;
    v_singer_name := v_req.singer_name;

    UPDATE public.song_requests
    SET applause_score = p_score,
        applause_measured_at = now(),
        applause_measurement_id = p_measurement_id
    WHERE id = p_request_id
    RETURNING * INTO v_req;

    SELECT count(*)::bigint INTO v_likes
    FROM public.performance_likes
    WHERE request_id = p_request_id;
  END IF;

  SELECT * INTO v_meas FROM public.applause_measurements WHERE id = p_measurement_id FOR UPDATE;
  IF FOUND THEN
    v_singer_user_id := COALESCE(v_meas.singer_user_id, v_singer_user_id);
    v_singer_name := COALESCE(NULLIF(trim(v_meas.singer_name), ''), v_singer_name);

    UPDATE public.applause_measurements
    SET status = 'completed',
        score = p_score,
        singer_user_id = v_singer_user_id,
        singer_name = v_singer_name,
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
    WHERE id = p_measurement_id;
  ELSE
    IF p_request_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'measurement_not_found');
    END IF;
    INSERT INTO public.applause_measurements (
      id, request_id, singer_user_id, singer_name, status, started_at, ends_at,
      duration_ms, score, samples_count, included, completed_at, updated_at
    )
    VALUES (
      p_measurement_id, p_request_id, v_singer_user_id, v_singer_name, 'completed',
      now(), now(), 10000, p_score, 0, true, now(), now()
    );
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT COALESCE(SUM(score), 0)::bigint INTO v_req_applause
    FROM public.applause_measurements
    WHERE request_id = p_request_id
      AND status = 'completed'
      AND score IS NOT NULL
      AND included = true;
  ELSE
    v_req_applause := p_score;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'applause_score', p_score,
    'request_applause_total', v_req_applause,
    'likes', v_likes,
    'total_points', p_score + (v_likes * 10)
  );
END;
$$;

-- Leaderboard: aggregates ALL included applause measurements + likes + performances
-- for BOTH registered accounts and name-only guest candidates across all periods.
DROP FUNCTION IF EXISTS public.leaderboard(text);
CREATE OR REPLACE FUNCTION public.leaderboard(p_period text)
RETURNS TABLE (
  singer_id text,
  display_name text,
  card_code text,
  is_guest boolean,
  likes bigint,
  applause_points bigint,
  total_points bigint,
  performances bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH since AS (
    SELECT CASE p_period
      WHEN 'night' THEN now() - interval '12 hours'
      WHEN 'month' THEN date_trunc('month', now())
      ELSE '-infinity'::timestamptz
    END AS t
  ),
  likes_by_req AS (
    SELECT l.request_id, count(*)::bigint AS like_count
    FROM public.performance_likes l
    GROUP BY l.request_id
  ),
  meas_by_req AS (
    SELECT DISTINCT m.request_id
    FROM public.applause_measurements m
    WHERE m.request_id IS NOT NULL
      AND m.status = 'completed'
      AND m.score IS NOT NULL
  ),
  req_events AS (
    SELECT
      s.user_id,
      trim(s.singer_name) AS clean_name,
      lower(trim(s.singer_name)) AS name_key,
      coalesce(l.like_count, 0)::bigint AS likes,
      CASE
        WHEN mr.request_id IS NULL THEN coalesce(s.applause_score, 0)::bigint
        ELSE 0::bigint
      END AS legacy_applause,
      CASE WHEN s.status = 'done' THEN 1::bigint ELSE 0::bigint END AS perf_count
    FROM public.song_requests s
    LEFT JOIN likes_by_req l ON l.request_id = s.id
    LEFT JOIN meas_by_req mr ON mr.request_id = s.id
    CROSS JOIN since
    WHERE s.status IN ('playing', 'done')
      AND coalesce(s.applause_measured_at, s.updated_at, s.created_at) >= since.t
  ),
  meas_events AS (
    SELECT
      coalesce(m.singer_user_id, s.user_id) AS user_id,
      trim(coalesce(nullif(trim(m.singer_name), ''), s.singer_name, '')) AS clean_name,
      lower(trim(coalesce(nullif(trim(m.singer_name), ''), s.singer_name, ''))) AS name_key,
      0::bigint AS likes,
      m.score::bigint AS applause_points,
      0::bigint AS perf_count
    FROM public.applause_measurements m
    LEFT JOIN public.song_requests s ON s.id = m.request_id
    CROSS JOIN since
    WHERE m.status = 'completed'
      AND m.score IS NOT NULL
      AND m.included = true
      AND coalesce(m.completed_at, m.updated_at, m.started_at) >= since.t
  ),
  all_events AS (
    SELECT user_id, clean_name, name_key, likes, legacy_applause AS applause_points, perf_count FROM req_events
    UNION ALL
    SELECT user_id, clean_name, name_key, likes, applause_points, perf_count FROM meas_events
  ),
  registered_rows AS (
    SELECT
      p.id::text AS singer_id,
      p.display_name,
      p.card_code,
      false AS is_guest,
      coalesce(sum(e.likes), 0)::bigint AS likes,
      coalesce(sum(e.applause_points), 0)::bigint AS applause_points,
      (coalesce(sum(e.applause_points), 0) + coalesce(sum(e.likes), 0) * 10)::bigint AS total_points,
      coalesce(sum(e.perf_count), 0)::bigint AS performances
    FROM public.profiles p
    JOIN all_events e ON e.user_id = p.id
    GROUP BY p.id, p.display_name, p.card_code
    HAVING (coalesce(sum(e.applause_points), 0) + coalesce(sum(e.likes), 0) * 10) > 0
        OR coalesce(sum(e.perf_count), 0) > 0
  ),
  guest_rows AS (
    SELECT
      ('guest:' || e.name_key)::text AS singer_id,
      max(e.clean_name)::text AS display_name,
      ''::text AS card_code,
      true AS is_guest,
      coalesce(sum(e.likes), 0)::bigint AS likes,
      coalesce(sum(e.applause_points), 0)::bigint AS applause_points,
      (coalesce(sum(e.applause_points), 0) + coalesce(sum(e.likes), 0) * 10)::bigint AS total_points,
      coalesce(sum(e.perf_count), 0)::bigint AS performances
    FROM all_events e
    WHERE e.user_id IS NULL
      AND length(e.name_key) > 0
    GROUP BY e.name_key
    HAVING (coalesce(sum(e.applause_points), 0) + coalesce(sum(e.likes), 0) * 10) > 0
        OR coalesce(sum(e.perf_count), 0) > 0
  ),
  combined AS (
    SELECT * FROM registered_rows
    UNION ALL
    SELECT * FROM guest_rows
  )
  SELECT
    c.singer_id,
    c.display_name,
    c.card_code,
    c.is_guest,
    c.likes,
    c.applause_points,
    c.total_points,
    c.performances
  FROM combined c
  ORDER BY
    c.total_points DESC,
    c.applause_points DESC,
    c.likes DESC,
    c.performances DESC,
    c.display_name ASC,
    c.singer_id ASC
  LIMIT 50;
$$;

DROP FUNCTION IF EXISTS public.my_singer_stats(uuid);
CREATE OR REPLACE FUNCTION public.my_singer_stats(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  likes bigint,
  applause_points bigint,
  total_points bigint,
  performances bigint,
  requests bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT coalesce(p_user_id, auth.uid()) AS uid
  ),
  likes_by_req AS (
    SELECT l.request_id, count(*)::bigint AS like_count
    FROM public.performance_likes l
    GROUP BY l.request_id
  ),
  meas_by_req AS (
    SELECT DISTINCT m.request_id
    FROM public.applause_measurements m
    WHERE m.request_id IS NOT NULL
      AND m.status = 'completed'
      AND m.score IS NOT NULL
  ),
  user_reqs AS (
    SELECT
      s.id,
      s.status,
      CASE
        WHEN mr.request_id IS NULL THEN coalesce(s.applause_score, 0)::bigint
        ELSE 0::bigint
      END AS legacy_applause,
      coalesce(l.like_count, 0)::bigint AS req_likes
    FROM public.song_requests s
    CROSS JOIN target
    LEFT JOIN likes_by_req l ON l.request_id = s.id
    LEFT JOIN meas_by_req mr ON mr.request_id = s.id
    WHERE s.user_id = target.uid
  ),
  user_meas AS (
    SELECT coalesce(sum(m.score), 0)::bigint AS applause_points
    FROM public.applause_measurements m
    LEFT JOIN public.song_requests s ON s.id = m.request_id
    CROSS JOIN target
    WHERE m.status = 'completed'
      AND m.score IS NOT NULL
      AND m.included = true
      AND coalesce(m.singer_user_id, s.user_id) = target.uid
  )
  SELECT
    coalesce((SELECT sum(req_likes) FROM user_reqs), 0)::bigint AS likes,
    (coalesce((SELECT sum(legacy_applause) FROM user_reqs), 0) + (SELECT applause_points FROM user_meas))::bigint AS applause_points,
    (coalesce((SELECT sum(legacy_applause + req_likes * 10) FROM user_reqs), 0) + (SELECT applause_points FROM user_meas))::bigint AS total_points,
    coalesce((SELECT count(*) FILTER (WHERE status = 'done') FROM user_reqs), 0)::bigint AS performances,
    coalesce((SELECT count(*) FROM user_reqs), 0)::bigint AS requests;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.dj_record_applause(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.leaderboard(text) TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.my_singer_stats(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.my_singer_stats(uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.applause_measurements TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_record_applause(uuid, uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.my_singer_stats(uuid) TO service_role;
  END IF;
END $$;
