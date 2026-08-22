import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager, type SessionEntry, type SessionHeader, type SessionInfo } from '@earendil-works/pi-coding-agent';
import { AGENT_ID_PATTERN, type SessionMessage, type SessionSummary } from '@pi-workbench/contracts';

export const PI_WORKBENCH_AGENT_ENTRY = 'pi-workbench.agent';
export const PI_WORKBENCH_SESSION_TITLE_ENTRY = 'pi-workbench.session-title';

const AGENT_ID_REGEX = new RegExp(AGENT_ID_PATTERN);

type AgentEntryData = { agentId: string };
type SessionTitleEntryData = { title: string };

/** Session/binding contract violations; `code` doubles as the message so existing callers keep working. */
export type SessionBindingErrorCode =
  | 'AGENT_BINDING_CONFLICT'
  | 'AGENT_BINDING_MISSING'
  | 'AGENT_BINDING_INVALID'
  | 'AGENT_SESSION_MISMATCH'
  | 'AGENT_SESSION_NOT_FOUND';

export class SessionBindingError extends Error {
  readonly code: SessionBindingErrorCode;
  constructor(code: SessionBindingErrorCode) {
    super(code);
    this.name = 'SessionBindingError';
    this.code = code;
  }
}

export function getPiSessionDir(cwd: string): string {
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

/**
 * Creates a persisted JSONL session file and stamps it with the immutable agent
 * binding. SessionManager only persists once the file carries its header, so the
 * header is written first ('wx' fails on a stale file) and the binding entry is
 * appended through a reopened manager. Shared by AgentSessionStore and the Pi
 * runtime factory in index.ts.
 */
export function initializeSessionFile(options: { cwd: string; sessionDir: string; agentId: string; id?: string }): { manager: SessionManager; file: string; header: SessionHeader } {
  const { cwd, sessionDir, agentId, id } = options;
  mkdirSync(sessionDir, { recursive: true });
  const created = SessionManager.create(cwd, sessionDir, id ? { id } : undefined);
  const file = created.getSessionFile();
  const header = created.getHeader();
  if (!file || !header) throw new Error('Pi session file could not be initialized');
  if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
  const manager = SessionManager.open(file, sessionDir, cwd);
  manager.appendCustomEntry(PI_WORKBENCH_AGENT_ENTRY, { agentId } satisfies AgentEntryData);
  return { manager, file, header };
}

/**
 * Every persisted Web session carries exactly one immutable agent binding as a
 * JSONL custom entry. Sessions without a binding are invalid and are never
 * migrated or inferred; a mismatched binding is rejected.
 */
export function assertSessionAgentBinding(entries: SessionEntry[], expectedAgentId?: string): string {
  const bindings = entries.filter((item) => item.type === 'custom' && item.customType === PI_WORKBENCH_AGENT_ENTRY && item.data && typeof item.data === 'object');
  if (bindings.length !== 1) throw new SessionBindingError(bindings.length ? 'AGENT_BINDING_CONFLICT' : 'AGENT_BINDING_MISSING');
  const entry = bindings[0]!;
  const agentId = entry.type === 'custom' ? (entry.data as Partial<AgentEntryData>).agentId : undefined;
  if (typeof agentId !== 'string' || !AGENT_ID_REGEX.test(agentId)) throw new SessionBindingError('AGENT_BINDING_INVALID');
  if (expectedAgentId && agentId !== expectedAgentId) throw new SessionBindingError('AGENT_SESSION_MISMATCH');
  return agentId;
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

function questionCountFromEntries(entries: SessionEntry[]): number {
  return entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user').length;
}

type SessionAttention = Pick<SessionSummary, 'needsAttention' | 'attentionReason' | 'attentionDetail'>;

/**
 * Attention is derived from the last assistant message persisted in the JSONL
 * session: Pi records stopReason "error" / "aborted" (plus errorMessage) when a
 * run fails or is interrupted. A later successful run clears the flag.
 */
function attentionFromEntries(entries: SessionEntry[]): SessionAttention {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const message = entry.message as { stopReason?: unknown; errorMessage?: unknown };
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return {
        needsAttention: true,
        attentionReason: message.stopReason,
        ...(typeof message.errorMessage === 'string' && message.errorMessage ? { attentionDetail: message.errorMessage } : {}),
      };
    }
    return { needsAttention: false };
  }
  return { needsAttention: false };
}

