// REVIEW PROBE (PR #990) - not for commit.
import { describe, it, expect } from "vitest";
import { redactSecrets, summarizeToolCall, parseAgentDashApiCall, summarizeToolOutcome } from "./readableTranscript";

const SECRET = "SUPERSECRETvalue123";

function show(label: string, input: string) {
  const out = redactSecrets(input);
  const s = summarizeToolCall("Bash", { command: input });
  // eslint-disable-next-line no-console
  console.log(
    `\n### ${label}\nIN : ${input}\nRED: ${out}\nLBL: ${s.label}\nSCR: ${s.script ?? "(none -> expanded shows formatToolPayload(input) redacted)"}\nLEAK(redact)=${out.includes(SECRET)} LEAK(label)=${s.label.includes(SECRET)} LEAK(script)=${(s.script ?? "").includes(SECRET)}`,
  );
  return { out, s };
}

describe("probe redaction", () => {
  const cases: Array<[string, string]> = [
    ["lowercase authorization", `curl -H "authorization: bearer ${SECRET}" https://x.test`],
    ["x-api-key single quotes", `curl -H 'x-api-key: ${SECRET}' https://x.test`],
    ["--header", `curl --header "Authorization: Bearer ${SECRET}" https://x.test`],
    ["--header= form", `curl --header="X-Api-Key: ${SECRET}" https://x.test`],
    ["-u user:pass", `curl -u admin:${SECRET} https://x.test`],
    ["--user user:pass", `curl --user admin:${SECRET} https://x.test`],
    ["url userinfo", `curl https://admin:${SECRET}@x.test/a`],
    ["?token=", `curl "https://x.test/a?token=${SECRET}"`],
    ["?api_key=", `curl "https://x.test/a?api_key=${SECRET}&b=1"`],
    ["?access_token=", `curl "https://x.test/a?access_token=${SECRET}"`],
    ["?key=", `curl "https://maps.test/a?key=${SECRET}"`],
    ["JSON body Bearer", `curl -d '{"auth":"Bearer ${SECRET}"}' https://x.test`],
    ["JSON body api_key", `curl -d '{"api_key":"${SECRET}"}' https://x.test`],
    ["JSON body password", `curl -d '{"password":"${SECRET}"}' https://x.test`],
    ["TOKEN=x curl", `TOKEN=${SECRET} curl https://x.test`],
    ["PAPERCLIP_API_KEY=", `PAPERCLIP_API_KEY=${SECRET} curl http://127.0.0.1:3100/api/agents/me`],
    ["export", `export OPENAI_API_KEY=${SECRET}`],
    ["quoted env", `API_KEY="${SECRET}" node x.js`],
    ["single-quoted env", `API_KEY='${SECRET}' node x.js`],
    ["Cookie header", `curl -H "Cookie: session=${SECRET}" https://x.test`],
    ["-b cookie", `curl -b "session=${SECRET}" https://x.test`],
    ["Basic auth header", `curl -H "Authorization: Basic ${SECRET}" https://x.test`],
    ["Set-Cookie", `Set-Cookie: sid=${SECRET}; Path=/`],
    ["X-Goog-Api-Key", `curl -H "X-Goog-Api-Key: ${SECRET}" https://x.test`],
    ["api-key (Azure)", `curl -H "api-key: ${SECRET}" https://x.test`],
    ["x-access-token", `curl -H "x-access-token: ${SECRET}" https://x.test`],
    ["PRIVATE-TOKEN gitlab", `curl -H "PRIVATE-TOKEN: ${SECRET}" https://x.test`],
    ["anthropic x-api-key", `curl -H "x-api-key: sk-ant-${SECRET}" https://api.anthropic.com`],
    ["mysql -p", `mysql -uroot -p${SECRET} db`],
    ["postgres url", `psql postgres://user:${SECRET}@db:5432/x`],
    [
      "multi-line script",
      `set -e\nexport PAPERCLIP_API_KEY=${SECRET}\ncurl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" http://127.0.0.1:3100/api/agents/me`,
    ],
    ["multi-line echo heading + secret", `echo "== fetch =="\ncurl -H "X-Api-Key: ${SECRET}" https://x.test`],
    ["header split across escaped newline", `curl \\\n  -H "Authorization: Bearer ${SECRET}" \\\n  https://x.test`],
    ["authorization with escaped quote inside", `curl -H "Authorization: Bearer ab\\"${SECRET}" https://x.test`],
  ];
  for (const [label, input] of cases) {
    it(label, () => {
      show(label, input);
    });
  }

  it("tool OUTPUT echoing keys (JSON response)", () => {
    const outputs = [
      `{"id":"k1","apiKey":"${SECRET}","name":"default"}`,
      `{"token":"${SECRET}"}`,
      `{"key":"pcp_${SECRET}"}`,
      `{"access_token":"${SECRET}","token_type":"bearer"}`,
      `OPENAI_API_KEY=${SECRET}`,
      `Authorization: Bearer ${SECRET}`,
    ];
    for (const o of outputs) {
      const red = redactSecrets(o);
      const collapsed = summarizeToolOutcome(o, "completed");
      // eslint-disable-next-line no-console
      console.log(`\n### OUTPUT ${o}\nRED: ${red}\nCOLLAPSED OUTCOME (unredacted path): ${collapsed}\nLEAK(red)=${red.includes(SECRET)} LEAK(collapsed)=${collapsed.includes(SECRET)}`);
    }
  });

  it("non-Bash tools: WebFetch URL label", () => {
    const s = summarizeToolCall("WebFetch", { url: `https://x.test/a?token=${SECRET}` });
    const m = summarizeToolCall("mcp__foo__bar", { url: `https://x.test/a?api_key=${SECRET}` });
    // eslint-disable-next-line no-console
    console.log(`\n### WebFetch label: ${s.label}\n### MCP label: ${m.label}`);
  });

  it("over-redaction of benign text", () => {
    const benign = [
      "git log --oneline",
      "KEYBOARD=us make",
      "echo MONKEY=banana",
      "grep -r 'TOKEN=' src",
      "cat docs/authorization.md",
      "a.b.c.d is not a jwt but abcdefgh.ijklmnop.qrstuvwx is",
      "Authorization: required for this endpoint",
    ];
    for (const b of benign) console.log(`\n### BENIGN ${b}\n => ${redactSecrets(b)}`);
  });
});

