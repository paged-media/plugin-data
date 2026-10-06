// The query lane's SQL hygiene (wave 6): the guard every user or document
// query passes before DuckDB runs it, DuckDB error text turned into a
// diagnostic with a position, and the preview wrapper.
//
// WHY A GUARD. A document's queries are code (§11): they come back from a
// saved file and run on refresh. DuckDB-WASM can read a URL from SQL alone
// (`read_csv('https://…')`, `FROM 'https://….csv'`), which would reach the
// network without the per-origin consent the remote-source lane asks for, and
// a statement other than SELECT could drop an imported table. Every source is
// materialised as a table at import (query/import.ts), so a query never needs
// a file or URL. The guard therefore admits exactly one SELECT that reads
// plain tables, plus the table functions that read nothing (`range`,
// `generate_series`, `unnest`).
//
// HOW. The guard is a conservative lexer and allow-list in plain TypeScript;
// it asks DuckDB nothing. It used to ask DuckDB's own parser
// (`json_serialize_sql`), but that function lives in DuckDB's json
// extension, which the shipped eh build does not contain: DuckDB autoloaded
// it from extensions.duckdb.org. Under the editor's CSP (connect-src 'self')
// the fetch was refused and the half-loaded extension trapped the worker
// ("table index is out of bounds") on every refresh; in Node it quietly
// fetched the extension from the internet, so the guard itself reached the
// network. test/duckdb-browser.spec.ts runs the shipped worker under the
// editor's headers so that cannot come back unseen.
//
// The lexer follows DuckDB's (PostgreSQL's) rules for what is code and what
// is not: '…' strings with '' escapes, "…" identifiers with "" escapes, --
// line comments and nested /* */ comments. Anything whose lexing differs
// between dialects is refused outright: E'…' escape strings, U&'…' strings,
// $-quoting and $ parameters. Then:
//   · exactly one statement (no `;`), with balanced brackets — the preview
//     and refresh paths wrap the query in `SELECT * FROM (…)`, and a stray
//     `)` would let the text escape that wrapper;
//   · it starts with SELECT, WITH, FROM, VALUES or `(`;
//   · no statement keyword anywhere (DELETE, ATTACH, COPY, SET, …);
//   · every table position — after FROM, JOIN, LATERAL, a comma in a FROM
//     list, a `(` that opens a FROM item — holds a plain table name (or
//     `main.` name), a subquery, or an allowed table function. A string or
//     quoted file name there (DuckDB's replacement scan reads it as a file)
//     or any other table function is refused.
// The engine side adds `lock_configuration` at boot (LOCKDOWN_SQL in
// query/duckdb.ts): no statement can change a DuckDB setting afterwards. `enable_external_access
// = false` was evaluated and rejected: it is global and one-way, and it also
// refuses DuckDB's own readers over registered in-memory buffers, so every
// import after the first query would fail (proven in the browser lane).

/** A query problem the panel can point at. `line`/`column` are 1-based,
 *  in the query text as the user wrote it. */
export interface SqlDiagnostic {
  /** DuckDB's error class (`Parser`, `Binder`, `Catalog`, …) or `Guard`. */
  kind: string;
  message: string;
  line?: number;
  column?: number;
}

/** Table functions that read no file and no URL. */
const PURE_TABLE_FUNCTIONS = new Set(["range", "generate_series", "unnest"]);
const PLAIN_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words that start or belong to a statement other than a SELECT. Refused
 *  anywhere as bare words (a column with such a name is written quoted). */
const STATEMENT_WORDS = new Set([
  "ABORT", "ALTER", "ANALYZE", "ATTACH", "BEGIN", "CALL", "CHECKPOINT", "COMMIT", "COPY",
  "CREATE", "DEALLOCATE", "DELETE", "DESCRIBE", "DETACH", "DROP", "EXECUTE", "EXPLAIN",
  "EXPORT", "FORCE", "IMPORT", "INSERT", "INSTALL", "LOAD", "MERGE", "PRAGMA", "PREPARE",
  "RESET", "ROLLBACK", "SET", "SHOW", "SUMMARIZE", "TRUNCATE", "UPDATE", "UPSERT", "USE",
  "VACUUM",
]);
/** Words that may open a query. */
const QUERY_STARTS = new Set(["SELECT", "WITH", "FROM", "VALUES"]);
/** Words that end a FROM list at their nesting level. */
const FROM_LIST_ENDS = new Set([
  "WHERE", "GROUP", "HAVING", "QUALIFY", "WINDOW", "ORDER", "LIMIT", "OFFSET", "UNION",
  "EXCEPT", "INTERSECT", "SELECT", "FETCH", "USING", "RETURNING",
]);
/** Functions whose argument syntax uses FROM without naming a table
 *  (`EXTRACT(year FROM d)`, `SUBSTRING(s FROM 2)`, `TRIM(BOTH FROM s)`). */
