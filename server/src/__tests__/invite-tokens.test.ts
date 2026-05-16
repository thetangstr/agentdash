import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPANY_INVITE_TTL_MS,
  INVITE_TOKEN_MAX_RETRIES,
  createInviteToken,
  hashToken,
  isInviteTokenHashCollisionError,
} from "../lib/invite-tokens.js";

describe("invite token primitives", () => {
  it("creates 16-character company invite tokens with the public prefix", () => {
    expect(createInviteToken()).toMatch(/^pcp_invite_[a-z0-9]{16}$/);
  });

  it("hashes tokens with sha256 hex", () => {
    const token = "pcp_invite_testtoken";
    expect(hashToken(token)).toBe(
      createHash("sha256").update(token).digest("hex")
    );
  });

  it("recognizes only invite token hash unique constraint collisions", () => {
    expect(
      isInviteTokenHashCollisionError({
        code: "23505",
        constraint: "invites_token_hash_unique_idx",
      })
    ).toBe(true);
    expect(
      isInviteTokenHashCollisionError({
        cause: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "invites_token_hash_unique_idx"',
        },
      })
    ).toBe(true);
    expect(
      isInviteTokenHashCollisionError({
        code: "23505",
        constraint: "other_unique_idx",
      })
    ).toBe(false);
  });

  it("exports the retry and ttl constants used by invite creation call sites", () => {
    expect(INVITE_TOKEN_MAX_RETRIES).toBe(5);
    expect(COMPANY_INVITE_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });
});
