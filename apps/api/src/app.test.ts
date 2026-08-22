import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore, loadAgents, openWorkbenchDb, piSessionRegistry, recordUsageEvent } from '@pi-workbench/pi-agent';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  PI_AGENT_ENABLED: false,
  PI_PROJECT_EXTENSIONS_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('Pi Workbench API', () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'pi-api-sessions-'));
  const sessions = new AgentSessionStore({ cwd: process.cwd(), sessionDir: sessionRoot });
  const app = buildApp(config, { sessionStore: sessions, db: openWorkbenchDb(':memory:') });

  before(async () => app.ready());
  after(async () => { await app.close(); rmSync(sessionRoot, { recursive: true, force: true }); });

  it('serves a health probe', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  });

  it('returns the workspace bootstrap with agents, prompts and models', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.agents.some((agent: { id: string }) => agent.id === 'pi-assistant'));
    assert.ok(body.agents.every((agent: { body?: unknown }) => agent.body === undefined));
    assert.ok(body.prompts.some((prompt: { name: string; path: string }) => prompt.name === 'explain' && prompt.path === '.pi/prompts/explain.md'));
    const modelIds = body.models.available.map((model: { id: string }) => model.id);
    assert.ok(modelIds.includes('kimi-for-coding'));
    assert.ok(body.models.current.model);
  });

  it('returns the agent detail with its system prompt body', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().name, 'Pi 助手');
    assert.ok(response.json().body.length > 0);
    assert.equal(response.json().path, '.pi/agents/pi-assistant.md');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/agents/no-such-agent' });
    assert.equal(missing.statusCode, 404);
    assert.equal(typeof missing.json().error, 'string');
  });

  it('serves project resources and run statistics per agent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/resources' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.prompts.some((prompt: { name: string; path: string }) => prompt.name === 'explain' && prompt.path === '.pi/prompts/explain.md'));
    assert.ok(Array.isArray(body.skills));
    assert.equal(typeof body.appendSystem, 'boolean');
    assert.equal(typeof body.stats.sessionCount, 'number');
    assert.equal(typeof body.stats.questionCount, 'number');
    assert.ok(body.stats.questionCount >= 0 && body.stats.sessionCount >= 0);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/agents/no-such-agent/resources' });
    assert.equal(missing.statusCode, 404);
  });

  it('creates, lists, renames and deletes sessions per agent', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/agents/pi-assistant/sessions' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/agents/pi-assistant/sessions' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;
    assert.equal(first.json().agentId, 'pi-assistant');

    const list = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/sessions' });
    const ids = list.json().items.map((session: { id: string }) => session.id);
    assert.ok(ids.indexOf(firstId) < ids.indexOf(secondId));

    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/agents/pi-assistant/sessions/${firstId}`, payload: { title: '架构讨论' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().title, '架构讨论');

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/agents/pi-assistant/sessions/${firstId}` });
    assert.equal(removed.statusCode, 204);
    const missing = await app.inject({ method: 'GET', url: `/api/v1/agents/pi-assistant/sessions/${firstId}` });
    assert.equal(missing.statusCode, 404);
  });

  it('rename 排在同一 session 的 in-flight 任务之后，不与进行中的写并发', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agents/pi-assistant/sessions' });
    const sessionId = created.json().id as string;

    // 模拟一个占住该 session 串行队列的进行中 turn（registry 与路由共用同一 KeyedExecutor）。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = piSessionRegistry.runExclusive('pi-assistant', sessionId, () => gate);

    let renameSettled = false;
    const renamed = app
      .inject({ method: 'PATCH', url: `/api/v1/agents/pi-assistant/sessions/${sessionId}`, payload: { title: '稍后落盘' } })
      .then((response) => { renameSettled = true; return response; });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(renameSettled, false, 'in-flight 任务未结束时 rename 不能抢先写入');

    release();
    await inFlight;
    const response = await renamed;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().title, '稍后落盘');

    // 串行化生效后 JSONL 不会交错：每一行都必须可独立解析。
    const { readdirSync, readFileSync } = await import('node:fs');
    const file = readdirSync(sessionRoot)
      .map((name) => join(sessionRoot, name))
      .find((path) => path.endsWith('.jsonl') && readFileSync(path, 'utf8').includes(`"${sessionId}"`));
    assert.ok(file);
    for (const line of readFileSync(file, 'utf8').trim().split('\n')) assert.ok(JSON.parse(line));
  });

  it('lists only attention sessions in the inbox, newest first', async () => {
    const { appendFileSync, readdirSync, readFileSync } = await import('node:fs');
    const ok = await sessions.createSession('pi-assistant', 'inbox-ok');
    const failed = await sessions.createSession('other-agent', 'inbox-failed');
    assert.ok(ok && failed);

    // apps/api 不直接依赖 Pi SDK：直接向 JSONL 追加一条出错的 assistant message entry。
    const file = readdirSync(sessionRoot)
      .map((name) => join(sessionRoot, name))
      .find((path) => path.endsWith('.jsonl') && readFileSync(path, 'utf8').includes('"inbox-failed"'));
    assert.ok(file);
    const message = {
      role: 'assistant', content: [], api: 'messages', provider: 'kimi-coding', model: 'kimi-for-coding',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error', errorMessage: '模型超时', timestamp: Date.now(),
    };
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'msg_err1', parentId: null, timestamp: new Date().toISOString(), message })}\n`);

    const response = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    assert.equal(response.statusCode, 200);
    const items = response.json().items as Array<{ id: string; needsAttention: boolean; attentionReason?: string }>;
    assert.deepEqual(items.map((item) => item.id), ['inbox-failed']);
    assert.equal(items[0]!.needsAttention, true);
    assert.equal(items[0]!.attentionReason, 'error');
  });

  it('replays persisted session messages and enforces the binding contract', async () => {
    const created = await sessions.createSession('pi-assistant', 'replay-api-session');
    assert.ok(created);
    const { appendFileSync, readdirSync, readFileSync } = await import('node:fs');
    const file = readdirSync(sessionRoot)
      .map((name) => join(sessionRoot, name))
      .find((path) => path.endsWith('.jsonl') && readFileSync(path, 'utf8').includes('"replay-api-session"'));
    assert.ok(file);
    const entry = (id: string, message: unknown) =>
      appendFileSync(file!, `${JSON.stringify({ type: 'message', id, parentId: null, timestamp: new Date().toISOString(), message })}\n`);
    entry('msg_u1', { role: 'user', content: [{ type: 'text', text: '历史问题' }], timestamp: Date.now() });
    entry('msg_a1', {
      role: 'assistant', content: [{ type: 'text', text: '历史回答' }], api: 'messages', provider: 'kimi-coding', model: 'kimi-for-coding',
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/sessions/replay-api-session/messages' });
    assert.equal(response.statusCode, 200);
    const items = response.json().items as Array<{ id: string; role: string; content: string; usage?: { total: number } }>;
    assert.deepEqual(items.map((item) => item.id), ['msg_u1', 'msg_a1']);
    assert.equal(items[0]!.content, '历史问题');
    assert.equal(items[1]!.usage?.total, 9);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/sessions/no-such-session/messages' });
    assert.equal(missing.statusCode, 404);
    const unknownAgent = await app.inject({ method: 'GET', url: '/api/v1/agents/no-such-agent/sessions/replay-api-session/messages' });
    assert.equal(unknownAgent.statusCode, 404);

    await sessions.createSession('other-agent', 'replay-foreign-session');
    const mismatch = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/sessions/replay-foreign-session/messages' });
    assert.equal(mismatch.statusCode, 409);
  });

  it('isolates sessions between agents and rejects unknown agents', async () => {
    // A session bound to another agent id never leaks into pi-assistant listings.
    await sessions.createSession('other-agent', 'foreign-session');
    const list = await app.inject({ method: 'GET', url: '/api/v1/agents/pi-assistant/sessions' });
    assert.ok(list.json().items.every((session: { agentId: string }) => session.agentId === 'pi-assistant'));

    const unknown = await app.inject({ method: 'POST', url: '/api/v1/agents/unknown-agent/sessions' });
    assert.equal(unknown.statusCode, 404);
  });

  it('reads prompt bodies without frontmatter and rejects arbitrary paths', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prompts/explain' });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.json().content.startsWith('---'));
    assert.match(response.json().content, /请解释/);

    const traversal = await app.inject({ method: 'GET', url: '/api/v1/prompts/..%2Fsettings' });
    assert.equal(traversal.statusCode, 400);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/prompts/no-such-prompt' });
    assert.equal(missing.statusCode, 404);
  });

  it('validates chat requests and rejects models outside the catalog', async () => {
    const missingMessage = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant' } });
    assert.equal(missingMessage.statusCode, 400);
    const invalidThinking = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', message: '你好', thinking: 'auto' } });
    assert.equal(invalidThinking.statusCode, 400);
    const unknownModel = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', message: '你好', model: 'no-such-model' } });
    assert.equal(unknownModel.statusCode, 400);
    assert.match(unknownModel.json().error, /no-such-model/);
    const unknownAgent = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'no-such-agent', message: '你好' } });
    assert.equal(unknownAgent.statusCode, 404);
  });

  it('streams an explicit error when Pi is disabled instead of a fallback answer', async () => {
    const before = (await sessions.listSessions('pi-assistant')).length;
    const response = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', message: 'Pi session 生命周期是什么？' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    assert.match(response.body, /event: error/);
    assert.match(response.body, /Pi 模型未启用/);
    // Pi 未启用时不创建空会话，也没有 start/done 事件。
    assert.doesNotMatch(response.body, /event: start|event: done|fallback|降级/);
    assert.equal((await sessions.listSessions('pi-assistant')).length, before);
  });

  it('rejects cross-agent chat reuse as a conflict before any Pi runtime work', async () => {
    // 绑定关系在 hijack 前校验：同 Agent 的既有会话不会被误判。
    await sessions.createSession('pi-assistant', 'chat-bound-session');
    const owned = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', sessionId: 'chat-bound-session', message: '你好' } });
    assert.equal(owned.statusCode, 200, '同 Agent 复用不应 409（Pi 未启用时走流内错误）');
    const persisted = await sessions.getSession('chat-bound-session', 'pi-assistant');
    assert.equal(persisted?.agentId, 'pi-assistant');

    // Binding lives in the JSONL file; pretending the same session belongs to
    // another agent id is rejected before any Pi runtime is touched.
    await sessions.createSession('other-agent', 'other-bound-session');
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', sessionId: 'other-bound-session', message: '越权' } });
    assert.equal(mismatch.statusCode, 409);
  });
});

describe('Usage and settings endpoints', () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'pi-api-usage-'));
  const sessions = new AgentSessionStore({ cwd: process.cwd(), sessionDir: sessionRoot });
  const db = openWorkbenchDb(':memory:');
  const app = buildApp(config, { sessionStore: sessions, db });

  before(async () => app.ready());
  after(async () => { await app.close(); rmSync(sessionRoot, { recursive: true, force: true }); });

  /** Appends a persisted user message so questionCount reflects it. */
  const appendUserMessage = async (sessionId: string, text: string) => {
    const { appendFileSync, readdirSync, readFileSync } = await import('node:fs');
    const file = readdirSync(sessionRoot)
      .map((name) => join(sessionRoot, name))
      .find((path) => path.endsWith('.jsonl') && readFileSync(path, 'utf8').includes(`"${sessionId}"`));
    assert.ok(file, `未找到会话文件：${sessionId}`);
    const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: `msg_${sessionId}`, parentId: null, timestamp: new Date().toISOString(), message })}\n`);
  };

  it('aggregates usage numbers consistent with the session store', async () => {
    await sessions.createSession('pi-assistant', 'usage-a');
    await sessions.createSession('pi-assistant', 'usage-b');
    await appendUserMessage('usage-a', '第一问');
    await appendUserMessage('usage-a', '第二问');
    await appendUserMessage('usage-b', '第三问');

    const response = await app.inject({ method: 'GET', url: '/api/v1/usage' });
    assert.equal(response.statusCode, 200);
    const body = response.json();

    const all = await sessions.listSessions();
    assert.equal(body.totalSessions, all.length);
    assert.equal(body.totalQuestions, all.reduce((sum, session) => sum + session.questionCount, 0));
    assert.ok(body.agentCount >= 1);
    assert.equal(body.agentCount, body.perAgent.length);
    // 测试里的会话都是今天创建的，今日提问数等于累计提问数。
    assert.equal(body.questionsToday, body.totalQuestions);
    assert.equal(body.totalQuestions, 3);

    const row = body.perAgent.find((item: { agentId: string }) => item.agentId === 'pi-assistant');
    assert.equal(row.sessionCount, 2);
    assert.equal(row.questionCount, 3);
    assert.equal(typeof row.lastActiveAt, 'string');
    assert.ok(body.perAgent.every((item: { lastActiveAt?: string; sessionCount: number }) => item.sessionCount > 0 === Boolean(item.lastActiveAt)));
  });

  it('overlays token totals recorded in the SQLite usage_events projection', async () => {
    recordUsageEvent(db, { sessionId: 'usage-a', agentId: 'pi-assistant', model: 'kimi-for-coding', input: 120, output: 30, total: 200 });
    recordUsageEvent(db, { sessionId: 'usage-b', agentId: 'pi-assistant', input: 5, output: 5, total: 10 });

    const response = await app.inject({ method: 'GET', url: '/api/v1/usage' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.tokens, { input: 125, output: 35, total: 210 });
    const row = body.perAgent.find((item: { agentId: string }) => item.agentId === 'pi-assistant');
    assert.deepEqual(row.tokens, { input: 125, output: 35, total: 210 });
    const idle = body.perAgent.find((item: { agentId: string; sessionCount: number }) => item.sessionCount === 0);
    if (idle) assert.deepEqual(idle.tokens, { input: 0, output: 0, total: 0 });
  });

  it('serves non-sensitive settings without any credential fields', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(response.statusCode, 200);
    const body = response.json();

    assert.ok(body.model.model);
    assert.ok(Array.isArray(body.model.available));
    assert.ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.thinkingLevel));
    assert.equal(typeof body.resources.agents, 'number');
    assert.ok(body.resources.agents >= 1 && body.resources.prompts >= 1 && body.resources.skills >= 0);
    assert.equal(typeof body.resources.appendSystem, 'boolean');
    assert.equal(body.workspace.name, 'pi-samples');
    assert.equal(typeof body.workspace.sessionDir, 'string');

    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /apiKey|api_key|secret|token|password/i);
  });
});

