import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { Award, Heart, Mic, ListMusic, LogOut, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiJson, setSingerToken } from "@/lib/api";
import { useAuthUser } from "@/hooks/use-auth-user";
import { useI18n } from "@/lib/i18n";

type Fav = {
  id: string;
  video_id: string;
  song_title: string;
  thumbnail_url: string | null;
  duration: string | null;
};

type Hist = {
  id: string;
  song_title: string;
  status: string;
  applause_score: number | null;
  applause_total?: number | null;
  applause_count?: number;
  likes_count: number;
  total_points: number;
  created_at: string;
};

export function AccountPage() {
  const { user, ready, refresh, signOut } = useAuthUser();
  return (
    <div className="pb-20">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4">
        {!ready ? null : user ? (
          <Card onSignOut={() => void signOut()} />
        ) : (
          <SignIn onSuccess={() => void refresh()} />
        )}
      </main>
    </div>
  );
}

function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await apiJson<{ ok: boolean; token?: string }>("/api/auth/local-login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          displayName: displayName.trim() || undefined,
        }),
      });
      if (res.token) {
        setSingerToken(res.token);
      }
      if (displayName.trim()) {
        localStorage.setItem("pm-name", displayName.trim());
      }
      toast.success("✓");
      onSuccess();
    } catch {
      toast.error(t.errGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm space-y-4 rounded-2xl border border-border bg-card p-6 neon-border">
      <h1 className="text-center font-display text-3xl text-primary neon-text">{t.singerCard}</h1>
      <p className="text-center text-xs text-muted-foreground">{t.localSignInHint}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.email}
        />
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={40}
          placeholder={t.localDisplayNamePh}
        />
        <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : t.localSignInBtn}
        </Button>
      </form>
    </div>
  );
}

function Card({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<{ display_name: string; card_code: string } | null>(null);
  const [name, setName] = useState("");
  const [stats, setStats] = useState({
    likes: 0,
    applause_points: 0,
    total_points: 0,
    performances: 0,
    requests: 0,
  });
  const [favs, setFavs] = useState<Fav[]>([]);
  const [hist, setHist] = useState<Hist[]>([]);

  const loadAccount = useCallback(async () => {
    try {
      const data = await apiJson<{
        profile: { display_name: string; card_code: string } | null;
        stats: typeof stats;
        favorites: Fav[];
        history: Hist[];
      }>("/api/account");
      if (data.profile) {
        setProfile(data.profile);
        setName(data.profile.display_name);
      }
      setStats(data.stats);
      setFavs(data.favorites ?? []);
      setHist(data.history ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const save = async () => {
    try {
      await apiJson("/api/account/profile", {
        method: "PATCH",
        body: JSON.stringify({ display_name: name.trim().slice(0, 40) }),
      });
      toast.success("✓");
      localStorage.setItem("pm-name", name.trim());
      await loadAccount();
    } catch {
      toast.error(t.errGeneric);
    }
  };

  const removeFav = async (id: string) => {
    await apiJson(`/api/favorites/${id}`, { method: "DELETE" });
    setFavs((f) => f.filter((x) => x.id !== id));
  };

  const cardUrl =
    typeof window !== "undefined" && profile
      ? `${window.location.origin}/rangliste?singer=${profile.card_code}`
      : "";

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-3xl border border-primary bg-card p-6 neon-border">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="w-fit rounded-xl bg-foreground p-3">
            {cardUrl && <QRCodeSVG value={cardUrl} size={120} />}
          </div>
          <div className="flex-1 space-y-2">
            <div className="text-xs uppercase tracking-[0.3em] text-accent">{t.singerCard}</div>
            <div className="font-display text-3xl text-primary neon-text">
              {profile?.display_name}
            </div>
            <div className="font-mono text-lg tracking-widest">{profile?.card_code}</div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
          <Stat icon={<Award className="size-5" />} n={stats.total_points} label={t.applauseTotalPoints} />
          <Stat icon={<Award className="size-5" />} n={stats.applause_points} label={t.applausePointsShort} />
          <Stat icon={<Heart className="size-5" />} n={stats.likes} label={t.likes} />
          <Stat icon={<Mic className="size-5" />} n={stats.performances} label={t.performances} />
          <Stat icon={<ListMusic className="size-5" />} n={stats.requests} label={t.requests} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex gap-2"
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <Button type="submit" disabled={!name.trim()}>
          {t.editName}
        </Button>
      </form>

      <section>
        <h2 className="mb-3 text-xl text-accent">{t.favorites}</h2>
        {favs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noFavs}</p>
        ) : (
          <ul className="space-y-2">
            {favs.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-2"
              >
                {f.thumbnail_url && (
                  <img
                    src={f.thumbnail_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-12 w-20 rounded object-cover"
                    loading="lazy"
                  />
                )}
                <span className="line-clamp-2 flex-1 text-sm">{f.song_title}</span>
                <Button size="sm" asChild>
                  <Link to="/" search={{ q: f.song_title }}>
                    {t.again}
                  </Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void removeFav(f.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hist.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl text-accent">{t.history}</h2>
          <ul className="space-y-1 text-sm">
            {hist.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2"
              >
                <span className="min-w-0 flex-1 truncate">{h.song_title}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {typeof (h.applause_total ?? h.applause_score) === "number"
                    ? (h.applause_count ?? 1) > 1
                      ? `${t.applausePointsShort}: ${h.applause_total} (${h.applause_count}×)`
                      : `${t.applausePointsShort}: ${h.applause_total ?? h.applause_score}/100`
                    : t.applauseNotMeasured}{" "}
                  · ♥ {h.likes_count} · <strong className="text-primary">{h.total_points} {t.points}</strong>
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(h.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Button variant="secondary" onClick={onSignOut}>
        <LogOut className="size-4" />
        {t.signOut}
      </Button>
    </div>
  );
}

function Stat({ icon, n, label }: { icon: React.ReactNode; n: number; label: string }) {
  return (
    <div className="rounded-xl bg-secondary p-3">
      <div className="flex justify-center text-primary">{icon}</div>
      <div className="font-display text-2xl tabular-nums">{n}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
