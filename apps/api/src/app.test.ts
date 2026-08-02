import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';

describe('Pi Workbench API', () => {
  const app = buildApp({ PORT: 4310, HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173', PI_AGENT_ENABLED: false, LOG_LEVEL: 'error' });

  before(async () => app.ready());
  after(async () => app.close());

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
    assert.equal(JSON.parse(dataLine.slice(5).trim()).response.source, 'local-fallback');
  });

  it('exposes the Pi workspace runtime contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/workspace' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().resources.some((resource: { path: string }) => resource.path.includes('pi-workbench')));
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