describe('Preferences endpoints', () => {
  const db = openWorkbenchDb(':memory:');
  const app = buildApp(config, { db });

  before(async () => app.ready());
  after(async () => { await app.close(); });

  it('round-trips namespaced preferences and rejects unknown key shapes', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/v1/preferences' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: {} });

    const written = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'ui.compact-messages', value: true } });
    assert.equal(written.statusCode, 200);
    assert.equal(written.json().items['ui.compact-messages'], true);

    await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'thinking.pi-assistant', value: 'minimal' } });
    const read = await app.inject({ method: 'GET', url: '/api/v1/preferences' });
    assert.deepEqual(read.json().items, { 'ui.compact-messages': true, 'thinking.pi-assistant': 'minimal' });

    const badKey = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'pi.settings', value: {} } });
    assert.equal(badKey.statusCode, 400);
  });

  it('validates model.* preferences against the model catalog and deletes on empty value', async () => {
    const written = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'model.pi-assistant', value: 'kimi-for-coding' } });
    assert.equal(written.statusCode, 200);
    assert.equal(written.json().items['model.pi-assistant'], 'kimi-for-coding');

    const unknownModel = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'model.pi-assistant', value: 'no-such-model' } });
    assert.equal(unknownModel.statusCode, 400);
    assert.match(unknownModel.json().error, /no-such-model/);
    const nonString = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'model.pi-assistant', value: 42 } });
    assert.equal(nonString.statusCode, 400);

    // 空串 = 跟随全局默认：行被真正删除而不是存一个空值。
    const cleared = await app.inject({ method: 'PUT', url: '/api/v1/preferences', payload: { key: 'model.pi-assistant', value: '' } });
    assert.equal(cleared.statusCode, 200);
    assert.ok(!('model.pi-assistant' in cleared.json().items));
  });
});

