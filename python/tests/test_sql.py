import json
from pathlib import Path

import pytest

from hibira_approvals.sql import assert_approved_sql, classify_sql, sql_fingerprint, sql_preview

CASES = json.loads((Path(__file__).resolve().parents[2] / "test" / "sql-cases.json").read_text())


@pytest.mark.parametrize("sql,want", CASES)
def test_classify_sql(sql, want):
    assert classify_sql(sql) == want


def test_fingerprint_and_assert():
    assert sql_fingerprint("SELECT 1") == "e004ebd5b5532a4b85984a62f8ad48a81aa3460c1ca07701f386135d72cdecf5"
    sql = "UPDATE orders SET status = 'refunded' WHERE id = 1042"
    fp = sql_fingerprint(sql)
    assert_approved_sql(sql, fp)
    with pytest.raises(ValueError):
        assert_approved_sql(sql.replace("1042", "1043"), fp)


def test_preview():
    assert sql_preview("DELETE FROM t", rows=0, fingerprint="ab") == "DELETE FROM t\n\nEstimated rows: 0\n\nSHA-256: ab"
