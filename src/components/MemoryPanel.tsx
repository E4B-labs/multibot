// multibot: F8 — pamięć bota silnika slafy w prawym slocie (400px, jak
// Routines/Settings/Computer). UI gada wyłącznie z przelotką harnessu
// (`server/engine/proxy.ts`: `/api/engine/<rest>` → `/api/<rest>` silnika);
// wszystkie trasy są READ-ONLY z założenia silnika (engine/server/memory.py:
// zapis faktów/MEMORY.md należy do local service, UI tylko czyta):
//   GET /api/engine/bots/mb-<threadId>/memory/facts?q=&limit= — lista faktów,
//   GET /api/engine/bots/mb-<threadId>/memory/markdown        — {content},
//   GET /api/engine/bots/mb-<threadId>/memory/graph           — {nodes, edges}
//     (graf dwudzielny fakt↔encja; node.id = "f<id>" | "e<id>").
// Delete faktu i zapis MEMORY.md nie mają tras HTTP — sekcje są podglądem.
import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

// Ten sam lokalny helper co RoutinesPanel: silnik zwraca błędy jako `{detail}`
// (FastAPI), przelotka jako `{error}`.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

/** Mirror of engine `memory.facts()` (engine/server/memory.py). */
interface Fact {
  id: number | string;
  text: string;
  trust_score?: number | null;
  created_at?: string | null;
  entities?: string[];
}

/** Mirror of engine `memory.graph()`. */
interface Graph {
  nodes: Array<{ id: string; type: "fact" | "entity"; label: string; weight: number | null }>;
  edges: Array<{ source: string; target: string }>;
}

