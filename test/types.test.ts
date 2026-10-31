import Pusher from 'pusher';
import { createApprovals, memoryStore, type ApprovalRequest } from '@hibira-io/approvals';
import { approvalCalls, approvalMessage } from '@hibira-io/approvals/ai-sdk';
import { approvalCalls as mastraCalls, resumeMastra } from '@hibira-io/approvals/mastra';
import { approval, resumeValue, type ApprovalDecision } from '@hibira-io/approvals/langgraph';
import { createApprovalsClient } from '@hibira-io/approvals/client';
import { ApprovalInbox, ApprovalCard, useApprovalInbox } from '@hibira-io/approvals/react';
import * as vue from '@hibira-io/approvals/vue';

const pusher = new Pusher({ appId: '1', key: 'k', secret: 's', host: 'ws.hibira.io', useTLS: true });
const approvals = createApprovals({ pusher, store: memoryStore(), scope: 'support', resume: async (r: ApprovalRequest) => r.calls.length });
const handle: (r: Request) => Promise<Response> = approvals.handler({ getUser: () => ({ id: 1, name: 'Ann' }) });

async function flow() {
  const r = await approvals.request({ calls: approvalCalls({}), agent: 'a' });
  const msg = approvalMessage(r);
  const role: 'tool' = msg.role;
  const { calls, metadata } = mastraCalls({});
  await approvals.request({ calls, metadata });
  const v: Record<string, ApprovalDecision> = resumeValue(r);
  const i = approval({ tool: 't', input: { a: 1 } });
  const client = createApprovalsClient({ endpoint: '/api/approvals' });
  const list: ApprovalRequest[] = await client.list('done');
  return [role, v, i, list, handle, ApprovalInbox({ client }), ApprovalCard, useApprovalInbox, vue.ApprovalCard, resumeMastra];
}
void flow;
