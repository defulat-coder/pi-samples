import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgentSession, getPiProjectRoot, loadPiResourceSnapshot } from './index.js';
import { PiFileSessionStore } from './session-store.js';

describe('Pi workspace tools', () => {
  it('registers knowledge search as a Pi decision tool instead of pre-routing the request', async () => {
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      digitalHumanId: 'project-steward',
      persistSession: false,
      searchKnowledge: async (query) => [{ kind: 'knowledge', title: 'Session', ref: '.pi/knowledge/agent/session-lifecycle.md', excerpt: `matched ${query}` }],
    });

    try {
      assert.match(runtime.session.systemPrompt, /Pi Workbench 项目约束/);
      assert.match(runtime.session.systemPrompt, /你是小派/);
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

  it('creates the commerce analyst digital human with only the business analytics capability profile', async () => {
    let observedDimensions: string[] = [];
    let observedMeasures: string[] = [];
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      digitalHumanId: 'commerce-analyst',
      persistSession: false,
      businessAnalytics: {
        catalog: {
          version: 'sales-demo-v2',
          measures: [{ key: 'net_sales', label: '退款后销售额', semanticType: 'currency', unit: '元', definition: 'GMV 扣除退款', formula: 'SUM(gross-refund)', owner: '经营分析组' }],
          dimensions: [{ key: 'region', label: '区域', role: 'dimension', dataType: 'string', values: ['华东', '华南'] }],
          limits: { maxMeasures: 3, maxDimensions: 2, maxFilters: 4, maxRows: 50 },
        },
        analyze: async (query) => {
          observedDimensions = query.dimensions ?? [];
          observedMeasures = query.measures;
          const result = {
            queryId: 'business-test',
            catalogVersion: 'sales-demo-v2' as const,
            dataset: '电商经营演示数据' as const,
            request: { measures: query.measures, dimensions: query.dimensions ?? [], time: { preset: query.time?.preset ?? 'last_30_days' as const }, filters: query.filters ?? [], ...(query.sort ? { sort: query.sort } : {}), limit: query.limit ?? 20, presentationIntent: query.presentationIntent ?? 'auto' as const },
            fields: [
              { key: 'region' as const, label: '区域', role: 'dimension' as const, dataType: 'string' as const },
              { key: 'net_sales' as const, label: '退款后销售额', role: 'measure' as const, dataType: 'number' as const, semanticType: 'currency' as const, unit: '元' as const, definition: 'GMV 扣除退款', formula: 'SUM(gross-refund)', owner: '经营分析组' },
            ],
            rows: [{ region: '华东', net_sales: 100 }],
            metadata: { asOf: '2026-08-18', datasetRows: 52_560, coverage: { from: '2025-08-19', to: '2026-08-18' }, generation: { source: 'codex-cli' as const, model: 'gpt-5.6-luna' as const, concurrency: 20 as const, scenarios: 20 as const }, timeWindow: { from: '2026-07-20', to: '2026-08-19', timezone: 'Asia/Shanghai' as const }, rowCount: 1, freshness: '演示数据', limitations: ['演示'] },
          };
          return { result, presentation: { version: '1', title: '区域经营分析', blocks: [{ id: 'table', type: 'table', fields: ['region', 'net_sales'] }] } };
        },
      },
    });

    try {
      assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['query_business_data', 'read']);
      assert.equal(runtime.session.getToolDefinition('search_knowledge'), undefined);
      const tool = runtime.session.getToolDefinition('query_business_data');
      assert.ok(tool);
      const result = await tool.execute('business-call', { measures: ['net_sales'], dimensions: ['region'], time: { preset: 'last_30_days' }, presentationIntent: 'ranking' }, undefined, undefined, undefined as never);
      assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /华东/);
      assert.deepEqual(observedDimensions, ['region']);
      assert.deepEqual(observedMeasures, ['net_sales']);
      await assert.rejects(() => tool.execute('business-call-again', { measures: ['net_sales'], dimensions: [] }, undefined, undefined, undefined as never), /已在本轮执行/);
    } finally {
      runtime.close();
    }
  });

  it('refuses to open another digital human session through the direct runtime interface', async () => {
    const cwd = getPiProjectRoot();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-runtime-binding-'));
    try {
      const store = new PiFileSessionStore({ cwd, sessionDir });
      await store.createSession('project-steward', 'owned-session');
      await assert.rejects(() => createPiAgentSession({ cwd, digitalHumanId: 'commerce-analyst', sessionId: 'owned-session', sessionDir, persistSession: true }), /DIGITAL_HUMAN_SESSION_MISMATCH/);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('allows only one business query attempt even when the first attempt fails', async () => {
    let calls = 0;
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      digitalHumanId: 'commerce-analyst',
      persistSession: false,
      businessAnalytics: {
        catalog: { version: 'sales-demo-v2', measures: [{ key: 'net_sales', label: '退款后销售额' }], dimensions: [], limits: { maxMeasures: 3, maxDimensions: 2, maxFilters: 4, maxRows: 50 } },
        analyze: async () => { calls += 1; throw new Error('query failed'); },
      },
    });
    try {
      const tool = runtime.session.getToolDefinition('query_business_data');
      assert.ok(tool);
      await assert.rejects(() => tool.execute('first', { measures: ['net_sales'], dimensions: [] }, undefined, undefined, undefined as never), /query failed/);
      await assert.rejects(() => tool.execute('second', { measures: ['net_sales'], dimensions: [] }, undefined, undefined, undefined as never), /已在本轮执行/);
      assert.equal(calls, 1);
    } finally {
      runtime.close();
    }
  });
});
