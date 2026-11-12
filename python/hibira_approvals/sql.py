"""SQL helpers for approval gates, the same as ``@hibira-io/approvals/sql``.

``classify_sql`` tells reads from writes; ``sql_fingerprint`` is the SHA-256
of the exact statement a reviewer approved, so a different one cannot run on
that approval. ``classify_sql`` is a convenience, not a security boundary: run
the read path on a read-only connection or in a READ ONLY transaction, so a
statement it misjudges fails instead of writing.
"""

from __future__ import annotations

import hashlib
import re
from typing import Literal, Optional

__all__ = ["classify_sql", "sql_fingerprint", "sql_preview", "assert_approved_sql"]

_READ_START = {"SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE"}

_WRITE_WORDS = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE",
    "COPY", "CALL", "EXEC", "EXECUTE", "LOCK", "VACUUM", "ANALYZE", "ANALYSE", "REINDEX", "REFRESH", "INTO",
    "SET", "RESET", "ATTACH", "DETACH", "PRAGMA", "NEXTVAL", "SETVAL", "SET_CONFIG", "LO_IMPORT", "LO_EXPORT",
    "LO_UNLINK", "DBLINK", "DBLINK_EXEC", "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "PG_RELOAD_CONF",
    "PG_ADVISORY_LOCK", "PG_ADVISORY_XACT_LOCK", "GET_LOCK", "SLEEP", "PG_SLEEP", "BENCHMARK",
}

_LOCKING = re.compile(r"\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b")
_DOLLAR = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_WORD = re.compile(r"[A-Z_][A-Z0-9_]*")


def _skeleton(sql: str) -> Optional[str]:
    """Comments stripped, literals and quoted names replaced; None when ambiguous."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            if i + 2 < n and not sql[i + 2].isspace():
                return None
            end = sql.find("\n", i)
            i = n if end < 0 else end
            out.append(" ")
        elif c == "#":
            return None
        elif c == "/" and nxt == "*":
            if i + 2 < n and sql[i + 2] == "!":
                return None
            end = sql.find("*/", i + 2)
            if end < 0:
                return None
            i = end + 2
            out.append(" ")
        elif c in "'\"`[":
            close = "]" if c == "[" else c
            j = i + 1
            while True:
                if j >= n or sql[j] == "\\":
                    return None
                if sql[j] == close and j + 1 < n and sql[j + 1] == close:
                    j += 2
                elif sql[j] == close:
                    break
                else:
                    j += 1
            i = j + 1
            out.append(" '' " if c == "'" else " _q ")
        elif c == "$" and _DOLLAR.match(sql, i):
            tag = _DOLLAR.match(sql, i).group(0)
            end = sql.find(tag, i + len(tag))
            if end < 0:
                return None
            i = end + len(tag)
            out.append(" '' ")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def classify_sql(sql: str) -> Literal["read", "write"]:
    """``"read"`` if ``sql`` only reads; ``"write"`` otherwise, or when unsure (including several statements)."""
    if not isinstance(sql, str):
        return "write"
    bare = _skeleton(sql)
    if bare is None:
        return "write"
    statements = [s.strip() for s in bare.split(";") if s.strip()]
    if len(statements) != 1:
        return "write"
    upper = statements[0].upper()
    words = _WORD.findall(upper)
    if not words or words[0] not in _READ_START:
        return "write"
    if _LOCKING.search(upper):
        return "write"
    return "write" if any(w in _WRITE_WORDS for w in words) else "read"


def sql_fingerprint(sql: str) -> str:
    """SHA-256 of the exact statement, as lowercase hex."""
    if not isinstance(sql, str):
        raise TypeError("sql_fingerprint() needs the SQL text.")
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()


def sql_preview(
    sql: str,
    *,
    rows: Optional[int] = None,
    plan: Optional[str] = None,
    note: Optional[str] = None,
    fingerprint: Optional[str] = None,
) -> str:
    """The text reviewers see: the statement, estimated rows, an optional plan or note, and the fingerprint."""
    parts = [sql.strip()]
    if rows is not None:
        parts.append(f"Estimated rows: {rows}")
    if plan:
        parts.append(str(plan).strip())
    if note:
        parts.append(str(note).strip())
    if fingerprint:
        parts.append(f"SHA-256: {fingerprint}")
    return "\n\n".join(parts)


def assert_approved_sql(sql: str, fingerprint: str) -> None:
    """Raises ``ValueError`` unless ``sql`` is the statement ``fingerprint`` was made from."""
    if not fingerprint or sql_fingerprint(sql) != str(fingerprint).lower():
        raise ValueError("This SQL is not the statement that was approved; ask for a new approval.")
