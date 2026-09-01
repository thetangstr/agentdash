import { describe, expect, it } from "vitest";
import {
  agentJoinGrantsFromDefaults,
  humanJoinGrantsFromDefaults,
} from "../services/invite-grants.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";

describe("agentJoinGrantsFromDefaults", () => {
  it("adds tasks:assign when invite defaults do not specify agent grants", () => {
    expect(agentJoinGrantsFromDefaults(null)).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  it("preserves invite agent grants and appends tasks:assign", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "agents:create",
              scope: null,
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "agents:create",
        scope: null,
      },
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  it("does not duplicate tasks:assign when invite defaults already include it", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "tasks:assign",
              scope: { projectId: "project-1" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: { projectId: "project-1" },
      },
    ]);
  });
});

describe("human invite roles", () => {
  it("maps admin to the full management grant set", () => {
    expect(grantsForHumanRole("admin")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "projects:create", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "users:manage_permissions", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("gives member the working grants and none of the management ones", () => {
    // agents:create is deliberately absent — that key doubles as the
    // agent-administrator predicate; member agent-creation is role-given at
    // the creation route instead.
    expect(grantsForHumanRole("member")).toEqual([
      { permissionKey: "projects:create", scope: null },
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("normalizes every legacy string to one of the two roles", () => {
    expect(normalizeHumanRole("owner")).toBe("admin");
    expect(normalizeHumanRole("operator")).toBe("member");
    expect(normalizeHumanRole("viewer")).toBe("member");
    expect(normalizeHumanRole("member")).toBe("member");
    expect(normalizeHumanRole("no-such-role")).toBe("member");
    expect(resolveHumanInviteRole(null)).toBe("member");
  });

  it("reads the configured human invite role from defaults, normalized", () => {
    // Sam's and Megan's live invites carry role "operator" in
    // defaults_payload; the payload is not migrated — this normalization is
    // what maps them at acceptance time.
    expect(resolveHumanInviteRole({ human: { role: "operator" } })).toBe("member");
    expect(resolveHumanInviteRole({ human: { role: "admin" } })).toBe("admin");
  });

  it("falls back to role grants when human invite defaults omit explicit grants", () => {
    expect(humanJoinGrantsFromDefaults(null, "member")).toEqual([
      { permissionKey: "projects:create", scope: null },
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("preserves explicit human invite grants", () => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              {
                permissionKey: "users:invite",
                scope: { companyId: "company-1" },
              },
            ],
          },
        },
        "member",
      ),
    ).toEqual([
      {
        permissionKey: "users:invite",
        scope: { companyId: "company-1" },
      },
    ]);
  });
});
