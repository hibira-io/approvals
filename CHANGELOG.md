# Changelog

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
