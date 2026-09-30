import { createHash } from 'node:crypto';

export const REVIEWED_EXECUTE_SHA256 = '4b0738181fe244290a2792b7c8bde12a4adc5f603a9cd9ff02e628d0966cae52';

// Offline draft only: Codex owns this file. No I/O or runtime activation.
export function draftHermesEnvironmentPatch(source: string) {
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (sourceSha256 !== REVIEWED_EXECUTE_SHA256) {
    throw new Error('unreviewed Hermes source drift: inspect before drafting');
  }
  const replacements = [
    [
      'import { runChildProcess, buildPaperclipEnv, renderTemplate, ensureAbsoluteDirectory, } from "@paperclipai/adapter-utils/server-utils";',
      'import { runChildProcess, buildPaperclipEnv, renderTemplate, ensureAbsoluteDirectory, inheritableAdapterEnv, } from "@paperclipai/adapter-utils/server-utils";',
    ],
    ['        ...process.env,', '        ...inheritableAdapterEnv(process.env),'],
  ];
  let candidate = source;
  for (const [before, after] of replacements) {
    if (candidate.split(before).length !== 2) {
      throw new Error('reviewed Hermes source does not have the unique expected patch location');
    }
    candidate = candidate.replace(before, after);
  }
  return {
    source: candidate,
    sourceSha256,
    candidateSha256: createHash('sha256').update(candidate).digest('hex'),
  };
}
