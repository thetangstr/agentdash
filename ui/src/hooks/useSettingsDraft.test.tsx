// @vitest-environment jsdom
// Settings save explicitly: a section's controls change a draft, and one
// "Save changes" sends only the fields that differ from the server.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSameSettingValue, useSettingsDraft, type SettingsDraft } from "./useSettingsDraft";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Form = { name: string; on: boolean };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let draft: SettingsDraft<Form>;
const save = vi.fn<(changes: Partial<Form>) => Promise<unknown>>();

function Probe({ saved, resetKey }: { saved: Form; resetKey: string }) {
  draft = useSettingsDraft<Form>({ saved, save, resetKey });
  return null;
}

async function render(saved: Form, resetKey = "company-1") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe saved={saved} resetKey={resetKey} />
      </QueryClientProvider>,
    );
  });
}

async function run(fn: () => void) {
  await act(async () => {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  save.mockReset();
  save.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSettingsDraft", () => {
  it("sends only the changed fields, in one request, and only on save", async () => {
    await render({ name: "Meridian", on: false });
    expect(draft.isDirty).toBe(false);
    await run(() => draft.set("on", true));
    await run(() => draft.set("name", "Meridian"));
    expect(save).not.toHaveBeenCalled();
    expect(draft.values).toEqual({ name: "Meridian", on: true });
    expect(draft.changes).toEqual({ on: true });
    await run(() => draft.save());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ on: true });
  });

  it("is clean again when an edit is set back to the server value", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await run(() => draft.set("on", false));
    expect(draft.isDirty).toBe(false);
    await run(() => draft.save());
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the draft and the error when a save fails", async () => {
    save.mockRejectedValueOnce(new Error("refused"));
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await run(() => draft.save());
    expect(draft.values.on).toBe(true);
    expect(draft.isDirty).toBe(true);
    expect((draft.error as Error).message).toBe("refused");
    await run(() => draft.discard());
    expect(draft.values.on).toBe(false);
    expect(draft.error).toBeNull();
  });

  it("reports saved once the server values carry the change", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await run(() => draft.save());
    await render({ name: "Meridian", on: true });
    expect(draft.isDirty).toBe(false);
    expect(draft.isSaved).toBe(true);
  });

  it("does not let a refetch overwrite what is being edited", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("name", "Meridian Labs"));
    await render({ name: "Meridian", on: true });
    expect(draft.values).toEqual({ name: "Meridian Labs", on: true });
  });

  it("drops the edits when the section moves to another record", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await render({ name: "Harbor", on: false }, "company-2");
    expect(draft.isDirty).toBe(false);
    expect(draft.values).toEqual({ name: "Harbor", on: false });
  });

  it("include adds a confirmed value, and sends nothing when it matches the server", async () => {
    await render({ name: "Meridian", on: false });
    const onSuccess = vi.fn();
    await run(() => draft.save({ include: { on: false }, onSuccess }));
    expect(save).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await run(() => draft.save({ include: { on: true } }));
    expect(save).toHaveBeenCalledWith({ on: true });
  });
});

describe("useSettingsDraft leaves no hidden edits", () => {
  it("a field set back to the saved value is no edit, so a later refetch shows the server value", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await run(() => draft.set("on", false));
    // Another tab turns it on; the page refetches.
    await render({ name: "Meridian", on: true });
    expect(draft.values.on).toBe(true);
    expect(draft.isDirty).toBe(false);
    expect(draft.changes).toEqual({});
  });

  it("a save with include clears that field's edit, whatever the edit held", async () => {
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("name", "Harbor"));
    await run(() => draft.save({ include: { name: "Meridian Labs" } }));
    expect(save).toHaveBeenCalledWith({ name: "Meridian Labs" });
    await render({ name: "Meridian Labs", on: false });
    expect(draft.values.name).toBe("Meridian Labs");
    expect(draft.isDirty).toBe(false);
  });

  it("an include that matches the server sends nothing and still clears that field's edit", async () => {
    await render({ name: "Meridian", on: true });
    await run(() => draft.set("on", false));
    const onSuccess = vi.fn();
    await run(() => draft.save({ include: { on: true }, onSuccess }));
    expect(save).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(draft.values.on).toBe(true);
    expect(draft.isDirty).toBe(false);
  });

  it("a save error clears once the person puts the draft back to the saved values", async () => {
    save.mockRejectedValueOnce(new Error("refused"));
    await render({ name: "Meridian", on: false });
    await run(() => draft.set("on", true));
    await run(() => draft.save());
    expect((draft.error as Error).message).toBe("refused");
    await run(() => draft.set("on", false));
    expect(draft.isDirty).toBe(false);
    expect(draft.error).toBeNull();
  });
});

describe("isSameSettingValue", () => {
  it("compares plain values and nested objects by content", () => {
    expect(isSameSettingValue("a", "a")).toBe(true);
    expect(isSameSettingValue({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(isSameSettingValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(isSameSettingValue([1], { 0: 1 })).toBe(false);
    expect(isSameSettingValue(null, {})).toBe(false);
  });
});
