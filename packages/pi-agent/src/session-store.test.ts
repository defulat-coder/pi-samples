import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { AgentSessionStore, assertSessionAgentBinding, PI_WORKBENCH_AGENT_ENTRY } from './session-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; store: AgentSessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-store-'));
  roots.push(root);
  return { root, store: new AgentSessionStore({ cwd: root }) };
}

describe('agent session store', () => {
  it('creates, lists, renames and deletes bound sessions', async () => {
    const { store } = fixture();
    const created = await store.createSession('pi-assistant', 'session-a');
    assert.equal(created.agentId, 'pi-assistant');
    assert.equal(created.title, '新会话');
    assert.equal(created.questionCount, 0);

    const renamed = await store.renameSession('session-a', 'pi-assistant', '架构讨论');
    assert.equal(renamed?.title, '架构讨论');

    const listed = await store.listSessions('pi-assistant');
    assert.deepEqual(listed.map((session) => session.id), ['session-a']);
    assert.deepEqual(await store.listSessions('other-agent'), []);

    assert.equal(await store.deleteSession('session-a', 'pi-assistant'), true);
    assert.equal(await store.getSession('session-a'), undefined);
  });

  it('counts user messages as questions and derives a title from the first one', async () => {
    const { root, store } = fixture();
    const created = await store.createSession('pi-assistant', 'session-questions');
    const info = (await SessionManager.list(root, store.sessionDir)).find((item) => item.id === created.id);
    assert.ok(info);
    const manager = SessionManager.open(info.path, store.sessionDir, root);
    manager.appendMessage({ role: 'user', content: '解释一下会话生命周期', timestamp: Date.now() });
    manager.appendMessage({ role: 'user', content: '第二个问题', timestamp: Date.now() });

    const session = await store.getSession('session-questions');
    assert.equal(session?.questionCount, 2);
    assert.equal(session?.title, '解释一下会话生命周期');
  });

  it('flags sessions whose last assistant message errored or was aborted', async () => {
    const { root, store } = fixture();
    await store.createSession('pi-assistant', 'attention-session');
    const info = (await SessionManager.list(root, store.sessionDir)).find((item) => item.id === 'attention-session');
    assert.ok(info);
    const manager = SessionManager.open(info.path, store.sessionDir, root);

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const base = { role: 'assistant' as const, content: [], api: 'messages' as const, provider: 'kimi-coding' as const, model: 'kimi-for-coding', usage, timestamp: Date.now() };

    // No assistant message yet: a fresh session never needs attention.
    assert.equal((await store.getSession('attention-session'))?.needsAttention, false);

    manager.appendMessage({ ...base, stopReason: 'error', errorMessage: '模型超时' });
    const errored = await store.getSession('attention-session');
    assert.equal(errored?.needsAttention, true);
    assert.equal(errored?.attentionReason, 'error');
    assert.equal(errored?.attentionDetail, '模型超时');

    manager.appendMessage({ ...base, stopReason: 'aborted' });
    const aborted = await store.getSession('attention-session');
    assert.equal(aborted?.needsAttention, true);
    assert.equal(aborted?.attentionReason, 'aborted');

    // A later successful run clears the flag.
    manager.appendMessage({ ...base, stopReason: 'stop' });
    assert.equal((await store.getSession('attention-session'))?.needsAttention, false);
  });

  it('replays persisted messages with usage and error details', async () => {
    const { root, store } = fixture();
    await store.createSession('pi-assistant', 'replay-session');
    const info = (await SessionManager.list(root, store.sessionDir)).find((item) => item.id === 'replay-session');
    assert.ok(info);
    const manager = SessionManager.open(info.path, store.sessionDir, root);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '第一句话' }], timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '回答你' },
      ],
      api: 'messages',
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: 'assistant',
      content: [],
      api: 'messages',
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error',
      errorMessage: '模型超时',
      timestamp: Date.now(),
    });

    const messages = await store.listMessages('replay-session', 'pi-assistant');
    assert.equal(messages.length, 3);
    assert.equal(messages[0]!.role, 'user');
    assert.equal(messages[0]!.content, '第一句话');
    assert.equal(messages[1]!.thinking, '想一下');
    assert.equal(messages[1]!.content, '回答你');
    assert.deepEqual(messages[1]!.usage, { input: 10, output: 5, total: 30 });
    assert.equal(messages[2]!.stopReason, 'error');
    assert.equal(messages[2]!.errorMessage, '模型超时');
    assert.equal(messages[2]!.usage, undefined);

    await assert.rejects(() => store.listMessages('replay-session', 'other-agent'), /AGENT_SESSION_MISMATCH/);
    await assert.rejects(() => store.listMessages('no-such-session', 'pi-assistant'), /AGENT_SESSION_NOT_FOUND/);
  });

  it('rejects cross-agent reuse of a persisted session', async () => {
    const { store } = fixture();
    await store.createSession('pi-assistant', 'owned-session');
    await assert.rejects(() => store.ensureSession('owned-session', 'other-agent'), /AGENT_SESSION_MISMATCH/);
    await assert.rejects(() => store.getSession('owned-session', 'other-agent'), /AGENT_SESSION_MISMATCH/);
    await assert.rejects(() => store.renameSession('owned-session', 'other-agent', '越权'), /AGENT_SESSION_MISMATCH/);
    await assert.rejects(() => store.deleteSession('owned-session', 'other-agent'), /AGENT_SESSION_MISMATCH/);
  });

  it('rejects sessions without a binding instead of migrating them', async () => {
    const { root, store } = fixture();
    mkdirSync(store.sessionDir, { recursive: true });
    SessionManager.create(root, store.sessionDir, { id: 'unbound-session' });
    assert.equal(await store.getSession('unbound-session'), undefined);
    const manager = SessionManager.create(root, store.sessionDir, { id: 'conflicted-session' });
    manager.appendCustomEntry(PI_WORKBENCH_AGENT_ENTRY, { agentId: 'pi-assistant' });
    manager.appendCustomEntry(PI_WORKBENCH_AGENT_ENTRY, { agentId: 'other-agent' });
    assert.equal(await store.getSession('conflicted-session'), undefined);
  });

  it('validates binding entries explicitly', () => {
    assert.throws(() => assertSessionAgentBinding([]), /AGENT_BINDING_MISSING/);
  });
});
