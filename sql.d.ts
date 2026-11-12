/**
 * Whether `sql` only reads ("read") or may change data, schema, settings or
 * locks ("write"). Anything it is not sure about, including more than one
 * statement, is "write". A convenience, not a security boundary: run reads
 * on a read-only connection or in a READ ONLY transaction.
 */
export function classifySql(sql: string): 'read' | 'write';

/** SHA-256 of the exact statement, as lowercase hex. */
export function sqlFingerprint(sql: string): Promise<string>;

/** The text reviewers see: the statement, estimated rows, an optional plan or note, and the fingerprint. */
export function sqlPreview(p: {
  sql: string;
  rows?: number | null;
  plan?: string | null;
  note?: string | null;
  fingerprint?: string | null;
}): string;

/** Throws unless `sql` is the statement `fingerprint` was made from. */
export function assertApprovedSql(sql: string, fingerprint: string): Promise<void>;