describe('Prompt and append-system editing endpoints', () => {
  // A scratch project root keeps these tests away from the real .pi/prompts files.
  const root = mkdtempSync(join(tmpdir(), 'pi-api-resources-'));
  mkdirSync(join(root, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(root, '.pi', 'prompts', 'edit-me.md'), '---\ndescription: 旧描述\n---\n\n旧正文。\n');
  const app = buildApp(config, { cwd: root, db: openWorkbenchDb(':memory:') });

  before(async () => app.ready());
  after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

  it('updates a prompt via PUT and keeps the frontmatter round-trip', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/prompts/edit-me', payload: { content: '新正文。', description: '新描述' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().content, '新正文。');
    assert.equal(response.json().description, '新描述');

    const reread = await app.inject({ method: 'GET', url: '/api/v1/prompts/edit-me' });
    assert.equal(reread.statusCode, 200);
    assert.equal(reread.json().content, '新正文。');
    assert.equal(reread.json().description, '新描述');
  });

  it('maps missing prompts to 404 and rejects traversal names at the schema', async () => {
    const missing = await app.inject({ method: 'PUT', url: '/api/v1/prompts/no-such-prompt', payload: { content: '正文' } });
    assert.equal(missing.statusCode, 404);
    const traversal = await app.inject({ method: 'PUT', url: '/api/v1/prompts/..%2Fsettings', payload: { content: '正文' } });
    assert.equal(traversal.statusCode, 400);
    const emptyBody = await app.inject({ method: 'PUT', url: '/api/v1/prompts/edit-me', payload: { content: '' } });
    assert.equal(emptyBody.statusCode, 400);
  });

  it('round-trips append-system and deletes the file on empty content', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/append-system' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().content, null);

    const written = await app.inject({ method: 'PUT', url: '/api/v1/append-system', payload: { content: '  全局规则。\n' } });
    assert.equal(written.statusCode, 200);
    assert.equal(written.json().content, '全局规则。');
    assert.ok(existsSync(join(root, '.pi', 'APPEND_SYSTEM.md')));
    const reread = await app.inject({ method: 'GET', url: '/api/v1/append-system' });
    assert.equal(reread.json().content, '全局规则。');

    const cleared = await app.inject({ method: 'PUT', url: '/api/v1/append-system', payload: { content: '   ' } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().content, null);
    assert.equal(existsSync(join(root, '.pi', 'APPEND_SYSTEM.md')), false);
  });
});

