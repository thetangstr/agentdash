// CLO-137 live end-to-end (no DB): generate a REAL Semaphore permission proof with the
// SAME field math as server/src/services/zk-permission.ts, anchor its SHA-256 through the
// EXISTING attest_action path (inputs.permission_proof.proof_hash), then re-verify with the
// keyless verify_receipt tool. Proves the seam end-to-end against the live hosted gateway.
//
// Run: node server/scripts/zk-permission-live-e2e.mjs   (reads CLOCKCHAIN_* from server/.env)
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(here, "..", ".env"), "utf8");
const KEY = (env.match(/CLOCKCHAIN_MCP_KEY=(.+)/) || [])[1]?.trim();
const URL = (env.match(/CLOCKCHAIN_MCP_URL=(.+)/) || [])[1]?.trim() || "https://mcp.clockchain.network/mcp";

async function callTool(name, args) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.trim().startsWith("{") ? raw.trim() : raw.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5).trim();
  const j = JSON.parse(line);
  const t = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return { text: t }; }
}

// Mirror zk-permission.ts field math exactly.
const fieldHash = (s) => BigInt("0x" + createHash("sha256").update(s).digest("hex").slice(0, 16));
const externalNullifierFor = (scope, t) => fieldHash(`${scope}:${t}`);
const messageFor = (scope, t) => (fieldHash(scope) << 64n) | BigInt(t);
const canonical = (p) => JSON.stringify({ merkleTreeDepth: p.merkleTreeDepth, merkleTreeRoot: p.merkleTreeRoot, message: p.message, nullifier: p.nullifier, scope: p.scope, points: p.points });

async function main() {
  if (!KEY) throw new Error("CLOCKCHAIN_MCP_KEY not found in server/.env");
  const SCOPE = "release_payment", EPOCH = Math.floor(Date.now() / 1000);
  const proverSeed = `mandate:live:${randomUUID().slice(0, 8)}`;
  const identity = new Identity(proverSeed);
  const members = [identity.commitment];
  for (let i = 0; i < 4; i++) members.push(new Identity(`${proverSeed}:filler:${i}`).commitment);
  const group = new Group(members);

  console.log("1. Generate real permission proof…");
  const proof = await generateProof(identity, group, messageFor(SCOPE, EPOCH), externalNullifierFor(SCOPE, EPOCH));
  const proofBytes = canonical(proof);
  const proofHash = createHash("sha256").update(proofBytes).digest("hex");
  const offchainOk = await verifyProof(proof);
  console.log(`   off-chain verify=${offchainOk}  proof_hash=${proofHash}`);

  console.log("2. Anchor proof_hash via attest_action (the network never opens the proof)…");
  const did = `did:clockchain:agentdash:zk${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await callTool("mint_identity", { did, document: { kind: "agent", name: "zk-permission-live" }, allow_degraded: true });
  const att = await callTool("attest_action", {
    agent_id: did,
    action: SCOPE,
    inputs: {
      mandateId: "live-demo",
      permission_proof: {
        scheme: "semaphore-v4",
        proof_hash: proofHash,
        public_signals: { authority: proof.merkleTreeRoot, scope: SCOPE, validAt: EPOCH, nullifier: proof.nullifier },
      },
    },
    outputs: {},
    allow_degraded: true,
  });
  const ledgerId = att.ledgerId ?? att.anchor?.ledgerId;
  const blockHeight = att.blockHeight ?? att.anchor?.blockHeight;
  const status = att.status ?? att.anchor?.status;
  const boundHash = att.inputs?.permission_proof?.proof_hash;
  console.log(`   ledgerId=${ledgerId} block=${blockHeight} status=${status}`);
  console.log(`   proof_hash bound into receipt inputs: ${boundHash === proofHash ? "YES" : "NO/absent"} (${boundHash ?? "n/a"})`);
  console.log(`   receipt eventHash=${(att.eventHash || "").slice(0, 32)}…`);

  console.log("3. Keyless re-verify via verify_receipt…");
  let verified = "unavailable";
  try {
    const vr = await callTool("verify_receipt", { receipt: att });
    verified = (vr.match ?? vr.verified ?? vr.isValid) === true ? "MATCH" : JSON.stringify(vr);
  } catch (e) { verified = `error: ${e.message}`; }
  console.log(`   verify_receipt => ${verified}`);

  console.log("\n=== LIVE E2E RESULT ===");
  console.log(`   off-chain ZK verify: ${offchainOk}`);
  console.log(`   proof_hash anchored: ${ledgerId ? `YES (${ledgerId}, status=${status}, block=${blockHeight})` : "NO"}`);
  console.log(`   verify_receipt:      ${verified}`);
  console.log(`   NOTE: the network anchored the 32-byte hash and never saw the proof — validity is off-chain by design.`);
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
