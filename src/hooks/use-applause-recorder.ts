import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiJson } from "@/lib/api";
import {
  APPLAUSE_COUNTDOWN_MS,
  APPLAUSE_MIN_SAMPLES,
  computeApplauseScore,
  computeFrameEnergyFromFloatSamples,
  extractFrequencyBands,
  normalizeRmsLevel,
  remainingApplauseSeconds,
  remainingCountdownSeconds,
  smoothLevelAsymmetric,
  type ApplauseStateSnapshot,
} from "@/lib/applause-meter";

import {
  buildAudioConstraints,
  isEmbeddedIframe,
  isMicrophoneAllowedByPolicy,
  loadAppSettings,
} from "@/lib/settings";

export type RecorderPhase = "idle" | "preparing" | "countdown" | "measuring" | "saving";
export type RecorderErrorCode =
  | "unsupported"
  | "permission"
  | "iframe_blocked"
  | "no_mic"
  | "busy"
  | "unauthorized"
  | "network"
  | "insufficient"
  | null;

export interface ApplauseTargetInput {
  requestId?: string | null;
  singerName?: string;
  singerUserId?: string | null;
}

export interface CompletedMeasurement {
  requestId: string | null;
  measurementId: string;
  score: number;
  likes: number;
  totalPoints: number;
}

