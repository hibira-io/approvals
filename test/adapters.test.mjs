// End-to-end with the real frameworks and mock models: the agent pauses,
// a reviewer decides through createApprovals(), and resume() carries on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { createTool } from '@mastra/core/tools';
import { InMemoryStore } from '@mastra/core/storage';
import { StateGraph, Annotation, MemorySaver, interrupt, Command, START, END } from '@langchain/langgraph';
import { createApprovals } from '../index.js';
import * as aiSdk from '../ai-sdk.js';
import * as mastra from '../mastra.js';
import * as langgraph from '../langgraph.js';

const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const toolCallTurn = (input) => ({
  content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'refund', input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: undefined },
  usage,
  warnings: [],
});
const textTurn = (text) => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] });

function scriptedModel() {
  const prompts = [];
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      prompts.push(opts.prompt);
      return ++n === 1 ? toolCallTurn({ order: 1042 }) : textTurn('done');
    },
  });
  return { model, prompts };
}

for (const decision of ['approve', 'reject', 'edit']) {
  test(`AI SDK needsApproval: ${decision}`, async () => {
    const { model, prompts } = scriptedModel();
    const ran = [];
    const tools = {
      refund: tool({
        inputSchema: z.object({ order: z.number() }),
        needsApproval: true,
        execute: async ({ order }) => (ran.push(order), { refunded: order }),
      }),
    };
    let messages = [{ role: 'user', content: 'Refund 1042' }];
    const approvals = createApprovals({
      resume: async (request) => {
        messages = [...messages, aiSdk.approvalMessage(request)];
        const again = await generateText({ model, tools, messages });
        messages = [...messages, ...again.response.messages];
      },
    });

    const first = await generateText({ model, tools, messages });
    messages = [...messages, ...first.response.messages];
    const calls = aiSdk.approvalCalls(first);
    assert.deepEqual(calls.map((c) => [c.tool, c.input]), [['refund', { order: 1042 }]]);
    const r = await approvals.request({ agent: 'support', calls });

    const d = decision === 'edit' ? { decision, input: { order: 7 } } : decision === 'reject' ? { decision, reason: 'Not eligible' } : { decision };
    const done = await approvals.decide(r.id, { [calls[0].id]: d }, { send: true });
    assert.equal(done.status, 'resumed');

    const last = JSON.stringify(prompts.at(-1));
    if (decision === 'approve') {
      assert.deepEqual(ran, [1042]);
    } else {
      assert.deepEqual(ran, []);
      assert.match(last, decision === 'reject' ? /Not eligible/ : /\{\\+"order\\+":7\}/);
    }
  });
}

test('AI SDK useChat messages', () => {
  const ui = [
    {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'tool-refund', toolCallId: 'tc1', state: 'approval-requested', input: { order: 1 }, approval: { id: 'ap1' } }],
    },
  ];
  assert.deepEqual(aiSdk.approvalCalls(ui), [{ id: 'ap1', tool: 'refund', input: { order: 1 } }]);
  const out = aiSdk.applyToUIMessages(ui, { calls: [{ id: 'ap1', tool: 'refund', decision: 'reject', reason: 'no' }] });
  assert.equal(out[0].parts[0].state, 'approval-responded');
  assert.deepEqual(out[0].parts[0].approval, { id: 'ap1', approved: false, reason: 'no' });
  assert.equal(ui[0].parts[0].state, 'approval-requested', 'input untouched');
});

function mastraAgent(refund) {
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => (++n === 1 ? toolCallTurn({ order: 1042 }) : textTurn('done')) });
  const agent = new Agent({ id: 'support', name: 'Support', instructions: 'Help.', model, tools: { refund } });
  return new Mastra({ agents: { support: agent }, storage: new InMemoryStore(), logger: false }).getAgent('support');
}

