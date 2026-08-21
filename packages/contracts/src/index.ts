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
  | { type: 'error'; error: string };

export interface PromptSummary {
  name: string;
  /** Project-relative path, e.g. .pi/prompts/inspect-pi.md */
  path: string;
  description?: string;
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

/** Every non-2xx API response uses this shape. */
export interface ApiError {
  error: string;
}
