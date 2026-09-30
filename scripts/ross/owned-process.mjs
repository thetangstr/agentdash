import { spawn } from 'node:child_process';

// One group per child. Cancellation stays installed until escalation completes,
// even if the immediate child exits before its descendants. Callers that nest
// this helper must give their inner child a shorter grace than the outer group.
export function runOwnedProcess(command, args, { cwd, env, timeoutMs, graceMs = 2000, maxBytes = 1_048_576 }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, failure = null, closed = false, escalated = false, directExited = false, settled = false, exitCode, exitSignal;
    const signal = name => {
      try { if (child.pid) process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const finish = () => {
      if (settled || (!closed && !(failure && escalated)) || (failure && !escalated)) return;
      settled = true;
      clearTimeout(deadline);
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      if (failure) failure = { ...failure, escalated, stdioClosed: closed, directExited };
      // Escaped pipe holders must not defeat the deadline. This records an
      // incomplete capture; it does not claim that unrelated groups were killed.
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal: exitSignal, failure });
    };
    const terminate = code => {
      if (failure) return;
      failure = { code, signal: exitSignal };
      signal('SIGTERM');
      setTimeout(() => { signal('SIGKILL'); escalated = true; finish(); }, graceMs);
    };
    const listeners = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(name => [name, () => terminate('parent_' + name)]);
    for (const [name, listener] of listeners) process.on(name, listener);
    const deadline = setTimeout(() => terminate('timeout'), timeoutMs);
    const collect = (stream, value) => {
      const remaining = Math.max(0, maxBytes - bytes);
      const captured = value.subarray(0, remaining);
      if (stream === 'stdout') stdout.push(captured); else stderr.push(captured);
      bytes += value.length;
      if (bytes > maxBytes) terminate('output_limit');
    };
    child.stdout.on('data', value => collect('stdout', value));
    child.stderr.on('data', value => collect('stderr', value));
    child.on('error', error => { failure = { code: error.code }; escalated = true; });
    child.on('exit', (code, sig) => {
      directExited = true; exitCode = code; exitSignal = sig;
      if (code !== 0 && !failure) terminate(code);
    });
    child.on('close', (code, sig) => {
      closed = true; exitCode = code; exitSignal = sig;
      // Do not clear escalation just because the direct child closed.
      finish();
    });
  });
}
