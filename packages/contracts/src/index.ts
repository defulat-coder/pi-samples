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

export interface AuthUser {
  id: string;
  name: string;
  avatarUrl?: string;
  openId?: string;
}

export interface AuthStatusResponse {
  provider: 'feishu';
  configured: boolean;
  authRequired: boolean;
  authenticated: boolean;
  user?: AuthUser;
  message?: string;
}

export type QuerySourceKind = 'database' | 'knowledge';

export interface QuerySource {
  kind: QuerySourceKind;
  title: string;
  ref: string;
  excerpt: string;
  fields?: string[];
}

export type DigitalHumanId = string;
export type DigitalHumanCapabilityProfile = 'project-knowledge' | 'business-analytics';
export type DigitalHumanAccent = 'indigo' | 'teal' | 'amber' | 'rose';
export type DigitalHumanChatRoute = DigitalHumanCapabilityProfile;

export interface DigitalHumanDefinition {
  schemaVersion: 1;
  order: number;
  id: DigitalHumanId;
  displayName: string;
  role: string;
  tagline: string;
  description: string;
  capabilityProfile: DigitalHumanCapabilityProfile;
  capabilityLabel: string;
  avatar: { initials: string; accent: DigitalHumanAccent };
  persona: {
    identity: string;
    mission: string;
    traits: string[];
    communicationStyle: string;
    principles: string[];
  };
  skills: string[];
  tools: string[];
  welcome: { title: string; description: string; suggestions: string[] };
}

export type BusinessMeasure = 'gross_sales' | 'net_sales' | 'order_count' | 'average_order_value' | 'refund_rate';
export type BusinessDimension = 'date' | 'month' | 'region' | 'channel' | 'category';
export type BusinessFilterField = 'region' | 'channel' | 'category';
export type BusinessTimePreset = 'last_7_days' | 'last_30_days' | 'last_90_days' | 'all';
export type BusinessPresentationIntent = 'auto' | 'trend' | 'comparison' | 'ranking' | 'detail';

export interface BusinessAnalysisRequest {
  measures: BusinessMeasure[];
  dimensions: BusinessDimension[];
  time?: { preset?: BusinessTimePreset };
  filters?: Array<{ field: BusinessFilterField; operator: 'eq' | 'in'; values: string[] }>;
  sort?: { field: BusinessMeasure; direction: 'asc' | 'desc' };
  limit?: number;
  presentationIntent?: BusinessPresentationIntent;
}

export interface NormalizedBusinessAnalysisRequest {
  measures: BusinessMeasure[];
  dimensions: BusinessDimension[];
  time: { preset: BusinessTimePreset };
  filters: Array<{ field: BusinessFilterField; operator: 'eq' | 'in'; values: string[] }>;
  sort?: { field: BusinessMeasure; direction: 'asc' | 'desc' };
  limit: number;
  presentationIntent: BusinessPresentationIntent;
}

export interface BusinessAnalyticalField {
  key: BusinessMeasure | BusinessDimension;
  label: string;
  role: 'measure' | 'dimension' | 'time';
  dataType: 'string' | 'number' | 'date';
  semanticType?: 'currency' | 'percent' | 'count';
  unit?: '元' | '单' | '%';
  definition?: string;
  formula?: string;
  owner?: string;
}

export interface BusinessCatalogSummary {
  version: 'sales-demo-v2';
  measures: Array<Pick<BusinessAnalyticalField, 'key' | 'label' | 'semanticType' | 'unit' | 'definition' | 'formula' | 'owner'>>;
  dimensions: Array<Pick<BusinessAnalyticalField, 'key' | 'label' | 'role' | 'dataType'> & { values?: string[] }>;
  limits: { maxMeasures: 3; maxDimensions: 2; maxFilters: 4; maxRows: 50 };
}

export interface BusinessAnalyticalResult {
  queryId: string;
  catalogVersion: 'sales-demo-v2';
  dataset: '电商经营演示数据';
  request: NormalizedBusinessAnalysisRequest;
  fields: BusinessAnalyticalField[];
  rows: Array<Record<string, string | number>>;
  metadata: {
    asOf: string;
    datasetRows: number;
    coverage: { from: string; to: string };
    generation: { source: 'codex-cli'; model: 'gpt-5.6-luna'; concurrency: 20; scenarios: 20 };
    timeWindow: { from: string; to: string; timezone: 'Asia/Shanghai' };
    rowCount: number;
    freshness: string;
    limitations: string[];
  };
}

export type BusinessPresentationBlock =
  | { id: string; type: 'summary'; primaryMeasure: BusinessMeasure; dimensionFields: BusinessDimension[] }
  | { id: string; type: 'chart'; chart: 'line' | 'bar'; title: string; xField: BusinessDimension; seriesField?: BusinessDimension; yField: BusinessMeasure }
  | { id: string; type: 'table'; fields: Array<BusinessMeasure | BusinessDimension> }
  | { id: string; type: 'scope' }
  | { id: string; type: 'notice' };

export interface BusinessPresentationPlan {
  version: '1';
  title: string;
  blocks: BusinessPresentationBlock[];
}

export interface BusinessAnalysis {
  result: BusinessAnalyticalResult;
  presentation: BusinessPresentationPlan;
}

/** Thinking is an explicit per-request capability, never inferred from the user message. */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentResourceSummary {
  path: string;
  kind: 'digital-human' | 'skill' | 'prompt' | 'knowledge' | 'session' | 'extension' | 'theme' | 'settings' | 'system' | 'file';
  title: string;
  status: 'active' | 'draft' | 'deprecated';
}

export interface AgentResourceDocument {
  resource: AgentResourceSummary;
  content: string;
}

