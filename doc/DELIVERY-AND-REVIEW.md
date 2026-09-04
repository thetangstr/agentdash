# Delivery and review for AgentDash agent work

This is the standing rule for changes produced by an AgentDash agent, including
work done by an assistant on an operator's behalf. It is not per-task guidance —
it applies until it is changed here.

## The rule

Every change:

1. is **committed** to the repository — never left only in a working tree or on a host;
2. is **pushed** to GitHub;
3. is **submitted as a pull request**, filled out per `.github/PULL_REQUEST_TEMPLATE.md`;
4. is **routed to Maya for review before merge**.

**Deployment is not part of delivery.** A merged pull request is not permission
to deploy. Deploying is a separate, explicitly authorised step.

## Why review is routed rather than announced

Maya is the product lead for AgentDash. Maya coordinates material status,
decisions and exceptions with Executive OS, and Executive OS communicates them
to the operator through Monica.

That chain is the point, not an inconvenience to work around. An agent that
reports a material decision straight to the operator has bypassed the person
accountable for the product and the process that keeps the record straight — so:

- **Do not create a direct user-facing bypass.** Status, decisions and
  exceptions travel Maya → Executive OS → Monica.
- **Do not self-approve.** An agent proposing a change is not the reviewer of
  it, for the same reason the verdict service refuses self-review.
- **An exception is itself a decision that goes through the chain.** If the rule
  cannot be followed, that is something to route, not something to decide
  locally.

Answering a direct question from whoever is at the terminal is normal and is not
a bypass. Reporting *material status, decisions or exceptions* is what belongs on
the chain.

## What to do when the review cannot be routed

Routing a review needs a reviewer who exists in the system you are routing
through. If Maya is not reachable there — not a repository collaborator, or not
present as an agent — then:

- Complete steps 1 to 3. The work must not be left uncommitted because step 4
  is blocked.
- **Say plainly that step 4 is outstanding, and why.** Name what is missing: a
  GitHub handle with repository access, or an agent to assign.
- Do not substitute a different reviewer, do not merge, and do not treat the
  blockage as approval.

A blocked review is a respected outcome. A change that merged because nobody
could be found to review it is not.
