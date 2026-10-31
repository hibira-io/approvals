import type { ReactElement } from 'react';
import type { ApprovalsClient } from './client.js';
import type { InboxController, InboxState, Locale } from './types.js';

export { createApprovalsClient } from './client.js';
export type { ApprovalsClient } from './client.js';
export type { InboxController, InboxState, Locale } from './types.js';

export interface ComponentProps {
  client: ApprovalsClient;
  /** Picks the bundled labels; defaults to English. */
  locale?: Locale;
  /** Overrides single labels. */
  labels?: Record<string, unknown>;
  /** The signed-in reviewer's id, left out of "also looking". */
  me?: string | number;
  className?: string;
}

export declare function useApprovalInbox(
  client: ApprovalsClient,
  options?: { id?: string; status?: InboxState['status'] },
): { inbox: InboxController | null; state: InboxState | null };

export declare function ApprovalInbox(props: ComponentProps & { status?: InboxState['status'] }): ReactElement | null;

export declare function ApprovalCard(props: ComponentProps & { id: string }): ReactElement | null;
