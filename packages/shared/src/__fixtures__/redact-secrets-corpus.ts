// AgentDash: deterministic corpus for the known-secrets memoization
// equivalence test (redact-secrets-memo.test.ts). The expected outputs in
// redact-secrets-corpus.expected.json were produced by the pre-memoization
// implementation (origin/main 9572ef844) over exactly this corpus, so the
// test proves the cached matcher redacts byte-for-byte the same output.
// Changing this generator invalidates the fixture — regenerate it from the
// pre-memoization implementation, never from the code under test.

export interface CorpusCase {
  kind: "text" | "value" | "stream" | "contains";
  text: string;
  secrets: string[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-";
const WORDS = "the agent ran a shell command and read files from the workspace then wrote output".split(" ");

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function toHex(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

export function buildRedactionCorpus(seed = 0x5eed_2026): CorpusCase[] {
  const rnd = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const token = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += TOKEN_CHARS[Math.floor(rnd() * TOKEN_CHARS.length)];
    return s;
  };
  const prose = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

  const secretSets: string[][] = [
    [],
    [token(40)],
    [token(64), token(24), token(36)],
    Array.from({ length: 12 }, () => token(30 + Math.floor(rnd() * 60))),
    // Short (ignored, < 6 chars), exactly-6, spaced passphrase, path-like,
    // regex metacharacters and non-ASCII — the edges of the literal builder.
    ["abc", "q1w2e3", "correct horse battery staple", "/srv/secrets/master.key", "a.b*c+d?e(f)[g]{h}|i^$\\j", "pässwörd-ünïcode-42"],
    // Duplicates and a secret that contains another.
    [`${token(10)}XYZ${token(20)}`, "XYZ", token(32), token(32)],
  ];
  // Same set, different order — must not change output.
  secretSets.push([...secretSets[3]!].reverse());

  const embeddings = (secret: string): string[] => {
    const half = Math.floor(secret.length / 2);
    const mutated = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    return [
      secret,
      toBase64(secret),
      toBase64(secret).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      toHex(secret),
      encodeURIComponent(secret),
      [...secret].reverse().join(""),
      secret.slice(3, 17),
      `A=${secret.slice(0, half)} B=${secret.slice(half)}`,
      mutated,
      `${secret.slice(0, 5)}​${secret.slice(5)}`,
      secret.replace(/[A-Za-z]/, (c) => `\\u00${c.charCodeAt(0).toString(16)}`),
    ];
  };

  const cases: CorpusCase[] = [];
  for (const secrets of secretSets) {
    const usable = secrets.length ? secrets : [token(40)];
    for (let i = 0; i < 24; i++) {
      const secret = pick(usable);
      const embedded = pick(embeddings(secret));
      const shapes = [
        `${prose(4)} ${embedded} ${prose(3)}`,
        `export API_KEY=${embedded}\n${prose(5)}`,
        `curl -H "Authorization: Bearer ${embedded}" https://example.test/v1`,
        `{"token":"${embedded}","note":"${prose(3)}"}`,
        `${prose(6)}\n${prose(2)} ${embedded}\n${prose(4)}`,
        `password: ${embedded} and KEYBOARD=us MONKEY=banana`,
        prose(8),
      ];
      const text = pick(shapes);
      cases.push({ kind: "text", text, secrets });
      cases.push({ kind: "contains", text, secrets });
      cases.push({
        kind: "value",
        text: JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", stream: pick(["stdout", "stderr"]), chunk: text, seq: i, nested: { apiKey: embedded, taskKey: "T-1", list: [embedded, prose(2)] } }),
        secrets,
      });
      if (i % 4 === 0) cases.push({ kind: "stream", text: `${text}\n${prose(3)} ${embedded}\n`, secrets });
    }
  }
  return cases;
}

export interface RedactionImpl {
  redactSecrets(text: string, secrets?: readonly (string | null | undefined)[]): string;
  containsSecrets(text: string, secrets?: readonly (string | null | undefined)[]): boolean;
  redactSecretsInValue<T>(value: T, secrets?: readonly (string | null | undefined)[]): T;
  createSecretStreamRedactor(secrets?: readonly (string | null | undefined)[]): { push(chunk: string): string; flush(): string };
}

/** Output of one corpus case under `impl` — the value the fixture records. */
export function evaluateCorpusCase(impl: RedactionImpl, c: CorpusCase): string {
  switch (c.kind) {
    case "text":
      return impl.redactSecrets(c.text, c.secrets);
    case "contains":
      return String(impl.containsSecrets(c.text, c.secrets));
    case "value":
      return JSON.stringify(impl.redactSecretsInValue(JSON.parse(c.text), c.secrets));
    case "stream": {
      const stream = impl.createSecretStreamRedactor(c.secrets);
      let out = "";
      for (let i = 0; i < c.text.length; i += 7) out += stream.push(c.text.slice(i, i + 7));
      return out + stream.flush();
    }
  }
}