export function useApplauseRecorder(options?: {
  onCompleted?: (result: CompletedMeasurement) => void;
  onUnauthorized?: () => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [liveLevel, setLiveLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [liveBands, setLiveBands] = useState<number[]>([]);
  const [countdownSec, setCountdownSec] = useState(5);
  const [remainingSec, setRemainingSec] = useState(10);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<RecorderErrorCode>(null);

  const phaseRef = useRef<RecorderPhase>("idle");
  const cleanupRef = useRef<() => void>(() => {});
  const onCompletedRef = useRef(options?.onCompleted);
  const onUnauthRef = useRef(options?.onUnauthorized);
  onCompletedRef.current = options?.onCompleted;
  onUnauthRef.current = options?.onUnauthorized;

  const setPhaseSync = (next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  const cancel = useCallback(async () => {
    cleanupRef.current();
  }, []);

  const start = useCallback(async (target: string | ApplauseTargetInput): Promise<boolean> => {
    if (phaseRef.current !== "idle") {
      setErrorCode("busy");
      return false;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorCode("unsupported");
      return false;
    }

    const normalized: ApplauseTargetInput =
      typeof target === "string" ? { requestId: target } : target;
    const requestId = normalized.requestId ?? null;
    const singerName = normalized.singerName?.trim() || undefined;
    const singerUserId = normalized.singerUserId ?? null;
    if (!requestId && !singerName) {
      return false;
    }

    const appSettings = loadAppSettings();
    const durationMs = appSettings.applauseDurationSec * 1000;
    const durationSec = appSettings.applauseDurationSec;

    setErrorCode(null);
    setLiveLevel(0);
    setPeakLevel(0);
    setCountdownSec(Math.ceil(APPLAUSE_COUNTDOWN_MS / 1000));
    setRemainingSec(durationSec);
    setActiveRequestId(requestId);
    setPhaseSync("preparing");

    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let countdownTickTimer: ReturnType<typeof setInterval> | null = null;
    let countdownEndTimer: ReturnType<typeof setTimeout> | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const measurementId = crypto.randomUUID();
    let startedOnServer = false;

    let liveChannel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        liveChannel = new BroadcastChannel("pm-applause-live");
      } catch {
        liveChannel = null;
      }
    }

    const teardownMedia = () => {
      if (countdownTickTimer) {
        clearInterval(countdownTickTimer);
        countdownTickTimer = null;
      }
      if (countdownEndTimer) {
        clearTimeout(countdownEndTimer);
        countdownEndTimer = null;
      }
      if (sampleTimer) {
        clearInterval(sampleTimer);
        sampleTimer = null;
      }
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      if (liveChannel) {
        try {
          liveChannel.close();
        } catch {
          /* ignore */
        }
        liveChannel = null;
      }
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        analyser?.disconnect();
      } catch {
        /* ignore */
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          track.stop();
        }
        stream = null;
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
    };

    const fullCancel = async (reason: "cancelled" | "failed" = "cancelled") => {
      if (cleaned) return;
      cleaned = true;
      teardownMedia();
      if (startedOnServer) {
        await apiJson("/api/applause/cancel", {
          method: "POST",
          body: JSON.stringify({ measurementId, requestId, reason }),
        }).catch(() => {});
      }
      setPhaseSync("idle");
      setActiveRequestId(null);
      setLiveLevel(0);
      setLiveBands([]);
    };

    cleanupRef.current = () => {
      void fullCancel("cancelled");
    };

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(appSettings),
        });
      } catch (err) {
        // Retry with minimal constraint if specific deviceId or processing flags are unsupported
        const name = err instanceof Error ? err.name : "";
        if (name === "OverconstrainedError" || name === "TypeError") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0 || audioTracks[0]?.readyState === "ended") {
        throw Object.assign(new Error("no_mic"), { name: "NotFoundError" });
      }

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);

      // Verify microphone pipeline yields readable frames before starting the clock
      const timeDomain = new Float32Array(analyser.fftSize);
      const freqDomain = new Uint8Array(analyser.frequencyBinCount);
      analyser.getFloatTimeDomainData(timeDomain);

      // Start authoritative server session in 5-second Beamer countdown phase
      const startRes = await apiJson<{ ok: boolean; state: ApplauseStateSnapshot }>(
        "/api/applause/start",
        {
          method: "POST",
          body: JSON.stringify({
            requestId,
            singerName,
            singerUserId,
            measurementId,
            durationMs,
            countdownMs: APPLAUSE_COUNTDOWN_MS,
          }),
        },
      );
      startedOnServer = true;

      audioTracks[0]!.onended = () => {
        setErrorCode("no_mic");
        void fullCancel("failed");
      };

      const countdownEndsAt = startRes.state.countdownEndsAt ?? Date.now() + APPLAUSE_COUNTDOWN_MS;
      const countdownWaitMs = Math.max(0, countdownEndsAt - Date.now());
      setCountdownSec(remainingCountdownSeconds(countdownEndsAt, Date.now()));
      setPhaseSync("countdown");

      const beginLiveMeasurement = async () => {
        if (cleaned) return;
        if (countdownTickTimer) {
          clearInterval(countdownTickTimer);
          countdownTickTimer = null;
        }

        try {
          await apiJson<{ ok: boolean; state: ApplauseStateSnapshot }>("/api/applause/begin", {
            method: "POST",
            body: JSON.stringify({ measurementId, requestId }),
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setErrorCode("unauthorized");
            onUnauthRef.current?.();
          } else {
            setErrorCode("network");
          }
          await fullCancel("failed");
          return;
        }

        if (cleaned || !analyser) return;

        const localEndsAt = Date.now() + durationMs;
        setRemainingSec(durationSec);
        setPhaseSync("measuring");

        const rawSamples: number[] = [];
        let smoothed = 0;
        let peak = 0;
        let seq = 0;
        let inFlightLevel = false;
        let unpushedPeakSinceSend = 0;

        // ~30 Hz high-responsiveness frame sampling over measurement window (NO raw audio stored/sent)
        sampleTimer = setInterval(() => {
          if (cleaned || !analyser) return;
          analyser.getFloatTimeDomainData(timeDomain);
          analyser.getByteFrequencyData(freqDomain);
          const { energy } = computeFrameEnergyFromFloatSamples(timeDomain);
          const norm = normalizeRmsLevel(energy);
          smoothed = smoothLevelAsymmetric(smoothed, norm, 0.9, 0.25);
          peak = Math.max(peak, norm);
          unpushedPeakSinceSend = Math.max(unpushedPeakSinceSend, smoothed);
          rawSamples.push(norm);
          const bands = extractFrequencyBands(freqDomain, 48, smoothed);

          setLiveLevel(smoothed);
          setPeakLevel(peak);
          setLiveBands(bands);
          setRemainingSec(remainingApplauseSeconds(localEndsAt, Date.now()));

          seq += 1;
          liveChannel?.postMessage({
            type: "level",
            measurementId,
            requestId,
            seq,
            latestLevel: smoothed,
            latestPeak: peak,
            latestBands: bands,
            updatedAt: Date.now(),
          });

          if (!inFlightLevel) {
            inFlightLevel = true;
            const levelToSend = Math.max(smoothed, unpushedPeakSinceSend * 0.95);
            unpushedPeakSinceSend = 0;
            apiJson("/api/applause/level", {
              method: "POST",
              body: JSON.stringify({
                measurementId,
                requestId,
                seq,
                level: levelToSend,
                peak,
                bands,
              }),
            })
              .catch((err) => {
                if (err instanceof ApiError && err.status === 401) {
                  setErrorCode("unauthorized");
                  onUnauthRef.current?.();
                  void fullCancel("failed");
                }
              })
              .finally(() => {
                inFlightLevel = false;
              });
          }
        }, 33);

        finishTimer = setTimeout(async () => {
          if (cleaned) return;
          cleaned = true;
          teardownMedia();
          setPhaseSync("saving");

          if (rawSamples.length < APPLAUSE_MIN_SAMPLES) {
            setErrorCode("insufficient");
            await apiJson("/api/applause/cancel", {
              method: "POST",
              body: JSON.stringify({ measurementId, requestId, reason: "failed" }),
            }).catch(() => {});
            setPhaseSync("idle");
            setActiveRequestId(null);
            return;
          }

          try {
            const completed = await apiJson<{
              ok: boolean;
              state: ApplauseStateSnapshot;
              breakdown: ReturnType<typeof computeApplauseScore>;
            }>("/api/applause/complete", {
              method: "POST",
              body: JSON.stringify({
                measurementId,
                requestId,
                samples: rawSamples,
              }),
            });
            setPhaseSync("idle");
            setActiveRequestId(null);
            setLiveLevel(0);
            setLiveBands([]);
            onCompletedRef.current?.({
              requestId,
              measurementId,
              score: completed.state.score ?? completed.breakdown.score,
              likes: completed.state.likes,
              totalPoints: completed.state.totalPoints ?? completed.breakdown.score,
            });
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              setErrorCode("unauthorized");
              onUnauthRef.current?.();
            } else {
              setErrorCode("network");
            }
            setPhaseSync("idle");
            setActiveRequestId(null);
          }
        }, durationMs);
      };

      countdownTickTimer = setInterval(() => {
        if (cleaned) return;
        setCountdownSec(remainingCountdownSeconds(countdownEndsAt, Date.now()));
      }, 100);

      countdownEndTimer = setTimeout(() => {
        void beginLiveMeasurement();
      }, countdownWaitMs);

      return true;
    } catch (err) {
      teardownMedia();
      if (startedOnServer) {
        await apiJson("/api/applause/cancel", {
          method: "POST",
          body: JSON.stringify({ measurementId, requestId, reason: "failed" }),
        }).catch(() => {});
      }
      setPhaseSync("idle");
      setActiveRequestId(null);

      if (err instanceof ApiError) {
        if (err.status === 401) {
          setErrorCode("unauthorized");
          onUnauthRef.current?.();
        } else if (err.status === 409) {
          setErrorCode("busy");
        } else {
          setErrorCode("network");
        }
        return false;
      }

      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        const policyBlocked = isMicrophoneAllowedByPolicy() === false || isEmbeddedIframe();
        setErrorCode(policyBlocked ? "iframe_blocked" : "permission");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setErrorCode("no_mic");
      } else {
        setErrorCode("network");
      }
      return false;
    }
  }, []);

  return {
    phase,
    liveLevel,
    peakLevel,
    liveBands,
    countdownSec,
    remainingSec,
    activeRequestId,
    errorCode,
    start,
    cancel,
    clearError: () => setErrorCode(null),
  };
}
