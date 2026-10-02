// AgentDash (scan 3, lane G): the CoS suggests one task per reply through a
// strictly validated JSON trailer; only the requester can confirm it, with
// their own agent visibility and authority.
import { describe, expect, it, vi } from "vitest";
import {
  COS_CHAT_ORIGIN_KIND,
  COS_ISSUE_NOTES,
  COS_PROPOSAL_CAP,
  ISSUE_PROPOSAL_CARD_KIND,
  cosIssueAction,
  isCreateIssueTrailer,
  parseCreateIssueTrailer,
  type CosIssueActionDeps,
  type CosIssueRequester,
  type IssueProposalPayload,
} from "../services/cos-issue-action.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const hiddenAgentId = "66666666-6666-4666-8666-666666666666";
const cosAgentId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const triggerMessageId = "77777777-7777-4777-8777-777777777777";
const cardMessageId = "88888888-8888-4888-8888-888888888888";
const founder = "user-a";
const member = "user-b";

function trailer(overrides: Record<string, unknown> = {}) {
  return {
    create_issue: {
      title: "Draft the Acme proposal",
      description: "A two-page proposal for Acme's renovation.",
      assigneeAgentId: agentId,
      ...overrides,
    },
  };
}

const agentsById: Record<string, any> = {
  [agentId]: { id: agentId, companyId, name: "Ellie", role: "general", title: "Proposal Drafter", status: "idle" },
  [hiddenAgentId]: { id: hiddenAgentId, companyId, name: "Owner-only Olive", role: "general", status: "idle" },
  [cosAgentId]: { id: cosAgentId, companyId, name: "Chief of Staff", role: "chief_of_staff", status: "idle" },
  p: { id: "p", companyId, name: "Pat", role: "general", status: "paused" },
};

function requester(userId = founder, visible: string[] | null = null): CosIssueRequester {
  return { userId, source: "session", isInstanceAdmin: false, visibleAgentIds: visible ? new Set(visible) : null };
}

