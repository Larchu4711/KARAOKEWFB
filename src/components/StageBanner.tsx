import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { toast } from "sonner";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useAuthUser } from "@/hooks/use-auth-user";
import { summedPerformancePoints } from "@/lib/singer";
import type { SongRequest } from "@/lib/queue";
import { getDeviceId } from "@/lib/device";

export function StageBanner({ current }: { current: SongRequest | undefined }) {
  const { t } = useI18n();
  const { user } = useAuthUser();
  const [count, setCount] = useState(0);
  const [liked, setLiked] = useState(false);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    const refresh = async () => {
      try {
        const data = await apiJson<{ counts: Array<{ request_id: string; likes: number }> }>(
          `/api/likes/counts?ids=${encodeURIComponent(current.id)}`,
        );
        if (alive) {
          setCount(Number(data.counts?.[0]?.likes ?? current.likes_count ?? 0));
        }
      } catch {
        /* ignore */
      }
    };
    void refresh();
    const iv = setInterval(() => void refresh(), 5000);

    if (!user) {
      setLiked(localStorage.getItem(`pm-liked-${current.id}`) === "1");
    } else {
      apiJson<{ liked: boolean }>(`/api/likes/mine?requestId=${encodeURIComponent(current.id)}`)
        .then((r) => {
          if (alive) setLiked(Boolean(r.liked));
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [current?.id, current?.likes_count, user?.id]);

  if (!current) return null;
  const own = !!user && current.user_id === user.id;
  const applauseDisplay = current.applause_total ?? current.applause_score;
  const applauseCount = current.applause_count ?? (typeof current.applause_score === "number" ? 1 : 0);
  const hasApplause = typeof applauseDisplay === "number" && applauseCount > 0;
  const totalPoints = summedPerformancePoints(applauseDisplay, count);

  const toggle = async (): Promise<void> => {
    if (!user) {
      if (liked) {
        toast(t.likeAlready);
        return;
      }
      try {
        const r = await apiJson<{ ok: boolean; reason?: string; already?: boolean; likes?: number }>(
          "/api/likes/guest",
          {
            method: "POST",
            body: JSON.stringify({ requestId: current.id, deviceId: getDeviceId() }),
          },
        );
        if (r.ok && !r.already) {
          setLiked(true);
          setCount((c) => r.likes ?? c + 1);
          toast.success(t.likeThanks);
          localStorage.setItem(`pm-liked-${current.id}`, "1");
        } else if (r.reason === "own") {
          toast.error(t.likeOwn);
        } else if (r.reason === "gone") {
          toast.error(t.likeGone);
        } else if (r.ok && r.already) {
          setLiked(true);
          if (typeof r.likes === "number") setCount(r.likes);
          localStorage.setItem(`pm-liked-${current.id}`, "1");
          toast(t.likeAlready);
        } else {
          toast.error(t.errGeneric);
        }
      } catch {
        toast.error(t.errGeneric);
      }
      return;
    }

    try {
      const r = await apiJson<{ ok: boolean; reason?: string; liked?: boolean; likes?: number }>(
        "/api/likes/toggle",
        {
          method: "POST",
          body: JSON.stringify({ requestId: current.id }),
        },
      );
      if (!r.ok) {
        toast.error(r.reason === "own" ? t.likeOwn : r.reason === "gone" ? t.likeGone : t.errGeneric);
        return;
      }
      setLiked(Boolean(r.liked));
      if (typeof r.likes === "number") setCount(r.likes);
    } catch {
      toast.error(t.errGeneric);
    }
  };

  return (
    <div className="animate-neon-pulse glass flex items-center gap-4 rounded-2xl p-4">
      {current.thumbnail_url && (
        <img
          src={current.thumbnail_url}
          alt=""
          referrerPolicy="no-referrer"
          className="size-14 rounded-lg object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold uppercase tracking-widest text-accent">
          ● {t.onStage}
        </div>
        <div className="truncate font-display text-lg">{current.singer_name}</div>
        <div className="truncate text-sm text-muted-foreground">{current.song_title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t.applauseScoreLabel}:{" "}
            <strong className="text-foreground">
              {hasApplause
                ? applauseCount > 1
                  ? `${applauseDisplay} (${applauseCount}×)`
                  : `${applauseDisplay}/100`
                : t.applauseNotMeasured}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {t.points}: <strong className="text-primary">{totalPoints}</strong>
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={own}
        aria-label={t.like}
        className={`flex flex-col items-center rounded-xl px-3 py-2 transition ${
          liked ? "text-primary" : "text-foreground"
        } disabled:opacity-40`}
      >
        <Heart className={`size-7 ${liked ? "fill-current neon-text" : ""}`} />
        <span className="text-sm font-bold tabular-nums">{count}</span>
      </button>
    </div>
  );
}
