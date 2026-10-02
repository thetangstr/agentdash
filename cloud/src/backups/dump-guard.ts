// AgentDash (GH #733 security review): what may be replayed from a box's dump.
//
// Threat model: the dump is written by the BOX. A compromised tenant box can
// put anything in it, and the envelope only proves the control plane sealed
// what the box sent; it does not prove the SQL is benign or which box sent
// it. Replay therefore never gives that SQL more than a database owner's power
// in a disposable database (sql-restore.ts checks the role), and, before that,
// every statement is parsed with the REAL Postgres parser (libpg_query, as
// WASM through `libpg-query`) and must match, node for node and field for
// field, one of the statement shapes packages/db/src/backup-lib.ts writes:
//
//   BEGIN / COMMIT, SET LOCAL session_replication_role | client_min_messages,
//   CREATE SCHEMA IF NOT EXISTS, CREATE TYPE … AS ENUM, CREATE TYPE … AS
//   (composite attribute list — names and types only), CREATE DOMAIN … AS
//   <type> (COLLATE / DEFAULT <checked expression> / NOT NULL only), CREATE
//   EXTENSION IF NOT EXISTS <allowlisted>, DROP TABLE|SEQUENCE IF EXISTS,
//   CREATE SEQUENCE, ALTER SEQUENCE … OWNED BY, CREATE TABLE (columns, NOT
//   NULL, DEFAULT, GENERATED ALWAYS AS <checked expression> STORED, PRIMARY
//   KEY, UNIQUE; never AS SELECT), CREATE INDEX, ALTER TABLE … ADD CONSTRAINT
//   (exactly one PRIMARY KEY | UNIQUE | FOREIGN KEY), INSERT …
//   VALUES (constants only), SELECT setval(<literal>, <literal>, <literal>),
//   COPY <table> (<columns>) FROM STDIN.
//
// AgentDash (GH #907): backup-lib also writes CHECK constraints, views,
// functions and triggers. Those are refused here and SKIPPED by replay (see
// deferredStatement below); schema-verify re-creates them from our migrations.
//
// AgentDash (GH #939, #944): backup-lib additionally writes ALTER DOMAIN (SET
//   DEFAULT / ADD CONSTRAINT), ALTER TABLE … ALTER COLUMN … SET DEFAULT and
//   ALTER TABLE … ADD COLUMN … GENERATED — all expression-bearing, all skipped
//   like the other schema objects. CREATE DOMAIN and CREATE TYPE … AS (…) are
//   NOT skipped: replayed CREATE TABLE statements name those types, so the
//   domain or composite must exist — but neither can carry unchecked code, so
//   they are validated above like a small CREATE TABLE. A constraint or index
//   that exists only because a column was added late carries the
//   DEFERRED_SCHEMA_MARKER comment and is skipped for the same reason.
//
// Any other node, any unknown field, more than one statement, and any
// function call outside FUNCTION_ALLOWLIST is refused. Expressions (column
// defaults, partial-index predicates, index expressions) may only use
// constants, casts, column references, operators, and the allowlisted
// functions. Quoting, comments and spacing cannot hide anything from a parser.
import { loadModule, parseSync } from "libpg-query";

export const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

/** AgentDash (GH #944): the leading-comment marker backup-lib writes before a deferred schema statement (kept in sync with packages/db/src/backup-lib.ts — the control plane does not import box code). */
export const DEFERRED_SCHEMA_MARKER = "-- paperclip deferred schema object";

/** Extensions a box schema may create (pg_trgm today; the rest are trusted, common and harmless). */
export const EXTENSION_ALLOWLIST = new Set(["plpgsql", "pg_trgm", "pgcrypto", "uuid-ossp", "citext", "btree_gin", "btree_gist", "unaccent", "fuzzystrmatch", "vector"]);

/** Functions allowed inside defaults and index expressions. Pure, built in, no I/O. */
export const FUNCTION_ALLOWLIST = new Set([
  "nextval", "now", "gen_random_uuid", "uuid_generate_v4", "lower", "upper", "length", "char_length", "btrim", "ltrim", "rtrim",
  "jsonb_typeof", "json_typeof", "array_length", "cardinality", "date_trunc", "timezone", "to_tsvector", "md5", "abs", "jsonb_build_object", "jsonb_build_array",
]);

