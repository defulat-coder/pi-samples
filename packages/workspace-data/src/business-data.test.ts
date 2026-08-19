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

    assert.equal(result.catalogVersion, 'sales-demo-v1');
    assert.equal(result.timeWindow.from, '2026-07-20');
    assert.equal(result.timeWindow.to, '2026-08-19');
    assert.equal(result.rows.length, 4);
    assert.equal(result.rows[0]?.dimension, '华东');
    assert.ok(Number(result.rows[0]?.netSales) > Number(result.rows.at(-1)?.netSales));
    assert.ok(result.rows.every((row) => typeof row.orderCount === 'number'));
  });

  it('keeps filters and requested metrics inside the certified catalog', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const result = store.query({ metrics: ['refund_rate'], groupBy: 'category', period: 'last_90_days', channel: '直播', orderBy: 'refund_rate', limit: 4 });

    assert.equal(result.query.channel, '直播');
    assert.equal(result.rows[0]?.dimension, '美妆个护');
    assert.ok(result.rows.every((row) => Object.keys(row).every((key) => ['dimension', 'refundRate'].includes(key))));
    assert.ok(result.limitations.some((item) => item.includes('不接受 SQL')));
  });
});
