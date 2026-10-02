#!/usr/bin/env node
// AgentDash: telemetry forwarder stub (spike R6). Runs as the `svc` identity.
// The real forwarder tails run logs and ships them to the hosted sink using
// the sealed token at /run/sandbox/sink-token.sealed — which only ever exists
// as ciphertext; unsealing needs the forwarder's private key plus the sink's
// mint flow, so neither the agent nor AgentDash can read the token plaintext.
// The stub proves the service shape and the file permission contract; the
// network path is intentionally not implemented in the spike.

import { existsSync, statSync, watchFile } from "node:fs";

const TOKEN = "/run/sandbox/sink-token.sealed";
const RUN_LOG = "/run/sandbox/run.log";

setInterval(() => {
  const tok = existsSync(TOKEN) ? statSync(TOKEN) : null;
  const log = existsSync(RUN_LOG) ? statSync(RUN_LOG) : null;
  if (log) {
    process.stdout.write(
      JSON.stringify({
        at: new Date().toISOString(),
        event: "forwarder.tick",
        logBytes: log.size,
        sealedTokenPresent: !!tok,
        note: "prototype: would ship run.log to the sink sealed-token endpoint",
      }) + "\n",
    );
  }
}, 10_000).unref();

process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "forwarder.start" }) + "\n");