/** Largest non-COPY statement accepted (an INSERT row with a big text value is the largest legitimate one). */
export const MAX_STATEMENT_BYTES = 16 * 1024 * 1024;

/**
 * PostgreSQL whitespace: the six ASCII characters the backend's scanner
 * treats as space (C-locale isspace). JavaScript's trim() also strips Unicode
 * spaces (U+00A0, U+2028, …) that Postgres sees as ordinary characters, so it
 * must never decide what counts as blank or a comment here — a line that only
 * LOOKS empty to JS would be skipped while Postgres still saw it.
 */
const PG_LEADING_WS = /^[ \t\n\r\f\v]+/;
const PG_TRAILING_WS = /[ \t\n\r\f\v]+$/;
const PG_ONLY_WS = /^[ \t\n\r\f\v]*$/;

/** trim() with PostgreSQL's whitespace set. */
export function pgTrim(s: string): string {
  return s.replace(PG_LEADING_WS, "").replace(PG_TRAILING_WS, "");
}

/** A line of nothing but PostgreSQL whitespace. */
export function isPgBlankLine(line: string): boolean {
  return PG_ONLY_WS.test(line);
}

/** A line whose first non-whitespace characters open a `--` comment, as Postgres sees it. */
export function isPgCommentLine(line: string): boolean {
  return line.replace(PG_LEADING_WS, "").startsWith("--");
}

/**
 * The ONE `COPY … FROM stdin` header test. Both the guard and the dump
 * splitter go through here so the two can never diverge — the earlier
 * duplicate regexes accepted slightly different shapes. Whitespace is
 * PostgreSQL's ASCII set, not JS `\s` (which also matches Unicode spaces the
 * real parser would choke on anyway).
 */
const COPY_FROM_STDIN = /^COPY[ \t\r\f\v].+[ \t\r\f\v]FROM[ \t\r\f\v]+stdin[ \t\r\f\v]*;?$/i;

/** The COPY command without its trailing `;`, or null when `line` is not a COPY-FROM-stdin header. */
export function copyFromStdinCommand(line: string): string | null {
  const t = pgTrim(line);
  return COPY_FROM_STDIN.test(t) ? t.replace(/;$/, "") : null;
}

/** Leading blank lines and `--` comment lines, as PostgreSQL would classify them. */
export function stripLeadingComments(statement: string): string {
  const lines = statement.split("\n");
  let i = 0;
  while (i < lines.length && (isPgBlankLine(lines[i]!) || isPgCommentLine(lines[i]!))) i++;
  return pgTrim(lines.slice(i).join("\n"));
}

/**
 * A `COPY … FROM stdin` block (after any leading comments), split into
 * command and TSV payload. Returns null for anything else, so ordinary DDL
 * keeps its existing path. For big payloads prefer the streaming splitter in
 * ./sql-restore.ts — this joins the data into one string.
 */
export function parseCopyFromStdin(statement: string): { command: string; payload: string } | null {
  const all = statement.split("\n");
  let i = 0;
  while (i < all.length && (isPgBlankLine(all[i]!) || isPgCommentLine(all[i]!))) i++;
  if (i >= all.length) return null;
  const command = copyFromStdinCommand(all[i]!);
  if (command === null) return null;
  const lines = all.slice(i + 1);
  const end = lines.findIndex((l) => l === "\\.");
  const data = end === -1 ? lines : lines.slice(0, end);
  return { command, payload: data.length ? `${data.join("\n")}\n` : "" };
}

