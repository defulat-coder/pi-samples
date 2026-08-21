import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
