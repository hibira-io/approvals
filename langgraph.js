// LangGraph (JS): a node asks with interrupt(approval({ tool, input })) and
// gets the reviewer's decision back when the graph resumes. approvalCalls()
// turns the interrupts of a paused invoke() into calls; resumeValue() builds
// the Command resume map once reviewers decide:
//
//   await graph.invoke(new Command({ resume: resumeValue(request) }), config)

export const INTERRUPT_TYPE = 'hibira-approval';

/**
 * The value to pass to interrupt(). interrupt() then returns
 * { decision, approved, input, reason }: `input` is the reviewer's input for
 * an edit and the original input otherwise.
 * @param {{ tool: string, input?: unknown, title?: string }} call
 */
export function approval(call) {
  if (!call || typeof call.tool !== 'string') throw new TypeError('approval() needs a tool name.');
  return { type: INTERRUPT_TYPE, tool: call.tool, input: call.input ?? null, ...(call.title ? { title: call.title } : {}) };
}

/**
 * Approval calls among the interrupts of a paused run: pass the invoke()
 * result (its __interrupt__), graph.getState(config), or the interrupts.
 * Interrupts that were not made with approval() are skipped.
 */
export function approvalCalls(source) {
  const list = Array.isArray(source)
    ? source
    : source?.__interrupt__ ?? source?.interrupts ?? (source?.tasks ?? []).flatMap((t) => t.interrupts ?? []);
  const calls = [];
  for (const it of list ?? []) {
    const v = it?.value;
    if (v?.type !== INTERRUPT_TYPE || !it.id) continue;
    calls.push({ id: String(it.id), tool: v.tool, input: v.input ?? null });
  }
  const title = list?.find((it) => it?.value?.type === INTERRUPT_TYPE && it.value.title)?.value.title ?? null;
  return { calls, title };
}

/** What interrupt() returns for one decided call. */
export function decisionFor(call) {
  return {
    decision: call.decision,
    approved: call.decision !== 'reject',
    input: call.decision === 'edit' ? call.edited_input : call.input,
    reason: call.reason ?? null,
  };
}

/** The `resume` map for new Command({ resume }), keyed by interrupt id. */
export function resumeValue(request) {
  return Object.fromEntries(request.calls.map((c) => [c.id, decisionFor(c)]));
}
