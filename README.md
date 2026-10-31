<p align="center"><img src="art/cover.jpg" alt="@hibira-io/approvals: ask a person before your agent acts" width="100%"></p>

# @hibira-io/approvals

Human approvals for AI agents, over [Hibira](https://hibira.io) realtime
channels. When an agent wants to run a tool that needs a person's OK, the
call waits in a live inbox. Reviewers approve, edit or reject it, see who
else is looking, and the agent carries on where it stopped.

- **Server helpers** for the [Vercel AI SDK](https://ai-sdk.dev)
  (`needsApproval`), [Mastra](https://mastra.ai) (`requireApproval`,
  `suspend()`) and [LangGraph](https://langchain-ai.github.io/langgraphjs/)
  (`interrupt()`), plus a framework-free core for anything else.
- **React and Vue components**: an inbox and a single-request card, in seven
  languages, light and dark.
- **One protocol** ([PROTOCOL.md](PROTOCOL.md)) shared with the
  [Python package](python/) (LangGraph Python + FastAPI),
  [filament-approvals](https://github.com/hibira-io/filament-approvals)
  (Laravel AI SDK) and the Hibira MCP server's `request_approval` tool. A
  React inbox can show requests from any of them.

![The inbox: requests on the left, the open one on the right, with Bo also looking](art/inbox-react-en-desktop-light.png)

| Edit the input before approving | Rejected, with the reason the agent saw |
| --- | --- |
| ![Editing a tool call's input as JSON](art/edit-react-en-desktop-light.png) | ![A rejected request in the Done tab](art/done-react-en-desktop-light.png) |

| Dark mode | Phones (Japanese) | Vue (Traditional Chinese) |
| --- | --- | --- |
| ![Dark inbox](art/inbox-react-en-desktop-dark.png) | ![Card on a phone, dark](art/card-react-ja-mobile-dark.png) | ![Vue inbox in Traditional Chinese](art/inbox-vue-zh-TW-desktop-light.png) |

## Install

```sh
npm install @hibira-io/approvals pusher pusher-js
```

`pusher` (server) and `pusher-js` (browser) are the standard Pusher
libraries; point them at your Hibira app. React 17+ or Vue 3.3+ for the
components. Node 20+ on the server.

## How it works

1. Your agent run stops on a tool call that needs approval.
2. You turn the stopped run into calls and open a request:
   `approvals.request({ calls })`. Reviewers get an `approval` event on
   `private-hibira-approvals.{scope}.inbox`; the event carries no tool input,
   so it stays tiny and nothing sensitive crosses the socket.
3. Reviewers decide in the inbox. The components call your backend (the
   routes in [PROTOCOL.md](PROTOCOL.md)), never client events.
4. Once every call is decided, your `resume(request)` gives the agent its
   answers. It runs once, even if two reviewers press Send together. If it
   throws, the request shows as failed with a Retry button.

## Server

```js
import Pusher from 'pusher';
import { createApprovals } from '@hibira-io/approvals';

const pusher = new Pusher({
  appId: process.env.HIBIRA_APP_ID,
  key: process.env.HIBIRA_KEY,
  secret: process.env.HIBIRA_SECRET,
  host: 'ws.hibira.io', // the host shown on your app page
  useTLS: true,
});

export const approvals = createApprovals({
  pusher,
  scope: 'support', // groups requests and reviewers
  resume: async (request) => {
    /* give the agent its answers: see the framework sections below */
  },
  notify: async (request) => {
    /* optional: push, email or Slack the reviewers */
  },
});
```

Requests live in memory by default. In production pass `store`: an object
with `create`, `get`, `list` and an atomic `update(id, fn)` over your
database (see `ApprovalStore` in `index.d.ts`).

### Routes

`approvals.handler()` returns a web-standard `(Request) => Response` that
serves the inbox's routes and the channel authorization:

```js
// app/api/approvals/[[...path]]/route.js (Next.js)
import { approvals } from '@/lib/approvals';
import { auth } from '@/auth';

const handle = approvals.handler({
  basePath: '/api/approvals',
  getUser: async () => {
    const session = await auth();
    return session?.user ? { id: session.user.id, name: session.user.name, avatar: session.user.image } : null;
  },
  canReview: (user, request) => user.role === 'admin', // request is null for the inbox as a whole
});

export { handle as GET, handle as POST, handle as DELETE };
```

For Express or `node:http`, wrap it with `nodeHandler(handle)` and mount it
before any body parser. `getUser` then gets `request.raw`, the original
`req`.

## Vercel AI SDK

Mark the tool with `needsApproval`, then open a request when the result
contains approval requests:

```js
import { generateText, tool } from 'ai';
import { approvalCalls, approvalMessage } from '@hibira-io/approvals/ai-sdk';

const tools = {
  refund_order: tool({ inputSchema, needsApproval: true, execute: refund }),
};

const result = await generateText({ model, tools, messages });
await saveMessages(chatId, [...messages, ...result.response.messages]);

const calls = approvalCalls(result);
if (calls.length) {
  await approvals.request({ agent: 'Support agent', title: 'Refund order #1042', calls, metadata: { chatId } });
}

// in createApprovals({ resume }):
async function resume(request) {
  const history = await loadMessages(request.metadata.chatId);
  const next = [...history, approvalMessage(request)];
  const result = await generateText({ model, tools, messages: next });
  await saveMessages(request.metadata.chatId, [...next, ...result.response.messages]);
}
```

With `useChat`, `approvalCalls(uiMessages)` reads the `approval-requested`
parts and `applyToUIMessages(uiMessages, request)` writes the answers back.
The AI SDK's approvals are yes or no, so an **edit** reaches the model as a
rejection whose reason carries the reviewer's input to call again with.

## Mastra

```js
import { approvalCalls, resumeMastra } from '@hibira-io/approvals/mastra';

const output = await agent.generate('Refund order 1042');
if (output.finishReason === 'suspended') {
  const { calls, metadata } = approvalCalls(output); // or a run from agent.listSuspendedRuns()
  await approvals.request({ agent: 'Support agent', calls, metadata });
}

// in createApprovals({ resume }):
const resume = (request) => resumeMastra(agent, request);
```

Tools with `requireApproval: true` are approved or declined (with the
reason). Tools that call `suspend()` resume with
`{ decision, approved, input?, reason? }`, so an edit really changes the
input:

```js
execute: async (input, ctx) => {
  const answer = ctx.agent.resumeData;
  if (!answer) return ctx.agent.suspend({ order: input.order });
  if (!answer.approved) return { skipped: answer.reason };
  return refund(answer.input ?? input);
}
```

## LangGraph (JS)

```js
import { interrupt, Command } from '@langchain/langgraph';
import { approval, approvalCalls, resumeValue } from '@hibira-io/approvals/langgraph';

function refundNode(state) {
  const answer = interrupt(approval({ tool: 'refund_order', input: { order: state.order } }));
  if (!answer.approved) return { log: [`skipped: ${answer.reason}`] };
  return { log: [refund(answer.input)] }; // the edited input when the reviewer changed it
}

const paused = await graph.invoke({ order: 1042 }, config);
const { calls, title } = approvalCalls(paused); // parallel interrupts become one request
if (calls.length) await approvals.request({ title, calls, metadata: { threadId: config.configurable.thread_id } });

// in createApprovals({ resume }):
const resume = (request) =>
  graph.invoke(new Command({ resume: resumeValue(request) }), { configurable: { thread_id: request.metadata.threadId } });
```

For LangGraph in Python, see [`python/`](python/).

## React

```jsx
import Pusher from 'pusher-js';
import { ApprovalInbox, ApprovalCard, createApprovalsClient } from '@hibira-io/approvals/react';
import '@hibira-io/approvals/styles.css';

const pusher = new Pusher(HIBIRA_KEY, {
  wsHost: 'ws.hibira.io',
  forceTLS: true,
  cluster: 'hibira', // pusher-js insists on one; Hibira ignores it
  channelAuthorization: { endpoint: '/api/approvals/auth', transport: 'ajax' },
});
const client = createApprovalsClient({ endpoint: '/api/approvals', pusher, scope: 'support' });

export function ApprovalsPage({ me }) {
  return <ApprovalInbox client={client} me={me.id} locale="en" />;
}

// One request inline, e.g. under the agent's message in your chat:
<ApprovalCard client={client} id={requestId} />;
```

`useApprovalInbox(client, { id })` gives you the same state and actions
(`decide`, `send`, `undo`...) to build your own UI.

## Vue

```vue
<script setup>
import { ApprovalInbox, createApprovalsClient } from '@hibira-io/approvals/vue';
import '@hibira-io/approvals/styles.css';

const client = createApprovalsClient({ endpoint: '/api/approvals', pusher, scope: 'support' });
</script>

<template>
  <ApprovalInbox :client="client" :me="user.id" locale="zh-TW" />
</template>
```

## Look and languages

`styles.css` defines every color as a `--hb-ap-*` variable on `.hb-ap` and
`.hb-ap-card`, so restyling is a few overrides. Dark mode follows the
system, or set `data-theme="dark"` / `"light"` on any ancestor. Labels ship
in English, Traditional and Simplified Chinese, Japanese, Korean, Thai and
Vietnamese (`locale`); override single strings with `labels`.

## Other APIs

- `approvals.wait(id)` polls until a request is decided, for long-running
  workers that keep the agent waiting in place instead of resuming later.
- `approvals.resolve(id)` marks a request answered somewhere else, such as
  the app's own chat. `approvals.expire()` expires overdue requests
  (`expiresIn` on `request()`); run it from a cron.
- `approvals.authorize(socketId, channel, user)` if you serve channel
  authorization yourself.

## License

MIT
