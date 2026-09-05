// multibot: F8 — skille bota w prawym slocie (400px, jak Routines).
// Provider-neutral skills. Harness stores them per bot and injects enabled
// instructions into every provider turn.
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

// Lokalny helper jak w RoutinesPanel: `status` na błędzie pozwala odróżnić
// brak trasy od realnej awarii po kodzie, nie po treści.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw Object.assign(new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }
  return body;
}

/** Kształt wiersza z GET /api/bots/{id}/skills. */
interface Skill {
  name: string;
  command?: string;
  description: string;
  instructions: string;
  path?: string;
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function SkillForm({
  skill,
  skillsRoot,
  onSaved,
  onCancel,
}: {
  skill: Skill;
  skillsRoot: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const polish = useLanguage() === "pl";
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    api(`${skillsRoot}/${encodeURIComponent(skill.name)}`, {
      method: "PATCH",
      body: JSON.stringify({ description, instructions }),
    })
      .then(onSaved)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Edytuj" : "Edit"} {skill.name}</div>
      <label className="block">
        <div className="mb-1.5 text-[13px] text-ink-secondary">{polish ? "Opis" : "Description"}</div>
        <input
          className={inputCls}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={polish ? "Kiedy bot ma użyć tej umiejętności?" : "When should the bot reach for this skill?"}
        />
      </label>
      <label className="block">
        <div className="mb-1.5 text-[13px] text-ink-secondary">{polish ? "Instrukcje" : "Instructions"}</div>
        <textarea
          className={cn(inputCls, "min-h-[180px] resize-none font-mono text-[12px]")}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {polish ? "Zapisz" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg bg-raised px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          {polish ? "Anuluj" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

export function SkillsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const skillsRoot = `/api/bots/${bot.id}/skills`;
  const [status, setStatus] = useState<"loading" | "offline" | "ready">("loading");
  const [skills, setSkills] = useState<Skill[]>([]);
  // multibot: panel otwarty klikiem w nazwę skilla w czacie startuje rozwinięty
  // na tym skillu — inaczej trzeba go było szukać na liście.
  const [expanded, setExpanded] = useState<string | null>(state.skillFocus);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "delete:<name>"
  const [error, setError] = useState<string | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillInstructions, setNewSkillInstructions] = useState("");
  const [creating, setCreating] = useState(false);

  const load = () =>
    api(skillsRoot).then((ss: Skill[]) => {
      setSkills(ss);
      setStatus("ready");
      // multibot: nazwy skilli do podświetlania w treści wiadomości (skillRefs)
      dispatch({ type: "setSkills", skills: ss.map((s) => ({ name: s.name, description: s.description })) });
    });

  useEffect(() => {
    if (state.skillFocus) setExpanded(state.skillFocus);
  }, [state.skillFocus]);

  useEffect(() => {
    let alive = true;
    load()
      .catch(() => alive && setStatus("offline"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [skillsRoot]);

  const showError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Bez dialogu potwierdzenia — wzorzec repo (delete rutyny/bota też jest
  // bezpośredni), destruktywność sygnalizuje styl danger.
  const remove = (name: string) => {
    setBusy(`delete:${name}`);
    setError(null);
    api(`${skillsRoot}/${encodeURIComponent(name)}`, { method: "DELETE" })
      .then(() => setSkills((ss) => ss.filter((s) => s.name !== name)))
      .catch(showError)
      .finally(() => setBusy(null));
  };

  const create = () => {
    if (creating || !newSkillName.trim() || !newSkillInstructions.trim()) return;
    setCreating(true);
    api(skillsRoot, { method: "POST", body: JSON.stringify({ name: newSkillName, instructions: newSkillInstructions }) })
      .then((skill: Skill) => { setSkills((items) => [...items, skill]); setNewSkillName(""); setNewSkillInstructions(""); })
      .catch(showError)
      .finally(() => setCreating(false));
  };

  return (
    <aside className="animate-panel-in flex h-full w-[360px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div data-shell-header className="flex items-center justify-between px-4 py-3">
        <span className="w-[26px]" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Umiejętności" : "Skills"}</span>
        <button
          onClick={() => dispatch({ type: "toggleSkills", open: false })}
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
            <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie umiejętności…" : "Loading skills…"}
          </div>
        ) : editing ? (
          <SkillForm
            skill={editing}
            skillsRoot={skillsRoot}
            onSaved={() => {
              setEditing(null);
              load().catch(() => setStatus("offline"));
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <div className="mt-3 rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">{polish ? "Nowa umiejętność" : "New skill"}</div>
              <input className={cn(inputCls, "mt-3")} value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder={polish ? "Nazwa umiejętności" : "Skill name"} />
              <textarea className={cn(inputCls, "mt-2 min-h-[100px] resize-y")} value={newSkillInstructions} onChange={(e) => setNewSkillInstructions(e.target.value)} placeholder={polish ? "Instrukcje dla bota" : "Instructions the bot should follow"} />
              <button onClick={create} disabled={creating || !newSkillName.trim() || !newSkillInstructions.trim()} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink disabled:opacity-40"><Check size={13} /> {polish ? "Utwórz umiejętność" : "Create skill"}</button>
            </div>

            {skills.length === 0 ? (
              <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                <Wand2 size={22} />
                <div className="text-[13px] font-medium text-ink">{polish ? "Brak umiejętności" : "No skills yet"}</div>
                <span className="text-[12px]">
                  {polish ? "Umiejętności to procedury współdzielone przez boty. Utwórz je powyżej albo poproś bota, by napisał własną." : "Skills are reusable playbooks shared by every bot — teach one above, or ask a bot to write one for itself."}
                </span>
              </div>
            ) : (
              skills.map((s) => {
                const open = expanded === s.name;
                return (
                  <div key={s.name} className="mt-3 rounded-xl bg-card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : s.name)}
                        className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                        title={s.path ?? s.name}
                      >
                        {open ? (
                          <ChevronDown size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
                        ) : (
                          <ChevronRight size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
                        )}
                         <span className="min-w-0">
                           <span className="block truncate text-[15px] font-medium text-ink">
                             <span className="mr-1 text-ink-secondary">⌘</span>{s.command ?? `/${s.name}`}
                           </span>
                          <span className="mt-0.5 block text-[13px] text-ink-secondary">
                            {s.description || (polish ? "Brak opisu" : "No description")}
                          </span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => setEditing(s)}
                          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                          title={polish ? "Edytuj" : "Edit"}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => remove(s.name)}
                          disabled={busy === `delete:${s.name}`}
                          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
                          title={polish ? "Usuń" : "Delete"}
                        >
                          {busy === `delete:${s.name}` ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="mt-3 border-t border-hairline/40 pt-3 text-[13px]">
                        <div className="mb-2 truncate text-[11px] text-ink-secondary" title={s.path ?? s.name}>
                          {s.path ?? (polish ? "Wspólna umiejętność bota" : "Shared bot skill")}
                        </div>
                        {s.instructions ? (
                          <ChatMarkdown text={s.instructions} />
                        ) : (
                          <div className="text-ink-secondary">{polish ? "Brak instrukcji" : "No instructions"}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
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
