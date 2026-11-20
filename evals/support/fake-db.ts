/**
 * An in-memory stand-in for Supabase's REST API (PostgREST), for the eval
 * suite. Tables, column defaults and unique keys are read from Tony's own
 * migrations, so the evals follow the schema as it changes; the supabase-js
 * client talks to it through a custom fetch, exactly as it talks to the real
 * database. Only what Tony's code uses is supported.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Default = () => unknown;
type Table = { columns: Map<string, Default | undefined>; identity: string[]; unique: string[][]; rows: Row[]; next: number };

/** A column default from its SQL: now(), a quoted text, a number, a boolean, '[]', '{0,15}', a uuid. */
function defaultOf(sql: string): Default | undefined {
  const expr = sql.trim().replace(/\s+(check|not null|null|references|unique|primary key)\b.*$/i, "").trim();
  if (/now\(\)/i.test(expr)) return () => new Date().toISOString();
  if (/gen_random_uuid/i.test(expr)) return () => randomUUID().replace(/-/g, "");
  if (/^true$/i.test(expr)) return () => true;
  if (/^false$/i.test(expr)) return () => false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return () => Number(expr);
  const quoted = /^'((?:[^']|'')*)'(::[\w[\]]+)?$/.exec(expr);
  if (quoted) {
    const text = quoted[1].replace(/''/g, "'");
    if (quoted[2]?.includes("json")) return () => JSON.parse(text);
    if (/^\{.*\}$/.test(text)) return () => text.slice(1, -1).split(",").filter(Boolean).map((v) => (/^-?\d+$/.test(v) ? Number(v) : v));
    return () => text;
  }
  return undefined;
}

/** Splits "a int default 1, b text, unique (a, b)" at top-level commas. */
function topLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.replace(/--[^\n]*/g, "").trim()).filter(Boolean);
}

function readSchema(dir: string): Map<string, Table> {
  const tables = new Map<string, Table>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, { columns: new Map(), identity: [], unique: [], rows: [], next: 1 });
    return tables.get(name)!;
  };
  const column = (t: Table, definition: string) => {
    const match = /^"?([a-z_][a-z0-9_]*)"?\s+(.*)$/is.exec(definition);
    if (!match || /^(primary|unique|constraint|check|foreign|exclude)$/i.test(match[1])) {
      const unique = /\bunique\s*\(([^)]+)\)/i.exec(definition) ?? /\bprimary key\s*\(([^)]+)\)/i.exec(definition);
      if (unique) t.unique.push(unique[1].split(",").map((c) => c.trim()));
      return;
    }
    const [, name, rest] = match;
    if (/generated .* as identity|\bserial\b/i.test(rest)) t.identity.push(name);
    const def = /\bdefault\s+(.+)$/is.exec(rest);
    t.columns.set(name, def ? defaultOf(def[1]) : undefined);
    if (/\b(primary key|unique)\b/i.test(rest)) t.unique.push([name]);
  };
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    for (const match of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi)) {
      const t = table(match[1]);
      for (const definition of topLevel(match[2])) column(t, definition);
    }
    for (const match of sql.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)\s+([\s\S]*?);/gi)) {
      if (!tables.has(match[1])) continue;
      const t = table(match[1]);
      for (const clause of topLevel(match[2])) {
        const add = /^add column (?:if not exists )?([\s\S]+)$/i.exec(clause.trim());
        if (add) column(t, add[1]);
        const unique = /^add (?:constraint \w+ )?unique\s*\(([^)]+)\)/i.exec(clause.trim());
        if (unique) t.unique.push(unique[1].split(",").map((c) => c.trim()));
      }
    }
  }
  return tables;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Compares a stored value with a value from the query string, by the stored value's type. */
function compare(have: unknown, raw: string): number {
  if (have === null || have === undefined) return NaN;
  if (typeof have === "number") return have - Number(raw);
  if (typeof have === "boolean") return Number(have) - Number(raw === "true");
  const text = String(have);
  if (TIMESTAMP.test(text) && TIMESTAMP.test(raw)) return new Date(text).getTime() - new Date(raw).getTime();
  return text < raw ? -1 : text > raw ? 1 : 0;
}

