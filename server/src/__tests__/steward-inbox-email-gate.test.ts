import { describe, expect, it } from "vitest";
import { isInboxEmailConfigured } from "../services/steward-inbox-email.js";

// Inbox emails reach people outside the app, so they are an explicit instance
// decision: having transactional email configured is not enough.
describe("inbox email gate", () => {
  it("is off when only RESEND_API_KEY is set", () => {
    expect(isInboxEmailConfigured({ RESEND_API_KEY: "re_test" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is off for any value other than exactly true", () => {
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      expect(isInboxEmailConfigured({ RESEND_API_KEY: "re_test", AGENTDASH_INBOX_EMAIL: value } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("is on only with AGENTDASH_INBOX_EMAIL=true and an email key", () => {
    expect(isInboxEmailConfigured({ RESEND_API_KEY: "re_test", AGENTDASH_INBOX_EMAIL: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isInboxEmailConfigured({ AGENTDASH_INBOX_EMAIL: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
