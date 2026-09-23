# Founder runbook — Muse MCP spike (GH #674)

You are running the client side of the spike. The stub server is at:

```
STUB URL:  https://<STUB_HOST>          (fill in when deployed)
MCP URL:   https://<STUB_HOST>/mcp      (paste this into clients)
LOG FILE:  requests.log on the host      (send it back with your notes)
```

Everything you do is recorded server-side in `requests.log`, so your job is to
**drive the client, narrate what it shows you, and screenshot the screens it
does not tell us about**. The stub holds no secrets — paste anything it gives
you freely.

---

## Before you start (5 min)

1. Confirm the stub is alive:
   ```sh
   curl -s https://<STUB_HOST>/healthz        # {"ok":true}
   curl -si https://<STUB_HOST>/mcp -X POST   # 401 + WWW-Authenticate: Bearer resource_metadata="..."
   ```
2. Have a **screen recorder** running for the whole session (Muse on iPhone:
   system screen record; on Mac: QuickTime or `Cmd+Shift+5`). The OAuth
   consent + any Sentinel prompt are the screens we cannot see server-side.
3. Have this checklist open — every cell in the findings doc needs one answer.

## Part 1 — Meta Muse

Muse is US-only; use the iPhone app or the Mac app. The question is **how a
third-party remote MCP server gets in at all**. Try each route in order and
stop at the first one that works:

### Route 1 — custom connector URL field

Look for anywhere Muse lets you paste a connector/server URL: Settings →
Connectors (or "Apps"/"Integrations"), a "+" / "Add custom connector" /
"Developer" option, or a URL field inside a tool/plugin picker.

- **If a URL field exists:** paste `https://<STUB_HOST>/mcp`. Record what
  happens next — does it open a browser/web view for OAuth? Does the consent
  page ("muse-mcp-stub — authorize") appear? Screenshot it, approve it, and
  see whether the connector saves.
- **If it saves:** send Muse: *"Call the echo tool with the text 'hello
  muse'"* then *"Call whoami and show me the raw result."* Screenshot any
  confirmation prompt (Sentinel or otherwise) and the tool result.
- **If it fails:** screenshot the exact error text and note which step died
  (URL rejected, OAuth never opened, consent shown but save failed, tools
  never listed).

### Route 2 — developer console / Meta developer portal

If there is no URL field, check whether Meta offers a developer console
(developers.facebook.com / Meta for Developers) where an MCP server can be
registered. Note whether it wants a **manifest**, a **directory submission**,
or a **pre-registered client_id** — and whether the submission is self-serve
or review-gated. Screenshot the registration form.

### Route 3 — directory submission only

If the only path is a reviewed directory listing, record the submission
requirements (what fields, whether a per-user server URL is allowed, whether
it is self-serve). **Do not submit anything** — that is M6, out of scope.

### If nothing works

That is outcome D and it is a valid, valuable result. Screenshot the places
you looked (Settings → Connectors, developer portal) so the doc can cite the
exact screens, then move to Part 2 — Grok still matters.

## Part 2 — Grok (control)

grok.com → Settings → Connectors → **Custom** (or the "+" card). Paste
`https://<STUB_HOST>/mcp`.

- Record whether it runs OAuth (consent page shows?) or asks for a static
  API key/header. If it only offers a header field, use the static-bearer
  token from the stub env (`STUB_STATIC_BEARER` — ask whoever deployed it).
- Ask Grok: *"Use the echo tool to say hello"* and *"Call whoami."*
  Screenshot the connector card, any confirmation UI, and the tool results.

## Part 3 — Claude.ai (reference control)

claude.ai → Settings → Connectors → **Add custom connector**. Paste
`https://<STUB_HOST>/mcp`. Complete OAuth, then ask Claude to call `echo` and
`whoami`. Screenshot the consent handoff and tool calls — Claude is the
known-good client, so its log entries are the baseline for interpreting what
Muse and Grok sent.

## What to write down (the findings-doc cells)

For **each** client, one line per cell — "didn't happen" is a fine answer:

| Cell | What to record |
|---|---|
| Where connectors are added | URL field / dev console / directory only / nowhere |
| Registration | CIMD (https client_id) / DCR (/register hit) / pre-registered / static header |
| Discovery | Did it fetch `.well-known/oauth-protected-resource*` or `oauth-authorization-server`? Did it follow the `WWW-Authenticate` 401? |
| Scopes requested | `scope` param seen on /authorize, or "none" |
| `resource` sent? | yes/no — visible in the token request log |
| Redirect URIs | the callback URL the client sent (in the log + consent page) |
| Transport + protocol version | Streamable HTTP? SSE? `protocolVersion` in initialize |
| Annotations / elicitation | did it honour tool annotations or ask in-band? |
| Sentinel confirmation | how it appeared, whether it could deny a call |
| Per-user server URL in directory | could a listing carry each user's own URL? |

The request log answers several cells by itself; your screenshots cover the
rest.

## Wrap-up

1. Stop the recorder; save the file.
2. Comment on **GH #674** with: which route worked (or didn't), the
   screenshots, and the filled table above.
3. Send `requests.log` from the host (or tell the engineer to pull it).
4. Leave the stub running until the orchestrator confirms the doc is written;
   then it gets torn down (it is throwaway by design).
