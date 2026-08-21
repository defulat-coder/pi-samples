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

/** Payloads transported by the POST /api/v1/chat SSE endpoint. */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; agentId: string; model: ChatModelLabel }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; answer: string; usage?: ChatUsage }
  /** Pi auto-retry lifecycle: emitted when a failed turn is retried. */
  | { type: 'retry'; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: 'error'; error: string };

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

export interface WorkspaceResponse {
  agents: AgentSummary[];
  prompts: PromptSummary[];
  models: {
    current: { provider?: string; model?: string };
    available: Array<{ id: string; name: string }>;
  };
}

/** One row of the per-agent usage table on the Usage page. */
export interface AgentUsageRow {
  agentId: string;
  name: string;
  mark: string;
  sessionCount: number;
  questionCount: number;
  /** Most recent updatedAt across this agent's sessions; absent when it has none. */
  lastActiveAt?: string;
}

/** Payload of GET /api/v1/usage; every number is aggregated from the persisted sessions. */
export interface UsageResponse {
  totalSessions: number;
  totalQuestions: number;
  agentCount: number;
  /**
   * Questions from sessions created or updated on the current local day.
   * Approximation: SessionSummary has no per-question timestamps.
   */
  questionsToday: number;
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

/** Every non-2xx API response uses this shape. */
export interface ApiError {
  error: string;
}
