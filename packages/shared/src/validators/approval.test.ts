import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  checkConnectorSendPayload,
  CONNECTOR_SEND_TEAMS_GUIDANCE,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });
});

describe("checkConnectorSendPayload", () => {
  const hubspotCreate = {
    provider: "hubspot",
    objectType: "contacts",
    operation: "create",
    properties: { email: "lead@example.com" },
  };

  it("refuses the Teams relay shape agents were filing, and says how to reach a person", () => {
    // The relay shape agents filed: a message and a channel, no provider at all.
    const check = checkConnectorSendPayload({
      to: "Jordan Lee",
      body: "Relay: the draft is ready for review",
      channel: "teams",
      summary: "Relay to Jordan",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe("teams_not_supported");
    expect(check.message).toBe(CONNECTOR_SEND_TEAMS_GUIDANCE);
    expect(check.message).toMatch(/steward webhook/);
    expect(check.message).toMatch(/agentdash-inbox/);
    expect(check.message).toMatch(/Get told in Teams/);
  });

  it("refuses Teams named as the provider, whatever the case", () => {
    for (const provider of ["MSTeams", "ms-teams", "microsoft_teams", "Microsoft Teams", " teams "]) {
      const check = checkConnectorSendPayload({ ...hubspotCreate, provider });
      expect(check.ok, provider).toBe(false);
      if (!check.ok) expect(check.problem, provider).toBe("teams_not_supported");
    }
  });

  it("does not treat an unrelated field that merely contains 'teams' as a Teams send", () => {
    expect(checkConnectorSendPayload({ ...hubspotCreate, channel: "msteams-sales" }).ok).toBe(true);
  });

  it("bounds an agent-written provider in the refusal message", () => {
    const check = checkConnectorSendPayload({ ...hubspotCreate, provider: "x".repeat(500) });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).not.toContain("x".repeat(41));
  });

  it("refuses a payload with no provider instead of assuming one", () => {
    const { provider: _provider, ...noProvider } = hubspotCreate;
    const check = checkConnectorSendPayload(noProvider);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe("provider_missing");
    expect(check.message).toMatch(/"hubspot"/);
    expect(checkConnectorSendPayload({ ...hubspotCreate, provider: "  " }).ok).toBe(false);
    expect(checkConnectorSendPayload(null).ok).toBe(false);
  });

  it("refuses a provider that has no executor", () => {
    const check = checkConnectorSendPayload({ ...hubspotCreate, provider: "slack" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problem).toBe("provider_unsupported");
  });

  it("requires the fields the HubSpot executor needs", () => {
    const problem = (payload: Record<string, unknown>) => {
      const check = checkConnectorSendPayload(payload);
      return check.ok ? null : check.problem;
    };
    expect(problem({ ...hubspotCreate, objectType: "tickets" })).toBe("object_type_invalid");
    expect(problem({ ...hubspotCreate, objectType: undefined })).toBe("object_type_invalid");
    expect(problem({ ...hubspotCreate, operation: "delete" })).toBe("operation_invalid");
    expect(problem({ ...hubspotCreate, operation: undefined })).toBe("operation_invalid");
    expect(problem({ ...hubspotCreate, operation: "update" })).toBe("object_id_required");
    expect(problem({ ...hubspotCreate, properties: undefined })).toBe("properties_invalid");
    expect(problem({ ...hubspotCreate, properties: ["email"] })).toBe("properties_invalid");
  });

  it("accepts the payload the HubSpot write route files", () => {
    expect(checkConnectorSendPayload(hubspotCreate)).toEqual({ ok: true, provider: "hubspot" });
    expect(
      checkConnectorSendPayload({ ...hubspotCreate, operation: "update", objectId: "501" }),
    ).toEqual({ ok: true, provider: "hubspot" });
  });
});