const TABS = ["facts", "markdown", "graph"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, [string, string]> = { facts: ["Facts", "Fakty"], markdown: ["MEMORY.md", "MEMORY.md"], graph: ["Graph", "Graf"] };

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

// Koncentryczny layout dwudzielny zamiast siłowego: encje równo na wewnętrznym
// okręgu, fakty na zewnętrznym — każdy pod średnim kątem (kołowa średnia przez
// sumę wektorów) swoich encji, a potem rozłożone RÓWNO w kolejności tych kątów,
// żeby dwa fakty o tych samych encjach nie nakryły się w jednym punkcie.
// Deterministyczne, zero iteracji — force layout dopiero, gdyby graf urósł
// do rozmiarów, przy których pierścienie przestają być czytelne.
const R_ENTITY = 88;
const R_FACT = 168;

function layout(graph: Graph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const entities = graph.nodes.filter((n) => n.type === "entity");
  const facts = graph.nodes.filter((n) => n.type === "fact");
  entities.forEach((n, i) => {
    const a = (i / Math.max(entities.length, 1)) * 2 * Math.PI - Math.PI / 2;
    pos.set(n.id, { x: R_ENTITY * Math.cos(a), y: R_ENTITY * Math.sin(a) });
  });
  const desired = facts.map((n, i) => {
    let dx = 0;
    let dy = 0;
    for (const e of graph.edges) {
      if (e.source !== n.id) continue;
      const p = pos.get(e.target);
      if (p) {
        dx += p.x;
        dy += p.y;
      }
    }
    // fakt bez encji: kąt z indeksu, żeby sierota nie lądowała w NaN
    const angle =
      dx === 0 && dy === 0 ? (i / Math.max(facts.length, 1)) * 2 * Math.PI : Math.atan2(dy, dx);
    return { id: n.id, angle };
  });
  desired
    .sort((a, b) => a.angle - b.angle)
    .forEach((f, i) => {
      const a = (i / Math.max(desired.length, 1)) * 2 * Math.PI - Math.PI / 2;
      pos.set(f.id, { x: R_FACT * Math.cos(a), y: R_FACT * Math.sin(a) });
    });
  return pos;
}

function MemoryGraph({ graph }: { graph: Graph }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const polish = useLanguage() === "pl";
  const pos = useMemo(() => layout(graph), [graph]);
  const hoveredNode = graph.nodes.find((n) => n.id === hovered);

  if (graph.nodes.length === 0) {
    return (
      <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
        <Brain size={22} />
        <div className="text-[13px] font-medium text-ink">{polish ? "Brak danych do zmapowania" : "Nothing to map yet"}</div>
        <span className="text-[12px]">
          {polish ? "Graf łączy fakty z osobami, miejscami i rzeczami. Wypełnia się, gdy bot zapamiętuje informacje." : "The graph links facts to the people, places and things they mention — it fills in as the bot remembers."}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <svg viewBox="-200 -200 400 400" className="aspect-square w-full rounded-xl bg-card">
        {graph.edges.map((e, i) => {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) return null;
          const hot = hovered === e.source || hovered === e.target;
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={hot ? "stroke-accent" : "stroke-hairline"}
              strokeWidth={hot ? 1.5 : 1}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const r =
            n.type === "entity"
              ? 4 + Math.min(6, n.weight ?? 0)
              : 3 + 3 * Math.min(1, Math.max(0, n.weight ?? 0));
          return (
            <circle
              key={n.id}
              cx={p.x}
              cy={p.y}
              r={r}
              className={cn(
                n.type === "entity" ? "fill-accent" : "fill-raised-hover",
                hovered === n.id && "stroke-ink",
              )}
              strokeWidth={1.5}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered((cur) => (cur === n.id ? null : cur))}
            >
              <title>{n.label}</title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-2 min-h-[32px] text-[12px] text-ink-secondary">
        {hoveredNode ? (
          <>
            <span className="mr-1.5 rounded bg-inset px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
              {hoveredNode.type}
            </span>
            <span className="text-ink">{hoveredNode.label}</span>
          </>
        ) : (
          <>
            <span className="mr-1.5 inline-block size-2 rounded-full bg-accent align-middle" />
            entities ·
            <span className="mx-1.5 inline-block size-2 rounded-full bg-raised-hover align-middle" />
            facts — hover a node for its label
          </>
        )}
      </div>
    </div>
  );
}

export function MemoryPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  // Ten sam wzorzec id co local runtime controls: domyślny botPrefix "mb-" z
  // decodeConfig w server/drivers/slafy.ts.
  const memoryRoot = `/api/bots/${bot.id}/memory`;
  const [status, setStatus] = useState<"loading" | "offline" | "ready">("loading");
  const [tab, setTab] = useState<Tab>("facts");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [error, setError] = useState<string | null>(null);
  const [newFact, setNewFact] = useState("");
  const [savingFact, setSavingFact] = useState(false);
  const [editingMarkdown, setEditingMarkdown] = useState(false);
  // Kasowanie notatek jest nieodwracalne, a panel nie ma miejsca na okno
  // potwierdzenia — pierwszy klik uzbraja przycisk, drugi kasuje.
  const [clearArmed, setClearArmed] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState("");

  // Panel jest keyowany bot.id w Shell, więc mount = jeden bot. Ensure jak w
  // RoutinesPanel: bot silnika powstaje leniwie przy pierwszej wiadomości, więc
  // najpierw idempotentny POST /api/bots (409 = już jest = sukces).
  useEffect(() => {
    let alive = true;
    Promise.all([
      api(`${memoryRoot}/facts`),
      api(`${memoryRoot}/markdown`),
      api(`${memoryRoot}/graph`),
    ])
      .then(([fs, md, g]: [Fact[], { content: string }, Graph]) => {
        if (!alive) return;
        setFacts(fs);
        setMarkdown(md.content ?? "");
        setGraph(g);
        setStatus("ready");
      })
      .catch(() => alive && setStatus("offline"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryRoot]);

  // Filtr faktów po treści (silnik robi LIKE po `q`), debounce jak przy PATCH-ach bota.
  useEffect(() => {
    if (status !== "ready") return;
    setSearching(true);
    const timer = setTimeout(() => {
      api(`${memoryRoot}/facts?q=${encodeURIComponent(query)}`)
        .then((fs: Fact[]) => setFacts(fs))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, memoryRoot, status]);

  const addWorkspaceFact = () => {
    if (!newFact.trim() || savingFact) return;
    setSavingFact(true);
    api(`${memoryRoot}/facts`, { method: "POST", body: JSON.stringify({ text: newFact }) })
      .then((fact: Fact) => { setFacts((items) => [fact, ...items]); setNewFact(""); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSavingFact(false));
  };

  const removeWorkspaceFact = (id: number | string) => {
    api(`${memoryRoot}/facts/${encodeURIComponent(String(id))}`, { method: "DELETE" })
      .then(() => setFacts((items) => items.filter((fact) => fact.id !== id)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const saveWorkspaceMarkdown = (content = markdownDraft) => {
    api(`${memoryRoot}/markdown`, { method: "PUT", body: JSON.stringify({ content }) })
      .then((md: { content: string }) => { setMarkdown(md.content); setEditingMarkdown(false); setClearArmed(false); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="w-[26px]" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Pamięć" : "Memory"}</span>
        <button
          onClick={() => dispatch({ type: "toggleMemory", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {status === "offline" ? (
          // Konwencja local runtime controls
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className="size-1.5 rounded-full bg-raised-hover" />
            {polish ? "Usługa offline" : "Service offline"}
          </div>
        ) : status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie pamięci…" : "Loading memory…"}
          </div>
        ) : (
          <>
            {/* Ten sam segmented control co harmonogram w RoutinesPanel */}
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {TABS.map((t, i) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex-1 py-1.5 text-[13px]",
                    i > 0 && "border-l border-hairline/40",
                    tab === t ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                  )}
                >
                  {TAB_LABELS[t][polish ? 1 : 0]}
                </button>
              ))}
            </div>

            {tab === "facts" && (
              <>
                <div className="mt-3 flex gap-2">
                  <input className={inputCls} value={newFact} onChange={(e) => setNewFact(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWorkspaceFact()} placeholder={polish ? "Dodaj fakt do pamięci…" : "Add a memory fact…"} />
                  <button onClick={addWorkspaceFact} disabled={savingFact || !newFact.trim()} className="rounded-lg bg-raised px-3 text-ink disabled:opacity-40" title={polish ? "Dodaj fakt" : "Add fact"}><Plus size={15} /></button>
                </div>
                <div className="relative mt-3">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary"
                  />
                  <input
                    className={cn(inputCls, "pl-8")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={polish ? "Filtruj fakty…" : "Filter facts…"}
                  />
                  {searching && (
                    <Loader2
                      size={14}
                      className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary"
                    />
                  )}
                </div>
                {facts.length === 0 ? (
                  <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                    <Brain size={22} />
                    <div className="text-[13px] font-medium text-ink">
                      {query ? polish ? "Brak pasujących faktów" : "No matching facts" : polish ? "Brak faktów" : "No facts yet"}
                    </div>
                    {!query && (
                      <span className="text-[12px]">
                        {polish ? "Fakty to informacje poznane przez bota w rozmowach. Bot zapisuje je podczas czatu." : "Facts are what this bot has learned from its conversations — it saves them on its own as you chat."}
                      </span>
                    )}
                  </div>
                ) : (
                  facts.map((f) => (
                    <div key={f.id} className="mt-3 rounded-xl bg-card p-4">
                      <div className="flex items-start justify-between gap-2"><div className="text-[13px] leading-relaxed text-ink">{f.text}</div><button onClick={() => removeWorkspaceFact(f.id)} className="shrink-0 text-ink-secondary hover:text-danger" title={polish ? "Usuń fakt" : "Delete fact"}><Trash2 size={14} /></button></div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                        {typeof f.trust_score === "number" && (
                          <span className="rounded bg-inset px-1.5 py-0.5">
                            trust {f.trust_score.toFixed(2)}
                          </span>
                        )}
                        {(f.entities ?? []).map((name) => (
                          <span key={name} className="rounded bg-inset px-1.5 py-0.5">
                            {name}
                          </span>
                        ))}
                        {f.created_at && (
                          <span className="ml-auto">{new Date(f.created_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {tab === "markdown" && editingMarkdown ? (
              <div className="mt-3 rounded-xl bg-card p-3"><textarea className={cn(inputCls, "min-h-[260px] resize-y font-mono text-[12px]")} value={markdownDraft} onChange={(e) => setMarkdownDraft(e.target.value)} /><button onClick={() => saveWorkspaceMarkdown()} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink"><Check size={13} /> {polish ? "Zapisz notatki" : "Save notes"}</button></div>
            ) : tab === "markdown" &&
              (markdown.trim() ? (
                <div className="mt-3 rounded-xl bg-card p-4 text-[13px]">
                  {/* Read-only: zapis MEMORY.md z UI wywróciłby drift guard local service
                      (engine/server/memory.py §c) — silnik świadomie nie daje trasy. */}
                  <ChatMarkdown text={markdown} />
                  <div className="mt-3 flex items-center gap-2">
                    <button onClick={() => { setMarkdownDraft(markdown); setEditingMarkdown(true); setClearArmed(false); }} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink">{polish ? "Edytuj notatki" : "Edit notes"}</button>
                    <button
                      onClick={() => (clearArmed ? saveWorkspaceMarkdown("") : setClearArmed(true))}
                      onBlur={() => setClearArmed(false)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px]",
                        clearArmed ? "bg-danger text-white" : "bg-raised text-ink-secondary hover:text-danger",
                      )}
                      title={polish ? "Usuń MEMORY.md" : "Delete MEMORY.md"}
                    >
                      <Trash2 size={13} />
                      {clearArmed ? (polish ? "Na pewno?" : "Sure?") : polish ? "Usuń notatki" : "Delete notes"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                  <Brain size={22} />
                  <div className="text-[13px] font-medium text-ink">{polish ? "MEMORY.md jest pusty" : "MEMORY.md is empty"}</div>
                  <span className="text-[12px]">
                    {polish ? "Bot przechowuje tu długoterminowe notatki. Pojawią się, gdy uzna informację za wartą zapisania." : "The bot keeps long-term notes here — they appear once it decides something is worth writing down."}
                  </span>
                  <button onClick={() => { setMarkdownDraft(""); setEditingMarkdown(true); }} className="mt-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink">{polish ? "Napisz notatki" : "Write notes"}</button>
                </div>
              ))}

            {tab === "graph" && <MemoryGraph graph={graph} />}
          </>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>
    </aside>
  );
}
