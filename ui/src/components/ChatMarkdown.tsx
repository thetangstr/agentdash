// AgentDash (scan 4, lane N): the CoS writes plain markdown ("- " lists,
// **bold**), which the chat bubble used to show literally. This renders it,
// safely: react-markdown never renders raw HTML (no rehype-raw), links go
// through its default URL filter (no javascript: or data: URLs) and open in a
// new tab, and images are shown as their alt text, never fetched.
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";

// Single line breaks stay line breaks, as they read in a chat bubble.
const REMARK_PLUGINS = [remarkGfm, remarkSoftBreaks];

const components: Components = {
  p: ({ children }) => <p className="my-0 [&:not(:first-child)]:mt-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
      {children}
    </a>
  ),
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
