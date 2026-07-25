# MKThink AgentDash — Troubleshooting Guide

Common issues and how to fix them without calling support.

---

## Dashboard Won't Load

**Symptom:** Browser can't connect to `http://<mac-mini-ip>:3100`

**Fixes:**

1. **Check if the server is running:**
   ```sh
   curl http://127.0.0.1:3100/api/health
   ```
   If this returns `{"status":"ok"}`, the server is running — it's a network issue.
   If it fails, the server is down.

2. **Restart the server:**
   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
   sleep 5
   curl http://127.0.0.1:3100/api/health
   ```

3. **Check you're on the same network:** The Mac mini must be on the same WiFi/LAN as your computer. If using Tailscale, both devices must be on the tailnet.

4. **Check the IP address hasn't changed:** Run `ipconfig getifaddr en0` on the Mac mini. If the IP changed, update your bookmark.

---

## Agents Not Working

**Symptom:** Tasks are assigned but agents show "idle" indefinitely

**Fixes:**

1. **Check agent environment:**
   - Dashboard → Agents → click the agent → "Test Environment"
   - If it fails, the LLM adapter isn't working

2. **Check Claude Code is logged in** (if using `claude_local`):
   ```sh
   echo "Respond with hello" | claude --print -
   ```
   If this fails, run `claude` interactively and log in.

3. **Check API key** (if using `claude_api`):
   ```sh
   echo $ANTHROPIC_API_KEY
   ```
   Should show a key starting with `sk-ant-`. If empty, add it to `~/.config/agentdash/agentdash.env` and restart.

4. **Check agent isn't paused:**
   - Dashboard → Agents → does it show "paused"?
   - If paused due to budget: raise the budget or wait for next cycle
   - If manually paused: click "Resume"

5. **Restart the server:**
   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
   ```

---

## CoS Chat Shows Stub Reply

**Symptom:** CoS responds with "Got it. (stub reply — set ANTHROPIC_API_KEY to wire real Claude)"

**Fix:** The LLM adapter isn't configured. Check:

```sh
# What adapter is configured?
grep AGENTDASH_DEFAULT_ADAPTER ~/.config/agentdash/agentdash.env

# If claude_api — check the key
grep ANTHROPIC_API_KEY ~/.config/agentdash/agentdash.env

# If claude_local — check Claude Code is installed and logged in
which claude
claude --version
```

After fixing, restart: `launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`

---

## Costs Showing $0

**Symptom:** Dashboard shows $0.00 spent even though agents are working

**Cause:** You're using `claude_local` (Claude Code subscription). The CLI doesn't report per-call costs in non-interactive mode.

**Fix:** Switch to `claude_api` with an Anthropic API key for cost tracking:
1. Get an API key from console.anthropic.com
2. Add to env: `ANTHROPIC_API_KEY=sk-ant-...`
3. Change adapter: `AGENTDASH_DEFAULT_ADAPTER=claude_api`
4. Restart: `launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`

---

## Mac Mini Went to Sleep

**Symptom:** Agents stopped working overnight; dashboard was unreachable

**Fix:** Prevent the Mac mini from sleeping:
1. System Settings → Energy (or "Displays" → "Energy")
2. Set "Prevent automatic sleeping when the display is off" to **ON**
3. Set display sleep to "Never" (or 3 hours minimum)
4. Optional: `sudo pmset -a sleep 0 disksleep 0` for permanent fix

---

## iMessage Agent Not Responding

**Symptom:** You text the CEO agent but get no reply

**Fixes:**

1. **Check the gateway is running:**
   ```sh
   hermes -p ceo gateway status
   ```
   If stopped: `hermes -p ceo gateway run`

2. **Check imsg can see messages:**
   ```sh
   imsg chats --limit 5 --json
   ```
   Should show recent conversations.

3. **Check Full Disk Access:**
   System Settings → Privacy & Security → Full Disk Access → ensure Terminal (or iTerm) is checked.

4. **Check Messages.app is signed in:**
   Open Messages.app on the Mac mini. Ensure it's signed in to the same Apple ID.

5. **Restart the gateway:**
   ```sh
   hermes -p ceo gateway restart
   ```

---

## Agent Produced Bad Output

**Symptom:** Agent completed a task but the output is wrong, incomplete, or low quality

**This isn't a bug — it's normal.** Agents aren't perfect. Here's how to handle it:

1. **Comment on the task:** "This is missing the financial analysis section. Please add it."
2. The agent picks up the comment on its next heartbeat and continues working.
3. **For better results next time:** Be more specific in the task description. Include format, scope, and examples.
4. **If the agent keeps failing:** Pause it and create a task for a different agent, or break the task into smaller pieces.

---

## Server Logs

**To check what's happening:**
```sh
# Recent server logs
tail -50 ~/.agentdash/logs/agentdash.log

# Error logs
tail -50 ~/.agentdash/logs/agentdash.err
```

**To check a specific agent run:**
Dashboard → Agents → click agent → Runs → click the run → see full transcript

---

## When to Contact Support

| Issue | Contact method | Response time |
|-------|---------------|---------------|
| Bug or unexpected behavior | [GitHub issue](https://github.com/thetangstr/agentdash/issues) | < 30 min (business hours) |
| How-to question | GitHub issue with "question" label | < 2 hours |
| Server down and can't restart | Text Eddy: [phone] | ASAP |
| Data loss or corruption | Text Eddy: [phone] | ASAP |
| Feature request | GitHub issue with "enhancement" label | Next sprint |

**Business hours:** 9 AM - 6 PM Pacific, Monday-Friday