function pending(overrides: Partial<IssueProposalPayload> = {}): IssueProposalPayload {
  return {
    status: "pending",
    title: "Draft the Acme proposal",
    description: null,
    assigneeAgentId: agentId,
    assigneeName: "Ellie",
    requesterUserId: founder,
    triggerMessageId,
    cosAgentId,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CosIssueActionDeps> = {}, card: IssueProposalPayload | null = pending()) {
  const wakeup = vi.fn().mockResolvedValue(null);
  const state = { card };
  const deps: CosIssueActionDeps = {
    getAgent: vi.fn(async (id: string) => agentsById[id] ?? null),
    listAgents: vi.fn(async () => Object.values(agentsById)),
    canAssign: vi.fn().mockResolvedValue(true),
    countRecentProposals: vi.fn().mockResolvedValue(0),
    getCard: vi.fn(async (_c: string, id: string) =>
      id === cardMessageId && state.card ? { id, cardKind: ISSUE_PROPOSAL_CARD_KIND, cardPayload: state.card } : null,
    ),
    claimCard: vi.fn(async (_id: string, from: IssueProposalPayload["status"], next: IssueProposalPayload) => {
      if (!state.card || state.card.status !== from) return false;
      state.card = next;
      return true;
    }),
    findIssueByOrigin: vi.fn().mockResolvedValue(null),
    createIssue: vi.fn().mockResolvedValue({
      id: "issue-1",
      identifier: "ACM-7",
      title: "Draft the Acme proposal",
      status: "backlog",
      assigneeAgentId: agentId,
    }),
    syncReferences: vi.fn().mockResolvedValue(undefined),
    logActivity: vi.fn().mockResolvedValue(undefined),
    heartbeat: () => ({ wakeup }),
    publishCardUpdate: vi.fn(),
    ...overrides,
  };
  return { deps, wakeup, state };
}

function propose(deps: CosIssueActionDeps, overrides: Record<string, unknown> = {}) {
  return cosIssueAction(deps).proposeFromTrailer({
    companyId,
    conversationId,
    cosAgentId,
    requester: requester(),
    triggerMessageId,
    triggerIsNewest: true,
    trailer: trailer(),
    ...overrides,
  });
}

function confirm(deps: CosIssueActionDeps, actor = requester(), start?: boolean) {
  return cosIssueAction(deps).confirmProposal({ companyId, conversationId, cardMessageId, actor, ...(start ? { start } : {}) });
}

describe("parseCreateIssueTrailer", () => {
  it("accepts one well-formed create_issue", () => {
    expect(parseCreateIssueTrailer(trailer()).ok).toBe(true);
  });

  it("refuses an array of issues (max one per reply)", () => {
    expect(parseCreateIssueTrailer({ create_issue: [trailer().create_issue, trailer().create_issue] }).ok).toBe(false);
  });

  it("refuses unknown keys, a missing title and a non-uuid assignee", () => {
    expect(parseCreateIssueTrailer({ ...trailer(), extra: true }).ok).toBe(false);
    expect(parseCreateIssueTrailer(trailer({ status: "done" })).ok).toBe(false);
    expect(parseCreateIssueTrailer(trailer({ title: "   " })).ok).toBe(false);
    expect(parseCreateIssueTrailer(trailer({ assigneeAgentId: "ellie" })).ok).toBe(false);
  });

  it("recognises a create_issue trailer, valid or not", () => {
    expect(isCreateIssueTrailer({ create_issue: null })).toBe(true);
    expect(isCreateIssueTrailer({ phase_decision: "stay_in_goals" })).toBe(false);
    expect(isCreateIssueTrailer(null)).toBe(false);
  });
});

describe("cosIssueAction.roster", () => {
  it("lists agents this person can see and give work to, never the CoS", async () => {
    const { deps } = makeDeps();
    await expect(cosIssueAction(deps).roster(companyId, requester(founder, [agentId, cosAgentId]), cosAgentId)).resolves.toEqual([
      { id: agentId, name: "Ellie", role: "Proposal Drafter" },
    ]);
  });

  it("lists every active agent but the CoS when the person sees all agents", async () => {
    const { deps } = makeDeps();
    const roster = await cosIssueAction(deps).roster(companyId, requester(), cosAgentId);
    expect(roster.map((a) => a.id)).toEqual([agentId, hiddenAgentId]);
  });

  it("is empty without a person", async () => {
    const { deps } = makeDeps();
    await expect(cosIssueAction(deps).roster(companyId, null, cosAgentId)).resolves.toEqual([]);
  });
});

describe("cosIssueAction.proposeFromTrailer", () => {
  it("returns a pending card for the requester, without creating anything", async () => {
    const { deps } = makeDeps();
    const result = await propose(deps);
    expect(result).toEqual({
      ok: true,
      payload: {
        status: "pending",
        title: "Draft the Acme proposal",
        description: "A two-page proposal for Acme's renovation.",
        assigneeAgentId: agentId,
        assigneeName: "Ellie",
        requesterUserId: founder,
        triggerMessageId,
        cosAgentId,
      },
    });
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  // Scan 4, lane N: the card knows the company default, so it can offer
  // "Create" and "Create and start" when new work parks in the backlog.
  it("records the company's default status for a new issue on the card", async () => {
    const { deps } = makeDeps({ defaultStatus: vi.fn().mockResolvedValue("backlog") });
    await expect(propose(deps)).resolves.toMatchObject({ ok: true, payload: { defaultStatus: "backlog" } });
    expect(deps.defaultStatus).toHaveBeenCalledWith(companyId);
  });

  it("still proposes when the default status cannot be read", async () => {
    const { deps } = makeDeps({ defaultStatus: vi.fn().mockRejectedValue(new Error("db down")) });
    const result = await propose(deps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.payload).not.toHaveProperty("defaultStatus");
  });

  it("refuses an invalid trailer politely", async () => {
    const { deps } = makeDeps();
    await expect(propose(deps, { trailer: { create_issue: null } })).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.invalid });
  });

  it("refuses when the message it answers is no longer the newest", async () => {
    const { deps } = makeDeps();
    await expect(propose(deps, { triggerIsNewest: false })).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.superseded });
  });

  it("refuses without a person or a triggering message", async () => {
    const { deps } = makeDeps();
    await expect(propose(deps, { requester: null })).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.noRequester });
    await expect(propose(deps, { triggerMessageId: null })).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.noRequester });
  });

  it("treats an agent the requester cannot see as unknown", async () => {
    const { deps } = makeDeps();
    const result = await propose(deps, {
      requester: requester(founder, [agentId]),
      trailer: trailer({ assigneeAgentId: hiddenAgentId }),
    });
    expect(result).toEqual({ ok: false, note: COS_ISSUE_NOTES.unknownAssignee });
  });

  it("refuses the CoS itself and an agent from another company", async () => {
    const { deps } = makeDeps();
    await expect(propose(deps, { trailer: trailer({ assigneeAgentId: cosAgentId }) })).resolves.toEqual({
      ok: false,
      note: COS_ISSUE_NOTES.unknownAssignee,
    });
    const { deps: foreign } = makeDeps({
      getAgent: vi.fn().mockResolvedValue({ id: agentId, companyId: otherCompanyId, name: "Mallory", status: "idle" }),
    });
    await expect(propose(foreign)).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.unknownAssignee });
  });

  it.each(["paused", "terminated", "pending_approval", "error"])("refuses a %s assignee", async (status) => {
    const { deps } = makeDeps({ getAgent: vi.fn().mockResolvedValue({ ...agentsById[agentId], status }) });
    await expect(propose(deps)).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.inactiveAssignee("Ellie") });
  });

  it("refuses when the requester may not assign tasks", async () => {
    const { deps } = makeDeps({ canAssign: vi.fn().mockResolvedValue(false) });
    await expect(propose(deps)).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.forbidden });
  });

  it(`caps a conversation at ${COS_PROPOSAL_CAP.max} suggestions per ten minutes`, async () => {
    const { deps } = makeDeps({ countRecentProposals: vi.fn().mockResolvedValue(COS_PROPOSAL_CAP.max) });
    const now = new Date("2026-10-02T12:00:00Z");
    await expect(propose(deps, { now })).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.capped });
    expect(deps.countRecentProposals).toHaveBeenCalledWith(conversationId, new Date("2026-10-02T11:50:00Z"));
  });

  it("turns a lookup failure into a note", async () => {
    const { deps } = makeDeps({ getAgent: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(propose(deps)).resolves.toEqual({ ok: false, note: COS_ISSUE_NOTES.failed });
  });
});

