import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiFileSessionStore } from './session-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response(sessionId: string) {
  const timestamp = new Date().toISOString();
  return {
    answer: '文件回答',
    source: 'pi-coding-agent' as const,
    digitalHumanId: 'project-steward',
    sessionId,
    route: 'project-knowledge' as const,
    decision: { decidedBy: 'pi' as const, toolCalls: [] },
    sources: [],
    resources: [],
    events: [],
    tools: { enabled: ['read'], policy: 'read-only' as const },
    model: { enabled: true, providerConfigured: true },
    metrics: { turn: 1, executionRounds: 1, startedAt: timestamp, completedAt: timestamp, durationMs: 2, eventCount: 0, eventCounts: {}, eventCategoryCounts: {}, toolCallCount: 0, toolResultCount: 0, toolErrorCount: 0, toolMetrics: [], retryCount: 0, retries: [], compactionCount: 0, compactions: [], queueUpdateCount: 0, settled: true, inputChars: 4, outputChars: 4, thinkingChars: 0, tokenUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, source: 'estimated' as const } },
    latencyMs: 2,
    createdAt: timestamp,
  };
}

describe('Pi JSONL session store', () => {
  it('uses the official session header and persists Web metadata as custom entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-'));
    roots.push(root);
    const store = new PiFileSessionStore({ cwd: root, sessionDir: join(root, '.pi', 'sessions') });
    const created = await store.createSession('project-steward', 'session-file');
    assert.equal(created.id, 'session-file');
    assert.equal(created.digitalHumanId, 'project-steward');
    const file = join(root, '.pi', 'sessions');
    const sessionFile = (await import('node:fs/promises')).readdir(file).then((items) => join(file, items[0]!));
    assert.equal(existsSync(file), true);
    assert.equal((await sessionFile).endsWith('.jsonl'), true);

    const manager = SessionManager.open(await sessionFile, file, root);
    manager.appendMessage({ role: 'user', content: '内部增强提示', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '文件回答' }], api: 'pi', provider: 'test', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    await store.appendTurnMetadata(created.id, 'turn-file', response(created.id), '文件问题');
    const persisted = await store.getSession(created.id);
    assert.deepEqual(persisted?.messages.map((message) => message.kind), ['user', 'assistant']);
    const lines = readFileSync(await sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; customType?: string });
    assert.equal(lines[0]?.type, 'session');
    assert.ok(lines.some((line) => line.customType === 'pi-workbench.turn'));

    const assistant = persisted?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.kind === 'assistant');
    assert.ok(assistant);
    const liked = await store.setMessageFeedback(created.id, assistant!.id, 'like');
    assert.equal(liked?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.id === assistant!.id && message.kind === 'assistant')?.feedback, 'like');
    assert.equal(liked?.messages.every((message) => Boolean(message.createdAt)), true);
    assert.equal(liked?.messages.find((message) => message.kind === 'assistant')?.persisted, true);
    const renamed = await store.setSessionTitle(created.id, '文件检索会话');
    assert.equal(renamed?.title, '文件检索会话');
    const reopened = new PiFileSessionStore({ cwd: root, sessionDir: join(root, '.pi', 'sessions') });
    assert.equal((await reopened.listSessions()).length, 1);
    assert.equal((await reopened.getSession(created.id))?.title, '文件检索会话');
    assert.equal((await reopened.getSession(created.id))?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.id === assistant!.id && message.kind === 'assistant')?.feedback, 'like');
    assert.equal(await reopened.deleteSession(created.id), true);
    assert.equal((await reopened.listSessions()).length, 0);
  });

  it('binds a session to one digital human and filters session lists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-agents-'));
    roots.push(root);
    const store = new PiFileSessionStore({ cwd: root, sessionDir: join(root, '.pi', 'sessions') });
    const steward = await store.createSession('project-steward', 'session-steward');
    const analyst = await store.createSession('commerce-analyst', 'session-analyst');

    assert.equal(steward.digitalHumanId, 'project-steward');
    assert.equal(analyst.digitalHumanId, 'commerce-analyst');
    assert.deepEqual((await store.listSessions('commerce-analyst')).map((session) => session.id), ['session-analyst']);
    await assert.rejects(() => store.ensureSession('session-analyst', 'project-steward'), /DIGITAL_HUMAN_SESSION_MISMATCH/);
  });

  it('ignores sessions that only contain the removed Agent binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-legacy-'));
    roots.push(root);
    const sessionDir = join(root, '.pi', 'sessions');
    const manager = SessionManager.create(root, sessionDir, { id: 'legacy-session' });
    manager.appendCustomEntry('pi-workbench.agent', { agentId: 'knowledge' });
    const store = new PiFileSessionStore({ cwd: root, sessionDir });
    assert.deepEqual(await store.listSessions(), []);
    assert.equal(await store.getSession('legacy-session'), undefined);
  });

  it('rejects conflicting digital human bindings in one JSONL file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-conflict-'));
    roots.push(root);
    const sessionDir = join(root, '.pi', 'sessions');
    const store = new PiFileSessionStore({ cwd: root, sessionDir });
    const created = await store.createSession('project-steward', 'conflicting-session');
    const manager = SessionManager.open(join(sessionDir, readdirSync(sessionDir)[0]!), sessionDir, root);
    manager.appendCustomEntry('pi-workbench.digital-human', { digitalHumanId: 'commerce-analyst' });
    assert.equal(await store.getSession(created.id), undefined);
  });

  it('allows only one winner when two digital humans create the same session id concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-race-'));
    roots.push(root);
    const store = new PiFileSessionStore({ cwd: root, sessionDir: join(root, '.pi', 'sessions') });
    const results = await Promise.allSettled([
      store.createSession('project-steward', 'shared-session'),
      store.createSession('commerce-analyst', 'shared-session'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await store.listSessions()).filter((session) => session.id === 'shared-session').length, 1);
  });

  it('keeps the original browser input separate from Pi internal prompt context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-input-'));
    roots.push(root);
    const sessionDir = join(root, '.pi', 'sessions');
    const store = new PiFileSessionStore({ cwd: root, sessionDir });
    const created = await store.createSession('project-steward', 'session-input');
    const manager = SessionManager.open(join(sessionDir, readdirSync(sessionDir)[0]!), sessionDir, root);
    manager.appendMessage({ role: 'user', content: 'ls -al\n\n这是一个 Pi Agent 验证工作台。项目资源目录摘要如下：{}', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '无法执行。' }], api: 'pi', provider: 'test', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    await store.appendTurnMetadata(created.id, 'turn-input', { ...response(created.id), answer: '无法执行。' }, 'ls -al');
    const projected = await store.getSession(created.id);
    assert.equal(projected?.messages[0]?.kind, 'user');
    assert.equal(projected?.messages[0]?.kind === 'user' ? projected.messages[0].text : '', 'ls -al');
  });
});
