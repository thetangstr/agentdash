import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentDashServer, parseToolset } from './index.js';
import type { PaperclipMcpConfig } from './config.js';

describe('explicit human MCP SDK transport', () => {
  let http: HttpServer; let apiUrl: string; const requests: {url?: string; body: any; auth?: string}[] = [];
  const target = { kind: 'company', companyId: '00000000-0000-4000-8000-000000000001' };
  beforeAll(async () => {
    http = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer pcp_board_test') { res.writeHead(403); res.end(JSON.stringify({ error: 'denied' })); return; }
      res.end(JSON.stringify(req.url?.endsWith('/identity') ? { source: 'board_key', user: { id: 'human', name: 'Human', email: 'human@test.invalid' }, targets: [target] } : { target, operations: [], nextCursor: null }));
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => http.once('listening', resolve));
    apiUrl = `http://127.0.0.1:${(http.address() as {port:number}).port}/api`;
  });
  afterAll(async () => { await new Promise<void>(resolve => http.close(() => resolve())); });
  it('advertises only six human tools after verified identity and calls only the typed bridge', async () => {
    expect(() => parseToolset('human')).not.toThrow();
    const config: PaperclipMcpConfig = { apiUrl, apiKey: 'pcp_board_test', companyId: null, agentId: null, runId: null };
    const server = createAgentDashServer(config, { toolset: parseToolset('human') });
    const client = new Client({ name: 'test', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.every(t => t.inputSchema.additionalProperties === false)).toBe(true);
      expect(listed.map(t => t.name)).toEqual(['human_identity', 'human_select_target', 'human_discover', 'human_read', 'human_prepare', 'human_confirm']);
      expect(requests[0].url).toBe('/api/human-control/identity');
      const select = await client.callTool({ name: 'human_select_target', arguments: { target } }); expect(select.isError).not.toBe(true);
      expect((await client.callTool({ name: 'human_discover', arguments: { target } })).isError).not.toBe(true);
      expect(requests.at(-1)?.body.target).toEqual(target);
      expect((await client.callTool({ name: 'human_read', arguments: { target, operationId: 'raw.http', version: 1, input: {} } })).isError).toBe(true);
      expect((await client.callTool({ name: 'human_select_target', arguments: { target: { kind: 'company', companyId: '00000000-0000-4000-8000-000000000002' } } })).isError).toBe(true);
      expect(requests.every(r => r.url?.startsWith('/api/human-control/'))).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it('rejects agent, assistant, endpoint and absent credentials and agent identity in explicit human mode', () => {
    expect(() => parseToolset('human')).not.toThrow();
    for (const apiKey of ['', 'pcp_agent', 'pcpa_assistant', 'pcin_internal', 'endpoint']) expect(() => createAgentDashServer({ apiUrl, apiKey, companyId: null, agentId: null, runId: null }, { toolset: parseToolset('human') })).toThrow();
    expect(() => createAgentDashServer({ apiUrl, apiKey: 'pcp_board_test', companyId: null, agentId: 'agent', runId: null }, { toolset: parseToolset('human') })).toThrow();
  });
});
