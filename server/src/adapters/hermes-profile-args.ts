// AgentDash: where a Hermes `-p/--profile` can come from in an adapterConfig,
// read the way Hermes reads it, and stripped from the same places.
//
// One module for both halves so they cannot drift: the ledger resolver
// (hermes-usage.ts) asks "which profile does this run use?", and the managed
// run path (registry.ts) removes every profile flag that does not name the
// agent's own profile. Before this, the resolver honoured `args` and a `-p`
// inside the command string while the run-time strip only looked at
// `extraArgs`, so a foreign `-p` in `args` survived the strip and still
// steered the resolver to another profile's ledger.

/**
 * The adapterConfig keys that can carry a profile flag, in argv order: the
 * command string's own tokens come first, then `extraArgs` (appended by the
 * adapter after its own flags), then the legacy `args` array.
 */
export const HERMES_PROFILE_COMMAND_KEYS = ["hermesCommand", "command"] as const;
export const HERMES_PROFILE_ARGV_KEYS = ["extraArgs", "args"] as const;

/** Hermes' own profile-id rule (hermes_cli/profiles.py `_PROFILE_ID_RE`). */
export const HERMES_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Hermes canonicalises a profile name to lowercase (`normalize_profile_name`). */
function canonicalProfile(raw: string): string | null {
  const canon = raw.trim().toLowerCase();
  if (canon === "default") return "default";
  return HERMES_PROFILE_ID.test(canon) ? canon : null;
}

/**
 * The profile Hermes selects from an argv, exactly as its pre-parse does
 * (hermes_cli/main.py `_scan_profile_flag`, pinned v2026.9.11): the FIRST
 * `-p NAME` / `--profile NAME` whose NAME is a valid profile id, or
 * `--profile=NAME`; a `-p` followed by anything else ends the scan with no
 * profile, and so does `--`. Returns the canonical name, `"default"` for the
 * root profile, or null when the argv selects none.
 */
export function hermesProfileFromArgv(tokens: unknown): string | null {
  if (!Array.isArray(tokens)) return null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string") continue;
    if (token === "--") return null;
    if (token === "-p" || token === "--profile") {
      const next = tokens[index + 1];
      if (typeof next === "string" && HERMES_PROFILE_ID.test(next)) return next;
      return null;
    }
    if (token.startsWith("--profile=")) return canonicalProfile(token.slice("--profile=".length));
  }
  return null;
}

function commandTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^["']|["']$/g, ""));
}

/** A `-p/--profile` inside the command string itself (`hermes -p foo`). */
export function hermesProfileFromCommand(command: unknown): string | null {
  if (typeof command !== "string" || command.trim().length === 0) return null;
  return hermesProfileFromArgv(commandTokens(command).slice(1));
}

/** The command the Hermes adapter invokes: `hermesCommand`, else `command` (normalizeHermesConfig). */
export function hermesConfigCommand(config: Record<string, unknown> | null | undefined): string | null {
  for (const key of HERMES_PROFILE_COMMAND_KEYS) {
    const value = config?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * The profile an explicit flag in the adapterConfig selects, reading the same
 * keys `stripForeignHermesProfileConfig` strips: the command string, then
 * `extraArgs`, then `args`. A wrapper script the command points at is the
 * resolver's business (it has to read the file); it sits between the command
 * string and `extraArgs`, because the wrapper's own `-p` precedes `"$@"`.
 */
export function hermesProfileFromConfigCommand(config: Record<string, unknown> | null | undefined): string | null {
  return hermesProfileFromCommand(hermesConfigCommand(config));
}

export function hermesProfileFromConfigArgv(config: Record<string, unknown> | null | undefined): string | null {
  for (const key of HERMES_PROFILE_ARGV_KEYS) {
    const profile = hermesProfileFromArgv(config?.[key]);
    if (profile) return profile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run-time strip
// ---------------------------------------------------------------------------

/**
 * A profile flag token. Broader than Hermes' pre-parse on purpose: argparse
 * later also accepts `-pNAME` and unambiguous abbreviations of `--profile`
 * (`--prof NAME`, `--prof=NAME`), so the strip treats all of them as profile
 * flags. Stripping a superset is safe; missing a spelling is not.
 */
function profileFlagOf(token: string): { inlineValue: string | null } | null {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (name.length >= 4 && "--profile".startsWith(name)) {
      return { inlineValue: eq > 0 ? token.slice(eq + 1) : null };
    }
    return null;
  }
  if (token === "-p") return { inlineValue: null };
  if (token.startsWith("-p")) return { inlineValue: token.slice(2) };
  return null;
}

/** Drop every profile flag in an argv that does not name `ownProfile`. */
export function stripForeignHermesProfileArgs(
  extraArgs: unknown,
  ownProfile: string,
): { extraArgs: unknown; dropped: string[] } {
  if (!Array.isArray(extraArgs)) return { extraArgs, dropped: [] };
  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const token = extraArgs[i];
    const parsed = typeof token === "string" ? profileFlagOf(token) : null;
    if (!parsed) {
      kept.push(token);
      continue;
    }
    if (parsed.inlineValue !== null) {
      if (parsed.inlineValue === ownProfile) kept.push(token);
      else dropped.push(parsed.inlineValue);
      continue;
    }
    const next = extraArgs[i + 1];
    if (typeof next === "string" && next === ownProfile) kept.push(token, next);
    else dropped.push(typeof next === "string" ? next : "");
    i += 1;
  }
  return { extraArgs: kept, dropped };
}

function stripForeignProfileFromCommand(command: string, ownProfile: string): { command: string; dropped: string[] } {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length <= 1) return { command, dropped: [] };
  const stripped = stripForeignHermesProfileArgs(
    tokens.slice(1).map((t) => t.replace(/^["']|["']$/g, "")),
    ownProfile,
  );
  if (stripped.dropped.length === 0) return { command, dropped: [] };
  return { command: [tokens[0], ...(stripped.extraArgs as string[])].join(" "), dropped: stripped.dropped };
}

/**
 * AgentDash (#737): the run-time half of the managed-profile rule, over every
 * key the resolver reads (`hermesCommand`, `command`, `extraArgs`, `args`).
 * Returns a patched copy and the profile values that were dropped.
 */
export function stripForeignHermesProfileConfig<T extends Record<string, unknown>>(
  config: T,
  ownProfile: string,
): { config: T; dropped: string[] } {
  const next: Record<string, unknown> = { ...config };
  const dropped: string[] = [];
  for (const key of HERMES_PROFILE_ARGV_KEYS) {
    if (!Array.isArray(next[key])) continue;
    const stripped = stripForeignHermesProfileArgs(next[key], ownProfile);
    if (stripped.dropped.length > 0) {
      next[key] = stripped.extraArgs;
      dropped.push(...stripped.dropped);
    }
  }
  for (const key of HERMES_PROFILE_COMMAND_KEYS) {
    const value = next[key];
    if (typeof value !== "string") continue;
    const stripped = stripForeignProfileFromCommand(value, ownProfile);
    if (stripped.dropped.length > 0) {
      next[key] = stripped.command;
      dropped.push(...stripped.dropped);
    }
  }
  return { config: next as T, dropped };
}