describe("cosIssueAction.confirmProposal", () => {
  it("creates the issue once, as the requester, with the company default status", async () => {
    const { deps, wakeup, state } = makeDeps();
    const result = await confirm(deps);
    expect(result).toMatchObject({
      ok: true,
      created: { issueId: "issue-1", identifier: "ACM-7", assigneeName: "Ellie", status: "backlog" },
    });
    expect(deps.createIssue).toHaveBeenCalledWith(companyId, {
      title: "Draft the Acme proposal",
      description: null,
      assigneeAgentId: agentId,
      createdByUserId: founder,
      originId: cardMessageId,
    });
    // No status is passed: issueService applies the company default.
    expect((deps.createIssue as any).mock.calls[0][1]).not.toHaveProperty("status");
    expect(deps.syncReferences).toHaveBeenCalledWith("issue-1");
    expect(deps.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: founder,
        agentId: cosAgentId,
        action: "issue.created",
        details: expect.objectContaining({ source: "cos_chat", proposalMessageId: cardMessageId }),
      }),
    );
    // A backlog issue (this company's default) waits; nobody is woken.
    expect(wakeup).not.toHaveBeenCalled();
    expect(state.card?.status).toBe("created");
    // Scan 4, lane N: the proposal card itself becomes the created card; its
    // new state is pushed live once, and no second "Task created" message is posted.
    expect(deps.publishCardUpdate).toHaveBeenCalledTimes(1);
    expect(deps.publishCardUpdate).toHaveBeenCalledWith({
      companyId,
      conversationId,
      messageId: cardMessageId,
      payload: expect.objectContaining({ status: "created", issueId: "issue-1", identifier: "ACM-7", issueStatus: "backlog" }),
    });
    expect(deps).not.toHaveProperty("postCreatedCard");
    expect(COS_CHAT_ORIGIN_KIND).toBe("cos_chat_request");
  });

  it("wakes the assignee when the company default starts the work", async () => {
    const { deps, wakeup } = makeDeps({
      createIssue: vi.fn().mockResolvedValue({ id: "issue-2", identifier: "ACM-8", title: "T", status: "todo", assigneeAgentId: agentId }),
    });
    await expect(confirm(deps)).resolves.toMatchObject({ ok: true, created: { status: "todo" } });
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_assigned", requestedByActorId: founder }));
  });

  it("starts the work now on \"Create and start\", whatever the default", async () => {
    const { deps, wakeup } = makeDeps({
      createIssue: vi.fn().mockResolvedValue({ id: "issue-3", identifier: "ACM-9", title: "T", status: "todo", assigneeAgentId: agentId }),
    });
    await expect(confirm(deps, requester(), true)).resolves.toMatchObject({ ok: true, created: { status: "todo" } });
    expect((deps.createIssue as any).mock.calls[0][1]).toMatchObject({ status: "todo" });
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_assigned" }));
  });

  it("keeps the created issue when the live update cannot be pushed", async () => {
    const { deps } = makeDeps({
      publishCardUpdate: vi.fn(() => {
        throw new Error("bus down");
      }),
    });
    await expect(confirm(deps)).resolves.toMatchObject({ ok: true });
  });

  it("creates one issue for two clicks", async () => {
    const { deps } = makeDeps();
    const [first, second] = await Promise.all([confirm(deps), confirm(deps)]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(deps.createIssue).toHaveBeenCalledTimes(1);
  });

  it("reuses an issue already recorded for the card instead of creating another", async () => {
    const existing = { id: "issue-0", identifier: "ACM-6", title: "Draft the Acme proposal", status: "todo", assigneeAgentId: agentId };
    const { deps } = makeDeps({ findIssueByOrigin: vi.fn().mockResolvedValue(existing) });
    const result = await confirm(deps);
    expect(result).toMatchObject({ ok: true, issue: existing });
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  // The B -> A scenario: member B (no tasks:assign) asks for work; founder A
  // only says "ok thanks". The card belongs to whoever's message the CoS was
  // answering, and nobody else can confirm it.
  it("lets only the requester confirm", async () => {
    const { deps } = makeDeps({}, pending({ requesterUserId: member }));
    const result = await confirm(deps, requester(founder));
    expect(result).toEqual({ ok: false, code: "forbidden", note: COS_ISSUE_NOTES.notRequester });
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  it("re-checks the requester's authority at confirm time", async () => {
    const { deps } = makeDeps({ canAssign: vi.fn().mockResolvedValue(false) }, pending({ requesterUserId: member }));
    const result = await confirm(deps, requester(member));
    expect(result).toEqual({ ok: false, code: "forbidden", note: COS_ISSUE_NOTES.forbidden });
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  it("re-checks visibility at confirm time", async () => {
    const { deps } = makeDeps();
    const result = await confirm(deps, requester(founder, []));
    expect(result).toEqual({ ok: false, code: "not_found", note: COS_ISSUE_NOTES.unknownAssignee });
  });

  it("refuses a handled or missing card", async () => {
    const { deps } = makeDeps({}, pending({ status: "dismissed" }));
    await expect(confirm(deps)).resolves.toEqual({ ok: false, code: "conflict", note: COS_ISSUE_NOTES.alreadyHandled });
    const { deps: none } = makeDeps({}, null);
    await expect(confirm(none)).resolves.toEqual({ ok: false, code: "not_found", note: COS_ISSUE_NOTES.notFound });
  });

  it("puts the card back to pending when the create fails, so it can be retried", async () => {
    const { deps, state } = makeDeps({ createIssue: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(confirm(deps)).resolves.toEqual({ ok: false, code: "failed", note: COS_ISSUE_NOTES.failed });
    expect(state.card?.status).toBe("pending");
  });

  it("keeps the created issue when a follow-up step fails", async () => {
    const { deps } = makeDeps({
      logActivity: vi.fn().mockRejectedValue(new Error("x")),
      syncReferences: vi.fn().mockRejectedValue(new Error("x")),
    });
    await expect(confirm(deps)).resolves.toMatchObject({ ok: true });
  });
});

describe("cosIssueAction.dismissProposal", () => {
  it("lets only the requester decline", async () => {
    const { deps, state } = makeDeps({}, pending({ requesterUserId: member }));
    const action = cosIssueAction(deps);
    await expect(action.dismissProposal({ conversationId, cardMessageId, actor: { userId: founder } })).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
    await expect(action.dismissProposal({ conversationId, cardMessageId, actor: { userId: member } })).resolves.toMatchObject({
      ok: true,
    });
    expect(state.card?.status).toBe("dismissed");
  });

  // GH #986 item 2: other viewers see "Not now" live.
  it("pushes the declined state to every open chat", async () => {
    const { deps } = makeDeps();
    await cosIssueAction(deps).dismissProposal({ companyId, conversationId, cardMessageId, actor: { userId: founder } });
    expect(deps.publishCardUpdate).toHaveBeenCalledWith({
      companyId,
      conversationId,
      messageId: cardMessageId,
      payload: expect.objectContaining({ status: "dismissed" }),
    });
  });
});
