import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BusinessAnalysis } from '@pi-workbench/contracts';
import { toJsonRenderSpec } from './to-json-render-spec.js';

const analysis: BusinessAnalysis = {
  result: {
    queryId: 'business_adapter_test',
    catalogVersion: 'sales-demo-v2',
    dataset: '电商经营演示数据',
    request: { measures: ['net_sales'], dimensions: ['month', 'channel'], time: { preset: 'last_90_days' }, filters: [], limit: 20, presentationIntent: 'trend' },
    fields: [
      { key: 'month', label: '月份', role: 'time', dataType: 'date' },
      { key: 'channel', label: '渠道', role: 'dimension', dataType: 'string' },
      { key: 'net_sales', label: '退款后销售额', role: 'measure', dataType: 'number', semanticType: 'currency', unit: '元' },
    ],
    rows: [
      { month: '2026-06', channel: '直播', net_sales: 120 },
      { month: '2026-07', channel: '直播', net_sales: 150 },
      { month: '2026-06', channel: '直营网店', net_sales: 180 },
      { month: '2026-07', channel: '直营网店', net_sales: 190 },
    ],
    metadata: { asOf: '2026-08-18', datasetRows: 52_560, coverage: { from: '2025-08-19', to: '2026-08-18' }, generation: { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 }, timeWindow: { from: '2026-05-21', to: '2026-08-19', timezone: 'Asia/Shanghai' }, rowCount: 4, freshness: '演示数据', limitations: ['仅用于演示。'] },
  },
  presentation: {
    version: '1',
    title: '月份 × 渠道经营趋势',
    blocks: [
      { id: 'summary', type: 'summary', primaryMeasure: 'net_sales', dimensionFields: ['month', 'channel'] },
      { id: 'primary-chart', type: 'chart', chart: 'line', title: '退款后销售额 · 趋势', xField: 'month', seriesField: 'channel', yField: 'net_sales' },
      { id: 'table', type: 'table', fields: ['month', 'channel', 'net_sales'] },
      { id: 'scope', type: 'scope' },
      { id: 'notice', type: 'notice' },
    ],
  },
};

describe('business presentation json-render adapter', () => {
  it('turns a vendor-neutral two-dimensional plan into multi-series UI data', () => {
    const spec = toJsonRenderSpec(analysis);
    assert.equal(spec.elements['primary-chart']?.type, 'LineChart');
    assert.deepEqual(spec.elements['primary-chart']?.props.series, [
      { name: '直播', values: [120, 150] },
      { name: '直营网店', values: [180, 190] },
    ]);
    assert.equal(spec.elements.table?.type, 'DataTable');
    assert.deepEqual(spec.elements.table?.props.rows, analysis.result.rows);
  });

  it('preserves missing series points instead of inventing zero values', () => {
    const sparse = structuredClone(analysis);
    sparse.result.rows = sparse.result.rows.filter((row) => !(row.month === '2026-07' && row.channel === '直播'));
    const spec = toJsonRenderSpec(sparse);
    const series = spec.elements['primary-chart']?.props.series as Array<{ name: string; values: Array<number | null> }>;
    assert.deepEqual(series[0], { name: '直播', values: [120, null] });
  });
});
