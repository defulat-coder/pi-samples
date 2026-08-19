import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteBusinessDataStore } from './business/index.js';

const stores: SqliteBusinessDataStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('catalog-driven business analytics', () => {
  it('returns a normalized regional ranking for an ad-hoc measure combination', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const analysis = store.analyze({ measures: ['net_sales', 'order_count'], dimensions: ['region'], time: { preset: 'last_30_days' }, sort: { field: 'net_sales', direction: 'desc' }, presentationIntent: 'ranking' });
    const { result } = analysis;

    assert.equal(result.catalogVersion, 'sales-demo-v2');
    assert.equal(result.metadata.timeWindow.from, '2026-07-20');
    assert.equal(result.metadata.timeWindow.to, '2026-08-19');
    assert.equal(result.metadata.datasetRows, 52_560);
    assert.deepEqual(result.metadata.coverage, { from: '2025-08-19', to: '2026-08-18' });
    assert.deepEqual(result.metadata.generation, { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 });
    assert.deepEqual(result.fields.map((field) => [field.key, field.role]), [['region', 'dimension'], ['net_sales', 'measure'], ['order_count', 'measure']]);
    assert.equal(result.rows.length, 6);
    assert.ok(Number(result.rows[0]?.net_sales) > Number(result.rows.at(-1)?.net_sales));
    assert.ok(result.rows.every((row) => typeof row.order_count === 'number'));
    assert.equal(analysis.presentation.blocks.find((block) => block.type === 'chart')?.type, 'chart');
  });

  it('supports safe filters and two-dimensional result shapes without predefined reports', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const { result } = store.analyze({
      measures: ['refund_rate', 'net_sales'],
      dimensions: ['region', 'category'],
      time: { preset: 'last_90_days' },
      filters: [{ field: 'channel', operator: 'eq', values: ['直播'] }],
      sort: { field: 'refund_rate', direction: 'desc' },
      limit: 12,
    });

    assert.deepEqual(result.request.filters, [{ field: 'channel', operator: 'eq', values: ['直播'] }]);
    assert.deepEqual(result.fields.map((field) => field.key), ['region', 'category', 'refund_rate', 'net_sales']);
    assert.equal(result.rows.length, 12);
    assert.ok(result.rows.every((row) => Object.keys(row).every((key) => ['region', 'category', 'refund_rate', 'net_sales'].includes(key))));
    assert.ok(result.metadata.limitations.some((item) => item.includes('不接受 SQL')));
  });

  it('builds a line-chart plan for chronological monthly results', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    const analysis = store.analyze({ measures: ['gross_sales', 'order_count'], dimensions: ['month'], time: { preset: 'all' }, presentationIntent: 'trend' });
    const { result } = analysis;

    assert.equal(result.rows.length, 13);
    assert.equal(result.rows[0]?.month, '2025-08');
    assert.equal(result.rows.at(-1)?.month, '2026-08');
    assert.ok(result.rows.every((row) => Number(row.gross_sales) > 0 && Number(row.order_count) > 0));
    assert.deepEqual(analysis.presentation.blocks.find((block) => block.type === 'chart'), { id: 'primary-chart', type: 'chart', chart: 'line', title: 'GMV · 趋势', xField: 'month', yField: 'gross_sales' });
  });

  it('rejects values outside the semantic catalog', () => {
    const store = new SqliteBusinessDataStore(':memory:');
    stores.push(store);
    assert.throws(() => store.analyze({ measures: ['net_sales'], filters: [{ field: 'region', operator: 'eq', values: ['海外'] }] }), /不支持筛选值/);
  });
});
