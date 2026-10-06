// The query guard's security matrix, shared by the Node lane
// (test/query-guard.spec.ts) and the real-browser lane
// (test/duckdb-browser.spec.ts), so both prove the same property.
//
// Fixture tables: `people(name, role)` (2 rows) and `orders(name, qty)`
// (3 rows), both imported as sources.

export const FIXTURE_CSV = {
  people: "name,role\nAda,Author\nGrace,Engineer\n",
  orders: "name,qty\nAda,2\nAda,3\nGrace,5\n",
} as const;

/** Every reach outside the imported tables: each must be refused. */
export const REFUSED: [sql: string, why: RegExp][] = [
  // file and URL reads
  ["SELECT * FROM read_csv('https://example.com/x.csv')", /read_csv\(\) reads files or URLs/],
  ["SELECT * FROM read_csv_auto('people.csv')", /read_csv_auto\(\) reads files or URLs/],
  ["SELECT * FROM read_parquet('https://example.com/x.parquet')", /read_parquet\(\) reads files or URLs/],
  ["SELECT * FROM read_json('/etc/passwd')", /read_json\(\) reads files or URLs/],
  ["SELECT * FROM read_text('/etc/hosts')", /read_text\(\) reads files or URLs/],
  ["SELECT * FROM 'https://example.com/x.parquet'", /not an imported source table/],
  ["SELECT * FROM 'people.csv'", /not an imported source table/],
  ['SELECT * FROM "https://example.com/x.csv"', /not an imported source table/],
  ["SELECT * FROM people, read_csv('x.csv')", /read_csv\(\) reads files or URLs/],
  ["SELECT * FROM people JOIN read_csv('x.csv') r ON true", /read_csv\(\) reads files or URLs/],
  ["SELECT * FROM people, LATERAL read_csv(people.name)", /read_csv\(\) reads files or URLs/],
  ["SELECT (SELECT count(*) FROM read_text('/etc/hosts'))", /read_text\(\) reads files or URLs/],
  ["SELECT * FROM people WHERE name IN (FROM read_csv('x.csv'))", /read_csv\(\) reads files or URLs/],
  ["WITH x AS (SELECT * FROM read_csv('x.csv')) SELECT * FROM x", /read_csv\(\) reads files or URLs/],
  ["SELECT * FROM (read_csv('x.csv'))", /read_csv\(\) reads files or URLs/],
  ["SELECT * FROM query_table('people')", /query_table\(\) reads files or URLs/],
  ["SELECT * FROM other.people", /not an imported source table/],
  // other statements
  ["ATTACH 'https://example.com/x.db' AS x", /only a SELECT query/],
  ["ATTACH ':memory:' AS m", /only a SELECT query/],
  ["COPY people TO 'out.csv'", /only a SELECT query/],
  ["INSTALL httpfs", /only a SELECT query/],
  ["LOAD json", /only a SELECT query/],
  ["SET enable_external_access = true", /only a SELECT query/],
  ["RESET lock_configuration", /only a SELECT query/],
  ["PRAGMA enable_external_access=true", /only a SELECT query/],
  ["DROP TABLE people", /only a SELECT query/],
  ["WITH x AS (SELECT 1) DELETE FROM people", /DELETE is not allowed/],
  ["CALL pragma_version()", /only a SELECT query/],
  // several statements, and lexer tricks
  ["SELECT 1; SELECT 2", /exactly one SELECT/],
  ["SELECT 1; DROP TABLE people", /exactly one SELECT/],
  ["SELECT 1 /* ; */ ; DROP TABLE people", /exactly one SELECT/],
  ["SELECT 'a'';' AS s; DROP TABLE people", /exactly one SELECT/],
  ["SELECT E'\\' ; DROP TABLE people --'", /escape string/],
  ["SELECT $$ x $$", /dollar/],
  ["SELECT 'unterminated", /not terminated/],
  ["SELECT 1 /* unterminated", /not terminated/],
  ["", /empty/],
];

/** Ordinary queries over the source tables: each must be admitted AND run.
 *  `rows` is the expected result (cells as text). */
export const ALLOWED: [sql: string, rows: (string | null)[][]][] = [
  ["SELECT name FROM people ORDER BY name", [["Ada"], ["Grace"]]],
  ["SELECT * FROM main.people WHERE role = 'Author';", [["Ada", "Author"]]],
  ['SELECT "name" FROM "people" WHERE name = \'Gr;ace\'', []],
  [
    "SELECT p.name, sum(o.qty) AS q FROM people p JOIN orders o ON o.name = p.name GROUP BY p.name ORDER BY q DESC, p.name",
    [["Ada", "5"], ["Grace", "5"]],
  ],
  [
    "WITH t AS (SELECT name, qty FROM orders WHERE qty > 2) SELECT name, count(*) FROM t GROUP BY name ORDER BY name",
    [["Ada", "1"], ["Grace", "1"]],
  ],
  ["SELECT count(*) FROM people, orders", [["6"]]],
  ["SELECT name FROM people WHERE name IN (SELECT name FROM orders WHERE qty = 5)", [["Grace"]]],
  ["SELECT * FROM range(3)", [["0"], ["1"], ["2"]]],
  ["-- a comment; with a semicolon\nSELECT upper(name) FROM people /* ; */ ORDER BY 1", [["ADA"], ["GRACE"]]],
  ["FROM people SELECT name ORDER BY name LIMIT 1", [["Ada"]]],
];
