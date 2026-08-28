// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, code blocks render
// as plain <pre> and nothing is cached — partial fences would poison it.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Wand2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { normalizeState } from "@/lib/mascot";
import { MausAvatar } from "./Avatar";
import { useStore } from "@/state/store";
// multibot (2.4): wzmianki jako chip — logika wtyczki w osobnym, testowanym pliku.
import { mentionPlugins } from "@/lib/mentions";
import { remarkBrackets } from "@/lib/brackets";
import { withSkillRefPlugins } from "@/lib/skillRefs";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed, capped, never written while streaming
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// multibot (2.4): typ bota ze store'a — wzmianka rysuje jego awatar, więc
// potrzebuje więcej niż imienia. Sama wtyczka siedzi w `@/lib/mentions`.
type MentionBot = ReturnType<typeof useStore>["state"]["bots"][number];

function CodeBlock({ code, lang, streaming, compact }: { code: string; lang: string; streaming: boolean; compact: boolean }) {
  const polish = useLanguage() === "pl";
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (streaming) return;
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    import("shiki")
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: lang || "text",
          theme: "github-dark-default",
        }),
      )
      .then((out) => {
        if (!alive) return;
        if (highlightCache.size >= CACHE_MAX) {
          const first = highlightCache.keys().next().value;
          if (first) highlightCache.delete(first);
        }
        highlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className={cn("uppercase tracking-wide text-ink-secondary", compact ? "text-[9px]" : "text-[11px]")}>{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title={polish ? "Kopiuj kod" : "Copy code"}
        >
          {copied
            ? <Check size={compact ? 11 : 13} className="text-success" />
            : <Copy size={compact ? 11 : 13} />}
        </button>
      </div>
      {html ? (
        <div
          className={cn("overflow-x-auto leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3", compact ? "text-[11px]" : "text-[13px]")}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={cn("overflow-x-auto p-3 leading-relaxed text-ink", compact ? "text-[11px]" : "text-[13px]")}>{code}</pre>
      )}
    </div>
  );
}

/** multibot: `compact` = wariant do dymków czatu — ten sam markup, tylko własne
 * rozmiary czcionek i ikon. Wartości ustawiał właściciel iteracyjnie; obecny
 * zestaw odpowiada treści dymka 13px (11px w kodzie, wzmiankach i tabelach,
 * 14/13px w nagłówkach). Panele (GroupPanel, RoomPanel, SkillsPanel) renderują BEZ tej
 * flagi, więc zostają w dotychczasowych rozmiarach. */
function ChatMarkdownComponent({ text, streaming = false, compact = false }: { text: string; streaming?: boolean; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const bots = useMemo<MentionBot[]>(() => state.bots, [state.bots]);
  const skillNames = state.skillNames;
  const remarkPlugins = useMemo<any[]>(
    () => withSkillRefPlugins([...mentionPlugins(remarkGfm, bots), remarkBrackets], skillNames) as any[],
    [bots, skillNames],
  );
  return (
    <div className="chat-md min-w-0 [&>*+*]:mt-2">
      <Markdown
        remarkPlugins={remarkPlugins}
        components={{
          span({ node, children }: { node?: any; children?: ReactNode }) {
            const mention = node?.properties?.dataMention ?? node?.properties?.["data-mention"];
            const bot = typeof mention === "string" ? bots.find((b) => b.name.toLowerCase() === mention.toLowerCase()) : undefined;
            if (!bot) {
              // multibot: skillRef — nazwa skilla jako żółta pigułka z ikoną
              const skillRef = node?.properties?.dataSkillRef ?? node?.properties?.["data-skill-ref"];
              if (typeof skillRef === "string") {
                return (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "toggleSkills", open: true })}
                    className={cn(
                      "inline-flex translate-y-px items-center gap-1.5 rounded-full bg-[#111] align-middle font-semibold text-[#ffb700] hover:brightness-110",
                      compact ? "h-[21px] px-2 text-[11px]" : "h-6 px-2.5 text-[12.5px]",
                    )}
                    title={skillRef}
                  >
                    <Wand2 size={compact ? 9 : 11} className="shrink-0 text-[#ffb700]" />
                    {children}
                  </button>
                );
              }
              return <span>{children}</span>;
            }
            return (
              <span className={cn("inline-flex translate-y-px items-center gap-1 rounded-full bg-raised px-2 py-0.5 align-middle font-medium text-ink", compact ? "text-[11px]" : "text-[13px]")}>
                <MausAvatar color={bot.color} shape={bot.mascotShape} state={normalizeState(bot.mascotExpression) ?? "happy"} size={compact ? 14 : 16} animated={false} />
                {children}
              </span>
            );
          },
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} streaming={streaming} compact={compact} />;
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className={cn("rounded bg-inset px-1 py-px", compact ? "text-[11px]" : "text-[13px]")}>{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="overflow-x-auto">
                <table className={cn("w-full border-collapse", compact ? "text-[11px]" : "text-[13.5px]")}>{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <div className={cn("mt-2 font-semibold", compact ? "text-[14px]" : "text-[16px]")}>{children}</div>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <div className={cn("mt-2 font-semibold", compact ? "text-[13px]" : "text-[15.5px]")}>{children}</div>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
            );
          },
          hr() {
            return <hr className="border-hairline/40" />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