const FROM_IN_ARGUMENTS = new Set(["extract", "substring", "trim", "overlay", "position"]);

type TokenKind = "word" | "qident" | "string" | "number" | "punct";
interface Token {
  kind: TokenKind;
  /** The word as written, the identifier or string unquoted, the punctuation. */
  value: string;
  /** 0-based offset in the text. */
  at: number;
  /** Text ends right before this token (no space between). */
  adjacent: boolean;
}

class GuardError extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
  }
}

/** Strip trailing semicolons and whitespace. */
export function trimSql(sql: string): string {
  return sql.replace(/[\s;]+$/, "").trim();
}

/** 1-based line/column of a 0-based character offset. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Split SQL into tokens the way DuckDB's lexer does, refusing every form
 *  whose lexing is not plain (see the header). */
function lex(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let lastEnd = -1;
  const push = (kind: TokenKind, value: string, at: number, end: number) => {
    out.push({ kind, value, at, adjacent: at === lastEnd });
    lastEnd = end;
  };
  const quoted = (q: string, kind: TokenKind, what: string) => {
    const at = i;
    let v = "";
    i++;
    for (;;) {
      if (i >= text.length) throw new GuardError(`${what} is not terminated`, at);
      if (text[i] === q) {
        if (text[i + 1] === q) {
          v += q;
          i += 2;
          continue;
        }
        i++;
        break;
      }
      v += text[i++];
    }
    push(kind, v, at, i);
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const at = i;
      let depth = 0;
      do {
        if (i >= text.length) throw new GuardError("a comment is not terminated", at);
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0);
    } else if (c === "'") {
      const prev = out[out.length - 1];
      if (prev && lastEnd === i && prev.kind === "word" && /^[eE]$/.test(prev.value)) {
        throw new GuardError("an escape string (E'…') cannot be used in a data query", prev.at);
      }
      if (prev && lastEnd === i && prev.kind === "punct" && prev.value === "&") {
        throw new GuardError("a Unicode escape string (U&'…') cannot be used in a data query", prev.at);
      }
      quoted("'", "string", "a string");
    } else if (c === '"') {
      quoted('"', "qident", "a quoted name");
    } else if (c === "$") {
      throw new GuardError("dollar-quoted strings and $ parameters cannot be used in a data query", i);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))!;
      push("number", m[0], i, i + m[0].length);
      i += m[0].length;
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      const m = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(text.slice(i))!;
      push("word", m[0], i, i + m[0].length);
      i += m[0].length;
    } else {
      push("punct", c, i, i + 1);
      i++;
    }
  }
  return out;
}

const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.value.toUpperCase() === w;
const isPunct = (t: Token | undefined, p: string) => t?.kind === "punct" && t.value === p;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

const fileReach = (name: string) =>
  `the table function ${name}() reads files or URLs — import the data as a source and query its table`;
const notATable = (name: string) =>
  `"${name}" is not an imported source table — a query reads source tables only`;

/** The allow-list walk over the tokens. Throws a GuardError at the first
 *  thing a data query may not do. */
