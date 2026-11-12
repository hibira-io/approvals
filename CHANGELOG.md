# Changelog

## 0.2.0

- `@hibira-io/approvals/sql` (and `hibira_approvals.sql` in Python 0.2.0):
  `classifySql()` tells reads from writes, `sqlFingerprint()` and
  `assertApprovedSql()` bind an approval to the exact statement, and
  `sqlPreview()` builds what reviewers see. README recipes gate database
  writes in the Vercel AI SDK, Mastra and LangGraph (JS and Python).
- Calls may carry a `preview` (protocol v1, optional field), shown under the
  input in the React and Vue inbox in all seven languages; LangGraph's
  `approval()` takes it in both languages.

## 0.1.0

First release.

- Hibira approvals protocol v1 ([PROTOCOL.md](PROTOCOL.md)), shared with
  filament-approvals and the Hibira MCP server.
- `createApprovals()`: requests, decisions, resume-once, retry, expiry,
  `wait()`, channel authorization, and a fetch handler for the HTTP API
  (`nodeHandler()` for Express).
- Adapters for the Vercel AI SDK (`needsApproval`), Mastra
  (`requireApproval`, `suspend()`) and LangGraph JS (`interrupt()`).
- React and Vue `ApprovalInbox` and `ApprovalCard`, in seven languages, light
  and dark.
- Python package `hibira-approvals` 0.1.0: the same core, LangGraph helpers
  and a FastAPI router.