function textFromContent(content: unknown, blockType: string, field: string): string {
  if (typeof content === 'string') return blockType === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === blockType))
    .map((block) => (typeof block[field] === 'string' ? (block[field] as string) : ''))
    .join('');
}

/** Maps a Pi JSONL message entry onto the replay contract; tool calls are pure-chat absent. */
function sessionMessageFromEntry(id: string, timestamp: string, message: unknown): SessionMessage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as {
    role?: unknown;
    content?: unknown;
    usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (record.role !== 'user' && record.role !== 'assistant') return undefined;
  const usage =
    record.usage && typeof record.usage.input === 'number' && typeof record.usage.output === 'number'
      ? {
          input: record.usage.input,
          output: record.usage.output,
          total: typeof record.usage.totalTokens === 'number' ? record.usage.totalTokens : record.usage.input + record.usage.output,
        }
      : undefined;
  const thinking = textFromContent(record.content, 'thinking', 'thinking');
  return {
    id,
    role: record.role,
    content: textFromContent(record.content, 'text', 'text'),
    ...(thinking ? { thinking } : {}),
    ...(usage && usage.total > 0 ? { usage } : {}),
    ...(typeof record.stopReason === 'string' ? { stopReason: record.stopReason } : {}),
    ...(typeof record.errorMessage === 'string' && record.errorMessage ? { errorMessage: record.errorMessage } : {}),
    timestamp,
  };
}

export interface AgentSessionStoreOptions {
  cwd: string;
  sessionDir?: string;
}

/**
 * File-backed Web session projection built on Pi's official JSONL SessionManager.
 * The JSONL file remains the source of truth; custom entries carry the agent
 * binding and the user-chosen title without entering the LLM context.
 */
export class AgentSessionStore {
  readonly cwd: string;
  readonly sessionDir: string;
  /**
   * JSONL 解析结果按 path+mtimeMs 缓存：listSessions/recordFromInfo 不再为每个会话文件
   * 重复 open+parse。进行中的会话会让文件 mtime 变化，天然触发重解析；无 watch 需求。
   */
  private readonly entriesCache = new Map<string, { mtimeMs: number; entries: SessionEntry[] }>();

  constructor(options: AgentSessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionDir = resolve(this.cwd, options.sessionDir ?? getPiSessionDir(this.cwd));
  }

  async listSessions(agentId?: string): Promise<SessionSummary[]> {
    const infos = await this.sortedInfos();
    // 清掉已删除会话的缓存条目，避免 map 随删除操作无限增长。
    const livePaths = new Set(infos.map((info) => info.path));
    for (const key of this.entriesCache.keys()) {
      if (!livePaths.has(key)) this.entriesCache.delete(key);
    }
    const records = await Promise.all(infos.map((info) => this.recordFromInfo(info)));
    const defined = records.filter((record): record is SessionSummary => Boolean(record));
    return agentId ? defined.filter((record) => record.agentId === agentId) : defined;
  }

  async createSession(agentId: string, id = `session_${randomUUID().slice(0, 8)}`): Promise<SessionSummary> {
    const existing = await this.findInfo(id);
    if (existing) {
      const record = await this.recordFromInfo(existing);
      if (!record || record.agentId !== agentId) throw new SessionBindingError('AGENT_SESSION_MISMATCH');
      return record;
    }
    const { file, header } = initializeSessionFile({ cwd: this.cwd, sessionDir: this.sessionDir, agentId, id });
    return (await this.recordFromInfo({ path: file, id: header.id, cwd: header.cwd, created: new Date(header.timestamp), modified: new Date(header.timestamp), messageCount: 0, firstMessage: '', allMessagesText: '' }))!;
  }

  /** Creates the session when absent; rejects reuse through another agent. */
  async ensureSession(id: string, agentId: string): Promise<SessionSummary> {
    const existing = await this.getSession(id);
    if (existing && existing.agentId !== agentId) throw new SessionBindingError('AGENT_SESSION_MISMATCH');
    return existing ?? this.createSession(agentId, id);
  }

