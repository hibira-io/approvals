import type { ApprovalEvent, ApprovalRequest, DecisionInput, Member } from './types.js';

export type * from './types.js';

export declare class ApprovalsHttpError extends Error {
  status: number;
  code?: string;
}

export interface ApprovalsClient {
  readonly scope: string;
  readonly endpoint: string;
  list(status?: 'pending' | 'done' | 'all'): Promise<ApprovalRequest[]>;
  get(id: string): Promise<ApprovalRequest>;
  decide(id: string, decisions: Record<string, DecisionInput>, options?: { send?: boolean }): Promise<ApprovalRequest>;
  undo(id: string, callId: string): Promise<ApprovalRequest>;
  send(id: string): Promise<ApprovalRequest>;
  retry(id: string): Promise<ApprovalRequest>;
  subscribe(onEvent: (event: ApprovalEvent) => void): () => void;
  watchReviewers(onMembers: (members: Member[]) => void): () => void;
  watchRequest(id: string, onMembers: (members: Member[]) => void): () => void;
}

export declare function createApprovalsClient(options: {
  /** Base URL of the approvals routes, e.g. "/api/approvals". */
  endpoint: string;
  /** A pusher-js instance; without one the components still work, without live updates. */
  pusher?: any;
  scope?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>);
}): ApprovalsClient;
