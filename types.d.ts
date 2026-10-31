export type Decision = 'approve' | 'reject' | 'edit';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'resuming' | 'resumed' | 'failed' | 'resolved' | 'expired';

export type ApprovalReason = 'requested' | 'decided' | 'resuming' | 'resumed' | 'failed' | 'resolved' | 'expired';

export interface ApprovalCall {
  id: string;
  tool: string;
  input: unknown;
  decision: Decision | null;
  edited_input: unknown;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface ApprovalRequest {
  id: string;
  scope: string;
  agent: string;
  title: string | null;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string | null;
  decided_at: string | null;
  finished_at: string | null;
  error: string | null;
  url: string | null;
  metadata: Record<string, any>;
  calls: ApprovalCall[];
}

/** The `approval` event on the inbox channel. */
export interface ApprovalEvent {
  v?: 1;
  id: string;
  reason: ApprovalReason;
  status: ApprovalStatus;
  agent?: string;
  title?: string | null;
  tools?: string[];
  by?: string | null;
  url?: string | null;
  expires_at?: string | null;
  [extra: string]: unknown;
}

export interface CallInput {
  id?: string;
  tool: string;
  input?: unknown;
}

export interface DecisionInput {
  decision: Decision;
  /** The new input, for `edit`. */
  input?: unknown;
  /** Why, for `reject`. The agent sees it. */
  reason?: string;
}

export interface Reviewer {
  id: string | number;
  name?: string;
  avatar?: string;
}

export interface Member {
  id: string;
  name?: string;
  avatar?: string;
}

export interface InboxState {
  status: 'pending' | 'done' | 'all';
  requests: ApprovalRequest[];
  loading: boolean;
  error: unknown;
  activeId: string | null;
  active: ApprovalRequest | null;
  viewers: Member[];
  reviewers: Member[];
  busy: boolean;
  actionError: Error | null;
  editing: { callId: string; text: string; invalid: boolean } | null;
  rejecting: { callId: string; text: string } | null;
}

export interface InboxController {
  getState(): InboxState;
  refresh(): Promise<unknown>;
  setStatus(status: InboxState['status']): void;
  open(id: string): void;
  close(): void;
  decide(callId: string, decision: Decision, extra?: { input?: unknown; reason?: string }): Promise<void>;
  undo(callId: string): Promise<void>;
  decideAll(decision: 'approve' | 'reject'): Promise<void>;
  send(): Promise<void>;
  retry(): Promise<void>;
}

export type Locale = 'en' | 'zh-TW' | 'zh-CN' | 'ja' | 'ko' | 'th' | 'vi' | (string & {});

