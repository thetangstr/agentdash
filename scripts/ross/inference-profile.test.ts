import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { buildRossInferenceProfile } from './inference-profile.js';

test('permits only the bound loopback port plus HTTPS, with no bind grant or invalid port', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ross-inference-profile-')));
  const home = join(root, 'home');
  const servers = [createServer(socket => socket.end()), createServer(socket => socket.end())];
  try {
    await mkdir(home);
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const [allowed, denied] = servers.map(server => (server.address() as { port: number }).port);
    const options = { homeDir: homedir(), workspaceDir: root, syntheticHomeDir: home, execPaths: [process.execPath], egress: 'loopback' as const };
    const profile = buildRossInferenceProfile(options, allowed);
    expect(profile).toContain('(remote ip "*:443")');
    expect(profile).not.toContain('(allow network-bind');
    for (const port of [0, 65536, 1.5, NaN]) expect(() => buildRossInferenceProfile(options, port)).toThrow();
    await writeFile(join(root, 'inference.sb'), profile);
    const script = `const net=require('node:net'); const probe=p=>new Promise(r=>{const s=net.connect({host:'127.0.0.1',port:p});s.setTimeout(1000);let done=false;const finish=v=>{if(done)return;done=true;s.destroy();r(v);};s.on('connect',()=>finish(true));s.on('error',()=>finish(false));s.on('timeout',()=>finish(false));});(async()=>console.log(JSON.stringify({allowed:await probe(${allowed}),denied:await probe(${denied})})))();`;
    const { stdout } = await promisify(execFile)('/usr/bin/sandbox-exec', ['-f', join(root, 'inference.sb'), process.execPath, '-e', script], { cwd: root, env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 5_000 });
    expect(JSON.parse(stdout)).toEqual({ allowed: true, denied: false });
  } finally { for (const server of servers) server.close(); await rm(root, { recursive: true, force: true }); }
});
