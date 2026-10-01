// Which contract routes refuse agents before they do anything else.
//
// The OpenAPI contract says, per operation, which credentials may call it. A
// route that opens with `assertBoard(req)` answers 403 to every agent key, so a
// spec that lists the agent-key scheme for it is a false promise. This module
// reads a route's handler source and answers one question: does it call a
// board-only guard unconditionally — before any `if`, `try`, loop, `return`,
// `throw` or nested callback — so that no agent can get past it?
//
// Board-only guards are the ones in server/src/routes/authz.ts that refuse a
// non-board actor outright, plus any helper in the route's own file whose body
// opens with one of them (found to a fixpoint, so a helper calling a helper
// counts). A guard behind a condition does not count: `PATCH /companies/:id`
// lets a CEO agent through one branch and calls `assertBoard` in the other, and
// is open to agents.
//
// Dependency-free: it runs in the PR workflow's policy job.

import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./generate-route-index.mjs";

/** server/src/routes/authz.ts guards that throw for any actor that is not a person. */
export const AUTHZ_BOARD_ONLY_GUARDS = [
  "assertBoard",
  "assertBoardOrgAccess",
  "assertInstanceAdmin",
  "assertCanSetCompanyDirection",
  "assertCompanyAdministrator",
];

const STOP = /\bif\s*\(|\bswitch\s*\(|\btry\s*\{|\bfor\s*\(|\bwhile\s*\(|\breturn\b|\bthrow\b|\bcatch\b|=>|(?<!\?)\?(?![.?:])/;

/** Index just past the `)` matching the `(` at `open`. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

const EXITS = /\b(return|throw)\b[^;{}]*;?\s*$/;

/**
 * The statements of a function body that run on every path that continues:
 * from the opening `{` up to the first branch. An early-exit guard clause —
 * `if (…) return;`, `if (…) { …; return; }` or the same with `throw`, with no
 * `else` — is stepped over, because nothing after it runs unless the clause
 * did not fire; whatever follows it still runs on every path that gets there.
 */
export function unconditionalPrefix(body) {
  let out = "";
  let rest = body;
  for (;;) {
    const match = STOP.exec(rest);
    if (!match) return out + rest;
    out += rest.slice(0, match.index);
    if (!/^if\s*\(/.test(match[0])) return out;
    const parenOpen = match.index + match[0].length - 1;
    let after = matchParen(rest, parenOpen);
    const tail = rest.slice(after);
    const lead = /^\s*/.exec(tail)[0].length;
    let clause;
    if (tail[lead] === "{") {
      const close = matchBrace(rest, after + lead);
      clause = rest.slice(after + lead + 1, close);
      after = close + 1;
    } else {
      const end = rest.indexOf(";", after);
      if (end === -1) return out;
      clause = rest.slice(after, end + 1);
      after = end + 1;
    }
    if (!EXITS.test(clause.trim()) || /^\s*else\b/.test(rest.slice(after))) return out;
    rest = rest.slice(after);
  }
}

function callsAny(text, names) {
  return names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

/** Index of the `}` matching the `{` at `open` (strings and comments already blanked or skipped). */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Local helper functions in a route file whose bodies open with a board-only guard. */
export function boardOnlyGuards(source, base = AUTHZ_BOARD_ONLY_GUARDS) {
  const clean = stripComments(source);
  const helpers = new Map();
  for (const match of clean.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{/g)) {
    const open = match.index + match[0].length - 1;
    helpers.set(match[1], clean.slice(open + 1, matchBrace(clean, open)));
  }
  const guards = new Set(base);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of helpers) {
      if (!guards.has(name) && callsAny(unconditionalPrefix(body), [...guards])) {
        guards.add(name);
        grew = true;
      }
    }
  }
  return [...guards];
}

/**
 * The handler body of the registration that starts on `line` (1-based): the
 * body of the first arrow function in the `router.<method>(…)` call.
 */
export function handlerBody(source, line) {
  const clean = stripComments(source);
  let offset = 0;
  for (let current = 1; current < line; current += 1) offset = clean.indexOf("\n", offset) + 1;
  const call = /\brouter\s*\.\s*\w+\s*\(/g;
  call.lastIndex = offset;
  const found = call.exec(clean);
  if (!found) return null;
  const arrow = /=>\s*\{/g;
  arrow.lastIndex = found.index;
  const handler = arrow.exec(clean);
  if (!handler) return null;
  const open = handler.index + handler[0].length - 1;
  return clean.slice(open + 1, matchBrace(clean, open));
}

/** The whole `router.<method>(…)` call that starts on `line` (1-based). */
export function registrationCall(source, line) {
  const clean = stripComments(source);
  let offset = 0;
  for (let current = 1; current < line; current += 1) offset = clean.indexOf("\n", offset) + 1;
  const call = /\brouter\s*\.\s*\w+\s*\(/g;
  call.lastIndex = offset;
  const found = call.exec(clean);
  if (!found) return null;
  return clean.slice(found.index, matchParen(clean, found.index + found[0].length - 1));
}

/** Schemas the registration on `line` parses: `validate(X)` middleware and `X.parse(…)` in the handler. */
export function parsedSchemas(source, line) {
  const call = registrationCall(source, line) ?? "";
  const names = new Set();
  for (const match of call.matchAll(/\bvalidate\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) names.add(match[1]);
  for (const match of call.matchAll(/\b([A-Za-z_$][\w$]*Schema)\s*\.\s*(?:parse|safeParse)\s*\(/g)) names.add(match[1]);
  return [...names].sort();
}

/** Does the handler on `line` of `source` refuse agents before anything else? */
export function isBoardOnlyHandler(source, line, guards = boardOnlyGuards(source)) {
  const body = handlerBody(source, line);
  return body !== null && callsAny(unconditionalPrefix(body), guards);
}

/**
 * For every contract route found in a route index: whether its handler is
 * board-only. Returns `Map<"METHOD /path", { file, line, boardOnly }>`.
 */
export function classifyContractRoutes(repoRoot, contract, index) {
  const located = new Map();
  for (const group of index.groups) {
    for (const route of group.routes) located.set(`${route.method} ${route.path}`, { file: group.file, line: route.line });
  }
  const sources = new Map();
  const guardSets = new Map();
  const out = new Map();
  for (const route of contract?.routes ?? []) {
    const key = `${route.method} ${route.path}`;
    const where = located.get(key);
    if (!where) continue;
    if (!sources.has(where.file)) {
      const text = readFileSync(path.join(repoRoot, "server", "src", "routes", where.file), "utf8");
      sources.set(where.file, text);
      guardSets.set(where.file, boardOnlyGuards(text));
    }
    out.set(key, {
      ...where,
      boardOnly: isBoardOnlyHandler(sources.get(where.file), where.line, guardSets.get(where.file)),
      schemas: parsedSchemas(sources.get(where.file), where.line),
    });
  }
  return out;
}
