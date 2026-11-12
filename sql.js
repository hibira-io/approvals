// SQL helpers for approval gates: tell reads from writes, and fingerprint the
// exact statement a reviewer approved so a different one cannot run on that
// approval. Database-agnostic and dependency-free; runs in Node 20+ and
// browsers (Web Crypto).
//
// classifySql() is a convenience, not a security boundary: run the "read"
// path on a read-only connection or in a READ ONLY transaction, so that a
// statement it misjudges fails instead of writing.

const READ_START = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE']);

// Words that make a statement that starts like a read change something:
// data-modifying CTEs, SELECT ... INTO, EXPLAIN ANALYZE (which runs the
// statement), sequence and settings functions, and the usual DML and DDL.
// Statements that start with any other word are writes already.
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE',
  'COPY', 'CALL', 'EXEC', 'EXECUTE', 'LOCK', 'VACUUM', 'ANALYZE', 'ANALYSE', 'REINDEX', 'REFRESH', 'INTO',
  'SET', 'RESET', 'ATTACH', 'DETACH', 'PRAGMA', 'NEXTVAL', 'SETVAL', 'SET_CONFIG', 'LO_IMPORT', 'LO_EXPORT',
  'LO_UNLINK', 'DBLINK', 'DBLINK_EXEC', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF',
  'PG_ADVISORY_LOCK', 'PG_ADVISORY_XACT_LOCK', 'GET_LOCK', 'SLEEP', 'PG_SLEEP', 'BENCHMARK',
]);

// SELECT ... FOR UPDATE / FOR SHARE takes row locks.
const LOCKING = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/;

/**
 * Strips comments and replaces string literals and quoted identifiers with
 * placeholders, so keywords inside them do not count. Returns null when the
 * text could split into statements differently across databases (a
 * backslash in a quoted string, `#`, `--` without a space, MySQL's `/*!`,
 * anything left open), so the caller treats it as a write.
 * @param {string} sql
 * @returns {string | null}
 */
function skeleton(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      if (i + 2 < sql.length && !/\s/.test(sql[i + 2])) return null;
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (c === '#') {
      return null;
    } else if (c === '/' && next === '*') {
      if (sql[i + 2] === '!') return null;
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === '\\') return null;
        if (sql[j] === close && sql[j + 1] === close) j += 2;
        else if (sql[j] === close) break;
        else j++;
      }
      i = j + 1;
      out += c === "'" ? " '' " : ' _q ';
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) return null;
      i = end + tag.length;
      out += " '' ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Whether `sql` only reads ("read") or may change data, schema, settings or
 * locks ("write"). Anything it is not sure about, including more than one
 * statement, is "write".
 * @param {string} sql
 * @returns {'read' | 'write'}
 */
export function classifySql(sql) {
  if (typeof sql !== 'string') return 'write';
  const bare = skeleton(sql);
  if (bare === null) return 'write';
  const statements = bare
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length !== 1) return 'write';
  const words = statements[0].toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  if (!READ_START.has(words[0])) return 'write';
  if (LOCKING.test(statements[0].toUpperCase())) return 'write';
  return words.some((w) => WRITE_WORDS.has(w)) ? 'write' : 'read';
}

/**
 * The SHA-256 of the exact statement, as lowercase hex. Store it with the
 * approval and compare it right before running: a statement that differs by
 * one character needs a new approval.
 * @param {string} sql
 * @returns {Promise<string>}
 */
export async function sqlFingerprint(sql) {
  if (typeof sql !== 'string') throw new TypeError('sqlFingerprint() needs the SQL text.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The text reviewers see under the statement: the estimated rows (from a
 * dry run or EXPLAIN on your side), an optional plan or sample, and the
 * fingerprint. Pass it as a call's `preview`, or as `details` to the hosted
 * approvals API.
 * @param {{ sql: string, rows?: number | null, plan?: string | null, note?: string | null, fingerprint?: string | null }} p
 */
export function sqlPreview({ sql, rows = null, plan = null, note = null, fingerprint = null }) {
  const parts = [sql.trim()];
  if (rows !== null && rows !== undefined) parts.push(`Estimated rows: ${rows}`);
  if (plan) parts.push(String(plan).trim());
  if (note) parts.push(String(note).trim());
  if (fingerprint) parts.push(`SHA-256: ${fingerprint}`);
  return parts.join('\n\n');
}

/**
 * Throws unless `sql` is the statement `fingerprint` was made from. Call it
 * right before running an approved statement.
 * @param {string} sql
 * @param {string} fingerprint
 */
export async function assertApprovedSql(sql, fingerprint) {
  const actual = await sqlFingerprint(sql);
  if (!fingerprint || actual !== String(fingerprint).toLowerCase()) {
    throw new Error('This SQL is not the statement that was approved; ask for a new approval.');
  }
}