for (const [decision, expected] of [
  ['approve', [1042]],
  ['reject', []],
]) {
  test(`Mastra requireApproval: ${decision}`, async () => {
    const ran = [];
    const refund = createTool({
      id: 'refund',
      description: 'Refund an order',
      inputSchema: z.object({ order: z.number() }),
      requireApproval: true,
      execute: async (input) => (ran.push(input.order), { ok: true }),
    });
    const agent = mastraAgent(refund);
    const approvals = createApprovals({ resume: (request) => mastra.resumeMastra(agent, request) });
    const out = await agent.generate('Refund 1042');
    const { calls, metadata } = mastra.approvalCalls(out);
    assert.equal(metadata.kinds.tc1, 'approval');
    const fromRun = mastra.approvalCalls((await agent.listSuspendedRuns()).runs[0]);
    assert.deepEqual(fromRun.calls, calls);
    const r = await approvals.request({ calls, metadata });
    const done = await approvals.decide(r.id, { tc1: { decision } }, { send: true });
    assert.equal(done.status, 'resumed', done.error ?? '');
    assert.deepEqual(ran, expected);
  });
}

test('Mastra suspend(): edit resumes with the new input', async () => {
  const ran = [];
  const refund = createTool({
    id: 'refund',
    description: 'Refund an order',
    inputSchema: z.object({ order: z.number() }),
    suspendSchema: z.object({ order: z.number() }),
    resumeSchema: z.object({ decision: z.string(), approved: z.boolean(), input: z.any().optional(), reason: z.string().optional() }),
    execute: async (input, ctx) => {
      const answer = ctx.agent.resumeData;
      if (!answer) return ctx.agent.suspend({ order: input.order });
      if (answer.approved) ran.push(answer.input?.order ?? input.order);
      return { ok: answer.approved };
    },
  });
  const agent = mastraAgent(refund);
  const approvals = createApprovals({ resume: (request) => mastra.resumeMastra(agent, request) });
  const { calls, metadata } = mastra.approvalCalls(await agent.generate('Refund 1042'));
  assert.equal(metadata.kinds.tc1, 'suspend');
  const r = await approvals.request({ calls, metadata });
  const done = await approvals.decide(r.id, { tc1: { decision: 'edit', input: { order: 7 } } }, { send: true });
  assert.equal(done.status, 'resumed', done.error ?? '');
  assert.deepEqual(ran, [7]);
});

test('LangGraph interrupt(): two parallel approvals, one edited', async () => {
  const State = Annotation.Root({
    order: Annotation(),
    log: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  });
  const graph = new StateGraph(State)
    .addNode('refund', (s) => {
      const d = interrupt(langgraph.approval({ tool: 'refund', input: { order: s.order }, title: 'Refund and tell the customer' }));
      return { log: [d.approved ? `refund ${d.input.order}` : `no refund: ${d.reason}`] };
    })
    .addNode('email', () => {
      const d = interrupt(langgraph.approval({ tool: 'send_email', input: { to: 'ann@example.com' } }));
      return { log: [d.approved ? `email ${d.input.to}` : 'no email'] };
    })
    .addEdge(START, 'refund')
    .addEdge(START, 'email')
    .addEdge('refund', END)
    .addEdge('email', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'th1' } };
  let final;
  const approvals = createApprovals({
    resume: async (request) => {
      final = await graph.invoke(new Command({ resume: langgraph.resumeValue(request) }), request.metadata.config);
    },
  });

  const paused = await graph.invoke({ order: 1042 }, config);
  const { calls, title } = langgraph.approvalCalls(paused);
  assert.equal(calls.length, 2);
  assert.equal(title, 'Refund and tell the customer');
  assert.deepEqual(langgraph.approvalCalls(await graph.getState(config)).calls.map((c) => c.id).sort(), calls.map((c) => c.id).sort());
  const r = await approvals.request({ title, calls, metadata: { config } });
  const refund = calls.find((c) => c.tool === 'refund');
  const email = calls.find((c) => c.tool === 'send_email');
  await approvals.decide(r.id, { [refund.id]: { decision: 'edit', input: { order: 7 } }, [email.id]: { decision: 'reject', reason: 'later' } }, { send: true });
  assert.deepEqual(final.log.sort(), ['no email', 'refund 7']);
});
