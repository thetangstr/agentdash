import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REPORT_DESCRIPTION_LENGTH,
  MAX_REPORT_TITLE_LENGTH,
  buildIssueBody,
  buildIssueTitle,
  createIssueReport,
  resolveGitHubIssuesConfig,
  type GitHubIssuesConfig,
} from "./github-issues.js";

const config: GitHubIssuesConfig = {
  hostname: "github.com",
  owner: "thetangstr",
  repo: "agentdash",
  token: "test-token",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveGitHubIssuesConfig", () => {
  it("is disabled unless both repo and token are set", () => {
    expect(resolveGitHubIssuesConfig({})).toBeNull();
    expect(resolveGitHubIssuesConfig({ AGENTDASH_GITHUB_ISSUES_REPO: "a/b" })).toBeNull();
    expect(resolveGitHubIssuesConfig({ AGENTDASH_GITHUB_ISSUES_TOKEN: "t" })).toBeNull();
  });

  it("parses owner/repo and defaults to github.com", () => {
    expect(
      resolveGitHubIssuesConfig({
        AGENTDASH_GITHUB_ISSUES_REPO: " thetangstr/agentdash ",
        AGENTDASH_GITHUB_ISSUES_TOKEN: " tok ",
      }),
    ).toEqual({ hostname: "github.com", owner: "thetangstr", repo: "agentdash", token: "tok" });
  });

  it("honours an enterprise hostname", () => {
    expect(
      resolveGitHubIssuesConfig({
        AGENTDASH_GITHUB_ISSUES_REPO: "o/r",
        AGENTDASH_GITHUB_ISSUES_TOKEN: "t",
        AGENTDASH_GITHUB_ISSUES_HOSTNAME: "ghe.example.com",
      })?.hostname,
    ).toBe("ghe.example.com");
  });

  it("stays disabled rather than guessing when the repo is malformed", () => {
    // A misconfigured slug must not become a filing target.
    expect(
      resolveGitHubIssuesConfig({
        AGENTDASH_GITHUB_ISSUES_REPO: "just-a-repo",
        AGENTDASH_GITHUB_ISSUES_TOKEN: "t",
      }),
    ).toBeNull();
  });
});

describe("buildIssueTitle", () => {
  it("prefixes by kind", () => {
    expect(buildIssueTitle("bug", "Cards drop wrong")).toBe("[Bug] Cards drop wrong");
    expect(buildIssueTitle("feature", "Filter by agent")).toBe("[Feature] Filter by agent");
  });

  it("clamps over-long titles", () => {
    const title = buildIssueTitle("bug", "x".repeat(400));
    expect(title.length).toBeLessThanOrEqual(MAX_REPORT_TITLE_LENGTH);
  });

  it("redacts secrets before they reach GitHub", () => {
    const title = buildIssueTitle("bug", "fails when api_key=sk-live-abcdef123456 is set");
    expect(title).not.toContain("sk-live-abcdef123456");
  });
});

describe("buildIssueBody", () => {
  it("keeps the reporter's text and appends provenance", () => {
    const body = buildIssueBody("The board never loads.", {
      reporterName: "Yang Tang",
      reporterEmail: "thetangstr@gmail.com",
      companyName: "MKThink",
      instanceName: "mkboard",
      pageUrl: "/MKT/issues",
      appVersion: "1.2.3",
    });
    expect(body).toContain("The board never loads.");
    expect(body).toContain("- Reported by: Yang Tang <thetangstr@gmail.com>");
    expect(body).toContain("- Company: MKThink");
    expect(body).toContain("- Instance: mkboard");
    expect(body).toContain("- Page: /MKT/issues");
    expect(body).toContain("- Version: 1.2.3");
  });

  it("omits facts it does not have instead of printing blanks", () => {
    const body = buildIssueBody("Something broke.", { reporterName: "Ada" });
    expect(body).toContain("- Reported by: Ada");
    expect(body).not.toContain("- Company:");
    expect(body).not.toContain("- Page:");
  });

  it("records an unknown reporter rather than dropping the line", () => {
    expect(buildIssueBody("Broke.", {})).toContain("- Reported by: unknown");
  });

  it("redacts secrets pasted into the description", () => {
    const body = buildIssueBody("crashes with password=hunter2000 in the config", {});
    expect(body).not.toContain("hunter2000");
  });

  it("clamps an over-long description", () => {
    const body = buildIssueBody("y".repeat(MAX_REPORT_DESCRIPTION_LENGTH + 5000), {});
    expect(body.length).toBeLessThan(MAX_REPORT_DESCRIPTION_LENGTH + 500);
  });
});

describe("createIssueReport", () => {
  it("posts a labelled issue and returns number + url", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(201, { number: 42, html_url: "https://github.com/thetangstr/agentdash/issues/42" }),
      );

    const created = await createIssueReport({
      config,
      kind: "bug",
      title: "Cards drop wrong",
      description: "Dragging a card puts it in the wrong column.",
      context: { reporterName: "Yang Tang" },
    });

    expect(created).toEqual({
      number: 42,
      url: "https://github.com/thetangstr/agentdash/issues/42",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/thetangstr/agentdash/issues");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const payload = JSON.parse(init.body as string);
    expect(payload.title).toBe("[Bug] Cards drop wrong");
    expect(payload.labels).toEqual(["user-report", "bug"]);
  });

  it("labels feature requests as enhancement", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(201, { number: 7, html_url: "https://example.com/7" }));

    await createIssueReport({
      config,
      kind: "feature",
      title: "Filter by agent",
      description: "I want to filter the board by assignee.",
      context: {},
    });

    const payload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.labels).toEqual(["user-report", "enhancement"]);
  });

  it("retries unlabelled when the repo rejects the labels", async () => {
    // The report matters more than its labels — a repo without `user-report`
    // must still capture what the person typed.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(422, { message: "Validation Failed" }))
      .mockResolvedValueOnce(jsonResponse(201, { number: 9, html_url: "https://example.com/9" }));

    const created = await createIssueReport({
      config,
      kind: "bug",
      title: "Still broken",
      description: "It is still broken today.",
      context: {},
    });

    expect(created.number).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(retryPayload.labels).toBeUndefined();
  });

  it("reports a rejected credential as a server-side misconfiguration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));
    await expect(
      createIssueReport({
        config,
        kind: "bug",
        title: "Anything",
        description: "Anything at all here.",
        context: {},
      }),
    ).rejects.toThrow(/misconfigured/i);
  });

  it("reports a missing repository distinctly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { message: "Not Found" }));
    await expect(
      createIssueReport({
        config,
        kind: "bug",
        title: "Anything",
        description: "Anything at all here.",
        context: {},
      }),
    ).rejects.toThrow(/repository was not found/i);
  });

  it("rejects a 2xx that is not actually an issue", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, { unexpected: true }));
    await expect(
      createIssueReport({
        config,
        kind: "bug",
        title: "Anything",
        description: "Anything at all here.",
        context: {},
      }),
    ).rejects.toThrow(/unexpected response/i);
  });
});
