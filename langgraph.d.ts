import type { ApprovalCall, ApprovalRequest, Decision } from './types.js';

export declare const INTERRUPT_TYPE: 'hibira-approval';

export interface ApprovalInterrupt {
  type: 'hibira-approval';
  tool: string;
  input: unknown;
  title?: string;
}

/** What interrupt(approval(...)) returns when the graph resumes. */
export interface ApprovalDecision<I = unknown> {
  decision: Decision;
  approved: boolean;
  input: I;
  reason: string | null;
}

export declare function approval(call: { tool: string; input?: unknown; title?: string }): ApprovalInterrupt;

export declare function approvalCalls(source: unknown): { calls: { id: string; tool: string; input: unknown }[]; title: string | null };

export declare function decisionFor(call: ApprovalCall): ApprovalDecision;

export declare function resumeValue(request: Pick<ApprovalRequest, 'calls'>): Record<string, ApprovalDecision>;
