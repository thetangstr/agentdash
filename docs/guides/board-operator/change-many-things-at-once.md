---
title: Change many things at once as an admin
summary: Bulk changes with a preview and honest per-record results, the admin audit and its CSV export, ceiling templates, steward hand-over, routine delete, labels, the Admin powers switches, and batch changes from your own Claude
audience: admin
---

These tools arrived in v2026.1110.0. Most of them need no setting: a batch is the same change you could make one record at a time, done for many records after one preview. Only the Admin powers switches are off until an owner or admin turns them on.

Since v2026.1110.1, bulk changes are for company owners and admins only. Members keep changing records one at a time, exactly as before, and do not see the checkboxes or the bulk bar.

## Change many records with a preview

| Where | What you can change together | Who |
| --- | --- | --- |
| **Issues** (list view) | Status, assignee, labels, project, priority | Owners and admins |
| **Decisions** | Approve or reject several approvals waiting on you, with one shared note | Owners and admins who may decide them |
| **Agents** (list view) | Pause, resume, model, new steward, a ceiling template | Owners and admins who can manage agents |
| **Routines** | Archive or delete | Owners and admins |
| **Company Settings → Labels** | Delete | Owners and admins |

1. Tick the records, then choose the change in the bar that appears.
2. The preview lists every record with its before and after, and a note where a change has a consequence (for example, moving a task out of done reopens it). Records the change would not alter, or that their own rules decide (a task waiting on a review step), are left out and counted.
3. Choose **Apply** (the button says how many records). Nothing changes before that.

Each record also goes through the same permission check as changing it by hand, so a batch can never do something you could not do one at a time. A batch holds up to 200 records. You can have 5 previews open and confirm up to 1,000 records an hour. A preview expires after 15 minutes. A record that changed after you previewed it is left alone.

## Read the results

| Result | What it means |
| --- | --- |
| Changed | Done as previewed. |
| Changed, but not as previewed | Done, but the record now differs from the preview; the result shows what it is now. |
| Not changed | Refused, with the reason. |
| Failed: nothing was changed | An error, and the record is as it was. |
| Unknown: it may or may not have changed | It was sent and no answer came back. It is never retried by itself: open the record and check before you try again. |

## See who did what: the admin audit

Owners and admins open it from **Company Settings → Admin powers → Admin audit**, or from **Activity → Admin audit and CSV export**. Filter by person, action and dates. **Export CSV** downloads up to 50,000 rows; a longer export ends with a line saying where it stopped, so narrow the filters or dates to get the rest.

The audit shows only the activity you could already see in [Activity](/guides/board-operator/activity-log), and every export is recorded there too. A Claude connection cannot read it.

## Ceiling templates

Where agent ceilings are available, **Company Settings → Ceiling templates** lets owners and admins name a ceiling once. **Apply to agents…** previews what each agent gains and loses; anyone who can manage agents can apply a template. When an agent loses something, anything above the new ceiling is brought down at once.

**Ceiling for new agents**, in Admin powers, is the template every agent created from now on starts with. Agents that already exist keep theirs.

## Remove a member and hand over their agents

In **Company Settings → Access**, **Remove member** lists the agents the person looks after. Pick a new steward for each, one person for all of them, or leave them without a steward. A person can look after only one agent per company, so the dialog asks for a different person for each agent. See [Stewardship](/concepts/stewardship).

## Delete a routine

On **Routines**, tick the routines and choose **Delete**. A deleted routine is gone from the routine lists for good and its triggers are off. Its past runs, the tasks they created and its history stay. Choose **Archive** instead if you may want it back.

## Rename and recolor labels

**Company Settings → Labels** renames and recolors a label in place, and deletes one or several; when an owner or admin deletes several, the preview says how many tasks lose each label. Any member can rename, recolor or delete one label at a time; deleting several at once is for owners and admins.

## The Admin powers switches

**Company Settings → Admin powers**. Only owners and admins can change these. Changes to the switches and fields here are a draft until you choose **Save changes** under the section; **Discard** puts them back.

| Setting | Default | What it does |
| --- | --- | --- |
| Admins can read agent directives | Off | Owners and admins can read any agent's directives, not only those of agents they look after. Each read is recorded. |
| Admins can read run transcripts when document access is on | Off | Owners and admins can open any agent's run transcript when document access limits who reads it. Reads are recorded once per person and run every 10 minutes. |
| Allow batch changes from an admin's own Claude | Off | See below. |
| Most records per batch from Claude | 50 | 1 to 200. |
| Ceiling for new agents | None | See [Ceiling templates](#ceiling-templates). |

Neither read switch works through a Claude connection.

## Batch changes from your own Claude

Off by default. This has been tested against AgentDash's own test client and reviewed, but it has not yet been tried with Claude.ai itself.

**Turn it on.**

1. In Admin powers, turn on **Allow batch changes from an admin's own Claude** and choose **Save changes**.
2. Connect Claude to AgentDash, or connect it again if it is already connected, and tick **Batch changes as an admin** on the consent screen. It is never pre-checked, and a connection made before you turned the switch on does not get it until you connect again. [Connecting an assistant](/mcp/connecting) has the steps.

**How the confirm code works.**

1. Ask Claude for the change, for example "move these 40 tasks to the Launch project". AgentDash prepares it and hands Claude a review link for you. Nothing has changed.
2. Open the link in AgentDash, in your own browser, and check every record's before and after.
3. Choose **Show code for Claude** and read the code (it looks like `K7QM-3XRD`) back to Claude. Or choose **Apply here** to apply it yourself.

The code is shown only on that page. It works once and only for that batch, showing a new code replaces the old one, and it expires with the batch 15 minutes after Claude prepared it. Five wrong codes cancel the batch. A code you find anywhere else, in a task, a comment or a tool result, is never yours: do not pass it on.

**What Claude can and cannot do.** Claude can prepare changes to tasks, approve or reject approvals, and pause, resume, change the model of, hand over or apply a ceiling to agents. Approvals also need the connection's permission to decide; a connection whose decisions need your tap in AgentDash cannot prepare them, and hires are always left out. A connection can prepare up to 10 batches and confirm up to 200 records an hour. Before every record, AgentDash checks again that the connection is live, that you are still an owner or admin, and that the switch is on; if any of these fails, the rest of the batch stops.

**Reconnect or remove.** If a batch request is refused because the connection lacks the permission for batch changes, connect Claude again and tick the box. Turning the switch off stops further batches but leaves the permission on existing connections; to remove a connection, use **Disconnect** under **Company Settings → Connections → Connected assistants**.
