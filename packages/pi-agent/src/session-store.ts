import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  SessionManager,
  type AgentSessionEvent,
  type SessionEntry,
  type SessionInfo,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import type { AgentChatResponse, AgentFeedback, AgentSessionMessage, AgentSessionRecord } from '@pi-workbench/contracts';

export const PI_WORKBENCH_TURN_ENTRY = 'pi-workbench.turn';
export const PI_WORKBENCH_FEEDBACK_ENTRY = 'pi-workbench.feedback';

function getProjectRoot(): string {
  if (existsSync(resolve(process.cwd(), '.pi'))) return process.cwd();
  return resolve(dirname(new URL(import.meta.url).pathname), '../../..');
}

type PersistedMessage = Parameters<SessionManager['appendMessage']>[0];
type AssistantMessage = Extract<PersistedMessage, { role: 'assistant' }>;
type UserMessage = Extract<PersistedMessage, { role: 'user' }>;

type TurnEntryData = {
  turnId: string;
  response: AgentChatResponse;
  /** Original browser input. Pi's runtime user entry may include its internal workspace prompt. */
  userText?: string;
  userEntryId?: string;
  assistantEntryIds: string[];
};

type FeedbackEntryData = {
  messageId: string;
  feedback: AgentFeedback | null;
};

type MessageEntry = SessionMessageEntry;

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === 'message';
}

function isAssistantMessage(entry: SessionEntry): entry is MessageEntry & { message: AssistantMessage } {
  return isMessageEntry(entry) && entry.message.role === 'assistant';
}

function isUserMessage(entry: SessionEntry): entry is MessageEntry & { message: UserMessage } {
  return isMessageEntry(entry) && entry.message.role === 'user';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block): block is { type: 'text'; text: string } => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')).map((block) => block.text).join('');
}

/**
 * Older Pi turns stored the augmented workspace prompt as the user message.
 * Keep those sessions readable while new turns persist the original input in
 * the Web-only custom entry above.
 */
function displayUserText(text: string, originalText?: string): string {
  const explicit = originalText?.trim();
  if (explicit) return explicit;
  const marker = '\n\n这是一个 Pi Agent 验证工作台。项目资源目录摘要如下';
  const markerIndex = text.indexOf(marker);
  return markerIndex >= 0 ? text.slice(0, markerIndex).trimEnd() : text;
}

function thinkingFromAssistant(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return '';
  return message.content.filter((block): block is { type: 'thinking'; thinking: string } => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'thinking' && typeof (block as { thinking?: unknown }).thinking === 'string')).map((block) => block.thinking).join('');
}

function toolCallsFromAssistant(message: AssistantMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block): block is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall' && typeof (block as { name?: unknown }).name === 'string')).map((block) => block.name);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function responseWithLegacyMetrics(response: AgentChatResponse, turn: number): AgentChatResponse {
  if (response.metrics) return response;
  const toolCallCount = response.decision?.toolCalls?.length ?? 0;
  return {
    ...response,
    metrics: {
      turn: Math.max(1, turn),
      executionRounds: Math.max(1, toolCallCount + 1),
      startedAt: response.createdAt,
      completedAt: response.createdAt,
      durationMs: response.latencyMs ?? 0,
      eventCount: response.events?.length ?? 0,
      toolCallCount,
      inputChars: 0,
      outputChars: response.answer?.length ?? 0,
      thinkingChars: 0,
      tokenUsage: { input: 0, output: 0, total: 0, source: 'unavailable' },
    },
  };
}

function parseTurnEntry(entry: SessionEntry): TurnEntryData | undefined {
  if (entry.type !== 'custom' || entry.customType !== PI_WORKBENCH_TURN_ENTRY || !entry.data || typeof entry.data !== 'object') return undefined;
  const data = entry.data as Partial<TurnEntryData>;
  if (typeof data.turnId !== 'string' || !data.response || typeof data.response !== 'object') return undefined;
  return {
    turnId: data.turnId,
    response: responseWithLegacyMetrics(data.response as AgentChatResponse, 1),
    userText: typeof data.userText === 'string' ? data.userText : undefined,
    userEntryId: typeof data.userEntryId === 'string' ? data.userEntryId : undefined,
    assistantEntryIds: Array.isArray(data.assistantEntryIds) ? data.assistantEntryIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

function parseFeedbackEntry(entry: SessionEntry): FeedbackEntryData | undefined {
  if (entry.type !== 'custom' || entry.customType !== PI_WORKBENCH_FEEDBACK_ENTRY || !entry.data || typeof entry.data !== 'object') return undefined;
  const data = entry.data as Partial<FeedbackEntryData>;
  if (typeof data.messageId !== 'string' || (data.feedback !== 'like' && data.feedback !== 'dislike' && data.feedback !== null)) return undefined;
  return { messageId: data.messageId, feedback: data.feedback };
}

function latestTurnEntry(entries: SessionEntry[], turnId: string): TurnEntryData | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const data = parseTurnEntry(entries[index]!);
    if (data?.turnId === turnId) return data;
  }
  return undefined;
}

function createFallbackAssistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'pi-workbench',
    provider: 'local-fallback',
    model: 'local-fallback',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function createFallbackUserMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function responseFromPiMessage(sessionId: string, userText: string, userTimestamp: number, assistant: AssistantMessage, turn: number, thinkingText: string, toolCalls: string[]): AgentChatResponse {
  const usage = assistant.usage;
  const hasUsage = isFiniteNumber(usage?.input) && isFiniteNumber(usage?.output) && isFiniteNumber(usage?.totalTokens);
  const startedAt = new Date(userTimestamp).toISOString();
  const completedAt = new Date(assistant.timestamp).toISOString();
  const durationMs = Math.max(0, assistant.timestamp - userTimestamp);
  return {
    answer: textFromContent(assistant.content),
    source: 'pi-coding-agent',
    sessionId,
    route: 'workspace',
    decision: { decidedBy: 'pi', toolCalls },
    sources: [],
    resources: [],
    events: [],
    tools: { enabled: ['read', 'search_knowledge'], policy: 'read-only' },
    model: { enabled: true, providerConfigured: true, provider: assistant.provider, model: assistant.model, thinkingLevel: undefined },
    metrics: {
      turn: Math.max(1, turn),
      executionRounds: Math.max(1, toolCalls.length + 1),
      startedAt,
      completedAt,
      durationMs,
      eventCount: 0,
      toolCallCount: toolCalls.length,
      inputChars: userText.length,
      outputChars: textFromContent(assistant.content).length,
      thinkingChars: thinkingText.length,
      tokenUsage: hasUsage ? { input: usage.input, output: usage.output, total: usage.totalTokens, source: 'provider' } : { input: 0, output: 0, total: 0, source: 'unavailable' },
    },
    latencyMs: durationMs,
    createdAt: completedAt,
  };
}

function responseWithSessionUsage(response: AgentChatResponse, userText: string, assistant: AssistantMessage, thinkingText: string): AgentChatResponse {
  const usage = assistant.usage;
  if (!isFiniteNumber(usage?.input) || !isFiniteNumber(usage?.output) || !isFiniteNumber(usage?.totalTokens)) return response;
  return {
    ...response,
    metrics: {
      ...response.metrics,
      inputChars: userText.length,
      outputChars: textFromContent(assistant.content).length,
      thinkingChars: thinkingText.length,
      tokenUsage: { input: usage.input, output: usage.output, total: usage.totalTokens, source: 'provider' },
    },
  };
}

