import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteBusinessDataStore } from './business-data.js';

const stores: SqliteBusinessDataStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('certified business data queries', () => {
  it('returns a stable regional sales ranking for the last 30 days', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const result = store.query({ metrics: ['net_sales', 'order_count'], groupBy: 'region', period: 'last_30_days', orderBy: 'net_sales' });

    assert.equal(result.catalogVersion, 'sales-demo-v2');
    assert.equal(result.timeWindow.from, '2026-07-20');
    assert.equal(result.timeWindow.to, '2026-08-19');
    assert.equal(result.datasetRows, 52_560);
    assert.deepEqual(result.coverage, { from: '2025-08-19', to: '2026-08-18' });
    assert.deepEqual(result.generation, { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 });
    assert.equal(result.rows.length, 6);
    assert.ok(Number(result.rows[0]?.netSales) > Number(result.rows.at(-1)?.netSales));
    assert.ok(result.rows.every((row) => typeof row.orderCount === 'number'));
  });

  it('keeps filters and requested metrics inside the certified catalog', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const result = store.query({ metrics: ['refund_rate'], groupBy: 'category', period: 'last_90_days', channel: '直播', orderBy: 'refund_rate', limit: 4 });

    assert.equal(result.query.channel, '直播');
    assert.ok(['数码家电', '家居生活', '美妆个护', '食品饮料', '服饰鞋包', '运动户外'].includes(String(result.rows[0]?.dimension)));
    assert.ok(result.rows.every((row) => Object.keys(row).every((key) => ['dimension', 'refundRate'].includes(key))));
    assert.ok(result.limitations.some((item) => item.includes('不接受 SQL')));
  });

  it('covers a full year with chronologically ordered monthly aggregates', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const result = store.query({ metrics: ['gross_sales', 'order_count'], groupBy: 'month', period: 'all', order: 'asc', limit: 20 });

    assert.equal(result.rows.length, 13);
    assert.equal(result.rows[0]?.dimension, '2025-08');
    assert.equal(result.rows.at(-1)?.dimension, '2026-08');
    assert.ok(result.rows.every((row) => Number(row.grossSales) > 0 && Number(row.orderCount) > 0));
  });
});
