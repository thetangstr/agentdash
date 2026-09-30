import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { buildRossNoNetworkStartupProfile } from './startup-profile.js';

const execute = promisify(execFile);

test('startup sandbox denies project dotenv, shared home, runtime writes and all networking while permitting code and isolated state', async () => {
  if (process.platform !== 'darwin') throw new Error('this host proof requires macOS; no unsandboxed fallback');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ross-startup-sandbox-')));
  const homeDir = join(root, 'operator');
  const runtime = join(homeDir, 'runtime');
  const workspaceDir = join(root, 'work');
  const syntheticHomeDir = join(workspaceDir, 'home');
  const listener = createServer(socket => { socket.on('error', () => {}); socket.end('synthetic network fixture'); });
  try {
    for (const path of [runtime, syntheticHomeDir]) await mkdir(path, { recursive: true });
    await writeFile(join(homeDir, 'shared-config'), 'synthetic shared data');
    await writeFile(join(runtime, 'code.py'), 'synthetic code');
    await writeFile(join(runtime, '.env'), 'SYNTHETIC_KEY=not-a-key');
    await writeFile(join(runtime, '.op.env'), 'SYNTHETIC_KEY=not-a-key');
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    const profile = buildRossNoNetworkStartupProfile({ homeDir, workspaceDir, syntheticHomeDir, readOnlyPaths: [runtime], execPaths: [process.execPath], egress: 'loopback' });
    const profilePath = join(workspaceDir, 'startup.sb');
    await writeFile(profilePath, profile);
    const probe = `const fs=require('node:fs'); const net=require('node:net'); const cp=require('node:child_process'); const p=${JSON.stringify({ homeDir, runtime, syntheticHomeDir, port })};
      const canRead=x=>{try{fs.readFileSync(x);return true;}catch{return false;}};
      const canWrite=x=>{try{fs.writeFileSync(x,'synthetic');return true;}catch{return false;}};
      const result={codeReadable:canRead(p.runtime+'/code.py'),dotenvReadable:canRead(p.runtime+'/.env'),opEnvReadable:canRead(p.runtime+'/.op.env'),sharedHomeReadable:canRead(p.homeDir+'/shared-config'),runtimeWritable:canWrite(p.runtime+'/new-file'),privateStateWritable:canWrite(p.syntheticHomeDir+'/state')};
      result.nullDeviceWritable=canWrite('/dev/null');
      result.auxExecutableRunnable=cp.spawnSync('/usr/bin/true').status===0;
      const socket=net.connect({host:'127.0.0.1',port:p.port}); socket.setTimeout(1000);
      let finished=false; const finish=v=>{if(finished)return;finished=true;result.networkConnectable=v;socket.destroy();console.log(JSON.stringify(result));}; socket.on('connect',()=>finish(true));socket.on('error',()=>finish(false));socket.on('timeout',()=>finish(false));`;
    const { stdout } = await execute('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, '-e', probe], { cwd: workspaceDir, env: { PATH: '/usr/bin:/bin', HOME: syntheticHomeDir }, timeout: 5_000 });
    expect(JSON.parse(stdout)).toEqual({ codeReadable: true, dotenvReadable: false, opEnvReadable: false, sharedHomeReadable: false, runtimeWritable: false, privateStateWritable: true, nullDeviceWritable: true, networkConnectable: false, auxExecutableRunnable: false });
    expect(await readFile(join(runtime, '.env'), 'utf8')).toBe('SYNTHETIC_KEY=not-a-key');
  } finally {
    listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
