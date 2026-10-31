import type { ApprovalRequest, CallInput, DecisionInput, Reviewer } from './types.js';

export type * from './types.js';

export declare const PROTOCOL_VERSION: 1;
export declare const EVENT: 'approval';
export declare const DECISIONS: readonly ['approve', 'reject', 'edit'];
export declare const STATUSES: readonly string[];

export declare const channels: {
  inbox(scope: string): string;
  reviewers(scope: string): string;
  request(scope: string, id: string): string;
};

export declare class ApprovalError extends Error {
  code: 'not_found' | 'not_pending' | 'undecided' | 'not_failed' | 'bad_request' | 'timeout';
  status: number;
}

export declare function approvalId(): string;

/** Where requests live. update() must be atomic. */
export interface ApprovalStore {
  create(record: ApprovalRequest): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | null>;
  list(filter: { scope: string; statuses: string[] | null; limit: number }): Promise<ApprovalRequest[]>;
  /** Runs fn on the current record and saves what it returns; null leaves it alone. */
  update(id: string, fn: (record: ApprovalRequest) => ApprovalRequest | null): Promise<ApprovalRequest | null>;
}

export declare function memoryStore(): ApprovalStore;

/** The parts of the `pusher` npm package this uses. */
export interface PusherLike {
  trigger(channel: string, event: string, data: unknown): unknown;
  authorizeChannel?(socketId: string, channel: string, presenceData?: { user_id: string; user_info?: object }): unknown;
}

export interface ApprovalsOptions {
  pusher?: PusherLike;
  /** Groups requests and reviewers. Default "default". */
  scope?: string;
  store?: ApprovalStore;
  /** Gives the agent its answers once every call is decided. Throwing marks the request failed. */
  resume?: (request: ApprovalRequest) => unknown | Promise<unknown>;
  /** Called after a request opens, for push notifications, email, Slack... */
  notify?: (request: ApprovalRequest) => unknown | Promise<unknown>;
  /** A link to the request in your app, sent with every event. */
  url?: (request: ApprovalRequest) => string | null;
  onError?: (error: unknown) => void;
}

export interface HandlerOptions {
  /** The signed-in reviewer, or null. */
  getUser(request: Request & { raw?: unknown }): Reviewer | null | undefined | Promise<Reviewer | null | undefined>;
  /** Whether `user` may review `request` (null: the inbox as a whole). Default: everyone signed in. */
  canReview?(user: Reviewer, request: ApprovalRequest | null): boolean | Promise<boolean>;
  /** Where the routes are mounted, e.g. "/api/approvals". */
  basePath?: string;
}

export interface Approvals {
  readonly scope: string;
  readonly store: ApprovalStore;
  readonly channels: { inbox: string; reviewers: string; request(id: string): string };
  request(input: {
    calls: CallInput[];
    agent?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    /** Milliseconds until the request expires. */
    expiresIn?: number;
    id?: string;
  }): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest>;
  list(filter?: { status?: 'pending' | 'done' | 'all'; limit?: number }): Promise<ApprovalRequest[]>;
  decide(id: string, decisions: Record<string, DecisionInput>, options?: { by?: string; send?: boolean }): Promise<ApprovalRequest>;
  undo(id: string, callId: string, options?: { by?: string }): Promise<ApprovalRequest>;
  send(id: string, options?: { by?: string }): Promise<ApprovalRequest>;
  retry(id: string, options?: { by?: string }): Promise<ApprovalRequest>;
  resolve(id: string): Promise<ApprovalRequest>;
  expire(): Promise<number>;
  wait(id: string, options?: { interval?: number; timeout?: number; signal?: AbortSignal }): Promise<ApprovalRequest>;
  authorize(socketId: string, channel: string, user: Reviewer): unknown;
  handler(options: HandlerOptions): (request: Request) => Promise<Response>;
}

export declare function createApprovals(options?: ApprovalsOptions): Approvals;

export declare function createHandler(approvals: Approvals, options: HandlerOptions): (request: Request) => Promise<Response>;

/** Adapts a fetch handler to Express / node:http. Mount it before any body parser. */
export declare function nodeHandler(
  handle: (request: Request) => Promise<Response>,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
