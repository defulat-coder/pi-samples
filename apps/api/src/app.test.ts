import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiFileSessionStore } from '@pi-workbench/pi-agent';

describe('Pi Workbench API', () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'pi-file-sessions-'));
  const sessions = new PiFileSessionStore({ cwd: process.cwd(), sessionDir: sessionRoot });
  const app = buildApp({ PORT: 4310, HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173', AUTH_REQUIRED: false, PI_AGENT_ENABLED: false, PI_PROJECT_EXTENSIONS_ENABLED: false, LOG_LEVEL: 'error' }, { sessionStore: sessions });

  before(async () => app.ready());
  after(async () => { await app.close(); sessions.close(); rmSync(sessionRoot, { recursive: true, force: true }); });

  it('returns a generic local workspace snapshot', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().workspace.name, 'Pi Workbench');
    assert.ok(response.json().metrics.totalRecords > 0);
    assert.ok(response.json().records.every((record: { id: string }) => record.id.startsWith('record-')));
  });

  it('exposes the Feishu login status without exposing provider credentials', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { provider: 'feishu', configured: false, authRequired: false, authenticated: false, message: '请先在 API 环境变量中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。' });

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/feishu/start' });
    assert.equal(start.statusCode, 503);
    assert.equal(start.json().error, 'AuthNotConfigured');
    assert.doesNotMatch(start.body, /9ZHZzyUa8bV6H1Z8jc0KbhiNafWnYYMS/);
  });

  it('protects workbench routes when Feishu auth is required', async () => {
    const protectedApp = buildApp({ PORT: 4310, HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173', AUTH_REQUIRED: true, PI_AGENT_ENABLED: false, PI_PROJECT_EXTENSIONS_ENABLED: false, LOG_LEVEL: 'error' }, { sessionStore: sessions });
    await protectedApp.ready();
    const response = await protectedApp.inject({ method: 'GET', url: '/api/v1/digital-humans/workspace' });
    await protectedApp.close();
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'Unauthenticated');
  });

  it('builds the official Feishu authorization URL when configured', async () => {
    const oauthApp = buildApp({ PORT: 4310, HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173', AUTH_REQUIRED: true, FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test-secret', PI_AGENT_ENABLED: false, PI_PROJECT_EXTENSIONS_ENABLED: false, LOG_LEVEL: 'error' }, { sessionStore: sessions });
    await oauthApp.ready();
    const response = await oauthApp.inject({ method: 'GET', url: '/api/v1/auth/feishu/start' });
    await oauthApp.close();
    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers.location), /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize/);
    assert.match(String(response.headers.location), /client_id=cli_test_app/);
    assert.match(String(response.headers.location), /response_type=code/);
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
  });

  it('queries local workspace records without a business domain', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace/records?search=Session' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].id, 'record-session-lifecycle');
  });

  it('fails explicitly when Pi is disabled instead of producing a fallback answer', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/chat', payload: { message: 'Pi session 生命周期是什么？', digitalHumanId: 'project-steward', sessionId: 'test-session' } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'InternalError');
    assert.doesNotMatch(response.body, /local-fallback|本地降级/);
  });

  it('requires a digital human identity and validates thinking modes', async () => {
    const missingIdentity = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/chat', payload: { message: '缺少数字人' } });
    assert.equal(missingIdentity.statusCode, 400);
    const invalidThinking = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/chat', payload: { message: '非法思考级别', digitalHumanId: 'project-steward', thinkingLevel: 'auto' } });
    assert.equal(invalidThinking.statusCode, 400);
  });

  it('streams an explicit error when Pi is disabled', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/chat/stream', payload: { message: 'Pi session 生命周期是什么？', digitalHumanId: 'project-steward', sessionId: 'stream-test-session' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    assert.match(response.body, /event: start/);
    assert.match(response.body, /event: error/);
    assert.doesNotMatch(response.body, /event: done|local-fallback/);
  });

  it('creates ordered digital human sessions', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/sessions', payload: { digitalHumanId: 'project-steward' } });
    const second = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/sessions', payload: { digitalHumanId: 'project-steward' } });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;
    const before = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/sessions?digitalHumanId=project-steward' });
    const beforeIds = before.json().items.map((session: { id: string }) => session.id);
    assert.ok(beforeIds.indexOf(firstId) < beforeIds.indexOf(secondId));
  });

  it('loads file-defined digital humans and isolates their sessions', async () => {
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/digital-humans' });
    assert.deepEqual(catalog.json().items.map((item: { id: string }) => item.id), ['project-steward', 'commerce-analyst']);
    assert.equal(catalog.json().items[1].displayName, '林澈');
    assert.deepEqual(catalog.json().items[1].avatar, { initials: '林', accent: 'teal' });

    const analyst = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/sessions', payload: { digitalHumanId: 'commerce-analyst' } });
    assert.equal(analyst.statusCode, 200);
    assert.equal(analyst.json().digitalHumanId, 'commerce-analyst');
    const analystId = analyst.json().id as string;
    const analystSessions = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/sessions?digitalHumanId=commerce-analyst' });
    assert.ok(analystSessions.json().items.every((session: { digitalHumanId: string }) => session.digitalHumanId === 'commerce-analyst'));

    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/chat', payload: { message: '解释项目', digitalHumanId: 'project-steward', sessionId: analystId } });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().error, 'DigitalHumanSessionMismatch');
    const crossRead = await app.inject({ method: 'GET', url: `/api/v1/digital-humans/sessions/${analystId}?digitalHumanId=project-steward` });
    assert.equal(crossRead.statusCode, 409);
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/sessions', payload: { digitalHumanId: 'unknown-human' } });
    assert.equal(unknown.statusCode, 404);
  });

  it('does not expose the removed Agent HTTP contract', async () => {
    const workspace = await app.inject({ method: 'GET', url: '/api/v1/agent/workspace' });
    const chat = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', payload: { message: '旧请求' } });
    assert.equal(workspace.statusCode, 404);
    assert.equal(chat.statusCode, 404);
  });

  it('renames and deletes persisted sessions', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/digital-humans/sessions', payload: { digitalHumanId: 'project-steward' } });
    const sessionId = created.json().id as string;
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/digital-humans/sessions/${sessionId}`, payload: { digitalHumanId: 'project-steward', title: '项目架构讨论' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().title, '项目架构讨论');

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/digital-humans/sessions/${sessionId}?digitalHumanId=project-steward` });
    assert.equal(removed.statusCode, 204);
    const missing = await app.inject({ method: 'GET', url: `/api/v1/digital-humans/sessions/${sessionId}?digitalHumanId=project-steward` });
    assert.equal(missing.statusCode, 404);
  });

  it('exposes the Pi workspace runtime contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/workspace' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path.includes('pi-workbench')));
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path === '.pi/README.md'));
    assert.ok(response.json().resources.every((resource: { path: string }) => !resource.path.startsWith('.pi/sessions/')));
    assert.ok(response.json().resources.some((resource: { path: string; kind: string }) => resource.path === '.pi/settings.json' && resource.kind === 'settings'));
    assert.ok(response.json().resources.some((resource: { path: string; kind: string }) => resource.path === '.pi/APPEND_SYSTEM.md' && resource.kind === 'system'));
    assert.ok(response.json().resources.some((resource: { path: string; kind: string }) => resource.path === '.pi/digital-humans/commerce-analyst.json' && resource.kind === 'digital-human'));
    assert.equal(response.json().pi.extensionsEnabled, false);
    assert.ok(response.json().pi.skills.some((skill: { name: string }) => skill.name === 'pi-session-observability'));
    assert.ok(response.json().pi.prompts.some((prompt: { name: string }) => prompt.name === 'inspect-pi'));
    assert.ok(response.json().pi.themes.some((theme: { name: string }) => theme.name === 'pi-workbench-neutral'));
    assert.deepEqual(response.json().tools, { enabled: ['read', 'search_knowledge', 'query_business_data'], policy: 'read-only' });
    assert.deepEqual(response.json().digitalHumans.map((item: { id: string }) => item.id), ['project-steward', 'commerce-analyst']);
    assert.equal(response.json().data.kind, 'local-sqlite');
  });

  it('reads an allowlisted project resource without exposing arbitrary paths', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/resource?path=.pi%2Fknowledge%2Fagent%2Fsession-lifecycle.md' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().resource.path, '.pi/knowledge/agent/session-lifecycle.md');
    assert.match(response.json().content, /session/i);

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/resource?path=..%2F.env' });
    assert.equal(blocked.statusCode, 404);
    const sessionBlocked = await app.inject({ method: 'GET', url: '/api/v1/digital-humans/resource?path=.pi%2Fsessions%2Fprivate.jsonl' });
    assert.equal(sessionBlocked.statusCode, 404);
  });

  it('exposes the local OKF-compatible knowledge bundle', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/knowledge' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().total >= 450);
    assert.ok(response.json().items.some((item: { path: string }) => item.path.includes('library/pi-runtime')));
    assert.equal(response.json().items[0].type, 'concept');
  });
});