export interface PiResourceDiagnostic {
  type: 'warning' | 'error' | 'collision';
  message: string;
  path?: string;
}

export interface PiRuntimeResourceSnapshot {
  /** Web embeds the SDK with a trusted local cwd; this is not a sandbox signal. */
  projectTrusted: boolean;
  /** Extensions stay opt-in in the Web gateway because they execute host code. */
  extensionsEnabled: boolean;
  extensions: Array<{
    path: string;
    commandNames: string[];
    toolNames: string[];
  }>;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    disableModelInvocation: boolean;
  }>;
  prompts: Array<{
    name: string;
    description: string;
    argumentHint?: string;
    path: string;
  }>;
  themes: Array<{ name: string; path?: string }>;
  contextFiles: Array<{ path: string }>;
  systemPrompt?: { path: string };
  appendSystemPrompts: Array<{ path: string }>;
  diagnostics: PiResourceDiagnostic[];
}

export interface AgentEventSummary {
  type: string;
  label: string;
  toolName?: string;
  /** Optional compact diagnostics for the inspector; never the full raw event. */
  detail?: string;
  category?: 'lifecycle' | 'message' | 'tool' | 'thinking' | 'error';
  sequence?: number;
  timestamp?: string;
  elapsedMs?: number;
  durationMs?: number;
}

export interface AgentDecision {
  /** Who selected the execution path. This is observed after the turn, not an input route. */
  decidedBy: 'pi';
  /** Tools actually called by Pi during this turn. */
  toolCalls: string[];
}

export type AgentFeedback = 'like' | 'dislike';

export interface AgentTokenCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface AgentTokenUsage {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic-only one-hour cache write subset, when reported by the provider. */
  cacheWrite1h?: number;
  /** Reasoning tokens are a subset of output, not an additional total. */
  reasoning?: number;
  cost: AgentTokenCost;
  /** `estimated` is used until a provider exposes an authoritative usage payload. */
  source: 'provider' | 'estimated' | 'unavailable';
}

export interface AgentContextUsage {
  /** Estimated context tokens; null means the runtime cannot currently provide it. */
  tokens: number | null;
  contextWindow: number;
  /** Percentage of the context window; null when tokens is unknown. */
  percent: number | null;
}

export interface AgentToolMetric {
  toolCallId?: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputChars: number;
  outputChars: number;
  errorMessage?: string;
  tokenUsage?: AgentTokenUsage;
}

export interface AgentRetryMetric {
  kind: 'agent' | 'summarization';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
}

export interface AgentCompactionMetric {
  reason: 'manual' | 'threshold' | 'overflow';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  aborted: boolean;
  willRetry: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  summaryChars?: number;
  tokenUsage?: AgentTokenUsage;
  errorMessage?: string;
}

export interface AgentSessionTotals {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokenUsage: AgentTokenUsage;
  cost: number;
  contextUsage?: AgentContextUsage;
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
  eventCounts: Record<string, number>;
  eventCategoryCounts: Record<string, number>;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  toolMetrics: AgentToolMetric[];
  retryCount: number;
  retries: AgentRetryMetric[];
  compactionCount: number;
  compactions: AgentCompactionMetric[];
  queueUpdateCount: number;
  settled: boolean;
  inputChars: number;
  outputChars: number;
  thinkingChars: number;
  tokenUsage: AgentTokenUsage;
  contextUsage?: AgentContextUsage;
  sessionTotals?: AgentSessionTotals;
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
}

export interface DigitalHumanChatRequest {
  message: string;
  digitalHumanId: DigitalHumanId;
  sessionId?: string;
  turnId?: string;
  thinkingLevel?: AgentThinkingLevel;
  debug?: boolean;
}

export interface DigitalHumanChatResponse {
  answer: string;
  source: 'pi-coding-agent';
  digitalHumanId: DigitalHumanId;
  sessionId: string;
  route: DigitalHumanChatRoute;
  decision: AgentDecision;
  sources: QuerySource[];
  analysis?: BusinessAnalysis;
  resources: AgentResourceSummary[];
  events: AgentEventSummary[];
  tools: {
    enabled: string[];
    policy: 'read-only';
  };
  model: {
    enabled: boolean;
    providerConfigured: boolean;
    api?: string;
    provider?: string;
    model?: string;
    responseModel?: string;
    responseId?: string;
    thinkingLevel?: AgentThinkingLevel;
  };
  metrics: AgentTurnMetrics;
  latencyMs: number;
  createdAt: string;
}

export type DigitalHumanSessionMessage =
  | { id: string; kind: 'user'; text: string; turnId?: string; createdAt?: string }
  | { id: string; kind: 'thinking'; turnId: string; text: string; status: 'streaming' | 'complete'; createdAt?: string }
  | { id: string; kind: 'assistant'; turnId: string; text: string; response?: DigitalHumanChatResponse; feedback?: AgentFeedback | null; createdAt?: string; persisted?: boolean };

export interface DigitalHumanSessionRecord {
  id: string;
  digitalHumanId: DigitalHumanId;
  title?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  messages: DigitalHumanSessionMessage[];
}

export interface DigitalHumanSessionListResponse {
  items: DigitalHumanSessionRecord[];
  total: number;
}

/** Payloads transported by the POST /digital-humans/chat/stream SSE endpoint. */
export type DigitalHumanChatStreamEvent =
  | { type: 'start'; digitalHumanId: DigitalHumanId; sessionId: string; model: DigitalHumanChatResponse['model'] }
  | { type: 'event'; event: AgentEventSummary }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; response: DigitalHumanChatResponse }
  | { type: 'error'; message: string };
