import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore } from '@pi-workbench/pi-agent';
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
  const app = buildApp(config, { sessionStore: sessions });

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
    const response = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', message: 'Pi session 生命周期是什么？' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    assert.match(response.body, /event: start/);
    assert.match(response.body, /"sessionId":"session_[a-f0-9-]+"/);
    assert.match(response.body, /event: error/);
    assert.match(response.body, /Pi 模型未启用/);
    assert.doesNotMatch(response.body, /event: done|fallback|降级/);
  });

  it('reuses an existing session for chat and reports cross-agent reuse as a conflict', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', sessionId: 'chat-bound-session', message: '你好' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"sessionId":"chat-bound-session"/);
    const persisted = await sessions.getSession('chat-bound-session', 'pi-assistant');
    assert.equal(persisted?.agentId, 'pi-assistant');

    // Binding lives in the JSONL file; pretending the same session belongs to
    // another agent id is rejected before any Pi runtime is touched.
    await sessions.createSession('other-agent', 'other-bound-session');
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { agentId: 'pi-assistant', sessionId: 'other-bound-session', message: '越权' } });
    assert.equal(mismatch.statusCode, 409);
  });
});