let ready: Promise<void> | null = null;
/** Load the parser (WASM) once; call before checkStatement. */
export function initDumpGuard(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

/** Source-position metadata the parser adds; never semantic. */
const POSITION_FIELDS = new Set(["location", "list_start", "list_end"]);

class Refused extends Error {}

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new Refused(msg);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The single `{ Type: body }` of a node. */
function node(v: unknown, where: string): [string, Obj] {
  if (!isObj(v)) fail(`${where}: not a node`);
  const keys = Object.keys(v);
  if (keys.length !== 1) fail(`${where}: malformed node`);
  const body = v[keys[0]!];
  if (!isObj(body)) fail(`${where}: malformed node`);
  return [keys[0]!, body];
}

function expectNode(v: unknown, type: string, where: string): Obj {
  const [t, body] = node(v, where);
  if (t !== type) fail(`${where}: ${t} is not allowed here`);
  return body;
}

/** Every field of `o` must be in `allowed`; `fixed` fields must hold exactly those values when present. */
function fields(o: Obj, allowed: string[], where: string, fixed: Record<string, unknown> = {}): void {
  for (const k of Object.keys(o)) {
    if (POSITION_FIELDS.has(k)) continue;
    if (!allowed.includes(k) && !(k in fixed)) fail(`${where}: field ${k} is not allowed`);
  }
  for (const [k, v] of Object.entries(fixed)) if (k in o && o[k] !== v) fail(`${where}: ${k}=${JSON.stringify(o[k])} is not allowed`);
}

function list(v: unknown, where: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${where}: expected a list`);
  return v;
}

function str(v: unknown, where: string): string {
  const b = expectNode(v, "String", where);
  fields(b, ["sval"], where);
  return String(b.sval ?? "");
}

function strings(v: unknown, where: string): string[] {
  return list(v, where).map((x) => str(x, where));
}

function rangeVar(v: unknown, where: string): void {
  if (!isObj(v)) fail(`${where}: expected a relation`);
  fields(v, ["schemaname", "relname"], where, { inh: true, relpersistence: "p" });
}

function typeName(v: unknown, where: string): void {
  if (!isObj(v)) fail(`${where}: expected a type`);
  fields(v, ["names", "typemod", "typmods", "arrayBounds"], where);
  strings(v.names, `${where}.names`);
  for (const m of list(v.typmods, `${where}.typmods`)) constant(m, `${where}.typmods`);
  for (const b of list(v.arrayBounds, `${where}.arrayBounds`)) fields(expectNode(b, "Integer", where), ["ival"], where);
}

function aConst(b: Obj, where: string): void {
  fields(b, ["sval", "ival", "fval", "boolval", "bsval", "isnull"], where);
}

/** Constants only: literals and casts of literals (INSERT values, typmods). */
function constant(v: unknown, where: string): void {
  const [t, b] = node(v, where);
  if (t === "A_Const") return aConst(b, where);
  if (t === "TypeCast") {
    fields(b, ["arg", "typeName"], where);
    typeName(b.typeName, where);
    return constant(b.arg, where);
  }
  if (t === "A_ArrayExpr") {
    fields(b, ["elements"], where);
    for (const e of list(b.elements, where)) constant(e, where);
    return;
  }
  fail(`${where}: ${t} is not a constant`);
}

function funcName(v: unknown, where: string): string {
  const parts = strings(v, where);
  if (parts.length === 2 && parts[0] === "pg_catalog") return parts[1]!;
  if (parts.length !== 1) fail(`${where}: schema-qualified function ${parts.join(".")} is not allowed`);
  return parts[0]!;
}

/** Expressions in defaults and index definitions. */
function expr(v: unknown, where: string): void {
  const [t, b] = node(v, where);
  switch (t) {
    case "A_Const":
      return aConst(b, where);
    case "TypeCast":
      fields(b, ["arg", "typeName"], where);
      typeName(b.typeName, where);
      return expr(b.arg, where);
    case "ColumnRef":
      fields(b, ["fields"], where);
      strings(b.fields, where); // A_Star is refused here
      return;
    case "A_Expr": {
      fields(b, ["kind", "name", "lexpr", "rexpr"], where);
      const ok = ["AEXPR_OP", "AEXPR_IN", "AEXPR_LIKE", "AEXPR_ILIKE", "AEXPR_BETWEEN", "AEXPR_NOT_BETWEEN", "AEXPR_NULLIF", "AEXPR_DISTINCT", "AEXPR_NOT_DISTINCT", "AEXPR_OP_ANY", "AEXPR_OP_ALL"];
      if (!ok.includes(String(b.kind))) fail(`${where}: ${String(b.kind)} is not allowed`);
      if (strings(b.name, where).length !== 1) fail(`${where}: qualified operators are not allowed`);
      for (const side of [b.lexpr, b.rexpr]) {
        if (side === undefined) continue;
        const [st, sb] = node(side, where);
        if (st === "List") list(sb.items, where).forEach((x) => expr(x, where));
        else expr(side, where);
      }
      return;
    }
    case "BoolExpr":
      fields(b, ["boolop", "args"], where);
      return list(b.args, where).forEach((x) => expr(x, where));
    case "NullTest":
      fields(b, ["arg", "nulltesttype"], where);
      return expr(b.arg, where);
    case "BooleanTest":
      fields(b, ["arg", "booltesttype"], where);
      return expr(b.arg, where);
    case "CoalesceExpr":
    case "MinMaxExpr":
      fields(b, ["args", "op"], where);
      return list(b.args, where).forEach((x) => expr(x, where));
    case "A_ArrayExpr":
      fields(b, ["elements"], where);
      return list(b.elements, where).forEach((x) => expr(x, where));
    case "SQLValueFunction":
      fields(b, ["op", "typmod"], where);
      return;
    case "CollateClause":
      fields(b, ["arg", "collname"], where);
      strings(b.collname, where);
      return expr(b.arg, where);
    case "CaseExpr":
      fields(b, ["arg", "args", "defresult"], where);
      if (b.arg !== undefined) expr(b.arg, where);
      for (const w of list(b.args, where)) {
        const cw = expectNode(w, "CaseWhen", where);
        fields(cw, ["expr", "result"], where);
        expr(cw.expr, where);
        expr(cw.result, where);
      }
      if (b.defresult !== undefined) expr(b.defresult, where);
      return;
    case "FuncCall": {
      fields(b, ["funcname", "args"], where, { funcformat: "COERCE_EXPLICIT_CALL" });
      const name = funcName(b.funcname, where);
      if (!FUNCTION_ALLOWLIST.has(name)) fail(`${where}: function ${name}() is not allowed`);
      const args = list(b.args, where);
      if (name === "nextval") {
        if (args.length !== 1) fail(`${where}: nextval takes one sequence name`);
        constant(args[0], where);
        return;
      }
      return args.forEach((x) => expr(x, where));
    }
    default:
      fail(`${where}: ${t} is not allowed in an expression`);
  }
}

function constraint(v: unknown, where: string, allowed: string[]): Obj {
  const c = expectNode(v, "Constraint", where);
  fields(c, ["contype", "conname", "raw_expr", "keys", "pktable", "fk_attrs", "pk_attrs", "fk_matchtype", "fk_upd_action", "fk_del_action", "deferrable", "initdeferred", "nulls_not_distinct", "generated_when", "generated_kind"], where, { is_enforced: true, initially_valid: true });
  const type = String(c.contype);
  if (!allowed.includes(type)) fail(`${where}: ${type} is not allowed here`);
  if (type === "CONSTR_GENERATED") {
    // AgentDash (GH #944): GENERATED ALWAYS AS (…) STORED (and PG18's
    // VIRTUAL) inside a CREATE TABLE column. The expression itself is checked
    // like a DEFAULT's below.
    if (c.generated_when !== "a") fail(`${where}: only GENERATED ALWAYS`);
    if (c.generated_kind !== "s" && c.generated_kind !== "v") fail(`${where}: generated kind ${JSON.stringify(c.generated_kind)} is not allowed`);
    if (c.raw_expr === undefined) fail(`${where}: a generated column needs an expression`);
  }
  if (c.raw_expr !== undefined) {
    if (type !== "CONSTR_DEFAULT" && type !== "CONSTR_GENERATED" && type !== "CONSTR_CHECK") {
      fail(`${where}: an expression is only allowed in DEFAULT, GENERATED or CHECK`);
    }
    const label = type === "CONSTR_GENERATED" ? "GENERATED" : type === "CONSTR_CHECK" ? "CHECK" : "DEFAULT";
    expr(c.raw_expr, `${where} ${label}`);
  }
  strings(c.keys, where);
  strings(c.fk_attrs, where);
  strings(c.pk_attrs, where);
  if (c.pktable !== undefined) rangeVar(c.pktable, where);
  if (type === "CONSTR_FOREIGN" && c.pktable === undefined) fail(`${where}: a foreign key needs a table`);
  return c;
}

/** A `COLLATE <name>` clause, serialized inline (no node wrapper). */
function collateClause(v: unknown, where: string): void {
  if (v === undefined) return;
  if (!isObj(v)) fail(`${where}: malformed COLLATE`);
  fields(v, ["collname"], where);
  strings(v.collname, where);
}

function defElems(v: unknown, where: string): Array<{ name: string; arg: unknown }> {
  return list(v, where).map((d) => {
    const b = expectNode(d, "DefElem", where);
    fields(b, ["defname", "arg"], where, { defaction: "DEFELEM_UNSPEC" });
    return { name: String(b.defname), arg: b.arg };
  });
}

function numberNode(v: unknown, where: string): void {
  const [t, b] = node(v, where);
  if (t === "Integer") return fields(b, ["ival"], where);
  if (t === "Float") return fields(b, ["fval"], where);
  fail(`${where}: expected a number`);
}

function checkTop(stmt: unknown): void {
  const [type, b] = node(stmt, "statement");
  const w = type;
  switch (type) {
    case "TransactionStmt":
      fields(b, ["kind"], w);
      if (b.kind !== "TRANS_STMT_BEGIN" && b.kind !== "TRANS_STMT_COMMIT") fail(`${w}: only BEGIN and COMMIT`);
      return;
    case "VariableSetStmt": {
      fields(b, ["name", "args"], w, { kind: "VAR_SET_VALUE", is_local: true });
      const allowed: Record<string, string[]> = { session_replication_role: ["replica"], client_min_messages: ["warning"] };
      const values = allowed[String(b.name)];
      if (!values || b.is_local !== true) fail(`${w}: only SET LOCAL session_replication_role or client_min_messages`);
      const args = list(b.args, w);
      if (args.length !== 1) fail(`${w}: one value`);
      const c = expectNode(args[0], "A_Const", w);
      aConst(c, w);
      const val = isObj(c.sval) ? String(c.sval.sval) : "";
      if (!values.includes(val)) fail(`${w}: value ${val} is not allowed`);
      return;
    }
    case "CreateSchemaStmt":
      fields(b, ["schemaname"], w, { if_not_exists: true });
      if (b.if_not_exists !== true) fail(`${w}: only IF NOT EXISTS`);
      return;
    case "CreateEnumStmt":
      fields(b, ["typeName", "vals"], w);
      strings(b.typeName, w);
      strings(b.vals, w);
      return;
    case "CompositeTypeStmt": {
      // AgentDash (GH #944): CREATE TYPE … AS (name type, …). Attribute lists
      // hold only names and types — nothing executable — so the type may run
      // during replay; a CREATE TABLE later in the dump can name it.
      fields(b, ["typevar", "coldeflist"], w);
      rangeVar(b.typevar, w);
      for (const el of list(b.coldeflist, w)) {
        const cd = expectNode(el, "ColumnDef", w);
        fields(cd, ["colname", "typeName", "collClause"], `${w} attribute`, { is_local: true });
        typeName(cd.typeName, `${w} attribute`);
        collateClause(cd.collClause, `${w} attribute`);
      }
      return;
    }
    case "CreateDomainStmt": {
      // AgentDash (GH #944): CREATE DOMAIN … AS <type> [COLLATE] [DEFAULT
      // <expr>] [CONSTRAINT <name> CHECK (<expr>)] [NOT NULL]. Validated CHECK
      // constraints are written inline — ALTER DOMAIN cannot add them once a
      // column of an array of the domain exists — so CHECK is accepted here
      // and its expression goes through the same allowlist as a DEFAULT's.
      // A check that needs an object the dump creates later still comes as
      // ALTER DOMAIN, which replay skips.
      fields(b, ["domainname", "typeName", "collClause", "constraints"], w);
      strings(b.domainname, w);
      typeName(b.typeName, w);
      collateClause(b.collClause, w);
      for (const c of list(b.constraints, w)) constraint(c, `${w} domain`, ["CONSTR_NOTNULL", "CONSTR_NULL", "CONSTR_DEFAULT", "CONSTR_CHECK"]);
      return;
    }
    case "CreateExtensionStmt": {
      // WITH SCHEMA stays allowed: backup-lib writes it to keep each extension
      // in its recorded schema, and backups already in storage rely on it. It
      // is only safe on a server with the CVE-2022-2625 / CVE-2023-39417
      // search_path fixes, which replayDump (sql-restore.ts) enforces via
      // server_version_num (>= 11.21 / 12.16 / 13.12 / 14.9 / 15.4, or 16+).
      fields(b, ["extname", "options"], w, { if_not_exists: true });
      if (b.if_not_exists !== true) fail(`${w}: only IF NOT EXISTS`);
      if (!EXTENSION_ALLOWLIST.has(String(b.extname))) fail(`extension ${String(b.extname)} is not on the allowlist`);
      for (const d of defElems(b.options, w)) {
        if (d.name !== "schema") fail(`${w}: option ${d.name} is not allowed`);
        str(d.arg, w);
      }
      return;
    }
    case "DropStmt":
      fields(b, ["objects", "removeType", "behavior"], w, { missing_ok: true });
      if (b.removeType !== "OBJECT_TABLE" && b.removeType !== "OBJECT_SEQUENCE") fail(`${w}: only tables and sequences`);
      if (b.missing_ok !== true) fail(`${w}: only IF EXISTS`);
      for (const o of list(b.objects, w)) strings(expectNode(o, "List", w).items, w);
      return;
    case "CreateSeqStmt":
      fields(b, ["sequence", "options"], w);
      rangeVar(b.sequence, w);
      for (const d of defElems(b.options, w)) {
        if (d.name === "as") typeName(expectNode(d.arg, "TypeName", w), w);
        else if (["increment", "minvalue", "maxvalue", "start", "cache"].includes(d.name)) numberNode(d.arg, w);
        else if (d.name === "cycle") fields(expectNode(d.arg, "Boolean", w), ["boolval"], w);
        else fail(`${w}: option ${d.name} is not allowed`);
      }
      return;
    case "AlterSeqStmt": {
      fields(b, ["sequence", "options"], w);
      rangeVar(b.sequence, w);
      const opts = defElems(b.options, w);
      if (opts.length !== 1 || opts[0]!.name !== "owned_by") fail(`${w}: only OWNED BY`);
      strings(expectNode(opts[0]!.arg, "List", w).items, w);
      return;
    }
    case "CreateStmt":
      fields(b, ["relation", "tableElts"], w, { oncommit: "ONCOMMIT_NOOP" });
      rangeVar(b.relation, w);
      for (const el of list(b.tableElts, w)) {
        const [et, eb] = node(el, w);
        if (et === "ColumnDef") {
          fields(eb, ["colname", "typeName", "constraints"], `${w} column`, { is_local: true });
          typeName(eb.typeName, `${w} column`);
          // AgentDash (GH #944): CONSTR_GENERATED is allowed — its expression
          // is checked like a DEFAULT's inside constraint().
          for (const c of list(eb.constraints, w)) constraint(c, `${w} column ${String(eb.colname)}`, ["CONSTR_NOTNULL", "CONSTR_NULL", "CONSTR_DEFAULT", "CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_GENERATED"]);
        } else if (et === "Constraint") {
          constraint(el, `${w} table constraint`, ["CONSTR_PRIMARY", "CONSTR_UNIQUE"]);
        } else fail(`${w}: ${et} is not allowed in a table`);
      }
      return;
    case "IndexStmt": {
      fields(b, ["idxname", "relation", "accessMethod", "indexParams", "indexIncludingParams", "whereClause", "unique", "nulls_not_distinct"], w);
      rangeVar(b.relation, w);
      if (!["btree", "gin", "gist", "hash", "brin"].includes(String(b.accessMethod))) fail(`${w}: access method ${String(b.accessMethod)} is not allowed`);
      const elems = [...list(b.indexParams, w), ...list(b.indexIncludingParams, w)];
      for (const e of elems) {
        const ie = expectNode(e, "IndexElem", w);
        fields(ie, ["name", "expr", "opclass", "ordering", "nulls_ordering", "collation"], w);
        if ((ie.name === undefined) === (ie.expr === undefined)) fail(`${w}: an index column needs a name or an expression`);
        if (ie.expr !== undefined) expr(ie.expr, `${w} expression`);
        strings(ie.opclass, w);
        strings(ie.collation, w);
      }
      if (b.whereClause !== undefined) expr(b.whereClause, `${w} WHERE`);
      return;
    }
    case "AlterTableStmt": {
      fields(b, ["relation", "cmds"], w, { objtype: "OBJECT_TABLE" });
      rangeVar(b.relation, w);
      const cmds = list(b.cmds, w);
      if (cmds.length !== 1) fail(`${w}: exactly one subcommand`);
      const cmd = expectNode(cmds[0], "AlterTableCmd", w);
      fields(cmd, ["def"], w, { subtype: "AT_AddConstraint", behavior: "DROP_RESTRICT" });
      if (cmd.subtype !== "AT_AddConstraint") fail(`${w}: only ADD CONSTRAINT`);
      constraint(cmd.def, `${w} constraint`, ["CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_FOREIGN"]);
      return;
    }
    case "InsertStmt": {
      fields(b, ["relation", "cols", "selectStmt"], w, { override: "OVERRIDING_NOT_SET" });
      rangeVar(b.relation, w);
      for (const c of list(b.cols, w)) fields(expectNode(c, "ResTarget", w), ["name"], w);
      const sel = expectNode(b.selectStmt, "SelectStmt", w);
      fields(sel, ["valuesLists"], `${w} VALUES`, { limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" });
      const rows = list(sel.valuesLists, w);
      if (!rows.length) fail(`${w}: only INSERT … VALUES`);
      for (const r of rows) list(expectNode(r, "List", w).items, w).forEach((x) => constant(x, `${w} value`));
      return;
    }
    case "SelectStmt": {
      fields(b, ["targetList"], w, { limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" });
      const targets = list(b.targetList, w);
      if (targets.length !== 1) fail(`${w}: only SELECT setval(…)`);
      const rt = expectNode(targets[0], "ResTarget", w);
      fields(rt, ["val"], w);
      const fc = expectNode(rt.val, "FuncCall", w);
      fields(fc, ["funcname", "args"], w, { funcformat: "COERCE_EXPLICIT_CALL" });
      if (funcName(fc.funcname, w) !== "setval") fail(`${w}: only SELECT setval(…)`);
      const args = list(fc.args, w);
      if (args.length !== 3) fail(`${w}: setval takes three literals`);
      args.forEach((a) => aConst(expectNode(a, "A_Const", w), w));
      return;
    }
    case "CopyStmt":
      fields(b, ["relation", "attlist"], w, { is_from: true });
      if (b.is_from !== true) fail(`${w}: only COPY … FROM STDIN`);
      rangeVar(b.relation, w);
      strings(b.attlist, w);
      return;
    default:
      fail(`${type} is not a statement the backup library writes`);
  }
}

/**
 * Why a statement must not be replayed, or null when it may. A COPY block is
 * checked on its header line only (the rest is TSV data, never parsed as SQL);
 * parseCopyFromStdin is the single place that decides what is such a block.
 * Call initDumpGuard() first.
 */
export function checkStatement(statement: string): string | null {
  const body = stripLeadingComments(statement);
  if (!body) return null;
  const copy = parseCopyFromStdin(body);
  const sql = copy ? copy.command : body;
  if (Buffer.byteLength(sql, "utf8") > MAX_STATEMENT_BYTES) return `statement larger than ${MAX_STATEMENT_BYTES} bytes`;
  let parsed: { stmts?: Array<{ stmt?: unknown }> };
  try {
    parsed = parseSync(sql) as { stmts?: Array<{ stmt?: unknown }> };
  } catch (err) {
    return `does not parse: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`;
  }
  const stmts = parsed.stmts ?? [];
  if (stmts.length !== 1) return stmts.length ? "more than one statement" : "empty statement";
  try {
    checkTop(stmts[0]!.stmt);
    return null;
  } catch (err) {
    if (err instanceof Refused) return err.message;
    throw err;
  }
}

/**
 * AgentDash (GH #907): backup-lib now also writes CHECK constraints, views,
 * functions and triggers (plus `SET LOCAL check_function_bodies = false`
 * ahead of the functions), so a box's own restore is self-contained. Replay
 * NEVER runs those from a box-written dump: a function body or a view is
 * arbitrary code. They are skipped here and re-created afterwards from OUR
 * migrations only (schema-verify.ts repairFromReference), exactly as for
 * older dumps that did not carry them. checkStatement still refuses them, so
 * nothing that only checks statements can run one by mistake.
 *
 * Returns what the statement is when replay should skip it, or null. A COPY
 * block or anything that is not exactly one such statement is never skipped.
 * Call initDumpGuard() first.
 */
export function deferredStatement(statement: string): string | null {
  // AgentDash (GH #944): backup-lib writes this marker ahead of a constraint
  // or index that only exists because a column was added late (a deferred
  // generated column — never created in replay, so the statement would fail
  // on a missing column). The marker must be a LEADING comment of the chunk:
  // the same text inside an INSERT's string literal does not count (it is not
  // a comment line there). Skipping can never hurt — schema-verify re-creates
  // these objects from our migrations — so the box-controlled marker is safe
  // to trust in this direction.
  for (const line of statement.split("\n")) {
    if (isPgBlankLine(line)) continue;
    if (!isPgCommentLine(line)) break;
    if (pgTrim(line) === DEFERRED_SCHEMA_MARKER) return "deferred schema object";
  }
  const body = stripLeadingComments(statement);
  if (!body || parseCopyFromStdin(body)) return null;
  if (Buffer.byteLength(body, "utf8") > MAX_STATEMENT_BYTES) return null;
  let parsed: { stmts?: Array<{ stmt?: unknown }> };
  try {
    parsed = parseSync(body) as { stmts?: Array<{ stmt?: unknown }> };
  } catch {
    return null;
  }
  const stmts = parsed.stmts ?? [];
  if (stmts.length !== 1) return null;
  const stmt = stmts[0]!.stmt;
  if (!isObj(stmt)) return null;
  const keys = Object.keys(stmt);
  if (keys.length !== 1) return null;
  const type = keys[0]!;
  const b = stmt[type];
  if (!isObj(b)) return null;
  switch (type) {
    case "CreateFunctionStmt":
      return "function";
    case "CreateTrigStmt":
      return "trigger";
    case "ViewStmt":
      return "view";
    case "CreateTableAsStmt":
      return b.objtype === "OBJECT_MATVIEW" ? "materialized view" : null;
    case "VariableSetStmt":
      return b.name === "check_function_bodies" && b.is_local === true ? "SET LOCAL check_function_bodies" : null;
    case "AlterTableStmt": {
      const cmds = Array.isArray(b.cmds) ? b.cmds : [];
      if (cmds.length !== 1 || !isObj(cmds[0])) return null;
      const cmd = (cmds[0] as Obj).AlterTableCmd;
      if (!isObj(cmd)) return null;
      // A trigger's enabled state (DISABLE / ENABLE REPLICA / ENABLE ALWAYS TRIGGER).
      if (["AT_DisableTrig", "AT_EnableReplicaTrig", "AT_EnableAlwaysTrig", "AT_EnableTrig"].includes(String(cmd.subtype))) return "trigger state";
      // AgentDash (GH #939): ALTER COLUMN … SET DEFAULT <expr> — the shape a
      // function-dependent default takes. The expression is unchecked code,
      // so it is never executed here; a DROP DEFAULT (no def) is refused.
      if (cmd.subtype === "AT_ColumnDefault") return cmd.def !== undefined ? "column default" : null;
      // AgentDash (GH #944): ADD COLUMN … GENERATED ALWAYS AS (…) STORED, the
      // deferred form a generated column takes when its expression needs an
      // object the dump creates later. Only the generated shape is skipped —
      // a plain ADD COLUMN stays refused.
      if (cmd.subtype === "AT_AddColumn" && isObj(cmd.def)) {
        const cd = (cmd.def as Obj).ColumnDef;
        if (isObj(cd) && Array.isArray(cd.constraints) && cd.constraints.some((c) => {
          const con = isObj(c) ? c.Constraint : null;
          return isObj(con) && con.contype === "CONSTR_GENERATED";
        })) return "generated column";
        return null;
      }
      if (cmd.subtype !== "AT_AddConstraint" || !isObj(cmd.def)) return null;
      const con = (cmd.def as Obj).Constraint;
      return isObj(con) && con.contype === "CONSTR_CHECK" ? "check constraint" : null;
    }
    // AgentDash (GH #944): every ALTER DOMAIN (SET DEFAULT, ADD CONSTRAINT,
    // SET NOT NULL, …) is an expression-bearing or schema-shaping statement
    // replay never runs.
    case "AlterDomainStmt":
      return "domain alteration";
    default:
      return null;
  }
}
