/// <reference types="node" />

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentStreamEvent, buildToolActivities, createLiveTurnProcess, isVisibleProcessEvent } from './stream-process.js';

describe('live Agent process', () => {
  it('keeps tool events as they arrive over SSE', () => {
    const event = { type: 'tool_execution_start', label: '调用 search_knowledge', category: 'tool' as const, toolName: 'search_knowledge' };
    const process = applyAgentStreamEvent(createLiveTurnProcess(), { type: 'event', event });
    assert.deepEqual(process.events, [event]);
  });

  it('keeps tool, thinking, and error events while dropping transport lifecycle noise', () => {
    assert.equal(isVisibleProcessEvent({ type: 'thinking_start', label: '开始 thinking', category: 'thinking' }), true);
    assert.equal(isVisibleProcessEvent({ type: 'tool_execution_end', label: '工具完成', category: 'tool' }), true);
    assert.equal(isVisibleProcessEvent({ type: 'agent_error', label: 'Agent 错误', category: 'error' }), true);
    assert.equal(isVisibleProcessEvent({ type: 'agent_start', label: 'Agent 开始', category: 'lifecycle' }), false);
    assert.equal(isVisibleProcessEvent({ type: 'message_start', label: '消息开始', category: 'lifecycle' }), false);
  });

  it('groups a tool call and its result into one Claude-style activity', () => {
    const activities = buildToolActivities([
      { type: 'toolcall_start', label: '模型准备调用工具', category: 'tool', elapsedMs: 100 },
      { type: 'tool_execution_start', label: '调用 search_knowledge', category: 'tool', toolName: 'search_knowledge', detail: '{"query":"Pi session"}', elapsedMs: 120 },
      { type: 'tool_execution_update', label: '工具输出 search_knowledge', category: 'tool', toolName: 'search_knowledge', detail: '{"count":3}', elapsedMs: 150 },
      { type: 'tool_execution_end', label: '完成 search_knowledge', category: 'tool', toolName: 'search_knowledge', detail: '{"count":3}', elapsedMs: 180 },
    ]);
    assert.deepEqual(activities, [{ id: '1-search_knowledge', toolName: 'search_knowledge', label: '调用 search_knowledge', status: 'completed', input: '{"query":"Pi session"}', output: '{"count":3}', startedAtMs: 120, durationMs: 60 }]);
  });
});
