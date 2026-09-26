// AgentDash: the offline escrow tool (GH #800 review). Runs on the founder's
// offline machine, never in the control plane, which holds only the public key.
//
//   keygen --out-dir <dir>              new key pair: <dir>/escrow-secret-key (0600) and
//                                       <dir>/escrow-public-key; prints the public key and its id
//   open --key-dir <dir> --out <file>   reads one blob (e1.<id>.<ciphertext>, e.g. a box's
//                                       master_key_escrow) on stdin and writes the master key to
//                                       <file> (0600, must not exist). Never prints the key.
//
// See doc/runbooks/cloud-control-plane.md, "Escrow key custody".
import fs from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers";
import { escrowKeyId, openEscrow, parseEscrowPublicKey } from "../railway/secrets.js";

export async function runEscrow(argv: string[], io: { out: (l: string) => void; err: (l: string) => void; stdin: () => Promise<string> }): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  await sodium.ready;
  if (cmd === "keygen") {
    const dir = flag("--out-dir");
    if (!dir) return (io.err("usage: escrow keygen --out-dir <dir>"), 64);
    const secretPath = path.join(dir, "escrow-secret-key");
    if (fs.existsSync(secretPath)) return (io.err(`refusing to overwrite ${secretPath}`), 1);
    const kp = sodium.crypto_box_keypair();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, Buffer.from(kp.privateKey).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    const pub = Buffer.from(kp.publicKey).toString("base64");
    fs.writeFileSync(path.join(dir, "escrow-public-key"), pub + "\n", { mode: 0o644 });
    io.out(`public key (set as CLOUD_ESCROW_PUBLIC_KEY): ${pub}`);
    io.out(`key id: ${escrowKeyId(kp.publicKey)}`);
    return 0;
  }
  if (cmd === "open") {
    const dir = flag("--key-dir");
    const out = flag("--out");
    if (!dir || !out) return (io.err("usage: escrow open --key-dir <dir> --out <file>  (blob on stdin)"), 64);
    const pub = parseEscrowPublicKey(fs.readFileSync(path.join(dir, "escrow-public-key"), "utf8"));
    const sec = new Uint8Array(Buffer.from(fs.readFileSync(path.join(dir, "escrow-secret-key"), "utf8").trim(), "base64"));
    if (sec.length !== 32) return (io.err("escrow-secret-key is not a 32-byte key"), 1);
    const key = await openEscrow(pub, sec, await io.stdin());
    fs.writeFileSync(out, key, { mode: 0o600, flag: "wx" });
    io.out(`master key written to ${out} (mode 600). Restore it as PAPERCLIP_SECRETS_MASTER_KEY, then delete the file.`);
    return 0;
  }
  io.err("usage: escrow keygen --out-dir <dir> | escrow open --key-dir <dir> --out <file>");
  return 64;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const stdin = () => new Promise<string>((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => resolve(s));
  });
  runEscrow(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"), stdin }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`escrow: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