  async getSession(id: string, expectedAgentId?: string): Promise<SessionSummary | undefined> {
    const info = await this.findInfo(id);
    const record = info ? await this.recordFromInfo(info) : undefined;
    if (record && expectedAgentId && record.agentId !== expectedAgentId) throw new SessionBindingError('AGENT_SESSION_MISMATCH');
    return record;
  }

  async renameSession(id: string, agentId: string, title: string): Promise<SessionSummary | undefined> {
    const manager = await this.openSession(id, agentId);
    manager.appendCustomEntry(PI_WORKBENCH_SESSION_TITLE_ENTRY, { title: title.trim() } satisfies SessionTitleEntryData);
    return this.getSession(id);
  }

  /** Replays the persisted messages of one session; the JSONL file stays the source of truth. */
  async listMessages(id: string, agentId: string): Promise<SessionMessage[]> {
    const manager = await this.openSession(id, agentId);
    const messages: SessionMessage[] = [];
    for (const entry of manager.getEntries()) {
      if (entry.type !== 'message') continue;
      const mapped = sessionMessageFromEntry(entry.id, entry.timestamp, entry.message);
      if (mapped) messages.push(mapped);
    }
    return messages;
  }

  async deleteSession(id: string, agentId: string): Promise<boolean> {
    const info = await this.findInfo(id);
    if (!info) return false;
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionAgentBinding(manager.getEntries(), agentId);
    rmSync(info.path);
    return true;
  }

  private async sortedInfos(): Promise<SessionInfo[]> {
    const infos = await SessionManager.list(this.cwd, this.sessionDir);
    return infos.sort((left, right) => left.created.getTime() - right.created.getTime() || left.path.localeCompare(right.path));
  }

  /**
   * id → SessionInfo 索引：SessionManager.list 会逐行扫完每个会话文件（buildSessionInfo
   * 统计 messageCount/firstMessage），findInfo 每次全量 list 代价过高。索引以目录签名
   * （mtimeMs + 条目数）失效：新增/删除/重命名文件会改变签名，文件内容追加不会——
   * 命中时再 stat 一次目标文件取新鲜 modified，created/firstMessage 本身不可变。
   */
  private idIndex: { signature: string; byId: Map<string, SessionInfo> } | undefined;

  private dirSignature(): string {
    try {
      return `${statSync(this.sessionDir).mtimeMs}:${readdirSync(this.sessionDir).length}`;
    } catch {
      return 'missing';
    }
  }

  private async findInfo(id: string): Promise<SessionInfo | undefined> {
    const signature = this.dirSignature();
    if (this.idIndex?.signature !== signature) {
      const byId = new Map<string, SessionInfo>();
      for (const info of await SessionManager.list(this.cwd, this.sessionDir)) byId.set(info.id, info);
      this.idIndex = { signature, byId };
    }
    const info = this.idIndex.byId.get(id);
    if (!info) return undefined;
    try {
      return { ...info, modified: statSync(info.path).mtime };
    } catch {
      // 索引与磁盘竞争（文件刚被删）：作废索引，按不存在处理。
      this.idIndex = undefined;
      return undefined;
    }
  }

  private async openSession(id: string, expectedAgentId?: string): Promise<SessionManager> {
    const info = await this.findInfo(id);
    if (!info) throw new SessionBindingError('AGENT_SESSION_NOT_FOUND');
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionAgentBinding(manager.getEntries(), expectedAgentId);
    return manager;
  }

  /** Parses one session JSONL once per file version; mtime changes force a re-parse. */
  private entriesFor(path: string): SessionEntry[] {
    const mtimeMs = statSync(path).mtimeMs;
    const cached = this.entriesCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
    const entries = SessionManager.open(path, this.sessionDir, this.cwd).getEntries();
    this.entriesCache.set(path, { mtimeMs, entries });
    return entries;
  }

  private async recordFromInfo(info: SessionInfo): Promise<SessionSummary | undefined> {
    const entries = this.entriesFor(info.path);
    let agentId: string;
    try {
      agentId = assertSessionAgentBinding(entries);
    } catch {
      return undefined;
    }
    const title = sessionTitleFromEntries(entries) ?? info.firstMessage.trim().slice(0, 40) ?? '';
    return {
      id: info.id,
      agentId,
      title: title || '新会话',
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      questionCount: questionCountFromEntries(entries),
      ...attentionFromEntries(entries),
    };
  }
}
