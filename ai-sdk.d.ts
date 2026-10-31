import type { ApprovalCall, ApprovalRequest } from './types.js';

/** Calls waiting for approval in an AI SDK result, its content/messages, or useChat UI messages. */
export declare function approvalCalls(source: unknown): { id: string; tool: string; input: unknown }[];

export declare function answerFor(call: ApprovalCall): { approved: boolean; reason?: string };

/** A tool message with one tool-approval-response per call. */
export declare function approvalMessage(request: Pick<ApprovalRequest, 'calls'>): {
  role: 'tool';
  content: { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string }[];
};

/** Copies the decisions into useChat UI messages. */
export declare function applyToUIMessages<M extends { parts?: unknown[] }>(messages: M[], request: Pick<ApprovalRequest, 'calls'>): M[];
