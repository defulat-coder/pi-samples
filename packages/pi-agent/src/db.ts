import Database from 'better-sqlite3';
import type { ApprovalRecord, ApprovalState } from '@pi-workbench/contracts';

/**
 * SQLite projection for generic workbench data (usage events, UI preferences).
 * Pi-specific state — sessions, messages, agent definitions, settings — stays in
 * Pi's own files (.pi/sessions/*.jsonl, .pi/agents/*.md, .pi/settings.json) and is
 * never duplicated here. The API opens it at .pi/workbench.db under the project
 * root; tests open ':memory:' instead.
 */
export type WorkbenchDb = Database.Database;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_usage_events_agent ON usage_events(agent_id);
  CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE inbox_state (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    read_at TEXT,
    completed_at TEXT
  );
  `,
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    agent_name TEXT NOT NULL,
    message TEXT NOT NULL,
    state TEXT NOT NULL,
    response_nonce TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX idx_approvals_state ON approvals(state);
  CREATE INDEX idx_approvals_session ON approvals(session_id);
  `,
];

export function openWorkbenchDb(path: string): WorkbenchDb {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: WorkbenchDb): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= MIGRATIONS.length) return;
  // All-or-nothing: a crash mid-migration must not leave a half-applied schema.
  db.transaction(() => {
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      db.exec(MIGRATIONS[index]!);
      db.pragma(`user_version = ${index + 1}`);
    }
  })();
}

export interface UsageEventInput {
  sessionId: string;
  agentId: string;
  model?: string;
  input: number;
  output: number;
  total: number;
}

export function recordUsageEvent(db: WorkbenchDb, event: UsageEventInput): void {
  db.prepare(
    `INSERT INTO usage_events (session_id, agent_id, model, input_tokens, output_tokens, total_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.sessionId, event.agentId, event.model ?? null, event.input, event.output, event.total, new Date().toISOString());
}

export interface TokenUsageSummary {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  /** Sum across agents for cross-checking; per-agent rows carry the breakdown. */
  perAgent: Array<{ agentId: string; input: number; output: number; total: number }>;
}

export function summarizeTokenUsage(db: WorkbenchDb): TokenUsageSummary {
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId,
              SUM(input_tokens) AS input,
              SUM(output_tokens) AS output,
              SUM(total_tokens) AS total
       FROM usage_events GROUP BY agent_id`,
    )
    .all() as Array<{ agentId: string; input: number; output: number; total: number }>;
  return {
    totalInput: rows.reduce((sum, row) => sum + row.input, 0),
    totalOutput: rows.reduce((sum, row) => sum + row.output, 0),
    totalTokens: rows.reduce((sum, row) => sum + row.total, 0),
    perAgent: rows,
  };
}

export function getPreferences(db: WorkbenchDb): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value_json AS valueJson FROM preferences').all() as Array<{ key: string; valueJson: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.valueJson);
    } catch {
      // A corrupt row is ignored rather than failing the whole read.
    }
  }
  return result;
}

export function setPreference(db: WorkbenchDb, key: string, value: unknown): void {
  db.prepare('INSERT INTO preferences (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(
    key,
    JSON.stringify(value),
  );
}

