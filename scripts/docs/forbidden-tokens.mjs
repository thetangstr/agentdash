// The hashed forbidden-token list for the public docs, and the scan that uses it.
// One copy: ui/src/lib/docs.test.ts scans every bundled page with it,
// scripts/ci/check-docs-forbidden-tokens.mjs scans every page the nav lists
// with it in the policy job, and scripts/docs/generate-api-changelog.mjs
// withholds any release-note line it hits. Node builtins only (the changelog generator runs in the PR workflow's
// policy job, which has no install).

import { createHash } from "node:crypto";

/**
 * Customer, instance and people identifiers that must never be on the public
 * site. Stored as SHA-256 of the lowercase token, with its length, only so the
 * tokens are not printed in clear in this file and its diffs. This is NOT a
 * secret: the tokens are short and guessable, and anyone with a guess list can
 * recover them from these hashes. Every token starts with a letter or digit,
 * so the scan hashes, for each token length, the window at every word start
 * in the page's lowercase text: the start of the text, or a letter or digit
 * right after anything else (a space, `.`, `@`, `/`, `(`, `-`, `_`, …). That
 * finds a token wherever it begins a word — on its own, in a hostname, an
 * address, a path or an identifier — and costs roughly a tenth of hashing
 * every window. It does not find a token glued onto the end of a longer run
 * of letters and digits (`xtoken`). Hyphenated spellings are listed
 * separately; a bare short name is not, where it would match inside ordinary
 * words.
 */
export const FORBIDDEN_TOKENS = [
  { length: 7, sha256: "4998fa28eb8d38a27eff147fb68e1ad03ea01658fb5eec10aabadbaf37ffe565" },
  { length: 7, sha256: "b9de7ec8cd4acc8522ecc7ac274f10fa904242ae15b9d05cd7a393a95bb7dd75" },
  { length: 12, sha256: "3e7cb594871023585497489bc000d29e482cda61bca9c8693020b3a85f40053c" },
  { length: 12, sha256: "0536debeda2dbcfc02c055b13ce259457871d9224cf501a302e1c751eb28c1f2" },
  { length: 6, sha256: "0c59fcbbac92f38fa899db945fa4e6d4b252a224b7003eb7839c80f7899544fc" },
  { length: 5, sha256: "b9cbfe962ddda6952b584988cbf7d074a35ec1e99ef71853447cb0eb91bb6547" },
  { length: 5, sha256: "2d07d002c88b7c7546f7c81175b0fd8ef3843654895574b81ba28573d4373a96" },
  { length: 12, sha256: "68b7730d0f4346654432e894c673760d287e3ee7a7509c4c6f802f216301c4b7" },
  { length: 12, sha256: "b9dd1da230753160f70e3864d24aa0bd1ca81cd8bceaf3709fd41e09d55214b1" },
  { length: 12, sha256: "53ac39752d14c82c6972e6acd2f56dbfbaeeccb41e7e6371e95799d1ad09dad8" },
  { length: 13, sha256: "37c999ba9fb7fc5b18a5786b2399cb2711ea412cc1de92246a6725712e56c21a" },
  // An engagement-specific product name (PR 3b review).
  { length: 6, sha256: "3908a3427811a92cb0a40293e10ac1ddc89dafb531404a784d792ae61d152d39" },
  // A personal network handle, and a bare short name (PR 4 review). The scan
  // starts windows at word starts only, so the 4-character one matches words
  // that begin with it, never ones that merely contain it.
  { length: 10, sha256: "9841cbc4448b3f02046ab6fe44cf212c069cd3cd85567a58ce1e6f90e9939319" },
  { length: 4, sha256: "fbd8dafe1f79f47371dd79d334d9a6c1aaab28c14b9533417462629d576639f3" },
];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const ALNUM = /[a-z0-9]/;

/** Offsets where a word starts: a letter or digit at the start of the text or after a non-alphanumeric character. */
function wordStarts(lower) {
  const starts = [];
  for (let i = 0; i < lower.length; i += 1) {
    if (ALNUM.test(lower[i]) && (i === 0 || !ALNUM.test(lower[i - 1]))) starts.push(i);
  }
  return starts;
}

/** Offsets at which a window starting a word in `text` hashes to one of `tokens`. */
export function forbiddenTokenOffsets(text, tokens = FORBIDDEN_TOKENS) {
  const lower = text.toLowerCase();
  const byLength = new Map();
  for (const token of tokens) {
    if (!byLength.has(token.length)) byLength.set(token.length, new Set());
    byLength.get(token.length).add(token.sha256);
  }
  const offsets = [];
  const starts = wordStarts(lower);
  for (const [length, hashes] of byLength) {
    for (const i of starts) {
      if (i + length > lower.length) break;
      if (hashes.has(sha256(lower.slice(i, i + length)))) offsets.push(i);
    }
  }
  return offsets.sort((a, b) => a - b);
}
