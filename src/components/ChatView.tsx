import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Brain, CalendarClock, Check, Crosshair, Loader2, Monitor, Square, Wand2, X } from "lucide-react";
// multibot: wspólna pigułka zdarzenia i wspólna karta pliku
import { EventChip } from "./EventChip";
import { AttachmentCard } from "./AttachmentCard";
import { routineStartName, slashCommandLabel } from "@/lib/transcriptChips";
import { useStore, formatTime, type Bot, type Message } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { Composer } from "./Composer";
// multibot: TTS głośniczek przy wiadomościach bota (tylko driver slafy)
import { SpeakButton } from "./SpeakButton";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { authFetch } from "@/lib/auth";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function MessageAttachment({ botId, file }: { botId: string; file: NonNullable<Message["attachments"]>[number] }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    authFetch(`/api/bots/${botId}/attachments/${file.id}`)
      .then((response) => response.ok ? response.blob() : Promise.reject())
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, file.id]);

  if (file.mime.startsWith("image/")) {
    return url ? (
      <a href={url} download={file.name} className="block">
        <img src={url} alt={file.name} className="max-h-64 w-auto max-w-full rounded-xl object-contain" />
      </a>
    ) : <div className="h-24 w-40 animate-pulse rounded-xl bg-raised" />;
  }
  return (
    <div className="flex items-center gap-2">
      {/* multibot: karta pliku wspólna dla załączników użytkownika i bota */}
      <div className="min-w-0 flex-1">
        <AttachmentCard name={file.name} size={file.size} url={url} />
      </div>
      {file.mime === "text/html" && (
        <button
          type="button"
          disabled={!url}
          onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}
          className="shrink-0 rounded-xl bg-raised px-3 py-2 text-sm text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          Otwórz
        </button>
      )}
    </div>
  );
}

/** multibot (F12): badge modelu przy wiadomości. Szuka ładnej etykiety w
 * katalogu instancji (id → label, np. "claude-opus-5" → "Opus 5"); jak nie
 * znajdzie, pokazuje surowe id. Użyty model leci z serwera na wiadomości. */
function ModelBadge({ model }: { model: string }) {
  const { state } = useStore();
  const label =
    state.instances
      .flatMap((instance) => instance.models.options)
      .find((option) => option.id === model)?.label ?? model;
  return (
    <span
      className="mb-1.5 inline-flex max-w-full items-center gap-1 truncate rounded-full border border-hairline/40 bg-raised/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
      title={model}
    >
      <span className="size-1 shrink-0 rounded-full bg-accent" />
      {label}
    </span>
  );
}

