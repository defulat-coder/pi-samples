import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentThinkingLevel, ChatUsage } from '@pi-workbench/contracts';
import { getAgent } from './agents.js';
import { assertSessionAgentBinding, getPiSessionDir, PI_WORKBENCH_AGENT_ENTRY } from './session-store.js';

export type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
export * from './agents.js';
export * from './session-store.js';

export type PiThinkingLevel = AgentThinkingLevel;

const THINKING_LEVELS: readonly PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

export interface PiModelConfig {
  provider?: string;
  model?: string;
}

export interface PiModelStatus extends PiModelConfig {
  enabled: boolean;
  providerConfigured: boolean;
  thinkingLevel: PiThinkingLevel;
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

export function getPiProjectRoot(): string {
  const candidate = process.cwd();
  for (const current of [candidate, resolve(candidate, '..'), resolve(candidate, '../..')]) {
    if (existsSync(resolve(current, '.pi'))) return current;
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '../../..');
}

export function getPiModelConfig(overrides: { provider?: string; model?: string } = {}, cwd = getPiProjectRoot()): PiModelConfig {
  let settings: { defaultProvider?: unknown; defaultModel?: unknown } = {};
  try {
    settings = JSON.parse(readFileSync(resolve(cwd, '.pi/settings.json'), 'utf8')) as typeof settings;
  } catch {
    // Environment variables and the kimi-coding default remain the contract.
  }
  const configuredProvider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : undefined;
  const configuredModel = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : undefined;
  const provider = overrides.provider ?? process.env.PI_MODEL_PROVIDER?.trim() ?? configuredProvider ?? 'kimi-coding';
  const model = overrides.model ?? process.env.PI_MODEL?.trim() ?? configuredModel ?? (provider === 'kimi-coding' ? 'kimi-for-coding' : undefined);
  return { provider, model };
}

export function getPiThinkingLevel(level?: PiThinkingLevel, cwd = getPiProjectRoot()): PiThinkingLevel {
  if (level) return level;
  const configured = process.env.PI_THINKING_LEVEL;
  if (configured && (THINKING_LEVELS as readonly string[]).includes(configured)) return configured as PiThinkingLevel;
  try {
    const settings = JSON.parse(readFileSync(resolve(cwd, '.pi/settings.json'), 'utf8')) as { defaultThinkingLevel?: unknown };
    if (typeof settings.defaultThinkingLevel === 'string' && (THINKING_LEVELS as readonly string[]).includes(settings.defaultThinkingLevel)) return settings.defaultThinkingLevel as PiThinkingLevel;
  } catch {
    // Keep the no-thinking project default when settings are absent or invalid.
  }
  return 'off';
}

function projectExtensionsEnabled(explicit?: boolean): boolean {
  return explicit ?? process.env.PI_PROJECT_EXTENSIONS_ENABLED === 'true';
}

let modelRuntimePromise: Promise<ModelRuntime> | undefined;

function getModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= ModelRuntime.create({ allowModelNetwork: false });
  return modelRuntimePromise;
}

/** Static provider catalog for the configured provider; used to render and validate the Web model picker. */
export async function listPiModels(): Promise<Array<{ id: string; name: string }>> {
  const { provider } = getPiModelConfig();
  if (!provider) return [];
  const runtime = await getModelRuntime();
  return runtime.getModels(provider).map((model) => ({ id: model.id, name: model.name }));
}

export function getPiModelStatus(enabled = process.env.PI_AGENT_ENABLED === 'true'): PiModelStatus {
  const config = getPiModelConfig();
  const providerKeyEnv: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', 'google-vertex': 'GOOGLE_API_KEY', 'kimi-coding': 'KIMI_API_KEY' };
  const providerConfigured = config.provider ? Boolean(process.env[providerKeyEnv[config.provider] ?? '']) : false;
  return { enabled, providerConfigured, thinkingLevel: getPiThinkingLevel(), ...config };
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
      mkdirSync(sessionDir, { recursive: true });
      const created = SessionManager.create(cwd, sessionDir, options.sessionId ? { id: options.sessionId } : undefined);
      const file = created.getSessionFile();
      const header = created.getHeader();
      if (!file || !header) throw new Error('Pi session file could not be initialized');
      // SessionManager only persists once the JSONL file carries its header.
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
      sessionManager = SessionManager.open(file, sessionDir, cwd);
      sessionManager.appendCustomEntry(PI_WORKBENCH_AGENT_ENTRY, { agentId: agent.id });
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

/** Keeps one Pi session per agent/session pair so contexts never share a runtime. */
export class PiSessionRegistry {
  private readonly sessions = new Map<string, Promise<PiAgentSession>>();

  private getOrCreate(agentId: string, sessionId: string, options: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<PiAgentSession> {
    const key = `${agentId}:${sessionId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = createPiAgentSession({ ...options, agentId, sessionId, persistSession: true });
    this.sessions.set(key, created);
    return created;
  }

  async run(agentId: string, sessionId: string, message: string, options: AgentTurnOptions = {}, sessionOptions: Omit<PiAgentSessionOptions, 'agentId' | 'sessionId'> = {}): Promise<AgentTurnResult> {
    const runtime = await this.getOrCreate(agentId, sessionId, sessionOptions);
    if (sessionOptions.thinkingLevel && runtime.session.thinkingLevel !== sessionOptions.thinkingLevel) runtime.session.setThinkingLevel(sessionOptions.thinkingLevel);
    if (options.model && runtime.session.model?.id !== options.model) {
      const { provider } = getPiModelConfig({}, runtime.cwd);
      const model = provider ? runtime.session.modelRuntime.getModel(provider, options.model) : undefined;
      if (!model) throw new Error(`Pi model not found: ${provider ?? 'default'}/${options.model}`);
      await runtime.session.setModel(model);
    }
    return collectTurn(runtime, message, options);
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
