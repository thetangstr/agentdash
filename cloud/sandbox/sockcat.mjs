#!/usr/bin/env node
// AgentDash: minimal unix-socket request helper for image-level checks —
// reads JSON lines from stdin, writes each to the socket, prints replies.
// (socat/nc -U are not in the slim image; node is.)
import { connect } from "node:net";

const socketPath = process.argv[2];
const conn = connect(socketPath);
conn.setEncoding("utf8");
let buf = "";
let pending = 0;
let stdinDone = false;

function maybeExit() {
  if (stdinDone && pending === 0) process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  for (const line of c.split("\n")) {
    if (line.trim()) {
      pending++;
      conn.write(line + "\n");
    }
  }
});
process.stdin.on("end", () => {
  stdinDone = true;
  maybeExit();
});
conn.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    process.stdout.write(buf.slice(0, i) + "\n");
    buf = buf.slice(i + 1);
    pending--;
  }
  maybeExit();
});
conn.on("error", (e) => {
  process.stderr.write(String(e.message) + "\n");
  process.exit(1);
});
setTimeout(() => process.exit(1), 5000).unref();
