import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  SessionManager,
  type AgentSessionEvent,
  type SessionEntry,
  type SessionInfo,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import type { AgentFeedback, DigitalHumanChatResponse, DigitalHumanId, DigitalHumanSessionMessage, DigitalHumanSessionRecord, AgentTokenUsage } from '@pi-workbench/contracts';

export const PI_WORKBENCH_TURN_ENTRY = 'pi-workbench.turn';
export const PI_WORKBENCH_FEEDBACK_ENTRY = 'pi-workbench.feedback';
export const PI_WORKBENCH_SESSION_TITLE_ENTRY = 'pi-workbench.session-title';
export const PI_WORKBENCH_DIGITAL_HUMAN_ENTRY = 'pi-workbench.digital-human';

function getProjectRoot(): string {
  if (existsSync(resolve(process.cwd(), '.pi'))) return process.cwd();
  return resolve(dirname(new URL(import.meta.url).pathname), '../../..');
}

type PersistedMessage = Parameters<SessionManager['appendMessage']>[0];
type AssistantMessage = Extract<PersistedMessage, { role: 'assistant' }>;
type UserMessage = Extract<PersistedMessage, { role: 'user' }>;

type TurnEntryData = {
  turnId: string;
  response: DigitalHumanChatResponse;
  userText: string;
  userEntryId: string;
  assistantEntryIds: string[];
};

type FeedbackEntryData = {
  messageId: string;
  feedback: AgentFeedback | null;
};

type SessionTitleEntryData = {
  title: string;
};

type DigitalHumanEntryData = {
  digitalHumanId: DigitalHumanId;
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

function thinkingFromAssistant(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return '';
  return message.content.filter((block): block is { type: 'thinking'; thinking: string } => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'thinking' && typeof (block as { thinking?: unknown }).thinking === 'string')).map((block) => block.thinking).join('');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function usageFromPersisted(usage: unknown, source: AgentTokenUsage['source'] = 'provider'): AgentTokenUsage {
  const value = usage && typeof usage === 'object' ? usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cacheWrite1h?: unknown; reasoning?: unknown; totalTokens?: unknown; cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown } } : undefined;
  const input = isFiniteNumber(value?.input) ? value.input : 0;
  const output = isFiniteNumber(value?.output) ? value.output : 0;
  const cacheRead = isFiniteNumber(value?.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = isFiniteNumber(value?.cacheWrite) ? value.cacheWrite : 0;
  const total = isFiniteNumber(value?.totalTokens) ? value.totalTokens : input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(isFiniteNumber(value?.cacheWrite1h) ? { cacheWrite1h: value.cacheWrite1h } : {}),
    ...(isFiniteNumber(value?.reasoning) ? { reasoning: value.reasoning } : {}),
    total,
    cost: {
      input: isFiniteNumber(value?.cost?.input) ? value.cost.input : 0,
      output: isFiniteNumber(value?.cost?.output) ? value.cost.output : 0,
      cacheRead: isFiniteNumber(value?.cost?.cacheRead) ? value.cost.cacheRead : 0,
      cacheWrite: isFiniteNumber(value?.cost?.cacheWrite) ? value.cost.cacheWrite : 0,
      total: isFiniteNumber(value?.cost?.total) ? value.cost.total : 0,
    },
    source,
  };
}

function parseTurnEntry(entry: SessionEntry): TurnEntryData | undefined {
  if (entry.type !== 'custom' || entry.customType !== PI_WORKBENCH_TURN_ENTRY || !entry.data || typeof entry.data !== 'object') return undefined;
  const data = entry.data as Partial<TurnEntryData>;
  if (typeof data.turnId !== 'string' || !data.response || typeof data.response !== 'object' || typeof data.userText !== 'string' || typeof data.userEntryId !== 'string' || !Array.isArray(data.assistantEntryIds)) return undefined;
  return {
    turnId: data.turnId,
    response: data.response as DigitalHumanChatResponse,
    userText: data.userText,
    userEntryId: data.userEntryId,
    assistantEntryIds: Array.isArray(data.assistantEntryIds) ? data.assistantEntryIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

function parseFeedbackEntry(entry: SessionEntry): FeedbackEntryData | undefined {
  if (entry.type !== 'custom' || entry.customType !== PI_WORKBENCH_FEEDBACK_ENTRY || !entry.data || typeof entry.data !== 'object') return undefined;
  const data = entry.data as Partial<FeedbackEntryData>;
  if (typeof data.messageId !== 'string' || (data.feedback !== 'like' && data.feedback !== 'dislike' && data.feedback !== null)) return undefined;
  return { messageId: data.messageId, feedback: data.feedback };
}

function sessionTitleFromEntries(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== 'custom' || entry.customType !== PI_WORKBENCH_SESSION_TITLE_ENTRY || !entry.data || typeof entry.data !== 'object') continue;
    const title = (entry.data as Partial<SessionTitleEntryData>).title?.trim();
    if (title) return title;
  }
  return undefined;
}

