// AgentDash: chat substrate message composer with @mention support
import { useState } from "react";
import { SendHorizontal } from "lucide-react";

export function Composer({
  onSend,
  agentDirectory,
}: {
  onSend: (body: string) => void;
  agentDirectory: Array<{ id: string; name: string; role: string }>;
}) {
  const [value, setValue] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);

  function send() {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    setShowMentionMenu(false);
  }

  const isEmpty = !value.trim();

  return (
    <div className="composer relative flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type="text"
          className="w-full border border-border-soft rounded-xl px-4 py-3 bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 transition-[color,box-shadow] text-sm"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setShowMentionMenu(
              agentDirectory.length > 0 && /@[A-Za-z][A-Za-z0-9_-]*$/.test(e.target.value),
            );
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message your Chief of Staff…"
          aria-label="Message input"
        />
      </div>

      {/* Send icon button */}
      <button
        className="w-10 h-10 rounded-full bg-accent-500 flex items-center justify-center shrink-0 hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={send}
        disabled={isEmpty}
        aria-label="Send message"
      >
        <SendHorizontal className="w-4 h-4 text-text-inverse" />
      </button>

      {/* @mention dropdown */}
      {showMentionMenu && agentDirectory.length > 0 && (
        <div className="mention-menu absolute bottom-full left-0 mb-2 bg-surface-raised border border-border-soft rounded-lg shadow-md p-1 min-w-[180px]">
          {agentDirectory.map((a) => (
            <button
              key={a.id}
              className="block w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-surface-sunken rounded-md transition-colors"
              onClick={() => {
                setValue(value.replace(/@\w*$/, "@" + a.name + " "));
                setShowMentionMenu(false);
              }}
            >
              @{a.name} · {a.role}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
