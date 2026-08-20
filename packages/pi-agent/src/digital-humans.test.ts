import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPiProjectRoot } from './index.js';
import { loadDigitalHumans } from './digital-humans.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('digital human registry', () => {
  it('loads ordered personas and derives tools from host capability profiles', () => {
    const definitions = loadDigitalHumans(getPiProjectRoot());
    assert.deepEqual(definitions.map((item) => item.id), ['project-steward', 'commerce-analyst']);
    assert.deepEqual(definitions[0]?.tools, ['read', 'search_knowledge']);
    assert.deepEqual(definitions[1]?.tools, ['read', 'query_business_data']);
    assert.equal(definitions[0]?.acceptsSkill('pi-workbench'), true);
    assert.equal(definitions[0]?.acceptsSkill('future-project-skill'), false);
    assert.equal(definitions[1]?.acceptsSkill('business-intelligence'), true);
    assert.match(definitions[1]?.systemPrompt ?? '', /你是林澈/);
  });

  it('rejects profile files that try to declare tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-digital-human-'));
    roots.push(root);
    const directory = join(root, '.pi', 'digital-humans');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'unsafe.json'), JSON.stringify({ schemaVersion: 1, order: 1, id: 'unsafe-human', displayName: '越权角色', role: '测试', tagline: '测试', description: '测试', capabilityProfile: 'project-knowledge', tools: ['bash'], avatar: { initials: '危', accent: 'rose' }, persona: { identity: '测试身份', mission: '测试使命', traits: ['测试'], communicationStyle: '测试风格', principles: ['测试原则'] }, welcome: { title: '测试', description: '测试', suggestions: ['测试'] } }));
    assert.throws(() => loadDigitalHumans(root), /未授权字段 tools/);
  });
});
