// multibot: TTS speaker for assistant bubbles. Audio comes from the slafy
// engine's edge-tts endpoint through the harness proxy:
// POST /api/engine/bots/<engineBotId>/speak → audio/mpeg blob.
// Renders ONLY for bots on the slafy driver (same instances check as
// SettingsPanel). Engine bot id `mb-<threadId>` mirrors decodeConfig's default
// botPrefix in server/drivers/slafy.ts — a custom prefix needs a change here
// too (same caveat as local runtime controls).
// Button styling copies the ChatMarkdown code-block copy button; visibility is
// gated on bubble hover via the `group/msg` class added in ChatView's Bubble.
import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2, VolumeX } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

type Phase = "idle" | "loading" | "playing" | "error";

// one utterance at a time — playing a second message stops the first
let live: { stop: () => void } | null = null;

export function SpeakButton({ text }: { text: string }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const [phase, setPhase] = useState<Phase>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // stable identity holding the latest stop() — for `live` and unmount cleanup
  const self = useRef<{ stop: () => void }>({ stop: () => {} });

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (live === self.current) live = null;
    setPhase("idle");
  };
  self.current.stop = stop;

  useEffect(() => {
    const s = self.current;
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      s.stop();
    };
  }, []);

  // messages render inside the selected bot's ChatView — same fallback as Shell
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  const slafy =
    state.instances.find((i) => i.instanceId === bot?.modelSelection.instanceId)?.driverKind ===
    "slafy";
  if (!bot || !slafy || !text.trim()) return null;

  const fail = () => {
    setPhase("error");
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setPhase("idle"), 2500);
  };

  const play = async () => {
    if (live && live !== self.current) live.stop();
    live = self.current;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPhase("loading");
    try {
      const res = await authFetch(`/api/engine/bots/${encodeURIComponent(`mb-${bot.threadId}`)}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (ctl.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => self.current.stop();
      await audio.play();
      setPhase("playing");
    } catch {
      // engine down (503), unknown bot (404), edge-tts unreachable (502),
      // or autoplay refusal — a short error state on the button, never a crash
      if (ctl.signal.aborted) return;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      audioRef.current = null;
      if (live === self.current) live = null;
      fail();
    }
  };

  return (
    <button
      onClick={() => (phase === "loading" || phase === "playing" ? stop() : void play())}
      className={cn(
        "mt-1 rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100",
        phase === "error" ? "text-danger" : "text-ink-secondary hover:bg-raised hover:text-ink",
        phase !== "idle" && "opacity-100",
      )}
      title={
        phase === "playing"
          ? polish ? "Zatrzymaj" : "Stop"
          : phase === "loading"
            ? polish ? "Ładowanie dźwięku…" : "Loading audio…"
            : phase === "error"
              ? polish ? "Synteza mowy niedostępna — czy usługa lokalna działa?" : "TTS unavailable — is the local service running?"
              : polish ? "Czytaj na głos" : "Read aloud"
      }
    >
      {phase === "loading" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : phase === "playing" ? (
        <Square size={13} className="fill-current" />
      ) : phase === "error" ? (
        <VolumeX size={13} />
      ) : (
        <Volume2 size={13} />
      )}
    </button>
  );
}
