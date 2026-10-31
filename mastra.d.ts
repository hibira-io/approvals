import type { ApprovalCall, ApprovalRequest } from './types.js';

export declare function approvalCalls(source: unknown): {
  runId: string | null;
  calls: { id: string; tool: string; input: unknown }[];
  metadata: { framework: 'mastra'; runId: string | null; kinds: Record<string, 'approval' | 'suspend'> };
};

/** Resume data a suspended tool receives. */
export declare function resumeDataFor(call: ApprovalCall): {
  decision: ApprovalCall['decision'];
  approved: boolean;
  input?: unknown;
  reason?: string;
};

/** The parts of a Mastra Agent this calls. */
export interface MastraAgentLike {
  approveToolCallGenerate(options: any): Promise<any>;
  declineToolCallGenerate(options: any): Promise<any>;
  resumeGenerate(resumeData: any, options: any): Promise<any>;
  approveToolCall?(options: any): Promise<any>;
  declineToolCall?(options: any): Promise<any>;
  resumeStream?(resumeData: any, options: any): Promise<any>;
}

export declare function resumeMastra(
  agent: MastraAgentLike,
  request: Pick<ApprovalRequest, 'calls' | 'metadata'>,
  options?: { stream?: boolean; [option: string]: unknown },
): Promise<any[]>;
