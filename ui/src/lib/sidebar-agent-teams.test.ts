// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildSidebarAgentTree,
  getSidebarTeamGroupStorageKey,
  readSidebarTeamGroupExpanded,
  writeSidebarTeamGroupExpanded,
  type SidebarAgentTreeNode,
} from "./sidebar-agent-teams";

type A = { id: string; reportsTo?: string | null };
const a = (id: string, reportsTo: string | null = null): A => ({ id, reportsTo });

// Render the tree as "id(child,child)" so shapes read at a glance.
function shape(nodes: SidebarAgentTreeNode<A>[]): string {
  return nodes
    .map((n) => (n.children.length ? `${n.agent.id}(${shape(n.children)})` : n.agent.id))
    .join(",");
}

describe("buildSidebarAgentTree", () => {
  it("keeps agents with no manager and no reports as plain top-level rows", () => {
    expect(shape(buildSidebarAgentTree([a("x"), a("y")]))).toBe("x,y");
  });

  it("nests reports under their lead, keeping display order within each level", () => {
    const tree = buildSidebarAgentTree([
      a("solo"),
      a("eng2", "cos"),
      a("cos"),
      a("eng1", "cos"),
    ]);
    expect(shape(tree)).toBe("solo,cos(eng2,eng1)");
  });

  it("nests recursively up to two levels", () => {
    const tree = buildSidebarAgentTree([a("cos"), a("lead", "cos"), a("ic", "lead")]);
    expect(shape(tree)).toBe("cos(lead(ic))");
  });

  it("flattens reports deeper than two levels into the deepest group", () => {
    const tree = buildSidebarAgentTree([
      a("cos"),
      a("lead", "cos"),
      a("ic", "lead"),
      a("intern", "ic"),
      a("sub", "intern"),
      a("peer", "lead"),
    ]);
    // ic sits at the cap, so its subtree is listed after it, not nested.
    expect(shape(tree)).toBe("cos(lead(ic,intern,sub,peer))");
  });

  it("treats an agent whose manager is not in the list as top level", () => {
    const tree = buildSidebarAgentTree([a("orphan", "terminated-agent"), a("lead"), a("r", "lead")]);
    expect(shape(tree)).toBe("orphan,lead(r)");
  });

  it("treats an agent reporting to itself as top level", () => {
    expect(shape(buildSidebarAgentTree([a("self", "self")]))).toBe("self");
  });

  it("breaks a reporting cycle without crashing or dropping agents", () => {
    const tree = buildSidebarAgentTree([a("p", "q"), a("q", "p"), a("r", "q"), a("solo")]);
    expect(shape(tree)).toBe("solo,p(q(r))");
    const all: string[] = [];
    const walk = (nodes: SidebarAgentTreeNode<A>[]) =>
      nodes.forEach((n) => {
        all.push(n.agent.id);
        walk(n.children);
      });
    walk(tree);
    expect(all.sort()).toEqual(["p", "q", "r", "solo"]);
  });

  it("returns an empty tree for no agents", () => {
    expect(buildSidebarAgentTree([])).toEqual([]);
  });
});

describe("team group storage", () => {
  it("is expanded unless a collapse was stored, per user per company per lead", () => {
    localStorage.clear();
    const key = getSidebarTeamGroupStorageKey("company-1", "user-1", "lead-1");
    expect(key).toBe("agentdash.sidebarTeamExpanded:company-1:user-1:lead-1");
    expect(getSidebarTeamGroupStorageKey("company-1", null, "lead-1")).toBe(
      "agentdash.sidebarTeamExpanded:company-1:anonymous:lead-1",
    );
    expect(readSidebarTeamGroupExpanded(key)).toBe(true);
    writeSidebarTeamGroupExpanded(key, false);
    expect(localStorage.getItem(key)).toBe("false");
    expect(readSidebarTeamGroupExpanded(key)).toBe(false);
    writeSidebarTeamGroupExpanded(key, true);
    expect(localStorage.getItem(key)).toBeNull();
    expect(readSidebarTeamGroupExpanded(key)).toBe(true);
    expect(readSidebarTeamGroupExpanded(null)).toBe(true);
  });
});
