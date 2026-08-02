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
    source: 'local-fallback' as const,
    sessionId,
    route: 'workspace' as const,
    decision: { decidedBy: 'fallback' as const, toolCalls: [] },
    sources: [],
    resources: [],
    events: [],
    tools: { enabled: ['read'], policy: 'read-only' as const },
    model: { enabled: false, providerConfigured: false },
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
    const created = await store.createSession('session-file');
    assert.equal(created.id, 'session-file');
    const file = join(root, '.pi', 'sessions');
    const sessionFile = (await import('node:fs/promises')).readdir(file).then((items) => join(file, items[0]!));
    assert.equal(existsSync(file), true);
    assert.equal((await sessionFile).endsWith('.jsonl'), true);

    await store.appendFallbackTurn(created.id, '文件问题', 'turn-file', response(created.id));
    const persisted = await store.getSession(created.id);
    assert.deepEqual(persisted?.messages.map((message) => message.kind), ['user', 'assistant']);
    const lines = readFileSync(await sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; customType?: string });
    assert.equal(lines[0]?.type, 'session');
    assert.ok(lines.some((line) => line.customType === 'pi-workbench.turn'));

    const assistant = persisted?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.kind === 'assistant');
    assert.ok(assistant);
    const liked = await store.setMessageFeedback(created.id, assistant!.id, 'like');
    assert.equal(liked?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.id === assistant!.id && message.kind === 'assistant')?.feedback, 'like');
    const reopened = new PiFileSessionStore({ cwd: root, sessionDir: join(root, '.pi', 'sessions') });
    assert.equal((await reopened.listSessions()).length, 1);
    assert.equal((await reopened.getSession(created.id))?.messages.find((message): message is Extract<typeof message, { kind: 'assistant' }> => message.id === assistant!.id && message.kind === 'assistant')?.feedback, 'like');
  });

  it('keeps the original browser input separate from Pi internal prompt context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-file-session-input-'));
    roots.push(root);
    const sessionDir = join(root, '.pi', 'sessions');
    const store = new PiFileSessionStore({ cwd: root, sessionDir });
    const created = await store.createSession('session-input');
    const manager = SessionManager.open(join(sessionDir, readdirSync(sessionDir)[0]!), sessionDir, root);
    manager.appendMessage({ role: 'user', content: 'ls -al\n\n这是一个 Pi Agent 验证工作台。项目资源目录摘要如下：{}', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '无法执行。' }], api: 'pi', provider: 'test', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    const projected = await store.getSession(created.id);
    assert.equal(projected?.messages[0]?.kind, 'user');
    assert.equal(projected?.messages[0]?.kind === 'user' ? projected.messages[0].text : '', 'ls -al');
  });
});
