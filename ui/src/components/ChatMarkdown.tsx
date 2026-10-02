// AgentDash (scan 4, lane N): the CoS writes plain markdown ("- " lists,
// **bold**), which the chat bubble used to show literally. This renders it,
// safely:
// - react-markdown never renders raw HTML here (no rehype-raw, skipHtml), and
//   its default URL filter drops javascript:, data: and similar links;
// - images are shown as their alt text, never fetched;
// - links cannot disguise where they go. An in-app path ("/ACM/issues/ACM-1")
//   stays a plain link. An external link shows its real hostname after its
//   text ("billing page (evil.example)"). A link whose text itself looks like
//   a URL or domain on another host ("https://app.agentdash.com/billing"
//   pointing at evil.example) is not a link at all, only text;
// - bare "www." text is not turned into a link.
import { Children, isValidElement, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";

type MdNode = { type?: string; url?: string; value?: string; children?: MdNode[] };

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/**
 * remark plugin: undo GFM's bare-"www." autolinks (a link whose text is the
 * www. address and whose URL is "http://" + that text). They become text.
 */
export function remarkNoBareWwwLinks() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child) => {
        if (child.type === "link" && typeof child.url === "string") {
          const text = textOf(child);
          if (/^www\./i.test(text) && child.url.toLowerCase() === `http://${text}`.toLowerCase()) {
            return { type: "text", value: text };
          }
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

/** Single line breaks stay line breaks, as they read in a chat bubble. */
const REMARK_PLUGINS = [remarkGfm, remarkNoBareWwwLinks, remarkSoftBreaks];

/** The hostname an href goes to, or null for an in-app (same-origin or relative) link. */
export function externalHost(href: string, origin: string = typeof window !== "undefined" ? window.location.origin : "http://localhost"): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  // "/path", "#x", "?q" and "path" are in-app; "//host" is another site.
  if (!trimmed.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, origin);
    if (url.protocol === "mailto:") return url.pathname.split("@")[1]?.toLowerCase() || "email";
    if (url.origin === new URL(origin).origin) return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return "unknown site";
  }
}

/** The host a piece of link text names, when it reads like a URL or a domain. */
export function hostNamedByText(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : t.startsWith("//") ? `https:${t}` : /^([a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)/i.test(t) ? `https://${t}` : null;
  if (!candidate) return null;
  try {
    return new URL(candidate).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(a) === strip(b);
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return plainText(child.props.children);
      return "";
    })
    .join("");
}

function ChatLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  const host = externalHost(href);
  if (!host) {
    return (
      <a href={href} className="underline">
        {children}
      </a>
    );
  }
  const named = hostNamedByText(plainText(children));
  // The text claims another site than the one the link opens: show text only.
  if (named && !sameSite(named, host)) return <span data-testid="chat-link-disarmed">{children}</span>;
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
        {children}
      </a>
      {named ? null : <span className="text-text-tertiary" data-testid="chat-link-host"> ({host})</span>}
    </>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-0 [&:not(:first-child)]:mt-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => <ChatLink href={href}>{children}</ChatLink>,
  img: ({ alt }) => <span>{alt ?? ""}</span>,
  h1: ({ children }) => <p className="my-0 font-semibold [&:not(:first-child)]:mt-2">{children}</p>,
  h2: ({ children }) => <p className="my-0 font-semibold [&:not(:first-child)]:mt-2">{children}</p>,
  h3: ({ children }) => <p className="my-0 font-semibold [&:not(:first-child)]:mt-2">{children}</p>,
  h4: ({ children }) => <p className="my-0 font-semibold [&:not(:first-child)]:mt-2">{children}</p>,
  code: ({ children }) => <code className="rounded bg-surface-sunken px-1 py-0.5 text-[0.9em]">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto whitespace-pre-wrap text-[0.9em]">{children}</pre>,
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border-soft px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border-soft px-2 py-1">{children}</td>,
};

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className="chat-markdown min-w-0 break-words" data-testid="chat-markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={defaultUrlTransform} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
