# Delivery and review for AgentDash agent work

This is the standing rule for changes produced by an AgentDash agent, including
work done by an assistant on an operator's behalf. It is not per-task guidance —
it applies until it is changed here.

## The rule

Every change:

1. is **committed** to the repository — never left only in a working tree or on a host;
2. is **pushed** to GitHub;
3. is **submitted as a pull request**, filled out per `.github/PULL_REQUEST_TEMPLATE.md`;
4. is **left open for Maya to pick up**, and merged by that review — not by the
   agent that wrote it.

**Deployment is not part of delivery.** A merged pull request is not permission
to deploy. Deploying is a separate, explicitly authorised step.

## Review is discovered, not routed

Maya is an internal AI review agent. On her normal wake-up heartbeat in Agent
Runner she discovers open AgentDash pull requests, reviews them, and merges what
passes policy. Nothing needs to hand her the work.

So the delivering agent does **not** request review, assign a reviewer, or add
anyone to the pull request. Opening it is the whole of step 4.

> **Maya is not a GitHub account.** There is a real, unrelated GitHub user named
> `maya`, and this is a public repository. Running `gh pr edit --add-reviewer maya`
> invites a stranger to private product work. Never map an internal agent name to
> a GitHub handle, and never guess a handle for any reviewer.

Human code review is not required for this work. Do not ask for it.

## What still holds

- **Do not self-approve.** An agent proposing a change is not the reviewer of
  it, for the same reason the verdict service refuses self-review. This is why
  step 4 ends in someone else's merge.
- **Do not create a direct user-facing bypass.** Material status, decisions and
  exceptions travel the established chain rather than going straight to the
  operator.
- **An exception is itself a decision.** If the rule cannot be followed, that is
  something to raise, not something to decide locally.

Answering a direct question from whoever is at the terminal is normal and is not
a bypass. Reporting *material status, decisions or exceptions* is what belongs on
the chain.

## When review does not arrive

If a pull request sits unreviewed — Maya has not woken, or did not pick it up:

- Steps 1 to 3 still stand. The work must not be left uncommitted because step 4
  has not completed.
- **Say plainly that the change is open and unmerged, and for how long.**
- Do not merge it yourself, do not substitute a reviewer, and do not treat the
  silence as approval.

An unmerged change is a respected outcome. A change that merged because nobody
reviewed it is not.
