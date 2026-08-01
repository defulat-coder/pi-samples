import type { CreateWorkspaceRecordRequest, Paginated, WorkspaceRecord, WorkspaceRecordQuery, WorkspaceSnapshot } from '@pi-workbench/contracts';
import { workspaceRecords as seedRecords } from './seed.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryWorkspaceStore {
  private records = clone(seedRecords);

  listRecords(options: WorkspaceRecordQuery = {}): Paginated<WorkspaceRecord> {
    const page = Math.max(options.page ?? 1, 1);
    const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
    const query = options.search?.trim().toLowerCase();
    const filtered = this.records.filter((record) => {
      const matchesKind = !options.kind || record.kind === options.kind;
      const matchesStatus = !options.status || record.status === options.status;
      const haystack = [record.title, record.summary, ...record.tags].join(' ').toLowerCase();
      return matchesKind && matchesStatus && (!query || haystack.includes(query));
    });
    const pages = Math.max(Math.ceil(filtered.length / pageSize), 1);
    return { items: clone(filtered.slice((page - 1) * pageSize, page * pageSize)), total: filtered.length, page, pageSize, pages };
  }

  getRecord(id: string): WorkspaceRecord | undefined {
    const record = this.records.find((item) => item.id === id);
    return record ? clone(record) : undefined;
  }

  createRecord(input: CreateWorkspaceRecordRequest): WorkspaceRecord {
    const record: WorkspaceRecord = {
      id: `record-${this.records.length + 1}`,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status ?? 'draft',
      tags: input.tags ?? [],
      updatedAt: new Date().toISOString(),
      payload: input.payload,
    };
    this.records.push(record);
    return clone(record);
  }

  getSnapshot(knowledgeDocuments: number): WorkspaceSnapshot {
    const activeRecords = this.records.filter((record) => record.status === 'active').length;
    return {
      generatedAt: new Date().toISOString(),
      workspace: { name: 'Pi Workbench', environment: 'local', timezone: 'Asia/Shanghai' },
      metrics: { totalRecords: this.records.length, activeRecords, draftRecords: this.records.filter((record) => record.status === 'draft').length, knowledgeDocuments },
      records: clone(this.records),
    };
  }
}

export const memoryStore = new InMemoryWorkspaceStore();
