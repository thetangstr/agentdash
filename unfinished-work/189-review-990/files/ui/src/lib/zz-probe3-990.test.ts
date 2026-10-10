import { it } from "vitest";
import { summarizeToolCall, summarizeToolOutcome } from "./readableTranscript";
import { redactSecrets, redactSecretsInValue } from "./redactSecrets";
const S = "Zq9SECRETvalue77";
const cmds: [string,string][] = [
  ["b64 basic", `curl -H "Authorization: Basic YWRtaW46${S}" https://x.test`],
  ["b64 decode", `echo c2stYW50LWFwaTAzLXNlY3JldHNlY3JldA== | base64 -d`],
  ["split vars non-secret names", `A=sk-ant-ap; B=${S}; curl -H "x-api-key: $A$B" https://x.test`],
  ["split vars secret names", `KEY_A=${S}; KEY_B=${S}; curl -H "x-api-key: $KEY_A$KEY_B" https://x.test`],
  ["heredoc auth", `cat > req.txt <<'EOF'\nAuthorization: Bearer ${S}\nX-Api-Key: ${S}\nEOF\ncurl -H @req.txt http://x.test`],
  ["heredoc json body", `curl -s -X POST https://x.test -d @- <<EOF\n{"token": "${S}", "password":"${S}"}\nEOF`],
  ["heredoc auth noscheme short", `cat > h.txt <<EOF\nAuthorization: abcdefgh\nEOF`],
  ["wrote file sk", `cat > /tmp/sk-live-123.txt <<'EOF'\nhello\nEOF`],
  ["wrote file stripe", `cat > /tmp/sk_live_51HxYzAbCdEfGhIjKlMnOp.txt <<'EOF'\nhi\nEOF`],
  ["wrote file anthropic", `cat > "/tmp/sk-ant-api03-${S}.txt" <<'EOF'\nhi\nEOF`],
  ["tee secret path", `tee /tmp/${S}-token.txt <<EOF\nx\nEOF`],
  ["stripe key in cmd", `stripe charges list --api-key sk_live_51HxYzAbCdEfGhIjKlMnOp`],
  ["stripe key bare", `node pay.js sk_live_51HxYzAbCdEfGhIjKlMnOp`],
  ["cyrillic Authorization", `curl -H "Authоrization: Bearer ${S}" https://x.test`],
  ["fullwidth colon", `curl -H "Authorization： Bearer ${S}" https://x.test`],
  ["NBSP after Bearer", `curl -H "Authorization: Bearer ${S}" https://x.test`],
  ["zero-width in name", `curl -H "x-api​-key: ${S}" https://x.test`],
  ["tab separator", `curl -H "x-api-key:\t${S}" https://x.test`],
  ["cyrillic env name", `АPI_KEY=${S} node x.js`],
  ["header via printf var", `H="Authorization: Bearer ${S}"; curl -H "$H" https://x.test`],
  ["python requests", `python3 -c 'import requests;requests.get("https://x.test",headers={"Authorization":"Bearer ${S}"})'`],
  ["python dict api_key", `python3 -c 'c=Client(api_key="${S}")'`],
  ["--data token=", `curl -d "client_id=a&client_secret=${S}" https://x.test/oauth`],
  ["--data-urlencode", `curl --data-urlencode "password=${S}" https://x.test`],
  ["wget header", `wget --header="Authorization: Bearer ${S}" https://x.test`],
  ["httpie", `http GET x.test Authorization:"Bearer ${S}"`],
  ["git url with token", `git clone https://oauth2:${S}@gitlab.com/a/b.git`],
  ["git url token only", `git clone https://${S}@github.com/a/b.git`],
];
it("cmds", () => {
  for (const [n, c] of cmds) {
    const s = summarizeToolCall("Bash", { command: c });
    const exp = redactSecrets(s.script ?? JSON.stringify({ command: c }, null, 2));
    const leakS = (x: string) => x.includes(S) || /sk_live_51|sk-ant-api03|c2stYW50/.test(x);
    console.log(`P| ${n.padEnd(30)} | LBL=${s.label.slice(0,70)} | leakLabel=${leakS(s.label)} leakExpanded=${leakS(exp)}`);
  }
});
it("outputs", () => {
  const outs = [
    `{"error":"Invalid API key ${S}"}`,
    `{"error":{"message":"Incorrect API key provided: sk-proj-${S}"}}`,
    `{"error":"invalid key \\u0073k-ant-${S}abcdef"}`,
    `{"error":"bad header Authorization: Bearer ${S}"}`,
    `{"error":"bad \\u0042earer ${S}"}`,
    `{"message":"token ${S} expired"}`,
    `{"error":"key=${S} rejected"}`,
    `{"tok\\u0065n":"${S}"}`,
    `{"apiKey":"${S}","id":"x"}`,
    `{"key":"${S}"}`,
    `{"data":{"credentials":{"value":"${S}"}}}`,
    `Error: 401 Unauthorized for api_key ${S}`,
    `export STRIPE_SECRET_KEY=sk_live_51HxYzAbCdEfGhIjKlMnOp`,
    `{"secret_key":"${S}"}`,
    `{"x-api-key":"${S}"}`,
  ];
  for (const o of outs) {
    const col = summarizeToolOutcome(o, "completed");
    const err = summarizeToolOutcome(o, "error");
    let parsedVal: unknown = o; try { parsedVal = JSON.parse(o); } catch {}
    const exp = JSON.stringify(redactSecretsInValue(parsedVal));
    const leak = (x: string) => x.includes(S) || x.includes("sk_live_51") || /sk-ant-Zq/.test(x);
    console.log(`O| ${o.slice(0,60).padEnd(60)} | COL=${col.slice(0,60)} | leakCol=${leak(col)||leak(err)} leakExpObj=${leak(exp)} leakExpStr=${leak(redactSecrets(o))}`);
  }
});
it("benign", () => {
  for (const b of ["KEYBOARD=us make","echo MONKEY=banana","grep -r 'TOKEN=' src","Authorization: required for this endpoint","SORT_KEY=name node x","PRIMARY_KEY=id","git log -p8 --stat","ps -p 1234","docker run -p 8080:80 img","ssh -p 2222 host","The token: is missing","see docs/api-key.md","curl -u $USER:$PASS x","PGPASSWORD=$PGPASS psql","\"keyboard\":\"us\"","{\"documentKey\":\"plan\",\"key\":\"plan\"}","SECRET_NAME=prod-db aws secretsmanager get-secret-value","tokens: 1234 in / 567 out","Key: Value header docs","cache-key: abc123"]) {
    const s = summarizeToolCall("Bash", { command: b });
    console.log(`B| ${b.padEnd(45)} => ${redactSecrets(b)} | LBL=${s.label}`);
  }
});