export function assertSessionDigitalHumanBinding(entries: SessionEntry[], expectedDigitalHumanId?: DigitalHumanId): DigitalHumanId {
  const bindings = entries.filter((item) => item.type === 'custom' && item.customType === PI_WORKBENCH_DIGITAL_HUMAN_ENTRY && item.data && typeof item.data === 'object');
  if (bindings.length !== 1) throw new Error(bindings.length ? 'DIGITAL_HUMAN_BINDING_CONFLICT' : 'DIGITAL_HUMAN_BINDING_MISSING');
  const entry = bindings[0]!;
  const digitalHumanId = entry.type === 'custom' ? (entry.data as Partial<DigitalHumanEntryData>).digitalHumanId : undefined;
  if (typeof digitalHumanId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(digitalHumanId)) throw new Error('DIGITAL_HUMAN_BINDING_INVALID');
  if (expectedDigitalHumanId && digitalHumanId !== expectedDigitalHumanId) throw new Error('DIGITAL_HUMAN_SESSION_MISMATCH');
  return digitalHumanId;
}

function latestTurnEntry(entries: SessionEntry[], turnId: string): TurnEntryData | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const data = parseTurnEntry(entries[index]!);
    if (data?.turnId === turnId) return data;
  }
  return undefined;
}

function responseWithSessionUsage(response: DigitalHumanChatResponse, userText: string, assistant: AssistantMessage, thinkingText: string): DigitalHumanChatResponse {
  const usage = assistant.usage;
  if (!isFiniteNumber(usage?.input) || !isFiniteNumber(usage?.output) || !isFiniteNumber(usage?.totalTokens)) return response;
  return {
    ...response,
    metrics: {
      ...response.metrics,
      inputChars: userText.length,
      outputChars: textFromContent(assistant.content).length,
      thinkingChars: thinkingText.length,
      tokenUsage: usageFromPersisted(usage),
    },
  };
}

function projectEntries(digitalHumanId: DigitalHumanId, entries: SessionEntry[]): DigitalHumanSessionMessage[] {
  const turnEntries = entries.map(parseTurnEntry).filter((entry): entry is TurnEntryData => Boolean(entry));
  const entriesById = new Map(entries.filter(isMessageEntry).map((entry) => [entry.id, entry]));
  const feedbackByMessage = new Map<string, AgentFeedback | null>();
  for (const entry of entries) {
    const data = parseFeedbackEntry(entry);
    if (data) feedbackByMessage.set(data.messageId, data.feedback);
  }

  const messages: DigitalHumanSessionMessage[] = [];
  for (const turn of turnEntries) {
    const userEntry = entriesById.get(turn.userEntryId);
    const assistantEntries = turn.assistantEntryIds.map((id) => entriesById.get(id)).filter((entry): entry is MessageEntry & { message: AssistantMessage } => Boolean(entry && isAssistantMessage(entry)));
    const assistantEntry = assistantEntries.at(-1);
    if (!userEntry || !isUserMessage(userEntry) || !assistantEntry) throw new Error(`数字人会话 ${turn.turnId} 缺少完整消息记录`);
    const assistantId = assistantEntry.id;
    const assistantCreatedAt = new Date(assistantEntry.message.timestamp).toISOString();
    const thinking = assistantEntries.map((entry) => thinkingFromAssistant(entry.message)).join('');
    const feedback = feedbackByMessage.get(assistantId);
    const response = { ...turn.response, digitalHumanId };
    messages.push({ id: userEntry.id, kind: 'user', text: turn.userText, turnId: turn.turnId, createdAt: new Date(userEntry.message.timestamp).toISOString() });
    if (thinking) messages.push({ id: `thinking_${userEntry.id}`, kind: 'thinking', turnId: turn.turnId, text: thinking, status: 'complete', createdAt: assistantCreatedAt });
    messages.push({ id: assistantId, kind: 'assistant', turnId: turn.turnId, text: response.answer, response, createdAt: assistantCreatedAt, persisted: true, ...(feedback !== undefined ? { feedback } : {}) });
  }
  return messages;
}

