import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatUsage } from '@pi-workbench/contracts';
import { getAgent } from './agents.js';
import { getModelRuntime, getPiModelConfig, getPiProjectRoot, getPiThinkingLevel, type PiThinkingLevel } from './model-config.js';
import { assertSessionAgentBinding, getPiSessionDir, initializeSessionFile } from './session-store.js';

export type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
export { getPiModelConfig, getPiProjectRoot, getPiThinkingLevel, listPiModels } from './model-config.js';
export type { PiModelConfig, PiThinkingLevel } from './model-config.js';
export * from './agents.js';
export * from './db.js';
export * from './session-store.js';
export * from './templates.js';
export * from './usage.js';

export interface PiAgentSessionOptions {
  cwd?: string;
  agentId: string;
  sessionId?: string;
  sessionDir?: string;
  /** Unit tests can opt into Pi's in-memory manager; Web sessions persist by default. */
  persistSession?: boolean;
  provider?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  /** Project extensions execute host code and stay opt-in for the Web gateway. */
  projectExtensions?: boolean;
}

export interface AgentTurnOptions {
  /** Explicit per-turn thinking level selected by the Web client. */
  thinkingLevel?: PiThinkingLevel;
  /** Per-session model override, already validated by the API against the provider catalog. */
  model?: string;
  onEvent?: (event: AgentSessionEvent) => void;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface AgentTurnResult {
  answer: string;
  thinkingText: string;
  usage?: ChatUsage;
}

export interface PiAgentSession {
  cwd: string;
  agentId: string;
  session: AgentSession;
  sessionManager: SessionManager;
  close: () => void;
}

function projectExtensionsEnabled(explicit?: boolean): boolean {
  return explicit ?? process.env.PI_PROJECT_EXTENSIONS_ENABLED === 'true';
}

/**
 * Creates one Pi AgentSession for an agent bound to one immutable session.
 * No custom tools are registered: agents in this round are pure chat.
 */
export async function createPiAgentSession(options: PiAgentSessionOptions): Promise<PiAgentSession> {
  const cwd = options.cwd ?? getPiProjectRoot();
  const agent = getAgent(cwd, options.agentId);
  const modelRuntime = await getModelRuntime();
  const modelConfig = getPiModelConfig(options, cwd);
  const model = modelConfig.provider && modelConfig.model ? modelRuntime.getModel(modelConfig.provider, modelConfig.model) : undefined;
  if (!model) throw new Error(`Pi model not found: ${modelConfig.provider ?? 'default'}/${modelConfig.model ?? 'default'}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, agent.body],
    noExtensions: !projectExtensionsEnabled(options.projectExtensions),
    // Themes are inert in the Web UI but remain part of the Pi resource graph.
    noThemes: false,
  });
  await resourceLoader.reload();

  const persistSession = options.persistSession !== false;
  const sessionDir = options.sessionDir ?? getPiSessionDir(cwd);
  let sessionManager: SessionManager;
  if (!persistSession) {
    sessionManager = SessionManager.inMemory(cwd);
  } else {
    const existing = options.sessionId ? (await SessionManager.list(cwd, sessionDir)).find((info) => info.id === options.sessionId) : undefined;
    if (existing) {
      sessionManager = SessionManager.open(existing.path, sessionDir, cwd);
      assertSessionAgentBinding(sessionManager.getEntries(), agent.id);
    } else {
      sessionManager = initializeSessionFile({ cwd, sessionDir, agentId: agent.id, ...(options.sessionId ? { id: options.sessionId } : {}) }).manager;
    }
  }

  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    modelRuntime,
    resourceLoader,
    model,
    tools: [],
    thinkingLevel: getPiThinkingLevel(options.thinkingLevel, cwd),
  });

  return { cwd, agentId: agent.id, session, sessionManager, close: () => session.dispose() };
}

function isAssistantMessage(value: unknown): value is { usage?: { input?: unknown; output?: unknown; totalTokens?: unknown } } {
  return Boolean(value && typeof value === 'object' && (value as { role?: unknown }).role === 'assistant');
}

async function collectTurn(runtime: PiAgentSession, message: string, options: AgentTurnOptions): Promise<AgentTurnResult> {
  let answer = '';
  let thinkingText = '';
  let usage: ChatUsage | undefined;
  const captureUsage = (value: unknown) => {
    if (!isAssistantMessage(value)) return;
    const raw = value.usage;
    const input = typeof raw?.input === 'number' ? raw.input : 0;
    const output = typeof raw?.output === 'number' ? raw.output : 0;
    const total = typeof raw?.totalTokens === 'number' ? raw.totalTokens : input + output;
    if (total > 0) usage = { input, output, total };
  };

  // Subscriptions must be in place before prompt() so no delta is missed.
  const unsubscribe = runtime.session.subscribe((event) => {
    options.onEvent?.(event);
    if (event.type === 'agent_end') captureUsage(event.messages.find(isAssistantMessage));
    if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') captureUsage(event.message);
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      answer += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta);
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
      thinkingText += event.assistantMessageEvent.delta;
      options.onThinkingDelta?.(event.assistantMessageEvent.delta);
    }
  });

  try {
    await runtime.session.prompt(message);
    return { answer: answer.trim(), thinkingText, ...(usage ? { usage } : {}) };
  } finally {
    unsubscribe();
  }
}

/** Serializes async tasks per key so one AgentSession never runs concurrent turns. */
export class KeyedExecutor {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(task);
    // The stored tail swallows rejections so one failed turn never blocks the queue.
    this.tails.set(key, next.catch(() => undefined));
    return next;
  }
}

/** Keeps one Pi session per agent/session pair so contexts never share a runtime. */
export class PiSessionRegistry {
  private readonly sessions = new Map<string, Promise<PiAgentSession>>();
  private readonly executor = new KeyedExecutor();

  private getOrCreate(agentId: string, sessionId: string, options: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<PiAgentSession> {
    const key = `${agentId}:${sessionId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = createPiAgentSession({ ...options, agentId, sessionId, persistSession: true });
    this.sessions.set(key, created);
    // 创建失败（如 model not found）时不能缓存 rejected Promise，否则该 session 后续所有
    // turn 都命中同一个失败；仅在自己仍是 map 里的条目时摘除，避免竞态误删新条目。
    created.catch(() => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
    });
    return created;
  }

  async run(agentId: string, sessionId: string, message: string, options: AgentTurnOptions = {}, sessionOptions: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<AgentTurnResult> {
    // Concurrent /chat turns on the same session would interleave prompt() calls and
    // delta subscriptions on one AgentSession; serialize them per key.
    return this.executor.run(`${agentId}:${sessionId}`, async () => {
      const runtime = await this.getOrCreate(agentId, sessionId, sessionOptions);
      if (sessionOptions.thinkingLevel && runtime.session.thinkingLevel !== sessionOptions.thinkingLevel) runtime.session.setThinkingLevel(sessionOptions.thinkingLevel);
      if (options.model && runtime.session.model?.id !== options.model) {
        const { provider } = getPiModelConfig({}, runtime.cwd);
        const model = provider ? runtime.session.modelRuntime.getModel(provider, options.model) : undefined;
        if (!model) throw new Error(`Pi model not found: ${provider ?? 'default'}/${options.model}`);
        await runtime.session.setModel(model);
      }
      return collectTurn(runtime, message, options);
    });
  }

  /** Aborts the running turn of one session (e.g. when the SSE client disconnects). */
  async abort(agentId: string, sessionId: string): Promise<void> {
    const runtime = this.sessions.get(`${agentId}:${sessionId}`);
    if (runtime) await (await runtime).session.abort();
  }

  async close(agentId: string, sessionId: string): Promise<void> {
    const key = `${agentId}:${sessionId}`;
    const runtime = this.sessions.get(key);
    this.sessions.delete(key);
    if (runtime) (await runtime).close();
  }

  async closeAll(): Promise<void> {
    const runtimes = [...this.sessions.values()];
    this.sessions.clear();
    for (const runtime of runtimes) (await runtime).close();
  }
}

export const piSessionRegistry = new PiSessionRegistry();

/** Runs one chat turn; errors are thrown explicitly, never replaced by a fallback answer. */
export async function runAgentTurn(agentId: string, sessionId: string, message: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
  if (process.env.PI_AGENT_ENABLED !== 'true') throw new Error('Pi 模型未启用，无法开始会话');
  return piSessionRegistry.run(agentId, sessionId, message, options, { thinkingLevel: options.thinkingLevel ?? getPiThinkingLevel() });
}
