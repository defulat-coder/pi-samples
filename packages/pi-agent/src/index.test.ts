import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPiAgentSession, getPiProjectRoot } from './index.js';

describe('Pi workspace tools', () => {
  it('registers knowledge search as a Pi decision tool instead of pre-routing the request', async () => {
    const runtime = await createPiAgentSession({
      cwd: getPiProjectRoot(),
      searchKnowledge: async (query) => [{ kind: 'knowledge', title: 'Session', ref: '.pi/knowledge/agent/session-lifecycle.md', excerpt: `matched ${query}` }],
    });

    try {
      assert.ok(runtime.session.getActiveToolNames().includes('read'));
      assert.ok(runtime.session.getActiveToolNames().includes('search_knowledge'));
      const tool = runtime.session.getToolDefinition('search_knowledge');
      assert.ok(tool);
      const result = await tool.execute('test-call', { query: 'session' }, undefined, undefined, undefined as never);
      assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /session-lifecycle/);
    } finally {
      runtime.close();
    }
  });
});
