// AgentDash (#209): chat substrate message composer with @mention typeahead.
//
// Behavior:
//   - Type "@" → open dropdown listing all agents in the company directory
//   - Continue typing → filter by name AND role (case-insensitive substring)
//   - ArrowDown / ArrowUp navigate the list
//   - Tab or Enter completes the highlighted entry (inserts "@<name> ")
//   - Esc dismisses without inserting
//   - Click on a list entry also completes
//   - Enter (when menu closed) sends the message; Shift+Enter inserts newline
//   - Role-by-alias: typing "@SDR" filters by role token so role-mentions work
//
// Trade-off: still an <input>, not a <textarea>. Multi-line composition is a
// separate ask (chat substrate spec §11) and not in #209's scope.
import { useMemo, useState } from "react";
import { SendHorizontal } from "lucide-react";

interface AgentDirEntry {
  id: string;
  name: string;
  role: string;
}

export function Composer({
  onSend,
  agentDirectory,
}: {
  onSend: (body: string) => void;
  agentDirectory: AgentDirEntry[];
}) {
  const [value, setValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // The mention query is everything after the last `@` (until whitespace).
  // Null means no active mention being typed.
  const mentionQuery = extractMentionQuery(value);
  const showMentionMenu = mentionQuery !== null && agentDirectory.length > 0;

  // Filter the directory against the query. Empty query (bare `@`) shows all.
  const filtered = useMemo(() => {
    if (!showMentionMenu) return [];
    const q = (mentionQuery ?? "").toLowerCase();
    if (!q) return agentDirectory.slice(0, 8);
    return agentDirectory
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [agentDirectory, mentionQuery, showMentionMenu]);

  // Clamp the highlighted row whenever the filter changes.
  const safeActiveIndex = filtered.length === 0
    ? 0
    : Math.min(activeIndex, filtered.length - 1);

  function send() {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    setActiveIndex(0);
  }

  function completeWith(agent: AgentDirEntry) {
    // Replace the in-progress "@<query>" with "@<canonical-name> " so the
    // server-side parseMentions can resolve unambiguously.
    setValue((prev) => prev.replace(/@[A-Za-z0-9_-]*$/, `@${agent.name} `));
    setActiveIndex(0);
  }

  const isEmpty = !value.trim();

  return (
    <div className="composer relative flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type="text"
          className="w-full border border-border-soft rounded-xl px-4 py-2 bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 transition-[color,box-shadow] text-sm"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            // Menu-navigation keys take priority when the menu is open.
            if (showMentionMenu && filtered.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % filtered.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                completeWith(filtered[safeActiveIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // Strip the in-progress "@..." so the menu closes without
                // completing.
                setValue((prev) => prev.replace(/@[A-Za-z0-9_-]*$/, ""));
                setActiveIndex(0);
                return;
              }
            }
            // Default Enter = send when menu isn't open.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message your Chief of Staff…  Tip: @ to mention an agent"
          aria-label="Message input"
          aria-autocomplete="list"
          aria-expanded={showMentionMenu}
          aria-controls={showMentionMenu ? "mention-menu" : undefined}
          autoComplete="off"
        />
      </div>

      {/* Send icon button */}
      <button
        className="w-9 h-9 rounded-full bg-accent-500 flex items-center justify-center shrink-0 hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={send}
        disabled={isEmpty}
        aria-label="Send message"
      >
        <SendHorizontal className="w-4 h-4 text-text-inverse" />
      </button>

      {/* @mention dropdown */}
      {showMentionMenu && filtered.length > 0 && (
        <div
          id="mention-menu"
          role="listbox"
          aria-label="Mention an agent"
          className="mention-menu absolute bottom-full left-0 mb-2 bg-surface-raised border border-border-soft rounded-lg shadow-md p-1 min-w-[220px] max-w-[320px] z-10"
        >
          {filtered.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === safeActiveIndex}
              className={
                "block w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors " +
                (i === safeActiveIndex
                  ? "bg-surface-sunken text-text-primary"
                  : "text-text-primary hover:bg-surface-sunken")
              }
              // Use onMouseDown so the click fires before the input loses
              // focus (which would close the menu on blur).
              onMouseDown={(e) => {
                e.preventDefault();
                completeWith(a);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="font-medium">@{a.name}</span>
              <span className="text-text-tertiary"> · {a.role}</span>
            </button>
          ))}
        </div>
      )}

      {showMentionMenu && filtered.length === 0 && (
        <div className="mention-menu absolute bottom-full left-0 mb-2 bg-surface-raised border border-border-soft rounded-lg shadow-md px-3 py-2 text-xs text-text-tertiary">
          No agents match.
        </div>
      )}
    </div>
  );
}

/**
 * Returns the in-progress mention query (the chars after the last @ up to the
 * caret), or null when the user isn't currently typing a mention.
 *
 * Valid: "@" → "", "@re" → "re", "hi @rees" → "rees"
 * Invalid (returns null): "hi @reese ", "no mention here", "@@", "user@host"
 *
 * The "no leading word character" rule (`(?:^|\s)@…`) is what differentiates
 * an email-like "user@host" from a true mention.
 */
function extractMentionQuery(text: string): string | null {
  // The caret is always at the end of `text` (controlled <input> with no
  // explicit selectionStart wiring). So we only need to look at the tail.
  const match = text.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match) return null;
  return match[1];
}
