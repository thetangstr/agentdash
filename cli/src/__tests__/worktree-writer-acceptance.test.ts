import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assets, companies, createDb, documents, issueDocuments, issueAttachments, issues, type Db } from '@paperclipai/db';
import { applyMergePlan, createConfiguredStorageFromPaperclipConfig } from '../commands/worktree.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

describe('actual worktree merge writer acceptance', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, directory: string;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('merge-writer-'); db = createDb(temp.connectionString); directory = await mkdtemp(path.join(os.tmpdir(), 'merge-objects-')); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); await rm(directory, { recursive: true, force: true }); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Disposable merge', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: 'Attachment parent' }).returning();
    const local = (side: string) => createConfiguredStorageFromPaperclipConfig({ storage: { provider: 'local_disk', localDisk: { baseDir: path.join(directory, company.id, side) } } } as any);
    const sourceStorage = local('source'), targetStorage = local('target');
    const body = Buffer.from('verified source body'); const now = new Date();
    const source = { id: randomUUID(), companyId: company.id, issueId: issue.id, issueCommentId: null, assetId: randomUUID(), provider: 's3', objectKey: `${company.id}/source.txt`, contentType: 'text/plain', byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex'), originalFilename: 'file.txt', createdByAgentId: null, createdByUserId: null, assetCreatedAt: now, assetUpdatedAt: now, attachmentCreatedAt: now, attachmentUpdatedAt: now };
    const plan: any = { projectImports: [], issuePlans: [], commentPlans: [], documentPlans: [], attachmentPlans: [{ source, action: 'insert', targetIssueCommentId: null, targetCreatedByAgentId: null, adjustments: [] }] };
    await sourceStorage.putObject(company.id, source.objectKey, body, source.contentType);
    return { company, issue, source, body, plan, sourceStorage, targetStorage };
  }
  it('stages verified fresh target references without overwriting an existing source key/asset', async () => {
    const f = await fixture(); const old = Buffer.from('referenced target bytes');
    await f.targetStorage.putObject(f.company.id, f.source.objectKey, old, 'text/plain');
    await db.insert(assets).values({ id: f.source.assetId, companyId: f.company.id, provider: 'local_disk', objectKey: f.source.objectKey, contentType: 'text/plain', byteSize: old.length, sha256: createHash('sha256').update(old).digest('hex') });
    const result = await applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: f.targetStorage, targetDb: db, company: f.company, plan: f.plan });
    expect(result.insertedAttachments).toBe(1);
    const [attachment] = await db.select().from(issueAttachments).where(eq(issueAttachments.id, f.source.id));
    const [asset] = await db.select().from(assets).where(eq(assets.id, attachment.assetId));
    expect(asset.id).not.toBe(f.source.assetId); expect(asset.objectKey).not.toBe(f.source.objectKey); expect(asset.provider).toBe('local_disk'); expect(asset.sha256).toBe(f.source.sha256);
    expect(await f.targetStorage.getObject(f.company.id, f.source.objectKey)).toEqual(old);
    expect(await f.targetStorage.getObject(f.company.id, asset.objectKey)).toEqual(f.body);
  });
  it('performs every source/target I/O before entering the DB transaction', async () => {
    const f = await fixture(); let inside = false; let reads = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => { inside = true; try { return await target.transaction(work); } finally { inside = false; } }; } });
    const source = { ...f.sourceStorage, getObject: async (company: string, key: string) => { expect(inside).toBe(false); reads++; return f.sourceStorage.getObject(company, key); } };
    await applyMergePlan({ sourceStorages: [source], targetStorage: f.targetStorage, targetDb: root, company: f.company, plan: f.plan }); expect(reads).toBe(1);
  });
  it.each(['size', 'hash'])('refuses declared %s mismatch before target DB writes', async kind => {
    const f = await fixture(); if (kind === 'size') f.source.byteSize++; else f.source.sha256 = 'bad';
    await expect(applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: f.targetStorage, targetDb: db, company: f.company, plan: f.plan })).rejects.toThrow(/metadata/i);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.companyId, f.company.id))).toEqual([]);
  });
  it('rejects distinct shared-asset attachment candidates before storage or DB acceptance', async () => {
    const f = await fixture(); f.plan.attachmentPlans.push({ ...f.plan.attachmentPlans[0], source: { ...f.source, id: randomUUID() } });
    let reads = 0, transactions = 0;
    const source = { ...f.sourceStorage, getObject: async (company: string, key: string) => { reads++; return f.sourceStorage.getObject(company, key); } };
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return (work: any) => { transactions++; return target.transaction(work); }; } });
    await expect(applyMergePlan({ sourceStorages: [source], targetStorage: f.targetStorage, targetDb: root, company: f.company, plan: f.plan })).rejects.toThrow('Unsupported attachment merge plan');
    expect(reads).toBe(0); expect(transactions).toBe(0);
  });
  it('computes actual hash for legacy null metadata without claiming source authenticity', async () => {
    const f = await fixture(); (f.source as any).sha256 = null;
    const result = await applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: f.targetStorage, targetDb: db, company: f.company, plan: f.plan });
    expect(result.insertedAttachments).toBe(1);
    expect((await db.select().from(assets).where(eq(assets.companyId, f.company.id)))[0].sha256).toBe(createHash('sha256').update(f.body).digest('hex'));
  });

  it('exclusive local creation never overwrites referenced bytes and collisions are bounded', async () => {
    const f = await fixture(), key = `${f.company.id}/exclusive`;
    expect(await f.targetStorage.createObjectIfAbsent(f.company.id, key, f.body, 'text/plain')).toBe('created');
    expect(await f.targetStorage.createObjectIfAbsent(f.company.id, key, Buffer.from('overwrite'), 'text/plain')).toBe('exists');
    expect(await f.targetStorage.getObject(f.company.id, key)).toEqual(f.body);
    const create = vi.fn(async () => 'exists' as const), read = vi.fn();
    const target = { ...f.targetStorage, createObjectIfAbsent: create, getObject: read };
    await expect(applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: target, targetDb: db, company: f.company, plan: f.plan })).rejects.toThrow(/collisions/);
    expect(create).toHaveBeenCalledTimes(3); expect(read).not.toHaveBeenCalled();
    expect(new Set(create.mock.calls.map(args => (args as any)[1])).size).toBe(3);
  });
  it('verified readback, immutable manifest, and target provider/config identity bind references', async () => {
    const f = await fixture(); let inside = false;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => { inside = true; try { return await target.transaction(work); } finally { inside = false; } }; } });
    const target = { ...f.targetStorage, createObjectIfAbsent: async (...args: Parameters<typeof f.targetStorage.createObjectIfAbsent>) => { expect(inside).toBe(false); return f.targetStorage.createObjectIfAbsent(...args); }, getObject: async (...args: Parameters<typeof f.targetStorage.getObject>) => { expect(inside).toBe(false); return f.targetStorage.getObject(...args); } };
    const result = await applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: target, targetDb: root, company: f.company, plan: f.plan });
    expect(Object.isFrozen(result.manifest)).toBe(true); expect(Object.isFrozen(result.manifest.entries[0])).toBe(true);
    expect(result.manifest).toMatchObject({ companyId: f.company.id, provider: 'local_disk', storageIdentity: f.targetStorage.identity });
    expect(result.referencedAttachments).toEqual(result.manifest.entries); expect(result.retainedObjects).toEqual([]);
    expect(JSON.stringify(result.manifest)).not.toContain(directory);
  });
  it.each(['readback', 'unknown-write'])('%s failure retains attempted immutable objects and never enters DB', async kind => {
    const f = await fixture(); let transactions = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return (work: any) => { transactions++; return target.transaction(work); }; } });
    const target = { ...f.targetStorage,
      createObjectIfAbsent: async (...args: Parameters<typeof f.targetStorage.createObjectIfAbsent>) => { const result = await f.targetStorage.createObjectIfAbsent(...args); if (kind === 'unknown-write') throw new Error('private endpoint credential'); return result; },
      getObject: async (...args: Parameters<typeof f.targetStorage.getObject>) => kind === 'readback' ? Buffer.from('wrong bytes') : f.targetStorage.getObject(...args),
    };
    const failure: any = await applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: target, targetDb: root, company: f.company, plan: f.plan }).catch(error => error);
    expect(failure.persistenceOutcome).toBe('not_started'); expect(failure.retainedObjects).toHaveLength(1); expect(transactions).toBe(0);
    expect(await f.targetStorage.getObject(f.company.id, failure.retainedObjects[0].targetKey)).toEqual(f.body); expect(failure.message).not.toContain('credential');
  });
  it.each(['rollback', 'success-skip', 'unknown'])('%s retains every staged object without replay or deletion', async mode => {
    const f = await fixture(); let callbacks = 0;
    if (mode === 'rollback') f.plan.attachmentPlans[0].targetCreatedByAgentId = randomUUID();
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => {
      callbacks++; if (mode === 'success-skip') await db.delete(issues).where(eq(issues.id, f.issue.id));
      const result = await target.transaction(work); if (mode === 'unknown') throw new Error('lost ack'); return result;
    }; } });
    const result: any = await applyMergePlan({ sourceStorages: [f.sourceStorage], targetStorage: f.targetStorage, targetDb: root, company: f.company, plan: f.plan }).catch(error => error);
    expect(callbacks).toBe(1); expect(result.retainedObjects).toHaveLength(1);
    expect(await f.targetStorage.getObject(f.company.id, result.retainedObjects[0].targetKey)).toEqual(f.body);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.companyId, f.company.id))).toHaveLength(mode === 'unknown' ? 1 : 0);
    if (mode !== 'success-skip') expect(result.persistenceOutcome).toBe(mode === 'unknown' ? 'unknown' : 'rolled_back');
    else expect(result.refusedAttachments).toEqual(result.manifest.entries);
  });
  it.each(['eligible', 'parent-gone', 'attachment-arrived'])('missing counts remain ordered after concurrent %s state', async kind => {
    const f = await fixture(); const source = { ...f.sourceStorage, getObject: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => {
      if (kind === 'parent-gone') await db.delete(issues).where(eq(issues.id, f.issue.id));
      if (kind === 'attachment-arrived') { await db.insert(assets).values({ id: f.source.assetId, companyId: f.company.id, provider: 'local_disk', objectKey: f.source.objectKey, contentType: f.source.contentType, byteSize: f.body.length, sha256: f.source.sha256 }); await db.insert(issueAttachments).values({ id: f.source.id, companyId: f.company.id, issueId: f.issue.id, assetId: f.source.assetId }); }
      return target.transaction(work);
    }; } });
    const result = await applyMergePlan({ sourceStorages: [source], targetStorage: f.targetStorage, targetDb: root, company: f.company, plan: f.plan });
    expect(result.skippedMissingAttachmentObjects).toBe(kind === 'eligible' ? 1 : 0); expect(result.insertedAttachments).toBe(0);
  });
  it.each([undefined, 412, 409, 501] as const)('conditional S3 request contract for status %s has no unconditional fallback', async status => {
    const requests: any[] = [];
    class Command { constructor(readonly input: any) {} }
    const send = vi.fn(async (command: Command) => { requests.push(command.input); if (status) throw { name: status === 412 ? 'PreconditionFailed' : 'Unsupported', $metadata: { httpStatusCode: status } }; return {}; });
    const sdk = { S3Client: class { send = send; }, PutObjectCommand: Command, GetObjectCommand: Command };
    const target = createConfiguredStorageFromPaperclipConfig({ storage: { provider: 's3', s3: { bucket: 'fixture-bucket', region: 'fixture-region', endpoint: 'https://secret:credential@example.invalid', prefix: 'prefix', forcePathStyle: true } } } as any, async () => sdk);
    const operation = target.createObjectIfAbsent('company', 'company/key', Buffer.from('body'), 'text/plain');
    if (status && status !== 412) await expect(operation).rejects.toThrow(/not acknowledged/); else expect(await operation).toBe(status === 412 ? 'exists' : 'created');
    expect(requests).toEqual([{ Bucket: 'fixture-bucket', Key: 'prefix/company/key', Body: Buffer.from('body'), ContentType: 'text/plain', ContentLength: 4, IfNoneMatch: '*' }]);
    expect(send).toHaveBeenCalledTimes(1); expect(target.identity).toMatch(/^[a-f0-9]{64}$/); expect(target.identity).not.toContain('credential');
  });
  it('fresh document conflict cannot rewrite another company during merge', async () => {
    const f = await fixture(); f.plan.attachmentPlans = [];
    const [foreign] = await db.insert(companies).values({ name: 'Private', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [privateIssue] = await db.insert(issues).values({ companyId: foreign.id, title: 'Private' }).returning();
    const [document] = await db.insert(documents).values({ companyId: foreign.id, title: 'Private original', format: 'markdown', latestBody: 'Private original' }).returning();
    await db.insert(issueDocuments).values({ companyId: foreign.id, issueId: privateIssue.id, documentId: document.id, key: 'plan' });
    f.plan.documentPlans = [{ action: 'merge_existing', source: { id: randomUUID(), companyId: f.company.id, issueId: f.issue.id, documentId: document.id, key: 'plan', title: 'Wrong replacement', format: 'markdown', latestBody: 'wrong', createdByUserId: null, updatedByUserId: null, documentCreatedAt: new Date(), documentUpdatedAt: new Date(), linkCreatedAt: new Date(), linkUpdatedAt: new Date() }, latestRevisionId: null, latestRevisionNumber: 0, targetCreatedByAgentId: null, targetUpdatedByAgentId: null, revisionsToInsert: [] }];
    await expect(applyMergePlan({ sourceStorages: [], targetStorage: f.targetStorage, targetDb: db, company: f.company, plan: f.plan })).rejects.toMatchObject({ persistenceOutcome: 'rolled_back' });
    expect((await db.select().from(documents).where(eq(documents.id, document.id)))[0].title).toBe('Private original');
    expect((await db.select().from(issueDocuments).where(eq(issueDocuments.documentId, document.id)))[0].issueId).toBe(privateIssue.id);
  });

  it('binds a relative local target directory once so cwd changes cannot retarget its identity', async () => {
    const f = await fixture(), initialCwd = process.cwd();
    const configuredRoot = path.join(directory, f.company.id, 'relative-target');
    const absoluteTarget = createConfiguredStorageFromPaperclipConfig({ storage: { provider: 'local_disk', localDisk: { baseDir: configuredRoot } } } as any);
    const key = `${f.company.id}/bound-object`;
    try {
      process.chdir(directory);
      const target = createConfiguredStorageFromPaperclipConfig({ storage: { provider: 'local_disk', localDisk: { baseDir: path.relative(directory, configuredRoot) } } } as any);
      const identity = target.identity;
      await target.createObjectIfAbsent(f.company.id, key, f.body, 'text/plain');
      process.chdir(initialCwd);
      expect(target.identity).toBe(identity);
      expect(await target.getObject(f.company.id, key)).toEqual(f.body);
    } finally { process.chdir(initialCwd); }
    expect(await absoluteTarget.getObject(f.company.id, key)).toEqual(f.body);
  });

});
