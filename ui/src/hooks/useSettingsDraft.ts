import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

/** What a section's save row needs to know about its draft. */
export interface SettingsDraftControls {
  isDirty: boolean;
  isSaving: boolean;
  /** The last save succeeded and nothing has changed since. */
  isSaved: boolean;
  /** The last save's error, while the draft it failed on is still here. */
  error: unknown;
  save: (options?: { onSuccess?: () => void }) => void;
  discard: () => void;
}

export interface SettingsDraftSaveOptions<T> {
  onSuccess?: () => void;
  /**
   * Values to save along with the draft, for a confirm step that decides a
   * field itself. Only those that differ from the server are sent; when
   * nothing differs, nothing is sent and `onSuccess` runs at once.
   */
  include?: Partial<T>;
}

export interface SettingsDraft<T extends Record<string, unknown>> extends SettingsDraftControls {
  /** The server values with the draft's edits on top: what the controls show. */
  values: T;
  /** Only the fields that differ from the server. */
  changes: Partial<T>;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  save: (options?: SettingsDraftSaveOptions<T>) => void;
}

export function isSameSettingValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && isSameSettingValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * One settings section's draft. Switches, selects and fields change the
 * draft; nothing is sent until `save()`. `changes` holds only the fields that
 * differ from the server, and one save sends exactly those in one request. A
 * failed save keeps the draft so the person can try again or discard it.
 *
 * The draft is kept as edits over the server values, not as a copy of them,
 * so a refetch never overwrites what the person is editing. `resetKey` names
 * what the section edits (a company id, say): when it changes, the edits and
 * the last save's outcome no longer apply.
 */
export function useSettingsDraft<T extends Record<string, unknown>, R = unknown>({
  saved,
  save,
  onSaved,
  resetKey = "",
}: {
  saved: T;
  save: (changes: Partial<T>) => Promise<R>;
  /** Runs after a successful save, before the draft is cleared (refresh the server values here). */
  onSaved?: (result: R, changes: Partial<T>) => unknown;
  resetKey?: string;
}): SettingsDraft<T> {
  const [state, setState] = useState<{ key: string; edits: Partial<T> }>({ key: resetKey, edits: {} });
  const edits: Partial<T> = state.key === resetKey ? state.edits : {};

  const mutation = useMutation({
    mutationFn: (variables: { key: string; changes: Partial<T> }) => save(variables.changes),
    onSuccess: async (result, variables) => {
      await onSaved?.(result, variables.changes);
      // Drop the edits that were saved; the server values now carry them.
      setState((current) => {
        if (current.key !== variables.key) return current;
        const next: Partial<T> = { ...current.edits };
        for (const key of Object.keys(variables.changes) as Array<keyof T>) {
          if (isSameSettingValue(next[key], variables.changes[key])) delete next[key];
        }
        return { key: current.key, edits: next };
      });
    },
  });

  const values = { ...saved, ...edits } as T;
  const changes: Partial<T> = {};
  for (const key of Object.keys(edits) as Array<keyof T>) {
    if (!isSameSettingValue(edits[key], saved[key])) changes[key] = edits[key];
  }
  const isDirty = Object.keys(changes).length > 0;
  const forThisKey = mutation.variables?.key === resetKey;

  return {
    values,
    changes,
    isDirty,
    isSaving: mutation.isPending,
    isSaved: mutation.isSuccess && forThisKey && !isDirty,
    error: mutation.isError && forThisKey ? mutation.error : null,
    set: (key, value) => {
      setState((current) => ({
        key: resetKey,
        edits: { ...(current.key === resetKey ? current.edits : {}), [key]: value } as Partial<T>,
      }));
    },
    save: (options) => {
      if (mutation.isPending) return;
      const toSend: Partial<T> = { ...changes };
      for (const key of Object.keys(options?.include ?? {}) as Array<keyof T>) {
        const value = options!.include![key];
        if (isSameSettingValue(value, saved[key])) delete toSend[key];
        else toSend[key] = value;
      }
      if (Object.keys(toSend).length === 0) {
        options?.onSuccess?.();
        return;
      }
      mutation.mutate({ key: resetKey, changes: toSend }, { onSuccess: () => options?.onSuccess?.() });
    },
    discard: () => {
      setState({ key: resetKey, edits: {} });
      mutation.reset();
    },
  };
}