function walk(tokens: Token[]): void {
  if (tokens.length === 0) throw new GuardError("the query is empty");
  const semi = tokens.find((t) => isPunct(t, ";"));
  if (semi) throw new GuardError("a data query is exactly one SELECT statement", semi.at);
  const first = tokens[0];
  if (!(isPunct(first, "(") || (first.kind === "word" && QUERY_STARTS.has(first.value.toUpperCase())))) {
    throw new GuardError("only a SELECT query can be a data query", first.at);
  }
  for (const t of tokens) {
    if (t.kind === "word" && STATEMENT_WORDS.has(t.value.toUpperCase())) {
      const w = t.value.toUpperCase();
      throw new GuardError(
        `${w} is not allowed in a data query (a column named ${t.value} is written quoted: "${t.value}")`,
        t.at,
      );
    }
  }

  // One frame per open bracket: the closing bracket it expects, whether a
  // FROM list is open at this level, and the function the bracket calls.
  interface Frame {
    close: string;
    fromList: boolean;
    callee: string;
  }
  const stack: Frame[] = [{ close: "", fromList: false, callee: "" }];
  const top = () => stack[stack.length - 1];
  let expectTable = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (expectTable) {
      if (isWord(t, "LATERAL")) continue;
      expectTable = false;
      if (isPunct(t, "(")) {
        // A subquery, or a parenthesised join whose first item is a table.
        const sub = next?.kind === "word" && QUERY_STARTS.has(next.value.toUpperCase());
        stack.push({ close: ")", fromList: !sub, callee: "" });
        expectTable = !sub;
        continue;
      }
      if (t.kind === "string") throw new GuardError(notATable(t.value), t.at);
      if (t.kind !== "word" && t.kind !== "qident") throw new GuardError("a FROM item must be a source table", t.at);
      // A (possibly qualified) name: word or "quoted", joined by dots.
      const parts = [t];
      let j = i;
      while (isPunct(tokens[j + 1], ".") && (tokens[j + 2]?.kind === "word" || tokens[j + 2]?.kind === "qident")) {
        parts.push(tokens[j + 2]);
        j += 2;
      }
      const name = parts.map((p) => p.value).join(".");
      if (isPunct(tokens[j + 1], "(")) {
        if (parts.length === 1 && t.kind === "word" && PURE_TABLE_FUNCTIONS.has(t.value.toLowerCase())) {
          i = j;
          continue; // its arguments are expressions: the `(` opens a frame below
        }
        throw new GuardError(fileReach(name), t.at);
      }
      const table = parts[parts.length - 1].value;
      const schema = parts.length === 2 ? parts[0].value.toLowerCase() : "";
      if (!PLAIN_TABLE.test(table) || parts.length > 2 || (parts.length === 2 && schema !== "main")) {
        throw new GuardError(notATable(name), t.at);
      }
      i = j;
      continue;
    }
    if (t.kind === "punct" && OPEN[t.value]) {
      const prev = tokens[i - 1];
      stack.push({
        close: OPEN[t.value],
        fromList: false,
        callee: prev?.kind === "word" ? prev.value.toLowerCase() : "",
      });
      continue;
    }
    if (t.kind === "punct" && CLOSE.has(t.value)) {
      if (stack.length === 1 || top().close !== t.value) {
        throw new GuardError(`unbalanced brackets: "${t.value}" closes nothing`, t.at);
      }
      stack.pop();
      continue;
    }
    if (isPunct(t, ",") && top().fromList) {
      expectTable = true;
      continue;
    }
    if (t.kind !== "word") continue;
    const w = t.value.toUpperCase();
    if (w === "FROM") {
      const p1 = tokens[i - 1];
      const p2 = tokens[i - 2];
      const distinctFrom = isWord(p1, "DISTINCT") && (isWord(p2, "IS") || isWord(p2, "NOT"));
      if (distinctFrom || FROM_IN_ARGUMENTS.has(top().callee)) continue;
      top().fromList = true;
      expectTable = true;
    } else if (w === "JOIN") {
      expectTable = true;
    } else if (FROM_LIST_ENDS.has(w)) {
      top().fromList = false;
    }
  }
  if (stack.length !== 1) throw new GuardError(`unbalanced brackets: a "${top().close}" is missing`);
}

/** Check one query. Returns null when it may run. Pure: asks DuckDB
 *  nothing, so it is the same in Node, in the browser worker and offline. */
export function checkQuery(sql: string): SqlDiagnostic | null {
  const text = trimSql(sql);
  try {
    walk(lex(text));
    return null;
  } catch (err) {
    if (!(err instanceof GuardError)) throw err;
    return {
      kind: "Guard",
      message: err.message,
      ...(err.at !== undefined ? positionOf(text, err.at) : {}),
    };
  }
}

/** Check one query (the session's entry point; see [`checkQuery`]). */
export async function guardQuery(sql: string): Promise<SqlDiagnostic | null> {
  return checkQuery(sql);
}

/** The statement a preview runs: the user's query on its own line (so
 *  DuckDB's `LINE n` maps back by one), limited. */
export function previewSql(sql: string, limit: number): string {
  return `SELECT * FROM (\n${trimSql(sql)}\n) AS paged_preview LIMIT ${Math.max(0, Math.floor(limit))}`;
}

/** DuckDB error text → a diagnostic. `lineOffset` is how many lines the
 *  executed statement put in front of the user's query (1 for previewSql). */
export function diagnoseDuckDBError(err: unknown, lineOffset = 0): SqlDiagnostic {
  const text = err instanceof Error ? err.message : String(err);
  const head = /^(?:Error:\s*)?([A-Za-z]+) Error:\s*([\s\S]*)$/.exec(text.trim());
  const kind = head ? head[1] : "Error";
  const body = head ? head[2] : text;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^LINE \d+:/.test(l));
  const message = (at >= 0 ? lines.slice(0, at) : lines).join("\n").trim();
  if (at < 0) return { kind, message };
  const m = /^LINE (\d+): /.exec(lines[at])!;
  const caret = lines[at + 1]?.indexOf("^") ?? -1;
  const line = Number(m[1]) - lineOffset;
  return {
    kind,
    message,
    ...(line >= 1 ? { line } : {}),
    ...(caret >= m[0].length ? { column: caret - m[0].length + 1 } : {}),
  };
}