/** Removes one preference row; used for「跟随全局默认」semantics (e.g. model.<agentId>). */
export function deletePreference(db: WorkbenchDb, key: string): void {
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

/** inbox_state 单行：收件箱的已读/完成是通用工作台数据，不进 Pi 的 JSONL。 */
export interface InboxState {
  agentId: string;
  readAt: string | null;
  completedAt: string | null;
}

/** Reads every inbox_state row keyed by session id. */
export function getInboxStates(db: WorkbenchDb): Map<string, InboxState> {
  const rows = db.prepare('SELECT session_id AS sessionId, agent_id AS agentId, read_at AS readAt, completed_at AS completedAt FROM inbox_state').all() as Array<{
    sessionId: string;
    agentId: string;
    readAt: string | null;
    completedAt: string | null;
  }>;
  return new Map(rows.map((row) => [row.sessionId, { agentId: row.agentId, readAt: row.readAt, completedAt: row.completedAt }]));
}

/** 标记已读/未读：read=true 写入当前时间，false 清空 read_at；按 session_id upsert。 */
export function setInboxRead(db: WorkbenchDb, sessionId: string, agentId: string, read: boolean): void {
  db.prepare(
    `INSERT INTO inbox_state (session_id, agent_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET agent_id = excluded.agent_id, read_at = excluded.read_at`,
  ).run(sessionId, agentId, read ? new Date().toISOString() : null);
}

/** 标记完成/未完成：completed=true 写入当前时间，且 read_at 未设时一并标记已读；false 仅清空 completed_at。 */
export function setInboxCompleted(db: WorkbenchDb, sessionId: string, agentId: string, completed: boolean): void {
  const now = completed ? new Date().toISOString() : null;
  db.prepare(
    `INSERT INTO inbox_state (session_id, agent_id, read_at, completed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       read_at = COALESCE(inbox_state.read_at, excluded.read_at),
       completed_at = excluded.completed_at`,
  ).run(sessionId, agentId, now, now);
}

/** Session 删除时清理对应的收件箱状态。 */
export function deleteInboxState(db: WorkbenchDb, sessionId: string): void {
  db.prepare('DELETE FROM inbox_state WHERE session_id = ?').run(sessionId);
}

/** 审批记录是通用工作台数据（走 SQLite）；responseNonce/targetSessionId 只用于回写扩展响应文件，不下发给浏览器。 */
export interface StoredApproval extends ApprovalRecord {
  responseNonce: string;
  targetSessionId: string;
}

export interface PendingApprovalInput {
  id: string;
  sessionId: string;
  agentId?: string;
  agentName: string;
  message: string;
  responseNonce: string;
  targetSessionId: string;
  createdAt: string;
}

type ApprovalRow = {
  id: string;
  sessionId: string;
  agentId: string | null;
  agentName: string;
  message: string;
  state: ApprovalState;
  responseNonce: string;
  targetSessionId: string;
  createdAt: string;
  resolvedAt: string | null;
};

const APPROVAL_SELECT = `SELECT id, session_id AS sessionId, agent_id AS agentId, agent_name AS agentName, message,
       state, response_nonce AS responseNonce, target_session_id AS targetSessionId,
       created_at AS createdAt, resolved_at AS resolvedAt FROM approvals`;

function approvalFromRow(row: ApprovalRow): StoredApproval {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    agentName: row.agentName,
    message: row.message,
    state: row.state,
    responseNonce: row.responseNonce,
    targetSessionId: row.targetSessionId,
    createdAt: row.createdAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
  };
}

/** 记录新的 pending 审批；按 id 幂等（watcher 重复扫描不产生回调），返回是否新插入。 */
export function recordPendingApproval(db: WorkbenchDb, approval: PendingApprovalInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO approvals (id, session_id, agent_id, agent_name, message, state, response_nonce, target_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(approval.id, approval.sessionId, approval.agentId ?? null, approval.agentName, approval.message, approval.responseNonce, approval.targetSessionId, approval.createdAt);
  return result.changes > 0;
}

export function getApproval(db: WorkbenchDb, id: string): StoredApproval | undefined {
  const row = db.prepare(`${APPROVAL_SELECT} WHERE id = ?`).get(id) as ApprovalRow | undefined;
  return row ? approvalFromRow(row) : undefined;
}

/** 按 state 过滤（缺省全部），created_at 倒序。 */
export function listApprovals(db: WorkbenchDb, state?: ApprovalState): StoredApproval[] {
  const rows = (
    state
      ? db.prepare(`${APPROVAL_SELECT} WHERE state = ? ORDER BY created_at DESC`).all(state)
      : db.prepare(`${APPROVAL_SELECT} ORDER BY created_at DESC`).all()
  ) as ApprovalRow[];
  return rows.map(approvalFromRow);
}

/** 写入终态与处理时间；调用方负责先校验当前 state 为 pending。 */
export function resolveApproval(db: WorkbenchDb, id: string, state: ApprovalState): void {
  db.prepare('UPDATE approvals SET state = ?, resolved_at = ? WHERE id = ?').run(state, new Date().toISOString(), id);
}

/** 收件箱集成：session_id → pending 审批（每会话最多取最新一条）。 */
export function getPendingApprovalsBySession(db: WorkbenchDb): Map<string, StoredApproval> {
  const map = new Map<string, StoredApproval>();
  for (const approval of listApprovals(db, 'pending')) {
    const existing = map.get(approval.sessionId);
    if (!existing || approval.createdAt > existing.createdAt) map.set(approval.sessionId, approval);
  }
  return map;
}
