import { describe, expect, it, vi, afterEach } from "vitest";
import { PaperclipApiClient } from "./client.js";
import {
  RESOURCE_TEMPLATES,
  listResources,
  readAgentDashResource,
} from "./resources.js";

/**
 * AgentDash-MK Slice G9 — the derivation record, served over MCP.
 *
 * **Read-only, opt-in, no enforcement claimed.** MCP resources are
 * application-controlled and prompts are user-controlled: nothing here verifies
 * that a harness read anything, and nothing here can. This is shared context,
 * not governance, and the descriptions say so — implying otherwise would be
 * claiming a control that does not exist, which is worse than not shipping one.
 *
 * Every served figure carries its age and who last confirmed it, because a human
 * at the end of a workflow catches errors but not wrong foundations: a stale
 * premise passes review silently, every time, and the only defence is that the
 * staleness travels with the number.
 */

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "company-1",
  agentId: null,
  runId: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("derivation record resources", () => {
  it("advertises both templates, and says plainly that nothing enforces them", () => {
    const uris = RESOURCE_TEMPLATES.map((template) => template.uriTemplate);
    expect(uris).toContain("agentdash://facts/{key}");
    expect(uris).toContain("agentdash://deliverables/{key}/latest");

    // The honesty requirement, asserted rather than trusted to a reviewer. We
    // ship shared context and must never call it governance.
    for (const template of RESOURCE_TEMPLATES) {
      expect(template.description.toLowerCase()).toContain("read-only");
      expect(
        /nothing (verifies|checks)|not (a )?polic|no enforcement/i.test(template.description),
        `${template.uriTemplate} claims more than it can do: ${template.description}`,
      ).toBe(true);
    }
  });

  it("keeps the existing static resources", () => {
    const uris = listResources().map((resource) => resource.uri);
    expect(uris).toContain("agentdash://playbook");
    expect(uris).toContain("agentdash://agents");
  });

  it("reads one fact's derivation record from the control plane", async () => {
    const calls = stubFetch({
      factKey: "labour.hours_booked",
      derivation: "Sum of the Hours column of the WeeklyHours table.",
      current: { value: 412, ageSeconds: 3_600 },
      lastConfirmedBy: { userId: "user-2", at: "2026-07-30T10:00:00Z", stage: "second" },
    });

    const client = new PaperclipApiClient({ ...CONFIG });
    const result = await readAgentDashResource(
      client,
      { companyId: CONFIG.companyId },
      "agentdash://facts/labour.hours_booked",
    );

    expect(calls[0]).toContain("/companies/company-1/fact-records/labour.hours_booked");
    const text = result!.contents[0]!.text as string;
    expect(text).toContain("WeeklyHours");
    expect(text).toContain("ageSeconds");
    expect(text).toContain("lastConfirmedBy");
  });

  it("percent-encodes a fact key so a dotted or slashed key cannot escape its path", async () => {
    const calls = stubFetch({ factKey: "x" });
    const client = new PaperclipApiClient({ ...CONFIG });
    await readAgentDashResource(
      client,
      { companyId: CONFIG.companyId },
      "agentdash://facts/..%2F..%2Fadmin",
    );
    // The decoded key is re-encoded, so traversal characters stay inside the
    // path segment instead of becoming path structure.
    expect(calls[0]).not.toContain("/admin");
    expect(calls[0]).toContain("fact-records/..%2F..%2Fadmin");
  });

  it("reads the last shipped run of a deliverable", async () => {
    const calls = stubFetch({ runKey: "2026-W31", facts: [] });
    const client = new PaperclipApiClient({ ...CONFIG });
    const result = await readAgentDashResource(
      client,
      { companyId: CONFIG.companyId },
      "agentdash://deliverables/weekly-project-review/latest",
    );
    expect(calls[0]).toContain("/companies/company-1/deliverables/weekly-project-review/latest");
    expect(result!.contents[0]!.text as string).toContain("2026-W31");
  });

  it("says what to set rather than failing obscurely when no company is configured", async () => {
    const client = new PaperclipApiClient({ ...CONFIG, companyId: null });
    const result = await readAgentDashResource(
      client,
      { companyId: null },
      "agentdash://facts/labour.hours_booked",
    );
    expect(result!.contents[0]!.text as string).toContain("PAPERCLIP_COMPANY_ID");
  });

  it("returns null for a URI it does not serve, so the caller can fall through", async () => {
    const client = new PaperclipApiClient({ ...CONFIG });
    expect(
      await readAgentDashResource(client, { companyId: CONFIG.companyId }, "agentdash://playbook"),
    ).toBeNull();
  });

  it("never issues a write to the control plane", async () => {
    // Read-only is a property of this surface, not an instruction to whoever
    // reads it. There is one HTTP verb in the file and it is GET.
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | string, init?: RequestInit) => {
        methods.push(String(init?.method ?? "GET"));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const client = new PaperclipApiClient({ ...CONFIG });
    await readAgentDashResource(client, { companyId: CONFIG.companyId }, "agentdash://facts/a");
    await readAgentDashResource(
      client,
      { companyId: CONFIG.companyId },
      "agentdash://deliverables/d/latest",
    );
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
});