export function getPiSessionDir(cwd = getProjectRoot()): string {
  const configured = process.env.PI_SESSION_DIR?.trim();
  if (configured) return resolve(cwd, configured);
  try {
    const settings = JSON.parse(readFileSync(resolve(cwd, '.pi/settings.json'), 'utf8')) as { sessionDir?: unknown };
    if (typeof settings.sessionDir === 'string' && settings.sessionDir.trim()) return resolve(cwd, settings.sessionDir.trim());
  } catch {
    // The official default remains .pi/sessions when settings are absent or invalid.
  }
  return resolve(cwd, '.pi/sessions');
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

  async listSessions(digitalHumanId?: DigitalHumanId): Promise<DigitalHumanSessionRecord[]> {
    const infos = await this.sortedInfos();
    const records = await Promise.all(infos.map((info, index) => this.recordFromInfo(info, index)));
    const defined = records.filter((record): record is DigitalHumanSessionRecord => Boolean(record));
    return digitalHumanId ? defined.filter((record) => record.digitalHumanId === digitalHumanId) : defined;
  }

  async createSession(digitalHumanId: DigitalHumanId, id = `session_${randomUUID().slice(0, 8)}`): Promise<DigitalHumanSessionRecord> {
    const existing = await this.findInfo(id);
    if (existing) {
      const record = await this.recordFromInfo(existing, await this.positionOf(id));
      if (!record || record.digitalHumanId !== digitalHumanId) throw new Error('DIGITAL_HUMAN_SESSION_MISMATCH');
      return record;
    }
    mkdirSync(this.sessionDir, { recursive: true });
    const lockPath = resolve(this.sessionDir, `.create-${encodeURIComponent(id)}.lock`);
    try {
      mkdirSync(lockPath);
    } catch {
      throw new Error('DIGITAL_HUMAN_SESSION_CREATE_CONFLICT');
    }
    try {
      const createdByPeer = await this.findInfo(id);
      if (createdByPeer) {
        const record = await this.recordFromInfo(createdByPeer, await this.positionOf(id));
        if (!record || record.digitalHumanId !== digitalHumanId) throw new Error('DIGITAL_HUMAN_SESSION_MISMATCH');
        return record;
      }
      const manager = SessionManager.create(this.cwd, this.sessionDir, { id });
      const file = manager.getSessionFile();
      const header = manager.getHeader();
      if (!file || !header) throw new Error('Pi session file could not be initialized');
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
      SessionManager.open(file, this.sessionDir, this.cwd).appendCustomEntry(PI_WORKBENCH_DIGITAL_HUMAN_ENTRY, { digitalHumanId } satisfies DigitalHumanEntryData);
      return (await this.recordFromInfo({ path: file, id: header.id, cwd: header.cwd, created: new Date(header.timestamp), modified: new Date(header.timestamp), messageCount: 0, firstMessage: '(no messages)', allMessagesText: '' }, await this.positionOf(id)))!;
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  async ensureSession(id: string, digitalHumanId: DigitalHumanId): Promise<DigitalHumanSessionRecord> {
    const existing = await this.getSession(id);
    if (existing && existing.digitalHumanId !== digitalHumanId) throw new Error('DIGITAL_HUMAN_SESSION_MISMATCH');
    return existing ?? this.createSession(digitalHumanId, id);
  }

  async getSession(id: string, expectedDigitalHumanId?: DigitalHumanId): Promise<DigitalHumanSessionRecord | undefined> {
    const info = await this.findInfo(id);
    const record = info ? await this.recordFromInfo(info, await this.positionOf(id)) : undefined;
    if (record && expectedDigitalHumanId && record.digitalHumanId !== expectedDigitalHumanId) throw new Error('DIGITAL_HUMAN_SESSION_MISMATCH');
    return record;
  }

  async appendTurnMetadata(sessionId: string, turnId: string, response: DigitalHumanChatResponse, userText: string): Promise<DigitalHumanSessionRecord> {
    const manager = await this.openSession(sessionId, response.digitalHumanId);
    const entries = manager.getEntries();
    if (!latestTurnEntry(entries, turnId)) {
      const latestUserIndex = entries.map((entry, index) => ({ entry, index })).reverse().find(({ entry }) => isUserMessage(entry));
      const userEntryId = latestUserIndex && isUserMessage(latestUserIndex.entry) ? latestUserIndex.entry.id : undefined;
      const assistantEntryIds = latestUserIndex ? entries.slice(latestUserIndex.index + 1).filter(isAssistantMessage).map((entry) => entry.id) : [];
      const latestAssistant = assistantEntryIds.length ? entries.find((entry) => entry.type === 'message' && entry.id === assistantEntryIds.at(-1)) : undefined;
      const persistedUserText = userText.trim();
      if (!userEntryId || !assistantEntryIds.length || !persistedUserText) throw new Error('数字人 turn 缺少持久化消息');
      const persistedResponse = latestAssistant && isAssistantMessage(latestAssistant) ? responseWithSessionUsage(response, persistedUserText, latestAssistant.message, thinkingFromAssistant(latestAssistant.message)) : response;
      manager.appendCustomEntry(PI_WORKBENCH_TURN_ENTRY, { turnId, response: persistedResponse, userText: persistedUserText, userEntryId, assistantEntryIds } satisfies TurnEntryData);
    }
    return (await this.getSession(sessionId))!;
  }

  async setMessageFeedback(sessionId: string, digitalHumanId: DigitalHumanId, messageId: string, feedback: AgentFeedback | null): Promise<DigitalHumanSessionRecord | undefined> {
    const manager = await this.openSession(sessionId, digitalHumanId);
    if (!manager.getEntries().some((entry) => isAssistantMessage(entry) && entry.id === messageId)) return undefined;
    manager.appendCustomEntry(PI_WORKBENCH_FEEDBACK_ENTRY, { messageId, feedback } satisfies FeedbackEntryData);
    return this.getSession(sessionId);
  }

  async setSessionTitle(sessionId: string, digitalHumanId: DigitalHumanId, title: string): Promise<DigitalHumanSessionRecord | undefined> {
    const info = await this.findInfo(sessionId);
    if (!info) return undefined;
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionDigitalHumanBinding(manager.getEntries(), digitalHumanId);
    manager.appendCustomEntry(PI_WORKBENCH_SESSION_TITLE_ENTRY, { title: title.trim() } satisfies SessionTitleEntryData);
    return this.getSession(sessionId);
  }

  async deleteSession(sessionId: string, digitalHumanId: DigitalHumanId): Promise<boolean> {
    const info = await this.findInfo(sessionId);
    if (!info) return false;
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionDigitalHumanBinding(manager.getEntries(), digitalHumanId);
    rmSync(info.path);
    return true;
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

  private async openSession(sessionId: string, expectedDigitalHumanId?: DigitalHumanId): Promise<SessionManager> {
    const info = await this.findInfo(sessionId);
    if (!info) throw new Error('DIGITAL_HUMAN_SESSION_NOT_FOUND');
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionDigitalHumanBinding(manager.getEntries(), expectedDigitalHumanId);
    return manager;
  }

  private async recordFromInfo(info: SessionInfo, position: number): Promise<DigitalHumanSessionRecord | undefined> {
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    const entries = manager.getEntries();
    const title = sessionTitleFromEntries(entries);
    let digitalHumanId: DigitalHumanId;
    try {
      digitalHumanId = assertSessionDigitalHumanBinding(entries);
    } catch {
      return undefined;
    }
    return { id: info.id, digitalHumanId, ...(title ? { title } : {}), position, createdAt: info.created.toISOString(), updatedAt: info.modified.toISOString(), messages: projectEntries(digitalHumanId, entries) };
  }
}

export const piFileSessionStore = new PiFileSessionStore();

// Kept as a narrow type-only reference so the store stays explicitly tied to
// Pi's event/session boundary rather than becoming a generic JSON database.
export type PiSessionEvent = AgentSessionEvent;
