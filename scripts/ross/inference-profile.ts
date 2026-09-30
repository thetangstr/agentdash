import { buildRossNoNetworkStartupProfile } from './startup-profile.js';

// Explicit pilot-only egress. Existing HOME/exec/write restrictions still apply.
export function buildRossInferenceProfile(options: Parameters<typeof buildRossNoNetworkStartupProfile>[0], apiPort: number) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('exact local API port required');
  return buildRossNoNetworkStartupProfile(options) + [
    // This host's SBPL remote-ip filter accepts only * or localhost. This is
    // outbound HTTPS, not a hostname allowlist; the client route stays pinned.
    '(allow network-outbound (remote ip "*:443"))',
    `(allow network-outbound (remote ip "localhost:${apiPort}"))`,
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    '',
  ].join('\n');
}
