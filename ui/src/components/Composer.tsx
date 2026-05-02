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
        className="border rounded px-3 py-2 flex-1"
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
      <button className="bg-blue-600 text-white px-3 rounded" onClick={send}>
        Send
      </button>
      {showMentionMenu && agentDirectory.length > 0 && (
        <div className="mention-menu absolute bottom-full left-0 bg-white border rounded shadow p-1">
          {agentDirectory.map((a) => (
            <button
              key={a.id}
              className="block w-full text-left px-2 py-1 hover:bg-gray-100"
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