const likeToRegex = (pattern: string, flags: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*").replace(/_/g, ".")}$`, flags);

function test(row: Row, column: string, filter: string): boolean {
  if (filter.startsWith("not.")) return !test(row, column, filter.slice(4));
  const dot = filter.indexOf(".");
  const op = filter.slice(0, dot);
  const value = filter.slice(dot + 1);
  const have = row[column];
  switch (op) {
    case "eq":
      return compare(have, value) === 0;
    case "neq":
      return have !== null && have !== undefined && compare(have, value) !== 0;
    case "lt":
      return compare(have, value) < 0;
    case "lte":
      return compare(have, value) <= 0;
    case "gt":
      return compare(have, value) > 0;
    case "gte":
      return compare(have, value) >= 0;
    case "is":
      return value === "null" ? have === null || have === undefined : String(have) === value;
    case "in": {
      const list = value.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      return list.some((v) => compare(have, v) === 0);
    }
    case "like":
      return typeof have === "string" && likeToRegex(value, "s").test(have);
    case "ilike":
      return typeof have === "string" && likeToRegex(value, "is").test(have);
    default:
      throw new Error(`fake-db: unsupported filter ${filter}`);
  }
}

/** "(a.eq.1,b.is.null)" → true when any holds. */
function testOr(row: Row, expression: string): boolean {
  return topLevel(expression.slice(1, -1)).some((clause) => {
    const dot = clause.indexOf(".");
    return test(row, clause.slice(0, dot), clause.slice(dot + 1));
  });
}

export type FakeDb = {
  client: SupabaseClient;
  tables: Map<string, Table>;
  rows: (table: string) => Row[];
  insert: (table: string, row: Row) => Row;
  reset: () => void;
  /** A write that does not stick, as in his 22:48 case: these fields are dropped from updates to the table. */
  faults: { table: string; drop: string[] }[];
};

export function createFakeDb(migrations = join(__dirname, "../../supabase/migrations")): FakeDb {
  const tables = readSchema(migrations);
  const faults: { table: string; drop: string[] }[] = [];
  const need = (name: string) => {
    const t = tables.get(name);
    if (!t) throw Object.assign(new Error(`relation "${name}" does not exist`), { status: 404, code: "42P01" });
    return t;
  };

  const fill = (t: Table, row: Row): Row => {
    const full: Row = {};
    for (const [name, def] of t.columns) full[name] = name in row ? row[name] : def ? def() : null;
    for (const name of t.identity) if (!(name in row)) full[name] = t.next++;
    for (const name of t.identity) if (typeof full[name] === "number" && (full[name] as number) >= t.next) t.next = (full[name] as number) + 1;
    for (const [name, value] of Object.entries(row)) if (!t.columns.has(name)) full[name] = value;
    return full;
  };
  const clash = (t: Table, row: Row, keys?: string[][]) =>
    t.rows.find((other) => (keys ?? t.unique).some((cols) => cols.every((c) => row[c] !== null && row[c] !== undefined && compare(other[c], String(row[c])) === 0)));

  const insert = (name: string, row: Row): Row => {
    const t = need(name);
    const full = fill(t, row);
    if (clash(t, full)) throw Object.assign(new Error("duplicate key value violates unique constraint"), { status: 409, code: "23505" });
    t.rows.push(full);
    return full;
  };

  const handle = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
    try {
      if (!url.pathname.includes("/rest/v1/")) return json(404, { message: "fake-db: only the REST API is served" });
      const name = url.pathname.split("/").pop()!;
      const t = need(name);
      const prefer = headers.get("prefer") ?? "";
      let order: [string, boolean, boolean][] = [];
      let limit: number | undefined;
      let offset = 0;
      const embeds: { alias: string; table: string }[] = [];
      const where: ((row: Row) => boolean)[] = [];
      for (const [key, value] of url.searchParams) {
        if (key === "select") {
          for (const m of value.matchAll(/(\w+):(\w+)\(\*\)/g)) embeds.push({ alias: m[1], table: m[2] });
          continue;
        }
        if (key === "order") {
          order = value.split(",").map((part) => {
            const [col, ...flags] = part.split(".");
            const desc = flags.includes("desc");
            return [col, desc, flags.includes("nullsfirst") ? true : flags.includes("nullslast") ? false : desc];
          });
          continue;
        }
        if (key === "limit") limit = Number(value);
        else if (key === "offset") offset = Number(value);
        else if (key === "columns" || key === "on_conflict") continue;
        else if (key === "or") where.push((row) => testOr(row, value));
        else where.push((row) => test(row, key, value));
      }
      const matching = () => t.rows.filter((row) => where.every((fn) => fn(row)));
      const sorted = (rows: Row[]) =>
        [...rows].sort((a, b) => {
          for (const [col, desc, nullsFirst] of order) {
            const x = a[col];
            const y = b[col];
            if (x == null || y == null) {
              if (x == null && y == null) continue;
              return (x == null ? -1 : 1) * (nullsFirst ? 1 : -1);
            }
            const c = compare(x, String(y));
            if (c !== 0 && !Number.isNaN(c)) return desc ? -c : c;
          }
          return 0;
        });
      const embed = (row: Row): Row => {
        const out = { ...row };
        for (const { alias, table } of embeds) out[alias] = need(table).rows.find((other) => other.id === row[`${alias}_id`]) ?? null;
        return out;
      };

      let rows: Row[];
      if (method === "GET" || method === "HEAD") {
        const all = sorted(matching());
        rows = all.slice(offset, limit === undefined ? undefined : offset + limit).map(embed);
        const count: Record<string, string> = prefer.includes("count=exact") ? { "content-range": `0-${Math.max(rows.length - 1, 0)}/${all.length}` } : {};
        if (method === "HEAD") return new Response(null, { status: 200, headers: count });
        return single(rows, headers, json, count);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init.body ?? "null"));
        const list: Row[] = Array.isArray(body) ? body : [body];
        const conflict = url.searchParams.get("on_conflict")?.split(",").map((c) => c.trim());
        rows = [];
        for (const row of list) {
          if (conflict || prefer.includes("resolution=")) {
            const keys = conflict ? [conflict] : t.unique;
            const existing = clash(t, fill(t, row), keys);
            if (existing) {
              if (prefer.includes("merge-duplicates")) Object.assign(existing, row);
              rows.push(existing);
              continue;
            }
          }
          rows.push(insert(name, row));
        }
        if (!prefer.includes("return=representation")) return new Response(null, { status: 201 });
        return single(rows.map(embed), headers, json, {}, 201);
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init.body ?? "{}")) as Row;
        for (const fault of faults) if (fault.table === name) for (const field of fault.drop) delete patch[field];
        rows = matching();
        for (const row of rows) {
          Object.assign(row, patch);
          if (t.columns.has("updated_at") && !("updated_at" in patch)) row.updated_at = new Date().toISOString();
        }
        if (!prefer.includes("return=representation")) return new Response(null, { status: 204 });
        return single(rows.map(embed), headers, json);
      }
      if (method === "DELETE") {
        rows = matching();
        t.rows = t.rows.filter((row) => !rows.includes(row));
        // "on delete cascade" for the tables that hang off tasks.
        if (name === "tasks") {
          const gone = new Set(rows.map((row) => row.id));
          for (const child of ["subtasks", "reminders"]) {
            const c = tables.get(child);
            if (c) c.rows = c.rows.filter((row) => !gone.has(row.task_id));
          }
        }
        if (!prefer.includes("return=representation")) return new Response(null, { status: 204 });
        return single(rows, headers, json);
      }
      return json(405, { message: `fake-db: ${method} not supported` });
    } catch (error) {
      const e = error as { status?: number; code?: string; message: string };
      return json(e.status ?? 400, { message: e.message, code: e.code ?? "fake" });
    }
  };

  function single(rows: Row[], headers: Headers, json: (status: number, body: unknown, extra?: Record<string, string>) => Response, extra: Record<string, string> = {}, status = 200) {
    if ((headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
      if (rows.length !== 1) return json(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `${rows.length} rows` });
      return json(status, rows[0], extra);
    }
    return json(status, rows, extra);
  }

  const client = createClient("http://fake.supabase.local", "sb_secret_fake", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: handle as typeof fetch },
  });

  return {
    client,
    tables,
    rows: (name) => need(name).rows,
    faults,
    insert,
    reset: () => {
      for (const t of tables.values()) {
        t.rows = [];
        t.next = 1;
      }
      faults.length = 0;
    },
  };
}
