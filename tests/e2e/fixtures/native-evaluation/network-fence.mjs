// Test-only process fence, inherited by all Node children of the isolated server.
import net from "node:net";
import { appendFileSync } from "node:fs";
const allowed = (host) => !host || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host));
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof normalized[0] === "object" ? normalized[0] : null;
  const host = options?.host ?? (typeof normalized[1] === "string" ? normalized[1] : undefined);
  if (!allowed(host)) {
    if (process.env.NATIVE_EVIDENCE_DIR) appendFileSync(`${process.env.NATIVE_EVIDENCE_DIR}/network-blocks.jsonl`, JSON.stringify({ at: new Date().toISOString(), host, pid: process.pid }) + "\n");
    throw new Error("Native evaluation fixture forbids non-loopback network access");
  }
  return original.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) {
    if (process.env.NATIVE_EVIDENCE_DIR) appendFileSync(`${process.env.NATIVE_EVIDENCE_DIR}/network-blocks.jsonl`, JSON.stringify({ at: new Date().toISOString(), host: url.hostname, pid: process.pid }) + "\n");
    throw new Error("Native evaluation fixture forbids external fetch");
  }
  return originalFetch(input, init);
};
