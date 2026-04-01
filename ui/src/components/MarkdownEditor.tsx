import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Code2,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
} from "lucide-react";
import { buildAgentMentionHref, buildProjectMentionHref } from "@agentdash/shared";
import { AgentIcon } from "./AgentIconPicker";
import { cn } from "../lib/utils";

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project";
  agentId?: string;
  agentIcon?: string | null;
  projectId?: string;
  projectColor?: string | null;
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  bordered?: boolean;
  mentions?: MentionOption[];
  onSubmit?: () => void;
}

export interface MarkdownEditorRef {
  focus: () => void;
}

interface MentionState {
  query: string;
  start: number;
  end: number;
}

interface SelectionRange {
  start: number;
  end: number;
}

function mentionMarkdown(option: MentionOption): string {
  if (option.kind === "project" && option.projectId) {
    return `[@${option.name}](${buildProjectMentionHref(option.projectId, option.projectColor ?? null)}) `;
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return `[@${option.name}](${buildAgentMentionHref(agentId, option.agentIcon ?? null)}) `;
}

function detectMention(markdown: string, caret: number): MentionState | null {
  const beforeCaret = markdown.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;

  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  return {
    query,
    start,
    end: caret,
  };
}

function normalizeSelection(textarea: HTMLTextAreaElement | null): SelectionRange {
  if (!textarea) {
    return { start: 0, end: 0 };
  }
  return {
    start: textarea.selectionStart ?? 0,
    end: textarea.selectionEnd ?? 0,
  };
}

type InsertMode = "wrap" | "prefix";

interface ToolbarAction {
  id: string;
  label: string;
  icon: typeof Bold;
  mode: InsertMode;
  prefix: string;
  suffix?: string;
  placeholder?: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { id: "bold", label: "Bold", icon: Bold, mode: "wrap", prefix: "**", suffix: "**", placeholder: "bold text" },
  { id: "italic", label: "Italic", icon: Italic, mode: "wrap", prefix: "_", suffix: "_", placeholder: "italic text" },
  { id: "code", label: "Code", icon: Code2, mode: "wrap", prefix: "`", suffix: "`", placeholder: "code" },
  { id: "link", label: "Link", icon: Link2, mode: "wrap", prefix: "[", suffix: "](https://example.com)", placeholder: "label" },
  { id: "Heading", label: "Heading", icon: Heading2, mode: "prefix", prefix: "## " },
  { id: "Bullet list", label: "Bullet list", icon: List, mode: "prefix", prefix: "- " },
  { id: "Numbered list", label: "Numbered list", icon: ListOrdered, mode: "prefix", prefix: "1. " },
  { id: "Quote", label: "Quote", icon: MessageSquareQuote, mode: "prefix", prefix: "> " },
];

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  contentClassName,
  onBlur,
  imageUploadHandler,
  bordered = true,
  mentions,
  onSubmit,
}: MarkdownEditorProps, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestValueRef = useRef(value);
  const selectionRef = useRef<SelectionRange>({ start: 0, end: 0 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const filteredMentions = useMemo(() => {
    if (!mentionState || !mentions || mentions.length === 0) return [];
    const query = mentionState.query.trim().toLowerCase();
    return mentions
      .filter((mention) => (query ? mention.name.toLowerCase().includes(query) : true))
      .slice(0, 8);
  }, [mentionState, mentions]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 140)}px`;
  }, []);

  useEffect(() => {
    latestValueRef.current = value;
    resizeTextarea();
  }, [resizeTextarea, value]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }), []);

  const updateSelectionState = useCallback(() => {
    const textarea = textareaRef.current;
    const selection = normalizeSelection(textarea);
    selectionRef.current = selection;
    if (!textarea || !mentions || mentions.length === 0 || selection.start !== selection.end) {
      setMentionState(null);
      return;
    }
    setMentionState(detectMention(textarea.value, selection.start));
    setMentionIndex(0);
  }, [mentions]);

  const applyValue = useCallback((next: string, nextSelection?: SelectionRange) => {
    latestValueRef.current = next;
    onChange(next);
    requestAnimationFrame(() => {
      resizeTextarea();
      const textarea = textareaRef.current;
      if (!textarea || !nextSelection) {
        updateSelectionState();
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextSelection.start, nextSelection.end);
      selectionRef.current = nextSelection;
      updateSelectionState();
    });
  }, [onChange, resizeTextarea, updateSelectionState]);

  const insertImageMarkdown = useCallback(async (file: File) => {
    if (!imageUploadHandler) return;

    try {
      const src = await imageUploadHandler(file);
      setUploadError(null);
      const textarea = textareaRef.current;
      const { start, end } = normalizeSelection(textarea);
      const before = latestValueRef.current.slice(0, start);
      const after = latestValueRef.current.slice(end);
      const needsLeadingNewline = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const needsTrailingNewline = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
      const snippet = `${needsLeadingNewline}![](${src})\n${needsTrailingNewline}`;
      const next = `${before}${snippet}${after}`;
      const caret = before.length + snippet.length;
      applyValue(next, { start: caret, end: caret });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image upload failed";
      setUploadError(message);
    }
  }, [applyValue, imageUploadHandler]);

  const updateText = useCallback((next: string) => {
    latestValueRef.current = next;
    onChange(next);
    requestAnimationFrame(() => {
      resizeTextarea();
      updateSelectionState();
    });
  }, [onChange, resizeTextarea, updateSelectionState]);

  const applyToolbarAction = useCallback((action: ToolbarAction) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = normalizeSelection(textarea);
    const current = latestValueRef.current;
    const selected = current.slice(start, end);

    if (action.mode === "wrap") {
      const inner = selected || action.placeholder || "";
      const next = `${current.slice(0, start)}${action.prefix}${inner}${action.suffix ?? ""}${current.slice(end)}`;
      const innerStart = start + action.prefix.length;
      const innerEnd = innerStart + inner.length;
      applyValue(next, { start: innerStart, end: innerEnd });
      return;
    }

    const lineStart = current.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const next = `${current.slice(0, lineStart)}${action.prefix}${current.slice(lineStart)}`;
    const nextPos = start + action.prefix.length;
    applyValue(next, { start: nextPos, end: nextPos });
  }, [applyValue]);

  const selectMention = useCallback((option: MentionOption) => {
    if (!mentionState) return;
    const current = latestValueRef.current;
    const replacement = mentionMarkdown(option);
    const next = `${current.slice(0, mentionState.start)}${replacement}${current.slice(mentionState.end)}`;
    const caret = mentionState.start + replacement.length;
    setMentionState(null);
    applyValue(next, { start: caret, end: caret });
  }, [applyValue, mentionState]);

  const dropdownAnchor = useMemo(() => {
    const textarea = textareaRef.current;
    if (!textarea) return null;
    const rect = textarea.getBoundingClientRect();
    const textBeforeCursor = (value ?? "").slice(0, selectionRef.current.start);
    const lines = textBeforeCursor.split("\n").length;
    const style = getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const approxCursorY = rect.top + paddingTop + (lines * lineHeight) - textarea.scrollTop;
    const top = Math.min(Math.max(approxCursorY + lineHeight, rect.top), rect.bottom);
    return { top: top + 4, left: rect.left };
  }, [mentionState, value]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
      return;
    }

    if (!mentionState || filteredMentions.length === 0) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setMentionState(null);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((current) => Math.min(current + 1, filteredMentions.length - 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMention(filteredMentions[mentionIndex]);
    }
  }, [filteredMentions, mentionIndex, mentionState, onSubmit, selectMention]);

  return (
    <div
      className={cn(
        "relative overflow-visible bg-transparent",
        bordered ? "rounded-md border border-border" : "",
        isDragOver && "ring-1 ring-primary/60 bg-accent/20",
        className,
      )}
      onDragEnter={(event) => {
        if (!imageUploadHandler || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
          return;
        }
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        if (!imageUploadHandler) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setIsDragOver(false);
        }
      }}
      onDrop={async (event) => {
        dragDepthRef.current = 0;
        setIsDragOver(false);
        if (!imageUploadHandler) return;
        event.preventDefault();
        const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/"));
        if (file) {
          await insertImageMarkdown(file);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border/70 px-2 py-1.5">
        {TOOLBAR_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => applyToolbarAction(action)}
              title={action.label}
            >
              <Icon className="h-4 w-4" />
              <span className="sr-only">{action.label}</span>
            </button>
          );
        })}
        {imageUploadHandler && (
          <label className="ml-auto inline-flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <ImageIcon className="h-4 w-4" />
            <span>Image</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) {
                  await insertImageMarkdown(file);
                }
                event.target.value = "";
              }}
            />
          </label>
        )}
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) => updateText(event.target.value)}
        onBlur={() => onBlur?.()}
        onKeyDown={handleKeyDown}
        onClick={updateSelectionState}
        onKeyUp={updateSelectionState}
        onSelect={updateSelectionState}
        onPaste={async (event) => {
          if (!imageUploadHandler) return;
          const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/"));
          if (!file) return;
          event.preventDefault();
          await insertImageMarkdown(file);
        }}
        className={cn(
          "min-h-[140px] w-full resize-y bg-transparent px-3 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground",
          "focus-visible:outline-none",
          contentClassName,
        )}
        spellCheck={false}
      />

      {mentionState && filteredMentions.length > 0 && dropdownAnchor && createPortal(
        <div
          className="fixed z-[9999] min-w-[180px] max-h-[200px] overflow-y-auto rounded-md border border-border bg-popover shadow-md"
          style={{ top: dropdownAnchor.top, left: dropdownAnchor.left }}
        >
          {filteredMentions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                index === mentionIndex && "bg-accent",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                selectMention(option);
              }}
              onMouseEnter={() => setMentionIndex(index)}
            >
              {option.kind === "project" && option.projectId ? (
                <span
                  className="inline-flex h-2 w-2 rounded-full border border-border/50"
                  style={{ backgroundColor: option.projectColor ?? "#64748b" }}
                />
              ) : (
                <AgentIcon
                  icon={option.agentIcon}
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span>{option.name}</span>
              {option.kind === "project" && option.projectId && (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                  Project
                </span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {isDragOver && imageUploadHandler && (
        <div className={cn(
          "pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-md border border-dashed border-primary/80 bg-primary/10 text-xs font-medium text-primary",
          !bordered && "inset-0 rounded-sm",
        )}
        >
          Drop image to upload
        </div>
      )}

      {uploadError && <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>}
    </div>
  );
});
