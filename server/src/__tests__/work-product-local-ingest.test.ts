import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOCAL_DELIVERABLE_MAX_BYTES,
  deliverableDocumentBody,
  deliverableDocumentKey,
  isAcceptableWorkspaceRoot,
  isLocalWorkProduct,
  localWorkProductPath,
  readLocalDeliverable,
  sanitizeDeliverableTitle,
} from '../services/work-product-local-ingest.js';

describe('work product local ingest (Scan 3 lane I)', () => {
  let scratch: string;
  let root: string;

  beforeAll(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-ingest-')));
    root = path.join(scratch, 'workspace');
    await fs.mkdir(path.join(root, 'out'), { recursive: true });
    await fs.writeFile(path.join(root, 'out', 'plan.md'), '# Plan\n');
    await fs.writeFile(path.join(root, 'data.json'), '{"a":1}\n');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
    await fs.writeFile(path.join(root, 'blob.txt'), Buffer.from([0x61, 0x00, 0x62]));
    await fs.writeFile(path.join(root, 'big.md'), 'x'.repeat(LOCAL_DELIVERABLE_MAX_BYTES + 1));
    await fs.writeFile(path.join(scratch, 'outside.md'), 'outside\n');
    await fs.symlink(path.join(scratch, 'outside.md'), path.join(root, 'link.md'));
  });

  afterAll(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('recognises local work products and the path they name', () => {
    expect(isLocalWorkProduct({ url: 'file:///tmp/a.md' })).toBe(true);
    expect(isLocalWorkProduct({ provider: 'local' })).toBe(true);
    expect(isLocalWorkProduct({ provider: 'github', url: 'https://github.com/a/b/pull/1' })).toBe(false);
    expect(localWorkProductPath({ url: 'file:///tmp/a%20b.md' })).toBe('/tmp/a b.md');
    expect(localWorkProductPath({ provider: 'local', metadata: { path: 'out/plan.md' } })).toBe('out/plan.md');
  });

  it('reads a text file inside the workspace, absolute or relative', async () => {
    const abs = await readLocalDeliverable(path.join(root, 'out', 'plan.md'), [root]);
    expect(abs).toMatchObject({ ok: true, filename: 'plan.md', body: '# Plan\n', kind: 'markdown' });
    const rel = await readLocalDeliverable('out/plan.md', [root]);
    expect(rel.ok).toBe(true);
  });

  it('refuses traversal, symlinks out, hidden files, binaries, big files and other types', async () => {
    expect(await readLocalDeliverable('../outside.md', [root])).toEqual({ ok: false, reason: 'not_found' });
    expect(await readLocalDeliverable(path.join(scratch, 'outside.md'), [root])).toEqual({ ok: false, reason: 'not_found' });
    expect(await readLocalDeliverable('link.md', [root])).toEqual({ ok: false, reason: 'not_found' });
    expect(await readLocalDeliverable('.env', [root])).toEqual({ ok: false, reason: 'outside_workspace' });
    expect(await readLocalDeliverable('blob.txt', [root])).toEqual({ ok: false, reason: 'not_text' });
    expect(await readLocalDeliverable('big.md', [root])).toEqual({ ok: false, reason: 'too_large' });
    expect(await readLocalDeliverable('/etc/passwd', [root])).toEqual({ ok: false, reason: 'not_found' });
    expect(await readLocalDeliverable('a\0b.md', [root])).toEqual({ ok: false, reason: 'invalid_path' });
  });

  it('ignores roots that would mean anywhere', async () => {
    expect(isAcceptableWorkspaceRoot('/')).toBe(false);
    expect(isAcceptableWorkspaceRoot('/tmp')).toBe(false);
    expect(isAcceptableWorkspaceRoot(os.homedir())).toBe(false);
    expect(isAcceptableWorkspaceRoot(path.dirname(os.homedir()))).toBe(false);
    expect(isAcceptableWorkspaceRoot(root)).toBe(true);
    expect(await readLocalDeliverable('/etc/hosts', ['/'])).toEqual({ ok: false, reason: 'outside_workspace' });
  });

  it('builds document keys, bodies and titles without paths', async () => {
    expect(deliverableDocumentKey('Tanaka Japan Proposal.md')).toBe('deliverable-tanaka-japan-proposal');
    expect(deliverableDocumentKey('...md')).toMatch(/^deliverable-/);
    const json = await readLocalDeliverable('data.json', [root]);
    if (!json.ok) throw new Error('expected a read');
    expect(deliverableDocumentBody(json)).toBe('```json\n{"a":1}\n```\n');
    expect(sanitizeDeliverableTitle('/private/tmp/run/plan.md')).toBe('plan.md');
    expect(sanitizeDeliverableTitle('file:///private/tmp/run/plan.md')).toBe('plan.md');
    expect(sanitizeDeliverableTitle('Tanaka family proposal')).toBe('Tanaka family proposal');
  });
});
