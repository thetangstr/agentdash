import { describe, expect, it } from "vitest";
import {
  createCompanyInviteSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";

describe("access validators", () => {
  it("accepts HTTP(S) and Paperclip asset image URLs", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "https://example.com/avatar.png",
    }).success).toBe(true);
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "/api/assets/avatar/content",
    }).success).toBe(true);
  });

  it("rejects data URI profile images", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "data:image/png;base64,AAAA",
    }).success).toBe(false);
  });

  it("defaults omitted combined member grants to an empty list", () => {
    const result = updateCompanyMemberWithPermissionsSchema.parse({
      membershipRole: "operator",
    });

    expect(result.grants).toEqual([]);
  });

  // AgentDash: auto-approve-invites — autoApprove defaults to false and is
  // accepted when explicitly provided.
  it("defaults createCompanyInvite autoApprove to false when omitted", () => {
    const result = createCompanyInviteSchema.parse({});
    expect(result.autoApprove).toBe(false);
  });

  it("accepts an explicit autoApprove flag on createCompanyInvite", () => {
    const result = createCompanyInviteSchema.parse({ autoApprove: true });
    expect(result.autoApprove).toBe(true);
  });
});
