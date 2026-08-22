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
import { loadPermissionExtension } from './permissions.js';
import { assertSessionAgentBinding, getPiSessionDir, initializeSessionFile } from './session-store.js';
import { loadSubagentsExtension } from './subagents.js';

export type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
export { getPiModelConfig, getPiProjectRoot, getPiThinkingLevel, listPiModels } from './model-config.js';
export type { PiModelConfig, PiThinkingLevel } from './model-config.js';
export * from './agents.js';
export * from './approvals.js';
export * from './db.js';
export * from './permissions.js';
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
 * Tools are a host-controlled pilot allowlist (read/grep/find/ls + bash); the
 * pi-permission-system extension guards every call — read-only tools are allowed
 * by policy, bash goes through HITL approval forwarding, everything else is denied.
 */
export async function createPiAgentSession(options: PiAgentSessionOptions): Promise<PiAgentSession> {
  const cwd = options.cwd ?? getPiProjectRoot();
  const agent = getAgent(cwd, options.agentId);
  const modelRuntime = await getModelRuntime();
  const modelConfig = getPiModelConfig(options, cwd);
  const model = modelConfig.provider && modelConfig.model ? modelRuntime.getModel(modelConfig.provider, modelConfig.model) : undefined;
  if (!model) throw new Error(`Pi model not found: ${modelConfig.provider ?? 'default'}/${modelConfig.model ?? 'default'}`);

  // 审批扩展必须在构造 ResourceLoader 前加载（进程级转发 env 在 import 扩展前设置）。
  const permissionExtension = await loadPermissionExtension(cwd);
  const subagentsExtension = await loadSubagentsExtension();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, agent.body],
    extensionFactories: [subagentsExtension, permissionExtension],
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
    // 试点工具白名单：宿主控制，agent 文件不得声明或扩展工具（契约不变）。
    // subagent 由 pi-subagents 扩展注册，allowlist 语义是「只启用列出的名字」，必须显式列出。
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'subagent'],
    thinkingLevel: getPiThinkingLevel(options.thinkingLevel, cwd),
  });

  // createAgentSession 不会代发 session_start（只有 CLI 的 print/interactive/rpc 模式
  // 内部调 bindExtensions）。SDK 宿主必须自己调一次：pi-permission-system 在
  // session_start 里才用 ctx.cwd 重建 PermissionManager，缺了这一步项目策略文件
  // （.pi/agent/pi-permissions.jsonc）永远不会被加载，全部工具退回 DEFAULT_POLICY(ask)。
  await session.bindExtensions({});

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
  /** Queued-or-running task count per key; eviction must never touch a key with pending work. */
  private readonly inFlight = new Map<string, number>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    const next = (this.tails.get(key) ?? Promise.resolve()).then(task);
    // The stored tail swallows rejections so one failed turn never blocks the queue.
    this.tails.set(key, next.catch(() => undefined));
    const settle = () => {
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, left);
    };
    void next.then(settle, settle);
    return next;
  }

  /** True while a task for this key is queued or running. */
  hasPending(key: string): boolean {
    return (this.inFlight.get(key) ?? 0) > 0;
  }
}

interface RegistryEntry {
  session: Promise<PiAgentSession>;
  lastUsedAt: number;
}

export interface PiSessionRegistryOptions {
  /** Idle sessions older than this are evicted on the next registry operation. */
  idleTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Session factory injection for tests; production uses createPiAgentSession. */
  createSession?: (options: PiAgentSessionOptions) => Promise<PiAgentSession>;
}

/** Keeps one Pi session per agent/session pair so contexts never share a runtime. */
export class PiSessionRegistry {
  private readonly sessions = new Map<string, RegistryEntry>();
  private readonly executor = new KeyedExecutor();
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly createSession: (options: PiAgentSessionOptions) => Promise<PiAgentSession>;

  constructor(options: PiSessionRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.createSession = options.createSession ?? createPiAgentSession;
  }