function projectEntries(sessionId: string, entries: SessionEntry[]): AgentSessionMessage[] {
  const turnEntries = entries.map(parseTurnEntry).filter((entry): entry is TurnEntryData => Boolean(entry));
  const turnByUser = new Map(turnEntries.filter((entry) => entry.userEntryId).map((entry) => [entry.userEntryId!, entry]));
  const turnByAssistant = new Map(turnEntries.flatMap((entry) => entry.assistantEntryIds.map((id) => [id, entry] as const)));
  const feedbackByMessage = new Map<string, AgentFeedback | null>();
  for (const entry of entries) {
    const data = parseFeedbackEntry(entry);
    if (data) feedbackByMessage.set(data.messageId, data.feedback);
  }

  const messages: AgentSessionMessage[] = [];
  let turnNumber = 0;
  let current: { userEntryId: string; userText: string; userTimestamp: number; assistantEntryIds: string[]; answer: string; thinking: string; assistant?: AssistantMessage } | undefined;
  const flush = () => {
    if (!current) return;
    const active = current;
    const metadata = turnByUser.get(active.userEntryId) ?? active.assistantEntryIds.map((id) => turnByAssistant.get(id)).find((entry): entry is TurnEntryData => Boolean(entry));
    const turnId = metadata?.turnId ?? `turn_${current.userEntryId}`;
    const userText = displayUserText(active.userText, metadata?.userText);
    messages.push({ id: active.userEntryId, kind: 'user', text: userText, turnId });
    if (active.thinking) messages.push({ id: `thinking_${active.userEntryId}`, kind: 'thinking', turnId, text: active.thinking, status: 'complete' });
    if (active.answer || metadata?.response || active.assistant) {
      const assistantId = metadata?.assistantEntryIds.at(-1) ?? active.assistantEntryIds.at(-1) ?? `assistant_${active.userEntryId}`;
      const toolCalls = active.assistant ? toolCallsFromAssistant(active.assistant) : [];
      const response = metadata?.response ? responseWithLegacyMetrics(metadata.response, turnNumber) : active.assistant ? responseFromPiMessage(sessionId, userText, active.userTimestamp, active.assistant, turnNumber, active.thinking, toolCalls) : undefined;
      const feedback = feedbackByMessage.get(assistantId);
      if (response) messages.push({ id: assistantId, kind: 'assistant', turnId, text: active.answer || response.answer, response, ...(feedback ? { feedback } : {}) });
    }
    current = undefined;
  };

  for (const entry of entries) {
    if (isUserMessage(entry)) {
      flush();
      turnNumber += 1;
      current = { userEntryId: entry.id, userText: textFromContent(entry.message.content), userTimestamp: entry.message.timestamp, assistantEntryIds: [], answer: '', thinking: '' };
      continue;
    }
    if (!isAssistantMessage(entry)) continue;
    if (!current) {
      turnNumber += 1;
      current = { userEntryId: `unknown_${entry.id}`, userText: '', userTimestamp: entry.message.timestamp, assistantEntryIds: [], answer: '', thinking: '' };
    }
    current.assistantEntryIds.push(entry.id);
    current.answer += textFromContent(entry.message.content);
    current.thinking += thinkingFromAssistant(entry.message);
    current.assistant = entry.message;
  }
  flush();
  return messages;
}

export function getPiSessionDir(cwd = getProjectRoot()): string {
  const configured = process.env.PI_SESSION_DIR?.trim();
  return configured ? resolve(cwd, configured) : resolve(cwd, '.pi/sessions');
}

export interface PiFileSessionStoreOptions {
  cwd?: string;
  sessionDir?: string;
}

/**
 * File-backed Web session projection built on Pi's official JSONL SessionManager.
 * The JSONL file remains the source of truth; custom entries carry Web-only
 * response metadata and feedback without entering the LLM context.
 */
export class PiFileSessionStore {
  readonly cwd: string;
  readonly sessionDir: string;

  constructor(options: PiFileSessionStoreOptions = {}) {
    this.cwd = resolve(options.cwd ?? getProjectRoot());
    this.sessionDir = resolve(this.cwd, options.sessionDir ?? getPiSessionDir(this.cwd));
  }

  async listSessions(): Promise<AgentSessionRecord[]> {
    const infos = await this.sortedInfos();
    return Promise.all(infos.map((info, index) => this.recordFromInfo(info, index)));
  }

