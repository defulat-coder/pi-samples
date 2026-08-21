import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager, type SessionEntry, type SessionInfo } from '@earendil-works/pi-coding-agent';
import type { SessionSummary } from '@pi-workbench/contracts';

export const PI_WORKBENCH_AGENT_ENTRY = 'pi-workbench.agent';
export const PI_WORKBENCH_SESSION_TITLE_ENTRY = 'pi-workbench.session-title';

type AgentEntryData = { agentId: string };
type SessionTitleEntryData = { title: string };

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
 * Every persisted Web session carries exactly one immutable agent binding as a
 * JSONL custom entry. Sessions without a binding are invalid and are never
 * migrated or inferred; a mismatched binding is rejected.
 */
export function assertSessionAgentBinding(entries: SessionEntry[], expectedAgentId?: string): string {
  const bindings = entries.filter((item) => item.type === 'custom' && item.customType === PI_WORKBENCH_AGENT_ENTRY && item.data && typeof item.data === 'object');
  if (bindings.length !== 1) throw new Error(bindings.length ? 'AGENT_BINDING_CONFLICT' : 'AGENT_BINDING_MISSING');
  const entry = bindings[0]!;
  const agentId = entry.type === 'custom' ? (entry.data as Partial<AgentEntryData>).agentId : undefined;
  if (typeof agentId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(agentId)) throw new Error('AGENT_BINDING_INVALID');
  if (expectedAgentId && agentId !== expectedAgentId) throw new Error('AGENT_SESSION_MISMATCH');
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

  constructor(options: AgentSessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionDir = resolve(this.cwd, options.sessionDir ?? getPiSessionDir(this.cwd));
  }

  async listSessions(agentId?: string): Promise<SessionSummary[]> {
    const infos = await this.sortedInfos();
    const records = await Promise.all(infos.map((info) => this.recordFromInfo(info)));
    const defined = records.filter((record): record is SessionSummary => Boolean(record));
    return agentId ? defined.filter((record) => record.agentId === agentId) : defined;
  }

  async createSession(agentId: string, id = `session_${randomUUID().slice(0, 8)}`): Promise<SessionSummary> {
    const existing = await this.findInfo(id);
    if (existing) {
      const record = await this.recordFromInfo(existing);
      if (!record || record.agentId !== agentId) throw new Error('AGENT_SESSION_MISMATCH');
      return record;
    }
    mkdirSync(this.sessionDir, { recursive: true });
    const manager = SessionManager.create(this.cwd, this.sessionDir, { id });
    const file = manager.getSessionFile();
    const header = manager.getHeader();
    if (!file || !header) throw new Error('Pi session file could not be initialized');
    if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
    SessionManager.open(file, this.sessionDir, this.cwd).appendCustomEntry(PI_WORKBENCH_AGENT_ENTRY, { agentId } satisfies AgentEntryData);
    return (await this.recordFromInfo({ path: file, id: header.id, cwd: header.cwd, created: new Date(header.timestamp), modified: new Date(header.timestamp), messageCount: 0, firstMessage: '', allMessagesText: '' }))!;
  }

  /** Creates the session when absent; rejects reuse through another agent. */
  async ensureSession(id: string, agentId: string): Promise<SessionSummary> {
    const existing = await this.getSession(id);
    if (existing && existing.agentId !== agentId) throw new Error('AGENT_SESSION_MISMATCH');
    return existing ?? this.createSession(agentId, id);
  }

  async getSession(id: string, expectedAgentId?: string): Promise<SessionSummary | undefined> {
    const info = await this.findInfo(id);
    const record = info ? await this.recordFromInfo(info) : undefined;
    if (record && expectedAgentId && record.agentId !== expectedAgentId) throw new Error('AGENT_SESSION_MISMATCH');
    return record;
  }

  async renameSession(id: string, agentId: string, title: string): Promise<SessionSummary | undefined> {
    const manager = await this.openSession(id, agentId);
    manager.appendCustomEntry(PI_WORKBENCH_SESSION_TITLE_ENTRY, { title: title.trim() } satisfies SessionTitleEntryData);
    return this.getSession(id);
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

  private async findInfo(id: string): Promise<SessionInfo | undefined> {
    return (await this.sortedInfos()).find((info) => info.id === id);
  }

  private async openSession(id: string, expectedAgentId?: string): Promise<SessionManager> {
    const info = await this.findInfo(id);
    if (!info) throw new Error('AGENT_SESSION_NOT_FOUND');
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    assertSessionAgentBinding(manager.getEntries(), expectedAgentId);
    return manager;
  }

  private async recordFromInfo(info: SessionInfo): Promise<SessionSummary | undefined> {
    const manager = SessionManager.open(info.path, this.sessionDir, this.cwd);
    const entries = manager.getEntries();
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
