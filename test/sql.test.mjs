import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySql, sqlFingerprint, sqlPreview, assertApprovedSql } from '../sql.js';

const cases = JSON.parse(readFileSync(new URL('./sql-cases.json', import.meta.url), 'utf8'));

test('classifySql tells reads from writes, and calls anything unclear a write', () => {
  for (const [sql, want] of cases) assert.equal(classifySql(sql), want, JSON.stringify(sql));
  assert.equal(classifySql(undefined), 'write');
});

test('sqlFingerprint is the SHA-256 of the exact text', async () => {
  assert.equal(await sqlFingerprint('SELECT 1'), 'e004ebd5b5532a4b85984a62f8ad48a81aa3460c1ca07701f386135d72cdecf5');
  assert.notEqual(await sqlFingerprint('SELECT 1'), await sqlFingerprint('SELECT 1 '));
});

test('assertApprovedSql accepts only the approved statement', async () => {
  const sql = "UPDATE orders SET status = 'refunded' WHERE id = 1042";
  const fp = await sqlFingerprint(sql);
  await assertApprovedSql(sql, fp);
  await assertApprovedSql(sql, fp.toUpperCase());
  await assert.rejects(assertApprovedSql(sql.replace('1042', '1043'), fp), /not the statement that was approved/);
  await assert.rejects(assertApprovedSql(sql, ''), /not the statement/);
});

test('sqlPreview lists the statement, rows, plan and fingerprint', () => {
  assert.equal(
    sqlPreview({ sql: ' DELETE FROM carts WHERE updated_at < now() ', rows: 37, plan: 'Seq Scan on carts', fingerprint: 'ab12' }),
    'DELETE FROM carts WHERE updated_at < now()\n\nEstimated rows: 37\n\nSeq Scan on carts\n\nSHA-256: ab12',
  );
  assert.equal(sqlPreview({ sql: 'DELETE FROM t', rows: 0 }), 'DELETE FROM t\n\nEstimated rows: 0');
});
