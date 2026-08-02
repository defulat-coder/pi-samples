export type WorkspaceRecordKind = 'experiment' | 'runbook' | 'decision' | 'fixture';
export type WorkspaceRecordStatus = 'active' | 'draft' | 'archived';

export interface WorkspaceRecord {
  id: string;
  kind: WorkspaceRecordKind;
  title: string;
  summary: string;
  status: WorkspaceRecordStatus;
  tags: string[];
  updatedAt: string;
  payload?: Record<string, string | number | boolean>;
}

export interface WorkspaceSnapshot {
  generatedAt: string;
  workspace: {
    name: string;
    environment: 'local';
    timezone: string;
  };
  metrics: {
    totalRecords: number;
    activeRecords: number;
    draftRecords: number;
    knowledgeDocuments: number;
  };
  records: WorkspaceRecord[];
}

export interface WorkspaceRecordQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  kind?: WorkspaceRecordKind;
  status?: WorkspaceRecordStatus;
}

export interface CreateWorkspaceRecordRequest {
  kind: WorkspaceRecordKind;
  title: string;
  summary: string;
  status?: WorkspaceRecordStatus;
  tags?: string[];
  payload?: Record<string, string | number | boolean>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface ApiError {
  error: string;
  message: string;
  requestId?: string;
}

export type QuerySourceKind = 'database' | 'knowledge';

export interface QuerySource {
  kind: QuerySourceKind;
  title: string;
  ref: string;
  excerpt: string;
  fields?: string[];
}

export type AgentChatRoute = 'workspace' | 'knowledge';

export interface AgentResourceSummary {
  path: string;
  kind: 'skill' | 'prompt' | 'knowledge' | 'session' | 'file';
  title: string;
  status: 'active' | 'draft' | 'deprecated';
}

export interface AgentResourceDocument {
  resource: AgentResourceSummary;
  content: string;
}

export interface AgentEventSummary {
  type: string;
  label: string;
  toolName?: string;
  /** Optional compact diagnostics for the inspector; never the full raw event. */
  detail?: string;
  category?: 'lifecycle' | 'message' | 'tool' | 'thinking' | 'error';
}

export interface AgentDecision {
  /** Who selected the execution path. This is observed after the turn, not an input route. */
  decidedBy: 'pi' | 'fallback';
  /** Tools actually called by Pi during this turn. */
  toolCalls: string[];
}

export type AgentFeedback = 'like' | 'dislike';

export interface AgentTokenUsage {
  input: number;
  output: number;
  total: number;
  /** `estimated` is used until a provider exposes an authoritative usage payload. */
  source: 'provider' | 'estimated' | 'unavailable';
}

export interface AgentTurnMetrics {
  /** Position of this user request within the persisted session. */
  turn: number;
  /** Number of model/tool exchanges observed for this response. */
  executionRounds: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  eventCount: number;
  toolCallCount: number;
  inputChars: number;
  outputChars: number;
  thinkingChars: number;
  tokenUsage: AgentTokenUsage;
}

export interface AgentChatRequest {
  message: string;
  sessionId?: string;
  turnId?: string;
  debug?: boolean;
}

export interface AgentChatResponse {
  answer: string;
  source: 'local-fallback' | 'pi-coding-agent';
  sessionId: string;
  route: AgentChatRoute;
  decision: AgentDecision;
  sources: QuerySource[];
  resources: AgentResourceSummary[];
  events: AgentEventSummary[];
  tools: {
    enabled: string[];
    policy: 'read-only';
  };
  model: {
    enabled: boolean;
    providerConfigured: boolean;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  };
  metrics: AgentTurnMetrics;
  latencyMs: number;
  createdAt: string;
}

export type AgentSessionMessage =
  | { id: string; kind: 'user'; text: string; turnId?: string }
  | { id: string; kind: 'thinking'; turnId: string; text: string; status: 'streaming' | 'complete' }
  | { id: string; kind: 'assistant'; turnId: string; text: string; response?: AgentChatResponse; feedback?: AgentFeedback | null };

export interface AgentSessionRecord {
  id: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  messages: AgentSessionMessage[];
}

export interface AgentSessionListResponse {
  items: AgentSessionRecord[];
  total: number;
}

/** Payloads transported by the POST /agent/chat/stream SSE endpoint. */
export type AgentChatStreamEvent =
  | { type: 'start'; sessionId: string; model: AgentChatResponse['model'] }
  | { type: 'event'; event: AgentEventSummary }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; response: AgentChatResponse }
  | { type: 'error'; message: string };