  async createSession(id = `session_${randomUUID().slice(0, 8)}`): Promise<AgentSessionRecord> {
    const existing = await this.findInfo(id);
    if (existing) return this.recordFromInfo(existing, await this.positionOf(id));
    const manager = SessionManager.create(this.cwd, this.sessionDir, { id });
    const file = manager.getSessionFile();
    const header = manager.getHeader();
    if (!file || !header) throw new Error('Pi session file could not be initialized');
    mkdirSync(this.sessionDir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
    return this.recordFromInfo({ path: file, id: header.id, cwd: header.cwd, created: new Date(header.timestamp), modified: new Date(header.timestamp), messageCount: 0, firstMessage: '(no messages)', allMessagesText: '' }, await this.positionOf(id));
  }

  async ensureSession(id: string): Promise<AgentSessionRecord> {
    return (await this.getSession(id)) ?? this.createSession(id);
  }

  async getSession(id: string): Promise<AgentSessionRecord | undefined> {
    const info = await this.findInfo(id);
    return info ? this.recordFromInfo(info, await this.positionOf(id)) : undefined;
  }

  async appendFallbackTurn(sessionId: string, text: string, turnId: string, response: AgentChatResponse): Promise<AgentSessionRecord> {
    const manager = await this.openOrCreate(sessionId);
    if (!latestTurnEntry(manager.getEntries(), turnId)) {
      const latestUser = [...manager.getEntries()].reverse().find(isUserMessage);
      const userEntryId = latestUser && textFromContent(latestUser.message.content) === text ? latestUser.id : manager.appendMessage(createFallbackUserMessage(text) as PersistedMessage);
      const assistantEntryId = manager.appendMessage(createFallbackAssistantMessage(response.answer) as PersistedMessage);
      manager.appendCustomEntry(PI_WORKBENCH_TURN_ENTRY, { turnId, response, userEntryId, assistantEntryIds: [assistantEntryId] } satisfies TurnEntryData);
    }
    return (await this.getSession(sessionId))!;
  }

  async appendTurnMetadata(sessionId: string, turnId: string, response: AgentChatResponse, userText?: string): Promise<AgentSessionRecord> {
    const manager = await this.openOrCreate(sessionId);
    const entries = manager.getEntries();
    if (!latestTurnEntry(entries, turnId)) {
      const latestUserIndex = entries.map((entry, index) => ({ entry, index })).reverse().find(({ entry }) => isUserMessage(entry));
      const userEntryId = latestUserIndex && isUserMessage(latestUserIndex.entry) ? latestUserIndex.entry.id : undefined;
      const assistantEntryIds = latestUserIndex ? entries.slice(latestUserIndex.index + 1).filter(isAssistantMessage).map((entry) => entry.id) : [];
      const latestAssistant = assistantEntryIds.length ? entries.find((entry) => entry.type === 'message' && entry.id === assistantEntryIds.at(-1)) : undefined;
      const persistedUserText = userText?.trim() || (latestUserIndex && isUserMessage(latestUserIndex.entry) ? displayUserText(textFromContent(latestUserIndex.entry.message.content)) : '');
      const persistedResponse = latestAssistant && isAssistantMessage(latestAssistant) ? responseWithSessionUsage(response, persistedUserText, latestAssistant.message, thinkingFromAssistant(latestAssistant.message)) : response;
      manager.appendCustomEntry(PI_WORKBENCH_TURN_ENTRY, { turnId, response: persistedResponse, userText, userEntryId, assistantEntryIds } satisfies TurnEntryData);
    }
    return (await this.getSession(sessionId))!;
  }

  async setMessageFeedback(sessionId: string, messageId: string, feedback: AgentFeedback | null): Promise<AgentSessionRecord | undefined> {
    const manager = await this.openOrCreate(sessionId);
    if (!manager.getEntries().some((entry) => isAssistantMessage(entry) && entry.id === messageId)) return undefined;
    manager.appendCustomEntry(PI_WORKBENCH_FEEDBACK_ENTRY, { messageId, feedback } satisfies FeedbackEntryData);
    return this.getSession(sessionId);
  }

  close(): void {
    // SessionManager owns append-only files and has no close operation.
  }

  private async sortedInfos(): Promise<SessionInfo[]> {
    const infos = await SessionManager.list(this.cwd, this.sessionDir);
    return infos.sort((left, right) => left.created.getTime() - right.created.getTime() || left.path.localeCompare(right.path));
  }

  private async findInfo(id: string): Promise<SessionInfo | undefined> {
    return (await this.sortedInfos()).find((info) => info.id === id);
  }

  private async positionOf(id: string): Promise<number> {
    const infos = await this.sortedInfos();
    return Math.max(0, infos.findIndex((info) => info.id === id));
  }

  private async openOrCreate(sessionId: string): Promise<SessionManager> {
    const info = await this.findInfo(sessionId);
    return info ? SessionManager.open(info.path, this.sessionDir, this.cwd) : SessionManager.create(this.cwd, this.sessionDir, { id: sessionId });
  }

  private async recordFromInfo(info: SessionInfo, position: number): Promise<AgentSessionRecord> {
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    return { id: info.id, position, createdAt: info.created.toISOString(), updatedAt: info.modified.toISOString(), messages: projectEntries(info.id, manager.getEntries()) };
  }
}

export const piFileSessionStore = new PiFileSessionStore();

// Kept as a narrow type-only reference so the store stays explicitly tied to
// Pi's event/session boundary rather than becoming a generic JSON database.
export type PiSessionEvent = AgentSessionEvent;
