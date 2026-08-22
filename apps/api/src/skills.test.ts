import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore, openWorkbenchDb } from '@pi-workbench/pi-agent';
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

describe('skills endpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-api-skills-'));
  const sessionRoot = mkdtempSync(join(tmpdir(), 'pi-api-skills-sessions-'));
  mkdirSync(join(root, '.agents', 'skills', 'web-research'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'skills', 'web-research', 'SKILL.md'),
    '---\nname: web-research\ndescription: 联网调研。\n---\n\n## 步骤\n\n1. 先搜索。\n',
  );
  writeFileSync(
    join(root, 'skills-lock.json'),
    JSON.stringify({ version: 1, skills: { 'web-research': { source: 'acme/skills' } } }),
  );

  const sessions = new AgentSessionStore({ cwd: root, sessionDir: sessionRoot });
  const db = openWorkbenchDb(':memory:');
  const app = buildApp(config, { cwd: root, sessionStore: sessions, db });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  it('GET /skills/installed lists skills with scope and lockfile source', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/skills/installed' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 1);
    assert.deepEqual(body.items[0].name, 'web-research');
    assert.equal(body.items[0].scope, 'agents');
    assert.equal(body.items[0].source, 'acme/skills');
  });

  it('GET /skills/installed/content returns the full body with frontmatter stripped', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/skills/installed/content?scope=agents&name=web-research' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.content, '## 步骤\n\n1. 先搜索。');
    assert.equal(body.frontmatter, 'name: web-research\ndescription: 联网调研。');
    assert.equal(body.source, 'acme/skills');
  });

  it('GET /skills/installed/content validates scope/name and 404s unknown skills', async () => {
    const badScope = await app.inject({ method: 'GET', url: '/api/v1/skills/installed/content?scope=elsewhere&name=web-research' });
    assert.equal(badScope.statusCode, 400);
    const traversal = await app.inject({ method: 'GET', url: `/api/v1/skills/installed/content?scope=agents&name=${encodeURIComponent('../settings')}` });
    assert.equal(traversal.statusCode, 400);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/skills/installed/content?scope=pi&name=web-research' });
    assert.equal(missing.statusCode, 404);
  });

  it('GET /skills/library/detail validates source/skillId before any fetch', async () => {
    const bad = await app.inject({ method: 'GET', url: `/api/v1/skills/library/detail?source=${encodeURIComponent('evil; rm -rf')}&skillId=x` });
    assert.equal(bad.statusCode, 400);
    const badId = await app.inject({ method: 'GET', url: '/api/v1/skills/library/detail?source=acme/skills&skillId=a/b' });
    assert.equal(badId.statusCode, 400);
  });
});
