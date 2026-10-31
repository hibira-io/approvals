# Hibira approvals protocol, v1

One way for an AI agent to ask a person before it does something, over Hibira
(or any Pusher-compatible) channels. Every Hibira approvals integration speaks
it: `@hibira-io/approvals` (Vercel AI SDK, Mastra, LangGraph JS), the Python
package `hibira-approvals` (LangGraph Python), `hibira-io/filament-approvals`
(Laravel AI SDK) and the Hibira MCP server's `request_approval` tool. A React
or Vue inbox built on this package can show requests from any of them.

## Words

- **Request**: one pause of one agent run, with one or more tool calls waiting.
- **Call**: one tool call inside a request: `{ id, tool, input }`.
- **Decision**: what a reviewer chose for one call: `approve`, `reject` or
  `edit` (approve with a changed input). A rejection may carry a `reason`.
- **Scope**: a name that groups requests and reviewers, such as a Filament
  panel id, a team, or `mcp`. Letters, digits, `-` and `_`.

## Channels

| Channel | Type | Who joins |
| --- | --- | --- |
| `private-hibira-approvals.{scope}.inbox` | private | every reviewer of the scope |
| `presence-hibira-approvals.{scope}.reviewers` | presence | reviewers who have the inbox open |
| `presence-hibira-approvals.{scope}.request.{id}` | presence | reviewers looking at one request |

The backend may use the reviewers channel to skip push notifications for
people who already have the inbox open.

## The `approval` event

Sent by the backend (never as a client event) on the inbox channel whenever a
request changes:

```json
{
  "v": 1,
  "id": "apr_01J…",
  "reason": "requested",
  "status": "pending",
  "agent": "Support agent",
  "title": "Refund order #1042",
  "tools": ["refund_order"],
  "by": null,
  "url": "https://app.example.com/approvals/apr_01J…",
  "expires_at": "2026-11-01T09:00:00Z"
}
```

Only `id`, `reason` and `status` are required; a missing `v` means 1. The
event is a ping: it carries no tool input, so it stays far below the 4 KB
message limit of the Free plan and nothing sensitive goes over the socket.
Clients load the request itself from the backend (see below).

`reason` says what happened:

| reason | meaning |
| --- | --- |
| `requested` | a new request is waiting |
| `decided` | a reviewer decided (or took back) one or more calls; `by` names them |
| `resuming` | every call is decided and the agent is being resumed |
| `resumed` | the agent carried on |
| `failed` | resuming failed; a reviewer may retry |
| `resolved` | answered somewhere else, such as in the app's own chat |
| `expired` | nobody answered in time |

`status` is the request's state after the change:

| status | meaning |
| --- | --- |
| `pending` | waiting on reviewers (calls may be partly decided) |
| `approved` / `rejected` | decided, with nothing left to resume (single-question requests such as MCP's `request_approval`) |
| `resuming` | decided; the agent is being resumed |
| `resumed` | done |
| `failed` | resuming failed |
| `resolved` | answered somewhere else |
| `expired` | nobody answered in time |

Producers may add fields. Consumers ignore fields they don't know. The MCP
server, for example, adds `options`, `choice`, `comment` and `decided_at`.

## Request record

What the backend returns for one request. Field names are snake_case so the
same JSON comes out of PHP, Python and JavaScript backends.

```json
{
  "id": "apr_01J…",
  "scope": "default",
  "agent": "Support agent",
  "title": "Refund order #1042",
  "status": "pending",
  "created_at": "2026-10-31T09:00:00Z",
  "expires_at": null,
  "decided_at": null,
  "finished_at": null,
  "error": null,
  "url": null,
  "metadata": {},
  "calls": [
    {
      "id": "call_1",
      "tool": "refund_order",
      "input": { "order": 1042, "amount": 120 },
      "decision": null,
      "edited_input": null,
      "reason": null,
      "decided_by": null,
      "decided_at": null
    }
  ]
}
```

`metadata` is for the framework adapter (run id, thread id, interrupt ids) and
is never shown to reviewers by the bundled components.

## HTTP API

The bundled React and Vue components talk to the app's backend with these
routes, relative to a base URL the app chooses (for example `/api/approvals`).
`createApprovals().handler()` in JavaScript and `hibira_approvals.fastapi` in
Python implement them. Every route checks the signed-in reviewer.

| Method and path | Body | Does |
| --- | --- | --- |
| `GET /?status=pending\|done\|all` | | `{ "data": [request, …] }`, newest first |
| `GET /{id}` | | the request |
| `POST /{id}/decisions` | `{ "decisions": { "<call id>": { "decision": "approve"\|"reject"\|"edit", "input"?: {…}, "reason"?: "…" } }, "send"?: true }` | saves decisions; with `send`, resumes once every call is decided |
| `DELETE /{id}/decisions/{call id}` | | takes one decision back while the request is pending |
| `POST /{id}/send` | | resumes once every call is decided |
| `POST /{id}/retry` | | resumes a `failed` request again |
| `POST /auth` | `socket_id`, `channel_name` (form or JSON) | Pusher channel authorization for the three channels |

Errors are `{ "error": "<code>", "message": "…" }` with status 400 (bad
input), 401 (not signed in), 403 (may not review), 404 (unknown request) or
409 (`not_pending`, `undecided`, `not_failed`).

## Rules

- Decisions only count while the request is `pending`. Two reviewers deciding
  at once: the last write wins per call, and every change is announced.
- Resume runs once: the move from `pending` to `resuming` is atomic, so a
  second `send` gets 409.
- `edit` resumes with the reviewer's input where the framework allows it
  (LangGraph `interrupt()`, Mastra tools that call `suspend()`, Laravel AI
  SDK). Plain tool approvals in the Vercel AI SDK and Mastra
  (`needsApproval`, `requireToolApproval`) can only say yes or no, so there an
  edit becomes a rejection whose reason gives the model the reviewer's input
  to call again with.
