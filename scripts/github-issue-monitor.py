#!/usr/bin/env python3
"""
GitHub Issue Monitor — syncs open thetangstr/agentdash GitHub issues to Paperclip.

For each open GitHub issue:
  - If a Paperclip issue with matching originId already exists → skip
  - Otherwise → POST to Paperclip /api/companies/<company_id>/issues
    with originKind=manual, originId=<github_issue_id>

Priority is inferred from GitHub labels: critical > high > medium > low > none → medium.
"""
import urllib.request
import urllib.error
import json
import re
import sys
from datetime import datetime, timezone

COMPANY_ID = "2b203e77-ab84-41bf-8809-1b8ee254667b"
PAPERCLIP_BASE = "http://localhost:3101"
GITHUB_REPO = "thetangstr/agentdash"
GITHUB_API = f"https://api.github.com/repos/{GITHUB_REPO}/issues"


def gh_request(url: str) -> list:
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "agentdash-issue-monitor/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def paperclip_get(path: str) -> list | dict:
    req = urllib.request.Request(
        f"{PAPERCLIP_BASE}{path}",
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def paperclip_post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{PAPERCLIP_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"POST {path} → HTTP {e.code}: {err_body[:500]}")


def priority_from_labels(labels: list[dict]) -> str:
    label_names = {l["name"].lower() for l in labels}
    if "critical" in label_names:
        return "critical"
    if "high" in label_names:
        return "high"
    if "medium" in label_names:
        return "medium"
    if "low" in label_names:
        return "low"
    return "medium"  # default


def github_issue_number_from_desc(desc: str | None) -> int | None:
    """Extract GitHub issue number from a Paperclip issue description like 'GitHub: #223'."""
    if not desc:
        return None
    m = re.search(r"GitHub:\s+#(\d+)", desc)
    return int(m.group(1)) if m else None


def build_description(gh_issue: dict) -> str:
    labels = [l["name"] for l in gh_issue.get("labels", [])]
    labels_str = ", ".join(labels) if labels else "none"
    body = gh_issue.get("body") or ""
    # Truncate very long issue bodies for the Paperclip description
    preview = body[:500].replace("\n", " ") if body else ""
    return (
        f"GitHub: #{gh_issue['number']}\n"
        f"{gh_issue['html_url']}\n\n"
        f"Labels: {labels_str}\n\n"
        f"---\n{preview}"
    )


def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] GitHub Issue Monitor starting...")

    # 1. Fetch all open GitHub issues (exclude PRs)
    print("Fetching open GitHub issues...")
    all_gh = gh_request(f"{GITHUB_API}?state=open&per_page=100")
    gh_issues = [i for i in all_gh if "pull_request" not in i]
    print(f"  Found {len(gh_issues)} open issues (excluded {len(all_gh) - len(gh_issues)} PRs)")

    # 2. Fetch existing Paperclip issues to find already-synced ones
    print("Fetching existing Paperclip issues...")
    existing_pc = paperclip_get(f"/api/companies/{COMPANY_ID}/issues")
    # Build a set of originIds that are already in Paperclip
    synced_gh_ids: set[int] = set()
    for pc_issue in existing_pc:
        oid = pc_issue.get("originId")
        if oid is not None:
            synced_gh_ids.add(int(oid))

    # Also track existing issue numbers from description for issues with originId=null
    for pc_issue in existing_pc:
        if pc_issue.get("originId") is None:
            desc = pc_issue.get("description", "")
            gh_num = github_issue_number_from_desc(desc)
            if gh_num:
                synced_gh_ids.add(gh_num)

    print(f"  Already synced: {sorted(synced_gh_ids)}")

    # 3. For each GitHub issue not yet in Paperclip, create a Paperclip issue
    to_create = [i for i in gh_issues if i["number"] not in synced_gh_ids]
    print(f"  Need to create: {len(to_create)} new issues: {[i['number'] for i in to_create]}")

    created = []
    errors = []

    for gh in to_create:
        title = f"[AGE-N] #{gh['number']} {gh['title']}"
        # Limit title length
        if len(title) > 200:
            title = title[:197] + "..."

        payload = {
            "title": title,
            "description": build_description(gh),
            "status": "backlog",
            "priority": priority_from_labels(gh.get("labels", [])),
            "originKind": "manual",
            "originId": str(gh["number"]),
        }

        print(f"  Creating #{gh['number']} — priority={payload['priority']} ...")
        try:
            result = paperclip_post(f"/api/companies/{COMPANY_ID}/issues", payload)
            identifier = result.get("identifier", "?")
            print(f"    → Created {identifier}")
            created.append(gh["number"])
        except Exception as exc:
            print(f"    → ERROR: {exc}")
            errors.append((gh["number"], str(exc)))

    # 4. Summary
    print()
    print(f"Done. Created: {len(created)}, Errors: {len(errors)}")
    if created:
        print(f"  Created GitHub issues: {created}")
    if errors:
        print(f"  Failed: {errors}")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
