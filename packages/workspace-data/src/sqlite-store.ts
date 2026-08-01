import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateWorkspaceRecordRequest, Paginated, WorkspaceRecord, WorkspaceRecordKind, WorkspaceRecordQuery, WorkspaceRecordStatus, WorkspaceSnapshot } from '@pi-workbench/contracts';
import { workspaceRecords as seedRecords } from './seed.js';

type Row = Record<string, unknown>;

function value<T>(row: Row, key: string): T {
  return row[key] as T;
}

function recordFromRow(row: Row): WorkspaceRecord {
  return {
    id: value<string>(row, 'id'),
    kind: value<WorkspaceRecordKind>(row, 'kind'),
    title: value<string>(row, 'title'),
    summary: value<string>(row, 'summary'),
    status: value<WorkspaceRecordStatus>(row, 'status'),
    tags: JSON.parse(value<string>(row, 'tags_json')) as string[],
    updatedAt: value<string>(row, 'updated_at'),
    payload: JSON.parse(value<string>(row, 'payload_json')) as WorkspaceRecord['payload'],
  };
}

export class SqliteWorkspaceStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.PI_WORKSPACE_DB_PATH ?? resolve(process.cwd(), '.data/pi-workspace.sqlite')) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.createSchema();
    this.seedIfEmpty();
  }

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_records_kind ON workspace_records(kind);
      CREATE INDEX IF NOT EXISTS idx_workspace_records_status ON workspace_records(status);
    `);
  }

  private seedIfEmpty() {
    const count = Number(value<number>(this.db.prepare('SELECT COUNT(*) AS count FROM workspace_records').get() as Row, 'count'));
    if (count > 0) return;
    const insert = this.db.prepare('INSERT INTO workspace_records (id, kind, title, summary, status, tags_json, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const record of seedRecords) insert.run(record.id, record.kind, record.title, record.summary, record.status, JSON.stringify(record.tags), record.updatedAt, JSON.stringify(record.payload ?? {}));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listRecords(options: WorkspaceRecordQuery = {}): Paginated<WorkspaceRecord> {
    const page = Math.max(options.page ?? 1, 1);
    const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind) { where.push('kind = ?'); params.push(options.kind); }
    if (options.status) { where.push('status = ?'); params.push(options.status); }
    if (options.search?.trim()) {
      const search = `%${options.search.trim()}%`;
      where.push('(LOWER(title) LIKE LOWER(?) OR LOWER(summary) LIKE LOWER(?) OR LOWER(tags_json) LIKE LOWER(?))');
      params.push(search, search, search);
    }
    const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = Number(value<number>(this.db.prepare(`SELECT COUNT(*) AS count FROM workspace_records${whereClause}`).get(...params) as Row, 'count'));
    const rows = this.db.prepare(`SELECT * FROM workspace_records${whereClause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    return { items: rows.map(recordFromRow), total, page, pageSize, pages: Math.max(Math.ceil(total / pageSize), 1) };
  }

  getRecord(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspace_records WHERE id = ?').get(id) as Row | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  createRecord(input: CreateWorkspaceRecordRequest): WorkspaceRecord {
    const id = `record-${Date.now().toString(36)}`;
    const record: WorkspaceRecord = { id, kind: input.kind, title: input.title, summary: input.summary, status: input.status ?? 'draft', tags: input.tags ?? [], updatedAt: new Date().toISOString(), payload: input.payload };
    this.db.prepare('INSERT INTO workspace_records (id, kind, title, summary, status, tags_json, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.kind, record.title, record.summary, record.status, JSON.stringify(record.tags), record.updatedAt, JSON.stringify(record.payload ?? {}));
    return record;
  }

  getSnapshot(knowledgeDocuments: number): WorkspaceSnapshot {
    const records = this.listRecords({ pageSize: 100 }).items;
    return {
      generatedAt: new Date().toISOString(),
      workspace: { name: 'Pi Workbench', environment: 'local', timezone: 'Asia/Shanghai' },
      metrics: { totalRecords: records.length, activeRecords: records.filter((record) => record.status === 'active').length, draftRecords: records.filter((record) => record.status === 'draft').length, knowledgeDocuments },
      records,
    };
  }

  close() {
    this.db.close();
  }
}
