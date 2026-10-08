// @vitest-environment jsdom
// AgentDash: exercise real forms and the first-party JSON API. No mailbox,
// provider, storage, or control-plane service is used by this test.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../MarketingShell", () => ({ MarketingShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { Start } from "../pages/Start";
import { StartProgress } from "../pages/StartProgress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const config = { turnstileSiteKey: null, signupOpen: true, waitlist: true, edgeDomain: "agentdash.cloud" };
const initialBox = { slug: "acme", url: "https://acme.agentdash.cloud", state: "waitlisted", phase: "waitlisted", stepIndex: null, slow: false, claimUrl: null, createdAt: "2026-10-08T00:00:00Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
let enabled: boolean | undefined;
let phase: string;
let mineCalls: number;
let posts: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }>;
let respond: (path: string) => Response | Promise<Response>;
let sessionEnded: boolean;
let configUnavailable: boolean;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  enabled = true;
  phase = "waitlisted";
  mineCalls = 0;
  sessionEnded = false;
  configUnavailable = false;
  posts = [];
  respond = () => json({ ok: true, provisioning: "waitlisted", reason: "at_capacity" });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts.push({ url, init, body: JSON.parse(init.body as string) });
      return respond(url);
    }
    if (url === "/api/cloud/config") {
      if (configUnavailable) throw new TypeError("Failed to fetch");
      return json({ ...config, ...(enabled === undefined ? {} : { invitationCodesEnabled: enabled }) });
    }
    if (url.startsWith("/api/cloud/slug-available")) return json({ available: true });
    if (url === "/api/cloud/boxes/mine") {
      mineCalls += 1;
      return sessionEnded ? json({ error: "Your session has ended.", code: "no_session" }, 401) : json({ email: "founder@acme.test", boxes: [{ ...initialBox, phase }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) { await act(async () => { root.render(node); }); }
function input(label: string): HTMLInputElement {
  const field = [...container.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label)?.querySelector("input");
  expect(field, `Field: ${label}`).toBeTruthy();
  return field!;
}
async function fill(label: string, value: string) {
  await act(async () => {
    const field = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function signupFields() {
  await fill("Work email", "founder@acme.test");
  await fill("Workspace name", "Acme");
  await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
}
async function submit(times = 1) {
  await act(async () => {
    for (let i = 0; i < times; i++) container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("hosted invitation signup", () => {
  it.each([undefined, false])("keeps old/disabled backends compatible (%s)", async (capability) => {
    enabled = capability;
    await render(<Start />);
    expect(container.textContent).not.toContain("Invitation code");
    await signupFields();
    await submit();
    expect(posts[0].body).toEqual({ email: "founder@acme.test", workspaceName: "Acme", slug: "acme", acceptTerms: true });
  });
  it("no code joins the waitlist without sending an empty invitation", async () => {
    await render(<Start />);
    expect(container.textContent).toContain("Without a code");
    await signupFields();
    await submit();
    expect(posts[0].body).not.toHaveProperty("invitationCode");
    expect(container.textContent).toContain("Check your email");
  });
  it("sends an invitation only in the first-party JSON body and clears it after success", async () => {
    await render(<Start />);
    await signupFields();
    expect(input("Invitation code (optional)").maxLength).toBe(120);
    await fill("Invitation code (optional)", "  AGD-TEST-ONLY  ");
    await submit();
    expect(posts[0]).toMatchObject({ url: "/api/cloud/signup", init: { credentials: "same-origin", headers: { "content-type": "application/json" } }, body: { invitationCode: "AGD-TEST-ONLY" } });
    expect(container.querySelector('input[autocomplete="off"]')).toBeNull();
    expect(window.location.href).not.toContain("AGD-TEST-ONLY");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("prevents duplicate signup requests while pending and shows invalid-code errors accessibly", async () => {
    let resolve!: (response: Response) => void;
    respond = () => new Promise((r) => { resolve = r; });
    await render(<Start />);
    await signupFields();
    await fill("Invitation code (optional)", "invalid-test-code");
    await submit(2);
    expect(posts).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => { resolve(json({ error: "This invitation is not available.", code: "invitation_invalid" }, 400)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("This invitation is not available.");
    expect(input("Invitation code (optional)").value).toBe("invalid-test-code");
  });
});

describe("verified waitlist invitation redemption", () => {
  it("submits once, clears the code, and refreshes approval without promising immediate capacity", async () => {
    let resolve!: (response: Response) => void;
    respond = () => new Promise((r) => { resolve = r; });
    await render(<StartProgress />);
    expect(input("Invitation code").maxLength).toBe(120);
    await fill("Invitation code", "  AGD-TEST-ONLY  ");
    await submit(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: "/api/cloud/invitation/redeem", body: { code: "AGD-TEST-ONLY" }, init: { credentials: "same-origin" } });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    phase = "approved";
    await act(async () => { resolve(json({ ok: true, provisioning: "waitlisted", reason: "at_capacity" })); });
    expect(mineCalls).toBe(2);
    expect(container.querySelector('input[autocomplete="off"]')).toBeNull();
    expect(container.textContent).toContain("capacity is available");
    expect(container.textContent).not.toContain("created shortly");
  });
  it("clears a successful code even while refreshed status remains waitlisted", async () => {
    await render(<StartProgress />);
    await fill("Invitation code", "AGD-TEST-ONLY");
    await submit();
    expect(input("Invitation code").value).toBe("");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("accepted");
  });
  it("shows invalid code errors and allows correction", async () => {
    respond = () => json({ error: "This invitation is not available.", code: "invitation_invalid" }, 400);
    await render(<StartProgress />);
    await fill("Invitation code", "invalid-test-code");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("This invitation is not available.");
    expect(input("Invitation code").value).toBe("invalid-test-code");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
  it("handles session expiry during redemption without retaining a redeem form", async () => {
    respond = () => json({ error: "Your session has ended.", code: "no_session" }, 401);
    await render(<StartProgress />);
    await fill("Invitation code", "AGD-TEST-ONLY");
    await submit();
    expect(container.textContent).toContain("Sign in to see your workspace");
    expect(container.querySelector("form")).toBeNull();
  });
  it("discloses a failed invitation configuration request and retries it", async () => {
    configUnavailable = true;
    await render(<StartProgress />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check your connection");
    expect(container.querySelector("form")).toBeNull();
    configUnavailable = false;
    await act(async () => {
      const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry invitation options");
      expect(retry).toBeTruthy();
      retry!.click();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input("Invitation code")).toBeTruthy();
  });
  it("does not offer redemption without a session", async () => {
    sessionEnded = true;
    await render(<StartProgress />);
    expect(container.textContent).toContain("Sign in to see your workspace");
    expect(container.querySelector("form")).toBeNull();
  });
  it.each([undefined, false])("does not offer redemption on older/disabled backends (%s)", async (capability) => {
    enabled = capability;
    await render(<StartProgress />);
    expect(container.querySelector("form")).toBeNull();
  });
  it.each(["approved", "provisioning", "ready", "active", "suspended", "failed", "closing"])("does not offer redemption in %s phase", async (nextPhase) => {
    phase = nextPhase;
    await render(<StartProgress />);
    expect(container.querySelector("form")).toBeNull();
  });
});