describe('Explore endpoints', () => {
  // A scratch project root keeps these tests away from the real .pi/agents files.
  const root = mkdtempSync(join(tmpdir(), 'pi-api-explore-'));
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  mkdirSync(join(root, '.pi', 'skills'), { recursive: true });
  const app = buildApp(config, { cwd: root, db: openWorkbenchDb(':memory:') });

  const templateBody = {
    name: '翻译助手 Pro',
    mark: '译',
    tagline: '双语互译',
    description: '在中英文之间互译。',
    suggestions: ['把这段话译成英文'],
    body: '你是翻译助手，专注中英互译。',
  };

  before(async () => app.ready());
  after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

  it('creates an agent file that the registry can load back', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, id: 'translator-pro' } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().id, 'translator-pro');
    const reloaded = loadAgents(root).find((agent) => agent.id === 'translator-pro');
    assert.equal(reloaded?.name, templateBody.name);
    assert.deepEqual(reloaded?.suggestions, templateBody.suggestions);
    assert.equal(reloaded?.body, templateBody.body);
  });

  it('rejects id conflicts with 409 and never overwrites', async () => {
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, id: 'translator-pro' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(typeof conflict.json().error, 'string');
  });

  it('rejects invalid ids and oversized bodies with 400', async () => {
    const badId = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, id: 'Bad Id' } });
    assert.equal(badId.statusCode, 400);
    const underivable = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, name: '翻译助手' } });
    assert.equal(underivable.statusCode, 400);
    const tooLarge = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, id: 'big-body', body: '长'.repeat(40 * 1024) } });
    assert.equal(tooLarge.statusCode, 400);
  });

  it('derives the id from ascii names when omitted', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { ...templateBody, name: 'Review Buddy' } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().id, 'review-buddy');
  });

  it('updates an agent via PATCH and keeps untouched fields', async () => {
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/agents/translator-pro', payload: { tagline: '双语互译 Pro', suggestions: ['翻成英文', '翻成中文'] } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().id, 'translator-pro');
    assert.equal(updated.json().tagline, '双语互译 Pro');
    assert.deepEqual(updated.json().suggestions, ['翻成英文', '翻成中文']);
    assert.equal(updated.json().name, templateBody.name);
    assert.equal(updated.json().body, templateBody.body);
    const reloaded = loadAgents(root).find((agent) => agent.id === 'translator-pro');
    assert.equal(reloaded?.tagline, '双语互译 Pro');
  });

  it('PATCH maps missing agents to 404 and invalid patches to 400', async () => {
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/agents/ghost-agent', payload: { name: '幽灵' } });
    assert.equal(missing.statusCode, 404);
    assert.equal(typeof missing.json().error, 'string');
    const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/agents/translator-pro', payload: { name: '两行\n名称' } });
    assert.equal(invalid.statusCode, 400);
    const oversized = await app.inject({ method: 'PATCH', url: '/api/v1/agents/translator-pro', payload: { body: '长'.repeat(40 * 1024) } });
    assert.equal(oversized.statusCode, 400);
    const badSchema = await app.inject({ method: 'PATCH', url: '/api/v1/agents/translator-pro', payload: { suggestions: [] } });
    assert.equal(badSchema.statusCode, 400);
  });

  it('serves the built-in agent templates', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/templates' });
    assert.equal(response.statusCode, 200);
    const items = response.json().items as Array<{ id: string; name: string; body: string; suggestions: string[] }>;
    assert.ok(items.length >= 4);
    assert.ok(items.some((item) => item.id === 'translator-pro' && item.name === '翻译助手'));
    for (const item of items) {
      assert.match(item.id, /^[a-z][a-z0-9-]{1,63}$/);
      assert.ok(item.body.trim().length > 0 && item.suggestions.length > 0);
    }
  });

  it('lists skills: empty directory yields [], SKILL.md entries get parsed', async () => {    const empty = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [], total: 0 });

    mkdirSync(join(root, '.pi', 'skills', 'research'), { recursive: true });
    writeFileSync(join(root, '.pi', 'skills', 'research', 'SKILL.md'), '---\nname: 调研助手\ndescription: 桌面调研。\n---\n\n先搜一手来源。\n');
    const filled = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    assert.equal(filled.statusCode, 200);
    const items = filled.json().items as Array<{ name: string; path: string; description?: string; preview?: string }>;
    assert.equal(filled.json().total, 1);
    assert.equal(items[0]?.name, '调研助手');
    assert.equal(items[0]?.path, '.pi/skills/research/SKILL.md');
    assert.equal(items[0]?.description, '桌面调研。');
    assert.equal(items[0]?.preview, '先搜一手来源。');
  });

  it('workspace agents carry a real session count', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace' });
    assert.equal(response.statusCode, 200);
    const agents = response.json().agents as Array<{ id: string; sessionCount?: number }>;
    assert.ok(agents.length >= 2);
    assert.ok(agents.every((agent) => typeof agent.sessionCount === 'number'));
  });
});
