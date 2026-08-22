/** Thinking is an explicit per-request capability, never inferred from the user message. */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Agent ids come from the Markdown filename under .pi/agents. */
export const AGENT_ID_PATTERN = '^[a-z][a-z0-9-]{1,63}$';

export interface AgentSummary {
  id: string;
  name: string;
  /** Avatar initials rendered by the Web client. */
  mark: string;
  tagline: string;
  description: string;
  /** Suggested questions shown on the welcome screen. */
  suggestions: string[];
  /** Persisted session count; only populated by the workspace endpoint. */
  sessionCount?: number;
}

/** Payload for POST /api/v1/agents; creates .pi/agents/<id>.md. */
export interface CreateAgentRequest {
  /** Optional explicit id; derived from `name` when omitted. */
  id?: string;
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  /** System-prompt body written after the YAML frontmatter. */
  body: string;
}

/** Payload for PATCH /api/v1/agents/:agentId; rewrites .pi/agents/<id>.md keeping untouched fields. */
export interface UpdateAgentRequest {
  name?: string;
  mark?: string;
  tagline?: string;
  description?: string;
  suggestions?: string[];
  /** System-prompt body written after the YAML frontmatter. */
  body?: string;
}

/** AgentDetail adds the system-prompt body for the configure panel. */
export interface AgentDetail extends AgentSummary {
  /** Markdown body of .pi/agents/<id>.md; used as the agent's system prompt. */
  body: string;
  /** Project-relative path of the definition file. */
  path: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Number of user questions recorded in the Pi JSONL session. */
  questionCount: number;
  /** True when the session's last assistant message ended in an error or was aborted. */
  needsAttention: boolean;
  /** stopReason of that last assistant message, when needsAttention is true. */
  attentionReason?: 'error' | 'aborted';
  /** Provider error message recorded on that message, when available. */
  attentionDetail?: string;
  /** 收件箱预览：最后一条 assistant 文本（无则最后一条 user 文本），压缩成单行并截断；为空时省略。 */
  preview?: string;
}

/** Payload of GET /api/v1/agents/:agentId/sessions. */
export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
}

/** 收件箱分段：Needs Attention / Completed / All。 */
export type InboxTab = 'attention' | 'completed' | 'all';

/** 收件箱条目：SessionSummary 叠加 SQLite inbox_state 里的已读/完成状态。 */
export interface InboxItem extends SessionSummary {
  /** 已读 = 用户已查看且此后没有新的出错/中断。 */
  read: boolean;
  /** 被标记完成（或出错/中断后又有成功运行）的时间；未完成为 undefined。 */
  completedAt?: string;
  /** 该会话有待人工审批的工具调用时携带；有待审批的会话会并入 attention tab。 */
  pendingApproval?: PendingApproval;
}

/** Payload of GET /api/v1/inbox; items 按 tab 过滤、updatedAt 倒序。 */
export interface InboxResponse {
  items: InboxItem[];
  total: number;
  /** attention tab 中未读条数；不受 q 过滤影响。 */
  unreadCount: number;
}

/** Payload of PATCH /api/v1/agents/:agentId/sessions/:sessionId/inbox; 至少一个字段。 */
export interface UpdateInboxStateRequest {
  read?: boolean;
  completed?: boolean;
}

/** Payload of PATCH /api/v1/agents/:agentId/sessions/:sessionId. */
export interface RenameSessionRequest {
  title: string;
}

export interface ChatRequest {
  agentId: string;
  sessionId?: string;
  message: string;
  /** Optional model override; the API validates it against the provider catalog. */
  model?: string;
  /** Optional per-turn thinking level. */
  thinking?: AgentThinkingLevel;
}

export interface ChatModelLabel {
  provider?: string;
  model?: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}

/** One message replayed from a persisted Pi JSONL session. */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning trace recorded on assistant messages, when the turn used thinking. */
  thinking?: string;
  usage?: ChatUsage;
  /** Pi stopReason of assistant messages; 'error' / 'aborted' mark failed turns. */
  stopReason?: string;
  errorMessage?: string;
  timestamp: string;
}

/** Payload of GET /api/v1/agents/:agentId/sessions/:sessionId/messages. */
export interface SessionMessagesResponse {
  items: SessionMessage[];
}

/** Payloads transported by the POST /api/v1/chat SSE endpoint. */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; agentId: string; model: ChatModelLabel }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; answer: string; usage?: ChatUsage }
  /** Pi auto-retry lifecycle: emitted when a failed turn is retried. */
  | { type: 'retry'; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: 'error'; error: string };

/**
 * 审批状态：pending 等待人工决策；approved/always 已批准（always = 本次会话内同类放行，
 * 由扩展内存语义承接）；denied* 已拒绝；expired = 请求文件已消失（扩展超时或外部消费），
 * 不会回写扩展，仅作为 SQLite 终态。
 */
export type ApprovalState = 'pending' | 'approved' | 'always' | 'denied' | 'denied_with_reason' | 'expired';

/** 一条等待人工审批的工具调用；审批桥把扩展的转发请求文件落成此记录。 */
export interface PendingApproval {
  /** 扩展请求文件里的 request id（即文件名 <id>.json）。 */
  id: string;
  /** 发起审批的会话（请求文件的 requesterSessionId）。 */
  sessionId: string;
  /** 由会话的 agent 绑定反查得到；会话已删除时缺省。 */
  agentId?: string;
  /** 请求文件里的 requesterAgentName。 */
  agentName: string;
  /** 扩展给出的待审批描述（工具与参数摘要）。 */
  message: string;
  createdAt: string;
}

