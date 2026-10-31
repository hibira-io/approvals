// Vercel AI SDK (v5 and later): tools with `needsApproval` stop the run with
// tool-approval-request parts. approvalCalls() turns those into calls for
// approvals.request(); once reviewers decide, approvalMessage() (model
// messages) or applyToUIMessages() (useChat messages) gives the run its
// answer so you can call generateText/streamText again.

const toolOfUIPart = (part) =>
  part.type === 'dynamic-tool' ? part.toolName : typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : null;

function* partsOf(source) {
  if (source == null) return;
  if (Array.isArray(source)) {
    for (const item of source) {
      if (item && Array.isArray(item.parts)) yield* item.parts.map((p) => ({ ui: true, part: p }));
      else if (item && Array.isArray(item.content)) yield* item.content.map((p) => ({ part: p, siblings: item.content }));
      else if (item) yield { part: item, siblings: source };
    }
    return;
  }
  if (Array.isArray(source.steps) && source.steps.length) {
    yield* partsOf(source.steps.at(-1).content);
    return;
  }
  if (Array.isArray(source.content)) yield* partsOf(source.content);
  else if (Array.isArray(source.response?.messages)) yield* partsOf(source.response.messages);
}

/**
 * Tool calls waiting for approval in a generateText/streamText result (after
 * awaiting it), its content or response.messages, or useChat UI messages.
 * Each call's id is the AI SDK approval id.
 * @returns {{ id: string, tool: string, input: unknown }[]}
 */
export function approvalCalls(source) {
  const calls = [];
  const seen = new Set();
  const toolCalls = new Map();
  const all = [...partsOf(source)];
  for (const { part } of all) if (part?.type === 'tool-call') toolCalls.set(part.toolCallId, part);
  for (const { part, ui } of all) {
    if (!part) continue;
    if (ui && part.state === 'approval-requested' && part.approval?.id) {
      const tool = toolOfUIPart(part);
      if (tool && !seen.has(part.approval.id)) {
        seen.add(part.approval.id);
        calls.push({ id: part.approval.id, tool, input: part.input ?? null });
      }
      continue;
    }
    if (part.type !== 'tool-approval-request' || part.isAutomatic || seen.has(part.approvalId)) continue;
    const call = part.toolCall ?? toolCalls.get(part.toolCallId);
    if (!call) continue;
    seen.add(part.approvalId);
    calls.push({ id: part.approvalId, tool: call.toolName, input: call.input ?? call.args ?? null });
  }
  return calls;
}

/** What the model hears for one decided call. */
export function answerFor(call) {
  if (call.decision === 'approve') return { approved: true };
  if (call.decision === 'edit') {
    return {
      approved: false,
      reason: `A reviewer changed the input instead of approving it. Call ${call.tool} again with this input: ${JSON.stringify(call.edited_input)}`,
    };
  }
  return { approved: false, reason: call.reason || 'A reviewer rejected this tool call.' };
}

/**
 * A tool message with one tool-approval-response per call; append it to the
 * model messages and run the agent again.
 */
export function approvalMessage(request) {
  return {
    role: 'tool',
    content: request.calls.map((call) => ({ type: 'tool-approval-response', approvalId: call.id, ...answerFor(call) })),
  };
}

/**
 * Copies the decisions into useChat UI messages (the same thing
 * addToolApprovalResponse does in the browser) and returns new messages.
 */
export function applyToUIMessages(messages, request) {
  const byId = new Map(request.calls.map((c) => [c.id, c]));
  return messages.map((message) => {
    if (!Array.isArray(message.parts)) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      const call = part?.state === 'approval-requested' ? byId.get(part.approval?.id) : null;
      if (!call) return part;
      changed = true;
      return { ...part, state: 'approval-responded', approval: { ...part.approval, ...answerFor(call) } };
    });
    return changed ? { ...message, parts } : message;
  });
}
