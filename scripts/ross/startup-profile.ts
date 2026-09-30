import { assertSandboxSupported, buildSandboxProfile } from '../../packages/adapter-utils/src/seatbelt.js';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export function buildRossNoNetworkStartupProfile(options: Parameters<typeof buildSandboxProfile>[0]) {
  assertSandboxSupported();
  if (!options.syntheticHomeDir || options.readWritePaths?.length || !options.execPaths?.length) throw new Error('startup requires private home, explicit executables and workspace-only writes');
  // Seatbelt matches resolved paths. /var aliases otherwise silently miss a deny.
  const canonical = {
    ...options, homeDir: realpathSync(options.homeDir), workspaceDir: realpathSync(options.workspaceDir),
    syntheticHomeDir: realpathSync(options.syntheticHomeDir), egress: 'loopback' as const,
    // Directory aliases also need metadata while execvp traverses symlinks.
    readOnlyPaths: options.readOnlyPaths ? [...new Set(options.readOnlyPaths.flatMap(path => [path, realpathSync(path)]))] : [],
    // execvp checks the invoked venv symlink as well as its resolved interpreter.
    // Keep both exact names; the builder validates each literal before emitting.
    execPaths: [...new Set(options.execPaths.flatMap(path => [path, realpathSync(path)]))],
  };
  if (!canonical.syntheticHomeDir.startsWith(canonical.workspaceDir + '/')) throw new Error('private home must be inside startup workspace');
  const base = buildSandboxProfile(canonical);
  // A terminal generic deny does not beat the builder's specific loopback
  // allows on this host. Remove those allows before loading the profile.
  const networkAllows = base.split('\n').filter(line => line.startsWith('(allow network'));
  if (networkAllows.length !== 2) throw new Error('review changed sandbox network rules before startup');
  const restrictedBase = base.split('\n').filter(line => !line.startsWith('(allow network') && !line.startsWith('(allow process-exec')).join('\n');
  const denied = new Set<string>();
  for (const root of canonical.readOnlyPaths ?? []) {
    for (const name of ['.env', '.op.env']) {
      const path = join(root, name);
      denied.add(path);
      try { denied.add(realpathSync(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  // Builder validated its paths; resolved dotenv targets need the same rejection.
  for (const path of denied) if (/["\\\n\r]/.test(path)) throw new Error('unsafe sandbox deny path');
  return restrictedBase + '\n' + [
    // Python 3.11 Path.exists propagates denied stat. Keep metadata available
    // while blocking contents and writes; startup also disables dotenv parsing.
    ...[...denied].map(path => `(deny file-read-data file-write* (literal "${path}"))`),
    '(deny file-read-data file-write* (subpath "/private/etc/hermes"))',
    '(deny file-write*)',
    `(allow file-write* (subpath "${canonical.workspaceDir}"))`,
    // Hermes' process-local supervisor redirects output to this device.
    '(allow file-write-data (literal "/dev/null"))',
    '(deny process-exec)',
    ...canonical.execPaths!.map(path => `(allow process-exec (literal "${path}"))`),
    '(deny network*)',
    '',
  ].join('\n');
}