/** 审批全量记录：pending 叠加最终状态与处理时间。 */
export interface ApprovalRecord extends PendingApproval {
  state: ApprovalState;
  resolvedAt?: string;
}

/** Payload of GET /api/v1/approvals; state 缺省时返回全部记录。 */
export interface ApprovalListResponse {
  items: ApprovalRecord[];
  total: number;
}

/** Payload of POST /api/v1/approvals/:id/decision。 */
export interface ApprovalDecisionRequest {
  approved: boolean;
  /** 拒绝时附带给扩展的 denialReason。 */
  reason?: string;
  /** 批准且 always=true 时 state 写 "always"（本次会话内同类调用放行，由扩展承接）。 */
  always?: boolean;
}

/** Project resources visible to an agent plus its persisted run statistics. */
export interface AgentResources {
  /** .pi/prompts templates merged into the project context. */
  prompts: PromptSummary[];
  /** .pi/skills entries available to the project. */
  skills: SkillSummary[];
  /** True when .pi/APPEND_SYSTEM.md exists and is appended to every agent's context. */
  appendSystem: boolean;
  stats: {
    /** Persisted session count bound to this agent. */
    sessionCount: number;
    /** Total user questions recorded across those sessions. */
    questionCount: number;
  };
}

export interface PromptSummary {
  name: string;
  /** Project-relative path, e.g. .pi/prompts/inspect-pi.md */
  path: string;
  description?: string;
  /** First characters of the body with frontmatter stripped; shown on the Skills page. */
  preview?: string;
}

/** One .pi/skills/<dir>/SKILL.md entry. */
export interface SkillSummary {
  name: string;
  /** Project-relative path, e.g. .pi/skills/research/SKILL.md */
  path: string;
  description?: string;
  /** First characters of the body with frontmatter stripped. */
  preview?: string;
}

export interface PromptDocument extends PromptSummary {
  /** Markdown body with the YAML frontmatter stripped. */
  content: string;
}

/** Payload of PUT /api/v1/prompts/:name; rewrites .pi/prompts/<name>.md keeping other frontmatter fields. */
export interface UpdatePromptRequest {
  /** Markdown body written after the YAML frontmatter. */
  content: string;
  /** Replaces the frontmatter description when present; omitted keeps the current one. */
  description?: string;
}

/** Payload of GET /api/v1/append-system; null when .pi/APPEND_SYSTEM.md is not configured. */
export interface AppendSystemResponse {
  content: string | null;
}

/** Payload of PUT /api/v1/append-system; an empty (trimmed) content removes the file. */
export interface UpdateAppendSystemRequest {
  content: string;
}

/** Payload of GET /api/v1/skills; items come from listSkills over .pi/skills. */
export interface SkillListResponse {
  items: SkillSummary[];
  total: number;
}

export interface WorkspaceResponse {
  agents: AgentSummary[];
  prompts: PromptSummary[];
  models: {
    current: { provider?: string; model?: string };
    available: Array<{ id: string; name: string }>;
  };
}

/** Token totals aggregated from the SQLite usage_events projection. */
export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

/** One row of the per-agent usage table on the Usage page. */
export interface AgentUsageRow {
  agentId: string;
  name: string;
  mark: string;
  sessionCount: number;
  questionCount: number;
  /** Token totals recorded for this agent; zeros when no turn has been recorded yet. */
  tokens: TokenTotals;
  /** Most recent updatedAt across this agent's sessions; absent when it has none. */
  lastActiveAt?: string;
}

/** Payload of GET /api/v1/usage; session/question numbers come from the JSONL sessions, tokens from SQLite. */
export interface UsageResponse {
  totalSessions: number;
  totalQuestions: number;
  agentCount: number;
  /**
   * Questions from sessions created or updated on the current local day.
   * Approximation: SessionSummary has no per-question timestamps.
   */
  questionsToday: number;
  /** Global token totals across all recorded chat turns. */
  tokens: TokenTotals;
  perAgent: AgentUsageRow[];
}

/** Payload of GET /api/v1/settings; non-sensitive configuration only, never credentials. */
export interface SettingsResponse {
  model: {
    provider?: string;
    model?: string;
    available: Array<{ id: string; name: string }>;
  };
  /** Default thinking level from PI_THINKING_LEVEL / .pi/settings.json. */
  thinkingLevel: AgentThinkingLevel;
  resources: {
    agents: number;
    prompts: number;
    skills: number;
    /** True when .pi/APPEND_SYSTEM.md exists. */
    appendSystem: boolean;
  };
  workspace: {
    /** Basename of the project root, e.g. "pi-samples". */
    name: string;
    /** Session storage path relative to the project root, e.g. ".pi/sessions". */
    sessionDir: string;
  };
}

/** Payload of GET /api/v1/templates; each entry creates .pi/agents/<id>.md when used. */
export interface AgentTemplate {
  id: string;
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  body: string;
}

export interface AgentTemplatesResponse {
  items: AgentTemplate[];
}

/** Payload of GET /api/v1/preferences; keys are namespaced (ui.*, thinking.<agentId>). */
export interface PreferencesResponse {
  items: Record<string, unknown>;
}

/** Payload of PUT /api/v1/preferences; upserts one namespaced key. */
export interface PreferenceUpdateRequest {
  key: string;
  value: unknown;
}

/** Every non-2xx API response uses this shape. */
export interface ApiError {
  error: string;
}
