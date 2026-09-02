export const COMMITS_PER_PAGE = 10;

export type UpdateLogEntry = {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  url: string;
};

export type UpdateLogPage = {
  page: number;
  hasNext: boolean;
  totalPages: number;
  entries: UpdateLogEntry[];
};

type PageNumber = number | "…";

function safePage(page: number): number {
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function commitsUrl(repository: string, page: number): string {
  return `https://api.github.com/repos/${repository}/commits?sha=main&per_page=${COMMITS_PER_PAGE}&page=${safePage(page)}`;
}

function relatedPage(linkHeader: string | null, relation: "next" | "last"): number | null {
  const link = linkHeader?.split(",").find((part) => part.includes(`rel="${relation}"`));
  const match = link?.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : null;
}

export function pageNumbers(currentPage: number, totalPages: number): PageNumber[] {
  const total = Math.max(1, Math.trunc(totalPages));
  const current = Math.min(Math.max(safePage(currentPage), 1), total);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total];
  if (current >= total - 3) return [1, "…", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "…", current - 1, current, current + 1, "…", total];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseEntry(value: unknown): UpdateLogEntry | null {
  const candidate = record(value);
  const commit = record(candidate?.commit);
  const author = record(commit?.author);
  const committer = record(commit?.committer);
  const sha = typeof candidate?.sha === "string" ? candidate.sha : "";
  const url = typeof candidate?.html_url === "string" ? candidate.html_url : "";
  const message = typeof commit?.message === "string" ? commit.message.split(/\r?\n/, 1)[0].trim() : "";
  const date = typeof author?.date === "string" ? author.date : typeof committer?.date === "string" ? committer.date : "";
  if (!sha || !url || !message || !date) return null;
  return { sha, shortSha: sha.slice(0, 7), message, date, url };
}

export function parseUpdateLogPage(value: unknown, page: number, linkHeader: string | null): UpdateLogPage {
  const current = safePage(page);
  const entries = Array.isArray(value) ? value.map(parseEntry).filter((entry): entry is UpdateLogEntry => entry !== null) : [];
  const next = relatedPage(linkHeader, "next");
  const last = relatedPage(linkHeader, "last");
  return {
    page: current,
    hasNext: next !== null,
    totalPages: Math.max(current, last ?? (next === null ? current : current + 1)),
    entries,
  };
}

export async function fetchUpdateLog(repository: string, page: number, signal?: AbortSignal): Promise<UpdateLogPage> {
  const response = await fetch(commitsUrl(repository, page), {
    headers: { Accept: "application/vnd.github+json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Update log unavailable (${response.status}).`);
  return parseUpdateLogPage(await response.json(), page, response.headers.get("link"));
}
