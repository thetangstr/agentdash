# HAL restoration — MKThink instance, hermes_local / GLM 5.3 Flash

**Audience:** the founder/operator, executing on the MK instance by hand.
**No agent may run any of this against MK.** Everything here is prepared in
this repository and the MK customer docs, then handed over.

**Time to execute:** ~5 minutes, plus one verification run (~2 min).

---

## 0. Preconditions (30 seconds)

SSH to the MK host as the operator. From the AgentDash install directory:

```sh
# Which instance is this? Confirm before touching anything.
curl -s http://127.0.0.1:3199/api/health | head -c 200

# HAL's current configuration (note it down — this is your rollback point):
psql "$DATABASE_URL" -c "select id, name, adapter_type, adapter_config from agents where name = 'HAL';"
```

Expect HAL to be `hermes_local` already (MK confirmed the assignment that
changed it was stopped before execution, and HAL is untouched). If the row
already reads `hermes_local` with the right model, skip to §3 (verify) — do
not rewrite a correct config.

## 1. The change (2 minutes)

HAL's adapter identity lives entirely in two columns of `agents`. The minimal
change sets the model on the existing `hermes_local` adapter. The the agent
adapter resolves the provider itself (explicit `provider` in adapterConfig
wins; otherwise inferred from the model prefix `glm-…` → zai; otherwise the
`~/.hermes/config.yaml` default on the MK host).

```sh
psql "$DATABASE_URL" <<'SQL'
update agents
set adapter_config = adapter_config || '{"model": "GLM 5.3 Flash"}'::jsonb,
    updated_at = now()
where name = 'HAL'
  and company_id = (select id from companies limit 1);
SQL
```

Exact before/after (placeholders — real values are whatever §0 printed):

| Field | Before (placeholder) | After |
|---|---|---|
| `adapter_type` | `"hermes_local"` | `"hermes_local"` (unchanged) |
| `adapter_config.model` | `null` (or stale value) | `"GLM 5.3 Flash"` |
| `adapter_config.provider` | whatever is there | unchanged |
| `adapter_config.env` | whatever is there | unchanged |

**Field notes**

- If `GLM 5.3 Flash` is not an exact the agent model name on the MK host, run
  `hermes models` there and use the listed name verbatim (e.g. `glm-5.3-flash`
  — whatever `hermes` accepts). The string is passed to `hermes chat -m`
  as-is.
- If MK's `~/.hermes/config.yaml` default provider is not zai and the model
  name does not carry a recognizable prefix, also set
  `'{"model": "…", "provider": "zai"}'` in the same statement.

## 2. What must NOT change

Touch **only** `adapter_config.model` (and `provider` if §1's note applies):

- `adapter_type` — stays `hermes_local`
- `adapter_config.env` — holds the `PAPERCLIP_API_KEY` binding and any host
  overrides; rewriting it can drop the injected-JWT precedence
- `adapter_config.hermesCommand`, `timeoutSec`, `graceSec`,
  `maxTurnsPerRun`, `toolsets`, `promptTemplate`,
  `instructionsFilePath` — leave as configured
- `runtime_config` (the whole column, including any `modelProfiles` block)
- steward binding (`accountable_user_id` / stewardship rows), pause state,
  heartbeat cadence, permissions, budget, channels, directives, memory
- Any other agent's row — this statement matches on `name = 'HAL'` only

## 3. Verify (2 minutes — one real bounded run)

1. **UI check:** Board → HAL → configuration shows
   `hermes_local` + the model string. Run "Test Environment" — expect a pass
   (this runs the adapter's env checks; enable
   `AGENTDASH_HERMES_ROUNDTRIP_PROBE=true` first if you want the live
   round-trip probe, then unset it again).
2. **One real bounded run:** wake HAL once (Board → HAL → Wake, trigger
   `manual`). It should complete with exit 0.
3. **Non-null usage on the the agent ledger:** the run's usage comes from
   the agent's own `session_model_usage` rows in `~/.hermes/state.db` on the
   MK host:

   ```sh
   sqlite3 ~/.hermes/state.db \
     "select model, api_call_count, input_tokens, output_tokens, actual_cost_usd, created_at
      from session_model_usage order by created_at desc limit 3;"
   ```

   The newest row must name the GLM model and have non-zero tokens. Then
   confirm it surfaced: Board → HAL → Runs → latest run shows non-null usage
   (Costs → by-agent likewise).
4. If the run fails with a model error: the model string is wrong for that
   host. `hermes models`, fix `adapter_config.model`, wake again. Do NOT
   accept a run answered by any other model — that is the failure this
   restoration exists to undo.

## 4. Rollback (1 minute)

Restore the exact `adapter_config` captured in §0:

```sh
psql "$DATABASE_URL" -c "update agents set adapter_config = '<PASTE JSON FROM §0>'::jsonb, updated_at = now() where name = 'HAL';"
```

(If the before value was `null`: `adapter_config = NULL`.) The change is one
JSONB key; nothing else is touched, so this fully reverts it.

## 5. Why this stays a human act

AGE-113 (branch `fix/age-113-adapter-model-invariant`) makes automatic
recovery structurally unable to change any agent's adapter or model — the
run healer refuses switches, chat dispatch refuses fallback hops, agents
cannot PATCH their own or others' adapter configuration. After that lands,
the only path that can produce the change in §1 is a human doing exactly
what this document describes.
