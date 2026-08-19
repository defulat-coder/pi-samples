/// <reference types="node" />

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentStreamEvent, createLiveTurnProcess, isVisibleProcessEvent } from './stream-process.js';

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
});