  private getOrCreate(agentId: string, sessionId: string, options: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<PiAgentSession> {
    const key = `${agentId}:${sessionId}`;
    this.sweepIdle();
    const existing = this.sessions.get(key);
    if (existing && !this.isExpired(existing)) {
      existing.lastUsedAt = this.now();
      return existing.session;
    }
    // 当前 key 的过期条目：executor 保证同 key 同一时间只有本任务在执行，淘汰安全。
    if (existing) this.evict(key, existing);
    const created = this.createSession({ ...options, agentId, sessionId, persistSession: true });
    this.sessions.set(key, { session: created, lastUsedAt: this.now() });
    // 创建失败（如 model not found）时不能缓存 rejected Promise，否则该 session 后续所有
    // turn 都命中同一个失败；仅在自己仍是 map 里的条目时摘除，避免竞态误删新条目。
    created.catch(() => {
      if (this.sessions.get(key)?.session === created) this.sessions.delete(key);
    });
    return created;
  }

  private isExpired(entry: RegistryEntry): boolean {
    return this.now() - entry.lastUsedAt > this.idleTtlMs;
  }

  private evict(key: string, entry: RegistryEntry): void {
    this.sessions.delete(key);
    void entry.session.then((runtime) => runtime.close(), () => undefined);
  }

  /** Lazy sweep (no timer): evict idle-expired entries that have no queued or running turn. */
  private sweepIdle(): void {
    for (const [key, entry] of this.sessions) {
      if (!this.isExpired(entry) || this.executor.hasPending(key)) continue;
      this.evict(key, entry);
    }
  }

  async run(agentId: string, sessionId: string, message: string, options: AgentTurnOptions = {}, sessionOptions: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<AgentTurnResult> {
    // Concurrent /chat turns on the same session would interleave prompt() calls and
    // delta subscriptions on one AgentSession; serialize them per key.
    return this.executor.run(`${agentId}:${sessionId}`, async () => {
      const runtime = await this.getOrCreate(agentId, sessionId, sessionOptions);
      try {
        if (sessionOptions.thinkingLevel && runtime.session.thinkingLevel !== sessionOptions.thinkingLevel) runtime.session.setThinkingLevel(sessionOptions.thinkingLevel);
        if (options.model && runtime.session.model?.id !== options.model) {
          const { provider } = getPiModelConfig({}, runtime.cwd);
          const model = provider ? runtime.session.modelRuntime.getModel(provider, options.model) : undefined;
          if (!model) throw new Error(`Pi model not found: ${provider ?? 'default'}/${options.model}`);
          await runtime.session.setModel(model);
        }
        return await collectTurn(runtime, message, options);
      } finally {
        // A long turn must not look idle-expired the moment it finishes.
        const entry = this.sessions.get(`${agentId}:${sessionId}`);
        if (entry) entry.lastUsedAt = this.now();
      }
    });
  }

  /** Runs a non-turn task (e.g. rename) after any in-flight turn of the same session. */
  runExclusive<T>(agentId: string, sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.executor.run(`${agentId}:${sessionId}`, task);
  }

  /** Aborts the running turn of one session (e.g. when the SSE client disconnects). */
  async abort(agentId: string, sessionId: string): Promise<void> {
    const entry = this.sessions.get(`${agentId}:${sessionId}`);
    if (entry) await (await entry.session).session.abort();
  }

  async close(agentId: string, sessionId: string): Promise<void> {
    const key = `${agentId}:${sessionId}`;
    const entry = this.sessions.get(key);
    this.sessions.delete(key);
    if (entry) (await entry.session).close();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) (await entry.session).close();
  }
}

export const piSessionRegistry = new PiSessionRegistry();

/** Runs one chat turn; errors are thrown explicitly, never replaced by a fallback answer. */
export async function runAgentTurn(agentId: string, sessionId: string, message: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
  if (process.env.PI_AGENT_ENABLED !== 'true') throw new Error('Pi 模型未启用，无法开始会话');
  return piSessionRegistry.run(agentId, sessionId, message, options, { thinkingLevel: options.thinkingLevel ?? getPiThinkingLevel() });
}