describe("probe API-call labels", () => {
  const AUTH = '-H "Authorization: Bearer $PAPERCLIP_API_KEY"';
  const cmds = [
    `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH}`,
    `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan" ${AUTH}`,
    `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/comments/abc" ${AUTH}`,
    `curl -s -X PUT "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH} -d '{}'`,
    `curl -s -X POST "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH} -d '{}'`,
    `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH} -d '{"status":"done"}'`,
    `curl -s -G "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" --data-urlencode "q=x" ${AUTH}`,
    `curl -s --get "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" -d "status=todo" ${AUTH}`,
    `curl -s -I "$PAPERCLIP_API_URL/api/issues/WHI-1"`,
    `curl -s -T file.json "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"`,
    `curl -s "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" ${AUTH} --data-raw '{"body":"done"}'`,
    `curl -s "\${PAPERCLIP_API_URL}/api/issues/WHI-1/documents/checklist" -X PUT ${AUTH} -d @b.json`,
    `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/checklist/revisions" ${AUTH}`,
    `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1/comments?after=x" ${AUTH}`,
    `curl -s "$API/api/issues/WHI-1" ${AUTH}`,
    `curl -s "$MY_PAPERCLIPISH_EVIL/api/issues/WHI-1"`,
    `curl -s "http://127.0.0.1:9999/api/issues/WHI-1"`,
    `curl -s "http://localhost:8080/api/v1/users"`,
    `curl -s http://127.0.0.1:3100/api/issues/WHI-1 -X PATCH -d '{"status":"cancelled"}'`,
    `curl -s -X patch "$PAPERCLIP_API_URL/api/issues/WHI-1" -d '{}'`,
    `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1/approve" -X POST`,
    `curl -s -X POST "$PAPERCLIP_API_URL/api/agents/me/keys"`,
  ];
  for (const c of cmds) {
    it(c, () => {
      const p = parseAgentDashApiCall(c);
      const s = summarizeToolCall("Bash", { command: c });
      console.log(`\n### ${c}\n PARSE=${JSON.stringify(p)}\n LABEL=${s.label}`);
    });
  }
});
