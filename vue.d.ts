import type { DefineComponent, ShallowRef } from 'vue';
import type { ApprovalsClient } from './client.js';
import type { InboxController, InboxState, Locale } from './types.js';

export { createApprovalsClient } from './client.js';
export type { ApprovalsClient } from './client.js';
export type { InboxController, InboxState, Locale } from './types.js';

export declare function useApprovalInbox(
  client: ApprovalsClient,
  options?: { id?: string | (() => string); status?: InboxState['status'] },
): { inbox: ShallowRef<InboxController | null>; state: ShallowRef<InboxState | null> };

interface CommonProps {
  client: ApprovalsClient;
  locale?: Locale;
  labels?: Record<string, unknown>;
  me?: string | number;
}

export declare const ApprovalInbox: DefineComponent<CommonProps & { status?: InboxState['status'] }>;
export declare const ApprovalCard: DefineComponent<CommonProps & { id: string }>;
