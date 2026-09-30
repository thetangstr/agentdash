import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runOwnedProcess } from './owned-process.mjs';

test('timeout kills an owned grandchild even when the immediate child exits first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ross-owned-process-'));
  const pidFile = join(root, 'grandchild.pid');
  const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const child = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  try {
    const result = await runOwnedProcess(process.execPath, ['-e', child], { cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 700, graceMs: 100 });
    assert.equal(result.failure.code, 'timeout');
    const pid = Number(await readFile(pidFile, 'utf8'));
    // macOS may briefly retain the exited child until its new parent reaps it.
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, 'owned grandchild must not survive the deadline');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('output overflow cancels the owned process and returns bounded capture', async () => {
  const result = await runOwnedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'], { cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 2000, graceMs: 50, maxBytes: 1000 });
  assert.equal(result.failure.code, 'output_limit');
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1000);
});

test('a failed immediate child cannot leave an owned grandchild running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ross-failed-process-'));
  const pidFile = join(root, 'grandchild.pid');
  const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const child = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setTimeout(()=>process.exit(7),300);`;
  let pid;
  try {
    const result = await runOwnedProcess(process.execPath, ['-e', child], { cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 2000, graceMs: 100 });
    pid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.failure.code, 7);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves UTF-8 when a character is split across output chunks', async () => {
  const child = 'const b=Buffer.from("hello 🌍");process.stdout.write(b.subarray(0,8));setTimeout(()=>process.stdout.write(b.subarray(8)),50);';
  const result = await runOwnedProcess(process.execPath, ['-e', child], { cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 2000 });
  assert.equal(result.failure, null);
  assert.equal(result.stdout, 'hello 🌍');
});

test('parent cancellation propagates through nested owned process groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ross-cancel-process-'));
  const pidFile = join(root, 'grandchild.pid');
  const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const child = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const helper = new URL('./owned-process.mjs', import.meta.url).href;
  const runner = `import {runOwnedProcess} from ${JSON.stringify(helper)};const r=await runOwnedProcess(process.execPath,['-e',${JSON.stringify(child)}],{cwd:${JSON.stringify(root)},env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,graceMs:100});console.log(JSON.stringify(r));`;
  const outer = spawn(process.execPath, ['--input-type=module', '-e', runner], { cwd: root, env: { PATH: '/usr/bin:/bin' }, detached: true });
  let output = '', pid;
  outer.stdout.setEncoding('utf8');
  outer.stdout.on('data', value => { output += value; });
  const closed = new Promise(resolve => outer.on('close', resolve));
  try {
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(pid, 'test descendant started');
    outer.kill('SIGTERM');
    await closed;
    assert.equal(JSON.parse(output).failure.code, 'parent_SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    for (const target of [pid, -outer.pid]) { if (target) { try { process.kill(target, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
    await rm(root, { recursive: true, force: true });
  }
});

test('deadline returns failure even when a detached pipe holder prevents child close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ross-escaped-pipe-'));
  const pidFile = join(root, 'escaped.pid');
  const escaped = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:['ignore',1,2]});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  let pid;
  const running = runOwnedProcess(process.execPath, ['-e', child], { cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 700, graceMs: 100 });
  let watchdog;
  try {
    const result = await Promise.race([running, new Promise(resolve => { watchdog = setTimeout(() => resolve({ hung: true }), 2000); })]);
    pid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.hung, undefined, 'stdio ownership must not defeat the process deadline');
    assert.equal(result.failure.code, 'timeout');
    assert.equal(result.failure.escalated, true);
    assert.equal(result.failure.stdioClosed, false);
    assert.equal(result.failure.directExited, true);
  } finally {
    clearTimeout(watchdog);
    if (!pid) { try { pid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await running;
    await rm(root, { recursive: true, force: true });
  }
});
