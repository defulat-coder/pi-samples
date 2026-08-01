import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryWorkspaceStore } from './store.js';

describe('workspace data', () => {
  it('provides generic local records and a snapshot', () => {
    const store = new InMemoryWorkspaceStore();
    const records = store.listRecords({ pageSize: 10 });
    assert.equal(records.total, 5);
    assert.ok(records.items.every((record) => record.id.startsWith('record-')));
    assert.equal(store.getSnapshot(455).workspace.name, 'Pi Workbench');
    assert.equal(store.getSnapshot(455).metrics.knowledgeDocuments, 455);
  });

  it('filters records by kind and status', () => {
    const store = new InMemoryWorkspaceStore();
    const result = store.listRecords({ kind: 'experiment', status: 'active' });
    assert.equal(result.total, 2);
    assert.ok(result.items.every((record) => record.kind === 'experiment' && record.status === 'active'));
  });
});
