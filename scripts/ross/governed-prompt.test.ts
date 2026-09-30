import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { getServerAdapter } from '../../server/src/adapters/registry.js';

test('actual adapter keeps the governed identity, role, directive and task while using the pilot read workflow', async () => {
  const template = await readFile(new URL('./ROSS-GOVERNED-PROMPT.md', import.meta.url), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'ross-governed-prompt-'));
  const previousManaged = process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  process.env.AGENTDASH_HERMES_MANAGED_PROFILES = 'false';
  try {
    const command = join(root, 'fake-hermes.cjs');
    const capture = join(root, 'prompt.txt');
    const mandate = join(root, 'AGENTS.md');
    await writeFile(mandate, 'ROLE_SENTINEL: retain accountable sourced executive advice.');
    await writeFile(command, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)},args[args.indexOf('-q')+1]);
process.stdout.write('Offline prompt proof.\\nsession_id: fixture-session\\n');
`, { mode: 0o700 });
    const config = { hermesCommand: command, cwd: root, provider: 'zai', model: 'glm-5.3-flash', toolsets: 'ross_agentdash', maxTurnsPerRun: 4, timeoutSec: 10, promptTemplate: template, instructionsFilePath: mandate };
    const result = await getServerAdapter('hermes_local').execute({
      runId: 'fixture-run', agent: { id: 'fixture-agent', companyId: 'fixture-company', name: 'Ross', adapterType: 'hermes_local', adapterConfig: config },
      config: { ...config, taskId: 'fixture-task', taskTitle: 'Review changed lead evidence', taskBody: 'TASK_SENTINEL: preserve assignment and permission limits.', commentId: 'fixture-comment', wakeReason: 'manual' },
      context: { paperclipAgentDirectives: { directives: 'DIRECTIVE_SENTINEL: qualify missing evidence.', version: 1, pushedAt: '2026-09-29T12:00:00Z' } },
      runtime: {}, authToken: 'synthetic-not-a-key', onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
    } as never);
    expect(result.exitCode).toBe(0);
    const prompt = await readFile(capture, 'utf8');
    for (const text of ['fixture-run', 'fixture-agent', 'fixture-company', 'fixture-task', 'fixture-comment', 'ROLE_SENTINEL', 'TASK_SENTINEL', 'DIRECTIVE_SENTINEL']) expect(prompt).toContain(text);
    expect(prompt).toContain('ross_project_snapshot');
    expect(prompt).toContain('ross_issue_evidence');
    expect(prompt).not.toContain('IMPORTANT: Use `terminal` tool');
    expect(prompt).not.toContain('When done, mark the issue as completed');
    expect(prompt).not.toContain('curl -s -X PATCH');
    expect(prompt).not.toContain('{{');
  } finally {
    if (previousManaged === undefined) delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    else process.env.AGENTDASH_HERMES_MANAGED_PROFILES = previousManaged;
    await rm(root, { recursive: true, force: true });
  }
});
