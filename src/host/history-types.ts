import type { Context, Message, Operation } from "./types.js";

export const HISTORY_LIMITS = {
  completedDetails: 500,
  aggregateTextBytes: 64 * 1024 * 1024,
  resultBytes: 64 * 1024,
  detailBytes: 2 * 1024 * 1024,
  artifactBytes: 10 * 1024 * 1024,
  aggregateArtifactBytes: 128 * 1024 * 1024,
  pageSize: 30,
  maxPageSize: 100,
  draftBytes: 512 * 1024,
} as const;
export const RETENTION_DESCRIPTION =
  "Up to 500 completed run details / 64 MiB text and 128 MiB images (10 MiB each). Older summaries remain; expired evidence is labeled. Active runs and unresolved native receipts are protected.";
export interface RunSummary {
  threadId?: string;
  id: string;
  instanceId: string;
  number: number;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  promptPreview: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "finished" | "failed" | "interrupted";
  intent: "work" | "authoring";
  mode: "execution" | "authoring";
  sourceRunIds: string[];
  provider: string;
  model: string;
  toolNames: string[];
  failedCalls: number;
  callCount: number;
  detailsAvailable: boolean;
  detailBytes?: number;
  artifactBytes?: number;
}
export interface ToolCallRecord {
  id: string;
  runId: string;
  name: string;
  sequence: number;
  arguments: unknown;
  startedAt: string;
  endedAt?: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  result?: unknown;
  error?: string;
  operationIds: string[];
  artifacts: string[];
}
export interface SkillReadRecord {
  id: string;
  revision: string;
  path: string;
  offset?: number;
  complete?: boolean;
}
export interface RunDetail {
  run: RunSummary;
  calls: ToolCallRecord[];
  messages: Message[];
  operations: Operation[];
  context?: Context;
  selectedSkills?: { id: string; revision: string }[];
  readSkills?: SkillReadRecord[];
  authoringReads?: SkillReadRecord[];
  availableSkills?: { id: string; revision: string; name: string }[];
  catalogSnapshot?: string;
  missingEvidence?: string[];
}
export interface HistoryQuery {
  threadId?: string;
  search?: string;
  errorsOnly?: boolean;
  tool?: string;
  cursor?: string;
  limit?: number;
}
