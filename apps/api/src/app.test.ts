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
  const app = buildApp({ PORT: 4310, HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173', PI_AGENT_ENABLED: false, LOG_LEVEL: 'error' }, { sessionStore: sessions });

  before(async () => app.ready());
  after(async () => { await app.close(); sessions.close(); rmSync(sessionRoot, { recursive: true, force: true }); });

  it('returns a generic local workspace snapshot', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().workspace.name, 'Pi Workbench');
    assert.ok(response.json().metrics.totalRecords > 0);
    assert.ok(response.json().records.every((record: { id: string }) => record.id.startsWith('record-')));
  });

  it('queries local workspace records without a business domain', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace/records?search=Session' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].id, 'record-session-lifecycle');
  });

  it('lets the Agent boundary return local knowledge evidence when Pi is disabled', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', payload: { message: 'Pi session 生命周期是什么？', sessionId: 'test-session' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().route, 'knowledge');
    assert.match(response.json().sources[0].ref, /\.pi\/knowledge/);
    assert.deepEqual(response.json().decision, { decidedBy: 'fallback', toolCalls: [] });
    assert.equal(response.json().tools.policy, 'read-only');
    assert.equal(response.json().metrics.turn, 1);
    assert.equal(response.json().metrics.tokenUsage.source, 'estimated');
  });

  it('streams fallback text and a terminal response over SSE', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/chat/stream', payload: { message: 'Pi session 生命周期是什么？', sessionId: 'stream-test-session' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    assert.match(response.body, /event: start/);
    assert.match(response.body, /event: text_delta/);
    const doneBlock = response.body.split('\n\n').find((block) => block.includes('event: done'));
    if (!doneBlock) throw new Error('SSE done event missing');
    const dataLine = doneBlock.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) throw new Error('SSE done data missing');
    const streamedResponse = JSON.parse(dataLine.slice(5).trim()).response;
    assert.equal(streamedResponse.source, 'local-fallback');
    assert.equal(streamedResponse.metrics.executionRounds, 1);
  });

  it('creates ordered sessions and persists streamed history', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;
    const before = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions' });
    const beforeIds = before.json().items.map((session: { id: string }) => session.id);
    assert.ok(beforeIds.indexOf(firstId) < beforeIds.indexOf(secondId));
    await app.inject({ method: 'POST', url: '/api/v1/agent/chat/stream', payload: { message: '记录第一个会话', sessionId: firstId, turnId: 'turn-ordered' } });
    const list = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions' });
    assert.deepEqual(list.json().items.map((session: { id: string }) => session.id), beforeIds);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/agent/sessions/${firstId}` });
    assert.equal(detail.json().messages[0].kind, 'user');
    assert.equal(detail.json().messages[0].text, '记录第一个会话');
  });

  it('persists assistant feedback without changing session order', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions' });
    const sessionId = created.json().id as string;
    await app.inject({ method: 'POST', url: '/api/v1/agent/chat/stream', payload: { message: '给这条回答加反馈', sessionId, turnId: 'turn-feedback' } });
    const detail = await app.inject({ method: 'GET', url: `/api/v1/agent/sessions/${sessionId}` });
    const assistant = detail.json().messages.find((message: { kind: string }) => message.kind === 'assistant') as { id: string } | undefined;
    assert.ok(assistant);
    const liked = await app.inject({ method: 'PATCH', url: `/api/v1/agent/sessions/${sessionId}/messages/${assistant!.id}/feedback`, payload: { feedback: 'like' } });
    assert.equal(liked.statusCode, 200);
    assert.equal(liked.json().messages.find((message: { id: string }) => message.id === assistant!.id).feedback, 'like');
    const cleared = await app.inject({ method: 'PATCH', url: `/api/v1/agent/sessions/${sessionId}/messages/${assistant!.id}/feedback`, payload: { feedback: null } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().messages.find((message: { id: string }) => message.id === assistant!.id).feedback, undefined);
  });

  it('exposes the Pi workspace runtime contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/workspace' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path.includes('pi-workbench')));
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path === '.pi/README.md'));
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path.startsWith('.pi/sessions/')));
    assert.deepEqual(response.json().tools, { enabled: ['read', 'search_knowledge'], policy: 'read-only' });
    assert.equal(response.json().data.kind, 'local-sqlite');
  });

  it('reads an allowlisted project resource without exposing arbitrary paths', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/resource?path=.pi%2Fknowledge%2Fagent%2Fsession-lifecycle.md' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().resource.path, '.pi/knowledge/agent/session-lifecycle.md');
    assert.match(response.json().content, /session/i);

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/agent/resource?path=..%2F.env' });
    assert.equal(blocked.statusCode, 404);
  });

  it('exposes the local OKF-compatible knowledge bundle', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/knowledge' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().total >= 450);
    assert.ok(response.json().items.some((item: { path: string }) => item.path.includes('library/pi-runtime')));
    assert.equal(response.json().items[0].type, 'concept');
  });
});
