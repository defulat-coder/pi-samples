import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPreferences, openWorkbenchDb, recordUsageEvent, setPreference, summarizeTokenUsage } from './db.js';

describe('openWorkbenchDb', () => {
  it('creates the usage_events and preferences tables on an in-memory database', () => {
    const db = openWorkbenchDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    assert.deepEqual(tables, ['preferences', 'usage_events']);
  });

  it('is idempotent: reopening an existing database keeps the schema and data', () => {
    const db = openWorkbenchDb(':memory:');
    recordUsageEvent(db, { sessionId: 's1', agentId: 'writer', input: 1, output: 2, total: 3 });
    // Simulate a second process boot by running the migration path again.
    const reopened = openWorkbenchDb(':memory:');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count, 1);
    assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as { count: number }).count, 0);
  });
});

describe('recordUsageEvent / summarizeTokenUsage', () => {
  it('aggregates token totals globally and per agent', () => {
    const db = openWorkbenchDb(':memory:');
    recordUsageEvent(db, { sessionId: 's1', agentId: 'writer', model: 'kimi-for-coding', input: 100, output: 50, total: 200 });
    recordUsageEvent(db, { sessionId: 's1', agentId: 'writer', input: 10, output: 5, total: 20 });
    recordUsageEvent(db, { sessionId: 's2', agentId: 'pi-assistant', input: 7, output: 3, total: 12 });

    const summary = summarizeTokenUsage(db);
    assert.equal(summary.totalInput, 117);
    assert.equal(summary.totalOutput, 58);
    assert.equal(summary.totalTokens, 232);
    assert.deepEqual(
      summary.perAgent.find((row) => row.agentId === 'writer'),
      { agentId: 'writer', input: 110, output: 55, total: 220 },
    );
  });

  it('returns zeros when no events exist', () => {
    const db = openWorkbenchDb(':memory:');
    const summary = summarizeTokenUsage(db);
    assert.equal(summary.totalTokens, 0);
    assert.deepEqual(summary.perAgent, []);
  });
});

describe('preferences', () => {
  it('round-trips JSON values by key and overwrites on conflict', () => {
    const db = openWorkbenchDb(':memory:');
    setPreference(db, 'thinking.writer', 'high');
    setPreference(db, 'ui.sidebarCollapsed', true);
    setPreference(db, 'thinking.writer', 'low');

    assert.deepEqual(getPreferences(db), { 'thinking.writer': 'low', 'ui.sidebarCollapsed': true });
  });

  it('returns an empty object when nothing is stored', () => {
    const db = openWorkbenchDb(':memory:');
    assert.deepEqual(getPreferences(db), {});
  });
});
