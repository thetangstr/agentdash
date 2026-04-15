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
  if (message.role === "tool_use" || message.role === "tool_result") {
    return (
      <ToolCard
        toolName={message.toolName ?? message.role}
        content={message.content}
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
        {message.content || (message.isStreaming ? "…" : "")}
      </div>
    </div>
  );
}

export function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
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

  const sendMessage = useCallback(async () => {
    const text = input.trim();
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

          let chunk: { type: string; text?: string; toolName?: string; toolInput?: Record<string, unknown>; content?: string; conversationId?: string; error?: string };
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

            case "tool_use": {
              const toolMsgId = crypto.randomUUID();
              setMessages((prev) => [
                ...prev.slice(0, -1), // temporarily remove assistant bubble
                {
                  id: toolMsgId,
                  role: "tool_use",
                  content: chunk.toolInput ? JSON.stringify(chunk.toolInput, null, 2) : "",
                  toolName: chunk.toolName ?? "tool",
                },
                prev[prev.length - 1]!, // put assistant bubble back
              ]);
              break;
            }

            case "tool_result": {
              const resultMsgId = crypto.randomUUID();
              setMessages((prev) => [
                ...prev.slice(0, -1),
                {
                  id: resultMsgId,
                  role: "tool_result",
                  content: chunk.content ?? "",
                  toolName: chunk.toolName ?? "tool",
                },
                prev[prev.length - 1]!,
              ]);
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
              setError(chunk.error ?? "An error occurred.");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: chunk.error ?? "An error occurred.", isStreaming: false }
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
  }, [input, isLoading, selectedCompanyId, conversationId]);

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
        <span className="flex-1 text-sm font-semibold">Assistant</span>
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
              Select a company to start chatting with the assistant.
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">AgentDash Assistant</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Ask about agents, pipelines, tasks, or anything about your workspace.
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
