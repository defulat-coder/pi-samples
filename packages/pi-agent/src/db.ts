import Database from 'better-sqlite3';

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
