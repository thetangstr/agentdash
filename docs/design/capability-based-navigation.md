# Capability-based navigation — replacing productProfile hardcoding

**Status: DESIGN ONLY. Implementation-ready, not implemented.**
Date: 2026-09-01. Companion design: `company-governance-mode.md` (also pending review).

---

## 1. The problem, measured

`productProfile` is a two-valued enum — `"default" | "agentdash_mk"` — and the UI branches on it
in **8 places**:

| Site | Gates |
|---|---|
| `Sidebar.tsx:53` | `showMyAgentLink` |
| `MyAgent.tsx:19` | the My Agent page |
| `OverrideInbox.tsx:20` | the Override inbox |
| `useInboxBadge.ts:205` | inbox badge counting |
| `Inbox.tsx:760` | inbox behaviour |
| `CompanyAccess.tsx:406` | access panel section |
| `CompanySettings.tsx:595` | settings section |
| `OnboardingWizard.tsx:673,771` | creates companies as `agentdash_mk` |

**What those pages actually do is stewardship.** `MyAgent` calls `stewardshipsApi.getMyAgent()`;
`OverrideInbox` calls `stewardshipsApi.getOverrideInbox()`. So the code asks *"is this company
MK?"* when the real question is *"does this company use stewardship?"*

The consequence is concrete: **Executive OS cannot have My Agent or Override without pretending
to be MK Think.** Any company that wants a stewardship surface has to adopt another customer's
product identity, and every new capability adds a ninth, tenth, eleventh branch on the same enum.

## 2. Three axes, currently collapsed into one

| Axis | Question | Values | Today |
|---|---|---|---|
| **Product profile** | which packaging/branding is this | `default`, `agentdash_mk` | exists, overloaded |
| **Capabilities** | which features are available | a set | **does not exist** |
| **Operating mode** | how is the company governed | `steward`, `autonomous` | **does not exist** (separate design) |

They are genuinely independent. An `autonomous` company can still use stewardship for a
particular agent; a `steward` company may not have the Override surface enabled; MK's branding
should not decide whether ExecOS gets a nav item.

**This design covers capabilities only.** It does not implement, migrate, or depend on operating
mode — that stays behind its own review.

## 3. Capability model

```ts
export const COMPANY_CAPABILITIES = [
  "stewardship",      // My Agent, steward pairing
  "override_inbox",   // Override queue
  "inbox_badge",      // profile-specific inbox counting
  "access_panel",     // the extra CompanyAccess section
] as const;
export type CompanyCapability = (typeof COMPANY_CAPABILITIES)[number];
```

Additive column, defaulted so nothing changes on migrate:

```sql
ALTER TABLE "companies"
  ADD COLUMN "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb;
```

### Resolution — profile is a DEFAULT, never a gate

```ts
const PROFILE_DEFAULT_CAPABILITIES: Record<CompanyProductProfile, CompanyCapability[]> = {
  default: [],
  agentdash_mk: ["stewardship", "override_inbox", "inbox_badge", "access_panel"],
};

export function capabilitiesOf(company: Company): ReadonlySet<CompanyCapability> {
  // An explicit list always wins. The profile only supplies a starting point,
  // so a company can gain or lose a capability without changing identity.
  return new Set(company.capabilities?.length
    ? company.capabilities
    : PROFILE_DEFAULT_CAPABILITIES[company.productProfile] ?? []);
}

export const can = (company: Company, c: CompanyCapability) => capabilitiesOf(company).has(c);
```

Every existing MK company resolves to exactly today's behaviour with no data written. That is
the compatibility guarantee, and it is what makes the change reversible.

## 4. Navigation

One helper replaces eight branches:

```ts
// before
const isProfileCompany = selectedCompany?.productProfile === "agentdash_mk";
// after
const isProfileCompany = can(selectedCompany, "stewardship");
```

Nav items declare what they need, so adding a capability never edits the sidebar:

```ts
const NAV = [
  { to: "/my-agent",  label: "My Agent", requires: "stewardship" },
  { to: "/override",  label: "Override", requires: "override_inbox" },
];
```

**A capability grants a surface, never authority.** `can()` decides whether a link renders and a
query runs. It does not decide what the server permits — the API keeps enforcing its own
authorization, and a client that renders a page it should not still gets refused. Anything else
would make navigation a permission system, which is how a UI flag becomes a security boundary.

## 5. Migration and compatibility

**Forward:** one additive column defaulting to `[]`. No row rewritten, no read path changed until
the UI ships. `capabilitiesOf` falls back to the profile map, so **behaviour on day one is
byte-identical for every existing company** — including MK Think, which is not to be modified.

**Adopting a capability** is a write to one company's list. Executive OS gaining `stewardship`
becomes a deliberate recorded act rather than a change of product identity.

**Rollback:** stop reading the column (revert the UI to the profile check), or drop it. Nothing
else references it; a down-migration is rehearsed against a snapshot before the up-migration runs
in anger.

**Sequencing:** ship `capabilitiesOf` with the profile fallback and migrate the 8 call sites
first, changing no behaviour. Only then does writing an explicit list to any company become
meaningful. The two steps must not be combined — combining them means a behaviour change and a
refactor land together and neither can be reverted alone.

## 6. Tests

| Test | Asserts |
|---|---|
| MK unchanged | an `agentdash_mk` company with empty capabilities resolves to today's four |
| default unchanged | a `default` company resolves to none — no new surfaces appear |
| explicit wins | a company with an explicit list ignores the profile map entirely |
| explicit empty | an explicitly empty list means none, and is distinguishable from unset |
| every call site | each of the 8 branches resolves identically before and after the swap |
| unknown capability | an unrecognised name grants nothing and is refused at write time |
| **no authority** | `can()` appears in no server authorization path — enumerated |
| **axis independence** | capabilities never read `productProfile` at runtime beyond the default map, and never read operating mode at all |

The last two exist because they are how this feature would go wrong quietly: by becoming a
permission system, or by re-coupling to the axes it was built to separate.

## 7. Open questions — review before building

1. **Who may edit a company's capabilities?** Proposed: the same authority that edits company
   settings. If capabilities should need higher authority, that is a different design.
2. **Should capabilities be visible in the API read surface** the ExecOS registry consumes? It
   would let the CEO surface show what each company can do; it is a scope decision.
3. **Does `agentdash_mk` remain a profile at all** once capabilities exist, or does it collapse to
   branding? Out of scope here; noted because the answer changes how long the fallback map lives.
4. **Naming.** `capabilities` reads as entitlements/billing to some people. `surfaces` or
   `features` are less loaded if that association is a problem.
