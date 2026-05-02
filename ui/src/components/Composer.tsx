// AgentDash: chat substrate message composer with @mention support
import { useState } from "react";

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

  return (
    <div className="composer relative flex gap-2">
      <textarea
        className="border border-border-soft rounded-md px-3 py-2 flex-1 bg-surface-raised text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 resize-none transition-[color,box-shadow]"
        rows={2}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setShowMentionMenu(/@[A-Za-z][A-Za-z0-9_-]*$/.test(e.target.value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Type a message…  Tip: @reese to talk to an agent directly"
      />
      <button
        className="bg-accent-500 text-text-inverse px-4 rounded-md font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-50"
        onClick={send}
        aria-label="Send message"
      >
        Send
      </button>
      {showMentionMenu && agentDirectory.length > 0 && (
        <div className="mention-menu absolute bottom-full left-0 bg-surface-raised border border-border-soft rounded-lg shadow-md p-1">
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
