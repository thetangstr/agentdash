import { it } from "vitest";
import { summarizeToolCall } from "./readableTranscript";
it("multi", () => {
  const c = `set -e\ncurl -s "$PAPERCLIP_API_URL/api/issues/WHI-1" -H "Authorization: Bearer $PAPERCLIP_API_KEY"\ncurl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"\ncurl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/WHI-1" -d '{"status":"cancelled"}'`;
  const c2 = `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1" && curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1"`;
  const c3 = `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"; echo ok`;
  for (const x of [c, c2, c3]) { const s = summarizeToolCall("Bash", { command: x }); console.log("LBL=" + s.label + " | script? " + Boolean(s.script)); }
});
