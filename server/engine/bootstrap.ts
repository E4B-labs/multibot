// multibot: bridge an existing engine profile into first harness bot.
// Profile contents stay in engine data; harness only receives neutral metadata.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ExistingEngineProfile {
  source: string;
  id: string;
  name: string;
  title?: string;
  description?: string;
}

const PROFILE_MARKERS = ["bot.json", "SOUL.md", "config.yaml", "profile.yaml"];

function profileMeta(source: string, id = ""): ExistingEngineProfile | null {
  const dir = resolve(source);
  if (!existsSync(dir)) return null;
  if (!PROFILE_MARKERS.some((name) => existsSync(join(dir, name)))) return null;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "bot.json"), "utf8")) as Record<string, unknown>;
  } catch {
    /* SOUL/config-only profiles are valid; name falls back to directory. */
  }
  const profileId = id || String(meta.id ?? dir.split(/[\\/]/).pop() ?? "profile");
  const fallbackName = profileId.startsWith(".") ? "My bot" : profileId;
  return {
    source: dir,
    id: profileId,
    name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName,
    ...(typeof meta.title === "string" && meta.title ? { title: meta.title } : {}),
    ...(typeof meta.description === "string" && meta.description ? { description: meta.description } : {}),
  };
}

function profileFromRoot(root: string): ExistingEngineProfile | null {
  const profiles = join(root, "profiles");
  if (!existsSync(profiles)) return null;
  const candidates = readdirSync(profiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(profiles, name);
      const config = existsSync(join(dir, "config.yaml"))
        ? readFileSync(join(dir, "config.yaml"), "utf8")
        : "";
      const env = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "";
      // Prefer real configured profiles. Fresh harness profiles are `mb-*`
      // and usually have no model; importing one would create a blank bot.
      const score = (/(^|\n)model:/m.test(config) ? 2 : 0) +
        (/(OPENAI|ANTHROPIC|OPENROUTER|GROQ|XAI|HF)_API_KEY=\S+/m.test(env) ? 1 : 0);
      return { name, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const ordered = candidates.some((candidate) => candidate.score > 0)
    ? candidates
    : candidates.filter((candidate) => !candidate.name.startsWith("mb-"));
  for (const { name } of ordered) {
    const found = profileMeta(join(profiles, name), name);
    if (found) return found;
  }
  return null;
}

/** Find first real profile without reading any secret content. */
export function findExistingEngineProfile(root: string): ExistingEngineProfile | null {
  const explicit = process.env.SLAFY_IMPORT_SOURCE?.trim();
  if (explicit) return profileFromRoot(explicit) ?? profileMeta(explicit);

  const candidates = [
    root,
    process.env.SLAFY_DATA_DIR,
    join(root, "engine-data"),
    // Historical dev layout used sibling `slafy-bot-data`; keep migration
    // automatic on normal 8799 startup, while random-port test servers stay
    // isolated from a developer's real profile.
    ...(process.env.OMB_PORT === undefined || process.env.OMB_PORT === "8799"
      ? [join(root, "..", "slafy-bot-data")]
      : []),
    join(homedir(), ".openmausbot", "engine-data"),
    // Hermes Agent's native Termux home is the user's existing profile.
    // Import metadata only; secrets stay inside the profile copy.
    ...(process.env.OMB_PORT === undefined || process.env.OMB_PORT === "8799" ? [join(homedir(), ".hermes")] : []),
  ].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    // Data roots also contain config.yaml/SOUL.md at top level. Never import
    // that root as a bot; inspect its profiles directory first.
    if (existsSync(join(normalized, "profiles"))) {
      const nested = profileFromRoot(normalized);
      if (nested) return nested;
      continue;
    }
    const direct = profileMeta(normalized);
    if (direct) return direct;
  }
  return null;
}

/** Copy profile into deterministic `mb-<threadId>` engine identity. */
export async function importExistingEngineProfile(
  baseUrl: string,
  profile: ExistingEngineProfile,
  engineBotId: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: profile.source,
      bot_id: engineBotId,
      name: profile.name,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  // Restart/second launch: target already exists and is the desired identity.
  if (response.ok || response.status === 409) return;
  const body = await response.text().catch(() => "");
  throw new Error(`engine profile import failed (${response.status}): ${body.slice(0, 200)}`);
}
