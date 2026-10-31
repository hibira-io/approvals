// Mastra agents: a run stops when a tool needs approval
// (`requireToolApproval`) or when a tool calls suspend(). approvalCalls()
// turns the stopped run into calls; resumeMastra() answers each call with
// approveToolCall / declineToolCall / resume once reviewers decide.
//
// A tool that suspends gets this resume data, so give it a matching
// resumeSchema: { decision: 'approve' | 'reject' | 'edit', approved: boolean,
// input?: unknown, reason?: string }.

function fromPayload(p, kind) {
  if (!p?.toolCallId || !p.toolName) return null;
  return {
    id: p.toolCallId,
    tool: p.toolName,
    input: kind === 'approval' ? p.args ?? null : p.suspendPayload ?? p.args ?? null,
    kind,
  };
}

/**
 * Calls waiting in a stopped Mastra run. Accepts a run from
 * agent.listSuspendedRuns(), the result of agent.generate(), or the chunks
 * of agent.stream()'s fullStream.
 * @returns {{ runId: string | null, calls: { id: string, tool: string, input: unknown }[], metadata: object }}
 */
export function approvalCalls(source) {
  let runId = source?.runId ?? null;
  const found = [];
  if (Array.isArray(source?.toolCalls) && source.toolCalls.some((t) => 'requiresApproval' in t)) {
    for (const t of source.toolCalls) {
      const c = fromPayload({ ...t, suspendPayload: t.suspendPayload }, t.requiresApproval ? 'approval' : 'suspend');
      if (c) found.push(c);
    }
  } else if (Array.isArray(source)) {
    for (const chunk of source) {
      runId ??= chunk?.runId ?? null;
      if (chunk?.type === 'tool-call-approval') found.push(fromPayload(chunk.payload, 'approval'));
      if (chunk?.type === 'tool-call-suspended') found.push(fromPayload(chunk.payload, 'suspend'));
    }
  } else if (source?.suspendPayload) {
    const p = source.suspendPayload;
    found.push(fromPayload(p, p.resumeSchema !== undefined && p.args !== undefined && !p.suspendPayload ? 'approval' : 'suspend'));
  }
  const calls = found.filter(Boolean);
  return {
    runId,
    calls: calls.map(({ id, tool, input }) => ({ id, tool, input })),
    metadata: { framework: 'mastra', runId, kinds: Object.fromEntries(calls.map((c) => [c.id, c.kind])) },
  };
}

/** Resume data for a tool that called suspend(). */
export function resumeDataFor(call) {
  return {
    decision: call.decision,
    approved: call.decision !== 'reject',
    ...(call.decision === 'edit' ? { input: call.edited_input } : {}),
    ...(call.reason ? { reason: call.reason } : {}),
  };
}

/**
 * Answers every call of a decided request on `agent`. Uses the generate
 * (non-streaming) methods unless `stream: true`. Extra options (memory,
 * requestContext...) pass through. Returns the outputs in call order.
 */
export async function resumeMastra(agent, request, options = {}) {
  const { stream = false, ...rest } = options;
  const runId = request.metadata?.runId;
  if (!runId) throw new Error('The request has no Mastra runId in its metadata.');
  const kinds = request.metadata?.kinds ?? {};
  const outputs = [];
  for (const call of request.calls) {
    const base = { ...rest, runId, toolCallId: call.id };
    if (kinds[call.id] === 'suspend') {
      outputs.push(await (stream ? agent.resumeStream : agent.resumeGenerate).call(agent, resumeDataFor(call), base));
    } else if (call.decision === 'approve') {
      outputs.push(await (stream ? agent.approveToolCall : agent.approveToolCallGenerate).call(agent, base));
    } else {
      const reason =
        call.decision === 'edit'
          ? `A reviewer changed the input instead of approving it. Call ${call.tool} again with this input: ${JSON.stringify(call.edited_input)}`
          : call.reason || 'A reviewer rejected this tool call.';
      outputs.push(await (stream ? agent.declineToolCall : agent.declineToolCallGenerate).call(agent, { ...base, reason }));
    }
  }
  return outputs;
}
