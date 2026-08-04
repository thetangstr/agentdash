import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESTRUCTIVE_ACTION_CLASSES,
  DESTRUCTIVE_ACTION_CLASS_KEYS,
  classifyAction,
  type DestructiveActionClassKey,
} from "./agent-destructive-classifier.js";

describe("DEFAULT_DESTRUCTIVE_ACTION_CLASSES", () => {
  it("matches the design doc's table exactly, in order", () => {
    expect(DEFAULT_DESTRUCTIVE_ACTION_CLASSES.map((c) => c.key)).toEqual([
      "external_record_delete",
      "external_record_merge",
      "external_bulk_mutation",
      "outbound_external_message",
      "financial_action",
      "access_grant_or_revoke",
      "external_publish",
      "local_machine_mutation",
      "credential_or_connection_change",
    ]);
  });

  it("carries a stable key and a non-empty one-line rationale the UI can render", () => {
    for (const entry of DEFAULT_DESTRUCTIVE_ACTION_CLASSES) {
      expect(entry.key).toMatch(/^[a-z_]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.example.length).toBeGreaterThan(0);
    }
  });

  it("exposes the same keys via DESTRUCTIVE_ACTION_CLASS_KEYS", () => {
    expect([...DESTRUCTIVE_ACTION_CLASS_KEYS]).toEqual(
      DEFAULT_DESTRUCTIVE_ACTION_CLASSES.map((c) => c.key),
    );
  });
});

describe("classifyAction — known destructive classes", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof classifyAction>[0];
    expected: DestructiveActionClassKey;
  }> = [
    {
      name: "HubSpot delete a record",
      input: { kind: "connector", provider: "hubspot", operation: "delete" },
      expected: "external_record_delete",
    },
    {
      name: "HubSpot archive a record",
      input: { kind: "connector", provider: "hubspot", operation: "archive" },
      expected: "external_record_delete",
    },
    {
      name: "HubSpot merge two companies",
      input: { kind: "connector", provider: "hubspot", operation: "merge" },
      expected: "external_record_merge",
    },
    {
      name: "HubSpot bulk-update a list",
      input: { kind: "connector", provider: "hubspot", operation: "bulk_update" },
      expected: "external_bulk_mutation",
    },
    {
      name: "WhatsApp message to a lead (external by default)",
      input: { kind: "connector", provider: "whatsapp", operation: "send" },
      expected: "outbound_external_message",
    },
    {
      name: "issue an invoice",
      input: { kind: "connector", provider: "stripe", operation: "invoice" },
      expected: "financial_action",
    },
    {
      name: "issue a refund",
      input: { kind: "connector", provider: "stripe", operation: "refund" },
      expected: "financial_action",
    },
    {
      name: "SharePoint add a share",
      input: { kind: "connector", provider: "microsoft", operation: "share" },
      expected: "access_grant_or_revoke",
    },
    {
      name: "grant portal access",
      input: { kind: "connector", provider: "hubspot", operation: "grant_access" },
      expected: "access_grant_or_revoke",
    },
    {
      name: "publish a doc",
      input: { kind: "connector", provider: "notion", operation: "publish" },
      expected: "external_publish",
    },
    {
      name: "create a public share link",
      input: { kind: "connector", provider: "google", operation: "create_public_link" },
      expected: "external_publish",
    },
    {
      name: "bridge act task mutates the local machine",
      input: { kind: "bridge", taskClass: "act" },
      expected: "local_machine_mutation",
    },
    {
      name: "revoke a HubSpot BYO key",
      input: { kind: "connector", provider: "hubspot", operation: "revoke_connection" },
      expected: "credential_or_connection_change",
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`${name} => ${expected} (destructive)`, () => {
      const result = classifyAction(input);
      expect(result.class).toBe(expected);
      expect(result.destructive).toBe(true);
    });
  }
});

describe("classifyAction — known-safe reads are never destructive", () => {
  const providers = [
    "google",
    "microsoft",
    "slack",
    "github",
    "linear",
    "notion",
    "jira",
    "hubspot",
    "whatsapp",
  ];
  const readOps = ["read", "get", "list", "query", "fetch", "search"];

  for (const provider of providers) {
    for (const operation of readOps) {
      it(`${provider}.${operation} => safe_read`, () => {
        const result = classifyAction({ kind: "connector", provider, operation });
        expect(result.class).toBe("safe_read");
        expect(result.destructive).toBe(false);
      });
    }
  }

  it("a bridge read task is safe_read", () => {
    const result = classifyAction({ kind: "bridge", taskClass: "read" });
    expect(result.class).toBe("safe_read");
    expect(result.destructive).toBe(false);
  });

  it("an internal-scoped message is safe_read, not an outbound external message", () => {
    const result = classifyAction({
      kind: "connector",
      provider: "slack",
      operation: "send",
      recipientScope: "internal",
    });
    expect(result.class).toBe("safe_read");
    expect(result.destructive).toBe(false);
  });
});

describe("classifyAction — fail closed", () => {
  it("an unrecognized write operation is unclassified_write and destructive", () => {
    const result = classifyAction({
      kind: "connector",
      provider: "hubspot",
      operation: "frobnicate",
    });
    expect(result.class).toBe("unclassified_write");
    expect(result.destructive).toBe(true);
  });

  it("an external record create/update is not a known-safe read => fail closed", () => {
    for (const operation of ["create", "update"]) {
      const result = classifyAction({ kind: "connector", provider: "hubspot", operation });
      expect(result.class).toBe("unclassified_write");
      expect(result.destructive).toBe(true);
    }
  });

  it("an unqualified message defaults to outbound-external (not silently allowed)", () => {
    const result = classifyAction({ kind: "connector", provider: "whatsapp", operation: "send" });
    expect(result.destructive).toBe(true);
  });

  it("an unknown bridge task class fails closed to unclassified_write", () => {
    const result = classifyAction({ kind: "bridge", taskClass: "wat" });
    expect(result.class).toBe("unclassified_write");
    expect(result.destructive).toBe(true);
  });
});