function Bubble({ botId, message }: { botId: string; message: Message }) {
  const polish = useLanguage() === "pl";
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);
  return (
    // multibot: group/msg reveals the SpeakButton (TTS) on bubble hover
    <div className={cn("group/msg flex w-full", user ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
          user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          message.pending && "opacity-60",
        )}
      >
        {message.model && <ModelBadge model={message.model} />}
        {!!message.attachments?.length && (
          <div className={cn("flex flex-col gap-2", text && "mb-2")}>
            {message.attachments.map((file) => <MessageAttachment key={file.id} botId={botId} file={file} />)}
          </div>
        )}
        {user ? (
          <>
            <div
              className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
            >
              {text}
            </div>
            {collapsible && (
              <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                {polish ? "Pokaż całą wiadomość" : "Show full message"}
              </button>
            )}
          </>
        ) : (
          <>
            <ChatMarkdown text={text} />
            {/* multibot: TTS — see SpeakButton.tsx; renders null off-slafy */}
            <SpeakButton text={text} />
          </>
        )}
      </div>
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const tool = message.tool;
  if (!tool) return null;
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

function EventPill({ message, polish }: { message: Message; polish: boolean }) {
  if (!message.event) return null;
  const labels = polish
    ? { renamed: "Zmieniono nazwę na", "skill-created": "Utworzono umiejętność", "routine-created": "Utworzono rutynę", "goal-progress": "Cel" }
    : { renamed: "Renamed to", "skill-created": "Created skill", "routine-created": "Created routine", "goal-progress": "Goal" };
  // multibot: wspólna pigułka zamiast własnego markupu — patrz EventChip.tsx.
  // Rutyna dostaje ikonę zegara, zmiana nazwy zostaje czystym tekstem.
  return (
    <EventChip
      icon={message.event.type === "routine-created" ? <CalendarClock size={13} /> : message.event.type === "goal-progress" ? <Crosshair size={13} /> : undefined}
      label={labels[message.event.type]}
      value={message.event.value}
    />
  );
}

/** Clickable centered "X texted Y" pill opening the read-only collaboration
 * room where those bots worked on a task together. */
function RoomChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const room = message.room;
  if (!room) return null;
  const owner = state.bots.find((b) => b.id === room.ownerBotId);
  const peers = room.bot_ids
    .filter((id) => id !== room.ownerBotId)
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  return (
    <div className="flex justify-center">
      <button
        onClick={() => {
          void authFetch(`/api/rooms/${encodeURIComponent(room.id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((full) => full && dispatch({ type: "toggleRoom", room: full }));
        }}
        className="flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        title={polish ? "Otwórz pokój współpracy (tylko do odczytu)" : "Open collaboration room (read-only)"}
      >
        <span className="flex items-center gap-1 font-medium text-ink">
          {owner && (
            <MausAvatar color={owner.color} shape={owner.mascotShape} state={stateForBot(owner)} size={18} animated={false} />
          )}
          {owner?.name ?? room.ownerBotId}
        </span>
        <span>{polish ? "napisał(a) do" : "texted"}</span>
        {peers.map((peer) => (
          <span key={peer.id} className="flex items-center gap-1 font-medium text-ink">
            <MausAvatar color={peer.color} shape={peer.mascotShape} state={stateForBot(peer)} size={18} animated={false} />
            {peer.name}
          </span>
        ))}
      </button>
    </div>
  );
}

// multibot: część wiadomości użytkownika to nie treść, tylko zdarzenie —
// start rutyny z przelotki (`[Routine: nazwa]`) i sam wybór z pickera `/`.
// Obie pokazujemy jako pigułkę zamiast surowego tekstu; start rutyny jest
// niebieski, żeby wiązał się z listą rutyn.
function userEventChip(message: Message) {
  if (message.role !== "user" || message.kind !== "text" || message.attachments?.length) return null;
  const routine = routineStartName(message.text);
  if (routine) return <EventChip key={message.id} icon={<CalendarClock size={13} />} value={routine} accent />;
  const command = slashCommandLabel(message.text);
  if (command) return <EventChip key={message.id} icon={<Wand2 size={13} />} value={command} />;
  return null;
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={text} streaming />
        <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const polish = useLanguage() === "pl";
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = polish
        ? `Praca trwa ${Math.max(0, Math.round((Date.now() - since) / 1000))} s`
        : `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [polish, since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

/** multibot: niebieski separator "NEW" nad pierwszą nieprzeczytaną wiadomością */
function NewSeparator() {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="h-px flex-1 bg-accent/30" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
        NEW
      </span>
      <div className="h-px flex-1 bg-accent/30" />
    </div>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, bot.messages.length, streaming, bot.busy, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const first = bot.messages[0];

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title={polish ? "Ustawienia bota" : "Bot settings"}
        >
          <MausAvatar
            color={bot.color}
            shape={bot.mascotShape}
            state={stateForBot(bot)}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
          <span className="text-[15px] font-semibold text-ink">{bot.name}</span>
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </button>
        <div className="flex items-center gap-2">
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              title={polish ? "Zatrzymaj turę" : "Stop this turn"}
            >
              <Square size={12} className="fill-current" />
              {polish ? "Zatrzymaj" : "Stop"}
            </button>
          )}
          <ModelPicker bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={polish ? "Komputer bota" : "Bot's computer"}
          >
            <Monitor size={18} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleMemory" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.memoryOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={polish ? "Pamięć bota" : "Bot memory"}
            aria-label={polish ? "Pamięć bota" : "Bot memory"}
          >
            <Brain size={18} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleRoutines" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.routinesOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={polish ? "Rutyny bota" : "Bot routines"}
            aria-label={polish ? "Rutyny bota" : "Bot routines"}
          >
            <CalendarClock size={18} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleSkills" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.skillsOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={polish ? "Umiejętności bota" : "Bot skills"}
            aria-label={polish ? "Umiejętności bota" : "Bot skills"}
          >
            <Wand2 size={18} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4">
          {first && (
            <div className="py-3 text-center text-[13px] text-ink-secondary">
              {polish ? "Dziś" : "Today"} {formatTime(first.at)}
            </div>
          )}
          {bot.messages.map((m) => {
            let child: ReactNode;
            switch (m.kind) {
              case "options":
                child = <OptionCard key={m.id} botId={bot.id} message={m} />;
                break;
              case "activity":
                child = <ActivityChip key={m.id} message={m} />;
                break;
              case "event":
                child = <EventPill key={m.id} message={m} polish={polish} />;
                break;
              case "room":
                child = <RoomChip key={m.id} message={m} />;
                break;
              case "screen":
                child = m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
                break;
              default:
                // multibot: pigułka zdarzenia wygrywa z dymkiem, gdy treść
                // wiadomości jest samym zdarzeniem (patrz userEventChip)
                child = userEventChip(m) ?? <Bubble key={m.id} botId={bot.id} message={m} />;
            }
            return (
              <Fragment key={m.id}>
                {bot.firstUnreadId === m.id && <NewSeparator />}
                {child}
              </Fragment>
            );
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                {polish ? "Konfigurowanie komputera bota…" : "Setting up this bot's computer…"}
              </div>
            </div>
          )}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={[...bot.messages].reverse().find((m) => m.role === "user")?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback while new content arrives — one tap back to live */}
      {!follow && (bot.busy || Boolean(streaming)) && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> {polish ? "Przejdź do najnowszych" : "Jump to latest"}
        </button>
      )}

      <Composer bot={bot} />
    </main>
  );
}
