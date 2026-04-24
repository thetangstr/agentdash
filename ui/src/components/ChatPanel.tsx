// AgentDash: Assistant Chat Panel
import { useState, useRef, useEffect, useCallback } from "react";
import { X, Send, Bot, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { assistantApi } from "../api/assistant";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isStreaming?: boolean;
}

interface ToolCardProps {
  toolName: string;
  content: string;
  role: "tool_use" | "tool_result";
}

function ToolCard({ toolName, content, role }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-medium">{toolName}</span>
        <span className="ml-1 text-muted-foreground/60">
          {role === "tool_use" ? "called" : "result"}
        </span>
        <span className="ml-auto">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (!message) return null;
  const content = typeof message.content === "string" ? message.content : String(message.content ?? "");

  if (message.role === "tool_use" || message.role === "tool_result") {
    return (
      <ToolCard
        toolName={message.toolName ?? message.role}
        content={content}
        role={message.role}
      />
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="mr-2 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-3.5 w-3.5" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "rounded-tr-sm bg-accent text-foreground"
            : "rounded-tl-sm bg-card text-foreground shadow-sm",
          message.isStreaming && "animate-pulse",
        )}
      >
        {content || (message.isStreaming ? "…" : "")}
      </div>
    </div>
  );
}

export function ChatPanel({
  open,
  onClose,
  seedMessage,
  onSeedConsumed,
}: {
  open: boolean;
  onClose: () => void;
  // AgentDash (AGE-50 Phase 4b): initial message auto-sent to the Chief of
  // Staff when the panel opens with a seed. Used by PlanApprovalCard to
  // trigger /deep-interview for company-level goals.
  seedMessage?: string | null;
  onSeedConsumed?: () => void;
}) {
  const { selectedCompanyId } = useCompany();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [input]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  // AgentDash: close the panel and reset conversation state when the
  // operator switches company. A conversation is scoped to one company, so
  // carrying it across would send the next message to the wrong backend.
  const prevCompanyIdRef = useRef<string | null | undefined>(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyIdRef.current === selectedCompanyId) return;
    prevCompanyIdRef.current = selectedCompanyId;
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(undefined);
    setError(null);
    setInput("");
    onClose();
  }, [selectedCompanyId, onClose]);

  // AgentDash (AGE-50 Phase 4b): internal helper that accepts an explicit
  // message. Lets sendMessage use the current input state, and lets the
  // seed-message effect bypass the input entirely.
  const sendText = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || isLoading || !selectedCompanyId) return;

    setInput("");
    setError(null);

    const userMsgId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: userMsgId, role: "user", content: text }]);

    const assistantMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: "assistant", content: "", isStreaming: true },
    ]);
    setIsLoading(true);

    abortRef.current = new AbortController();

    try {
      const response = await assistantApi.chat(selectedCompanyId, text, conversationId);

      if (!response.ok) {
        const errBody = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errBody?.error ?? `Request failed: ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;

          let chunk: { type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: string; conversationId?: string; message?: string };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          switch (chunk.type) {
            case "text":
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: m.content + (chunk.text ?? ""), isStreaming: true }
                    : m,
                ),
              );
              break;

            // Server sends both tool calls and tool results as type="tool_use";
            // results have names ending in "_result".
            case "tool_use": {
              const toolMsgId = crypto.randomUUID();
              const isResult = (chunk.name ?? "").endsWith("_result");
              const displayName = isResult
                ? (chunk.name ?? "tool").replace(/_result$/, "")
                : (chunk.name ?? "tool");
              let contentStr: string;
              try {
                contentStr = chunk.input
                  ? JSON.stringify(chunk.input, null, 2)
                  : (chunk.content ?? "");
              } catch {
                contentStr = "(unserializable tool input)";
              }
              const toolMsg = {
                id: toolMsgId,
                role: isResult ? ("tool_result" as const) : ("tool_use" as const),
                content: contentStr,
                toolName: displayName,
              };
              // Insert the tool card before the streaming assistant bubble
              // (which is always the last entry mid-stream). If for any
              // reason there is no tail, just append — never inject
              // `undefined` into the array, which would crash rendering.
              setMessages((prev) => {
                if (prev.length === 0) return [toolMsg];
                const tail = prev[prev.length - 1];
                return [...prev.slice(0, -1), toolMsg, tail];
              });
              break;
            }

            case "done":
              if (chunk.conversationId) {
                setConversationId(chunk.conversationId);
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, isStreaming: false } : m,
                ),
              );
              break;

            case "error":
              setError(chunk.message ?? "An error occurred.");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: chunk.message ?? "An error occurred.", isStreaming: false }
                    : m,
                ),
              );
              break;
          }
        }
      }

      // Mark streaming done if not already
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, isStreaming: false } : m,
        ),
      );
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Failed to send message.";
      setError(msg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: msg, isStreaming: false }
            : m,
        ),
      );
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [isLoading, selectedCompanyId, conversationId]);

  // AgentDash (AGE-50 Phase 4b): button/enter-key path — sends whatever is
  // currently in the input field.
  const sendMessage = useCallback(() => {
    return sendText(input);
  }, [sendText, input]);

  // AgentDash (AGE-50 Phase 4b): seed-message effect. When the panel opens
  // with a seed (e.g. PlanApprovalCard triggered a deep-interview), send
  // it once and notify the parent to clear the seed so subsequent opens
  // don't re-send.
  useEffect(() => {
    if (open && seedMessage && !isLoading && selectedCompanyId) {
      void sendText(seedMessage);
      onSeedConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedMessage, selectedCompanyId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  const handleNewConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(undefined);
    setError(null);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  if (!open) return null;

  return (
    <div
      className={cn(
        "flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-background",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bot className="h-4 w-4 text-primary" />
        <span className="flex-1 text-sm font-semibold">Chief of Staff</span>
        {messages.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={handleNewConversation}
          >
            New chat
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onClose}
          aria-label="Close chat panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {!selectedCompanyId ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-center text-sm text-muted-foreground">
              Select a company to start chatting with your Chief of Staff.
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">Chief of Staff</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Talk through goals, delegate work, or get a read on what your agents are doing.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))
        )}
        {error && (
          <p className="text-center text-xs text-destructive">{error}</p>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        {!selectedCompanyId ? (
          <p className="text-center text-xs text-muted-foreground">No company selected</p>
        ) : (
          <div className="flex items-end gap-2 rounded-xl border border-border bg-card px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything…"
              rows={1}
              disabled={isLoading}
              className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
              style={{ maxHeight: "120px", overflowY: "auto" }}
            />
            <Button
              type="button"
              size="icon-sm"
              disabled={!input.trim() || isLoading}
              onClick={() => void sendMessage()}
              aria-label="Send message"
              className="shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          Enter to send · Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}
