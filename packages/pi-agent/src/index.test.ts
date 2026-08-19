import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPiAgentSession, getPiProjectRoot, loadPiResourceSnapshot } from './index.js';

describe('Pi workspace tools', () => {
  it('registers knowledge search as a Pi decision tool instead of pre-routing the request', async () => {
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      persistSession: false,
      searchKnowledge: async (query) => [{ kind: 'knowledge', title: 'Session', ref: '.pi/knowledge/agent/session-lifecycle.md', excerpt: `matched ${query}` }],
    });

    try {
      assert.ok(runtime.session.getActiveToolNames().includes('read'));
      assert.ok(runtime.session.getActiveToolNames().includes('search_knowledge'));
      const tool = runtime.session.getToolDefinition('search_knowledge');
      assert.ok(tool);
      const result = await tool.execute('test-call', { query: 'session' }, undefined, undefined, undefined as never);
      assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /session-lifecycle/);
      assert.ok(typeof (result.details as { retrievalMs?: unknown }).retrievalMs === 'number');
    } finally {
      runtime.close();
    }
  });

  it('discovers the official project resource types without enabling extensions', async () => {
    const snapshot = await loadPiResourceSnapshot(getPiProjectRoot(), { projectExtensions: false });
    assert.equal(snapshot.extensionsEnabled, false);
    assert.ok(snapshot.skills.some((skill) => skill.name === 'pi-session-observability'));
    assert.ok(snapshot.prompts.some((prompt) => prompt.name === 'inspect-pi'));
    assert.ok(snapshot.themes.some((theme) => theme.name === 'pi-workbench-neutral'));
    assert.ok(snapshot.appendSystemPrompts.some((prompt) => prompt.path === '.pi/APPEND_SYSTEM.md'));
  });

  it('creates a second Pi AgentSession with only the business analysis capability set', async () => {
    let observedGroupBy = '';
    let observedMetrics: string[] = [];
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      agentId: 'business-data',
      persistSession: false,
      queryBusinessData: async (query) => {
        observedGroupBy = query.groupBy ?? '';
        observedMetrics = query.metrics;
        return {
          queryId: 'business-test',
          catalogVersion: 'sales-demo-v2',
          dataset: '电商经营演示数据',
          asOf: '2026-08-18',
          datasetRows: 52_560,
          coverage: { from: '2025-08-19', to: '2026-08-18' },
          generation: { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 },
          timeWindow: { from: '2026-07-20', to: '2026-08-19', timezone: 'Asia/Shanghai' },
          query: { metrics: query.metrics, groupBy: query.groupBy ?? 'none', period: query.period ?? 'last_30_days', orderBy: query.orderBy ?? query.metrics[0]!, order: query.order ?? 'desc', limit: query.limit ?? 10 },
          metricDefinitions: [{ id: 'net_sales', name: '退款后销售额', unit: '元', definition: 'GMV 扣除退款', formula: 'SUM(gross-refund)', owner: '经营分析组', grain: '日', timeField: 'sale_date' }],
          rows: [{ dimension: '华东', netSales: 100 }],
          rowCount: 1,
          freshness: '演示数据',
          limitations: ['演示'],
        };
      },
    });

    try {
      assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['query_business_data', 'read']);
      assert.equal(runtime.session.getToolDefinition('search_knowledge'), undefined);
      const tool = runtime.session.getToolDefinition('query_business_data');
      assert.ok(tool);
      const result = await tool.execute('business-call', { analysis: 'regional_performance_30d' }, undefined, undefined, undefined as never);
      assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /华东/);
      assert.equal(observedGroupBy, 'region');
      assert.deepEqual(observedMetrics, ['net_sales', 'order_count', 'average_order_value']);
    } finally {
      runtime.close();
    }
  });
});
