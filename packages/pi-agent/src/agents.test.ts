import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, listPrompts, loadAgents, readPrompt } from './agents.js';
import { getPiProjectRoot } from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-agents-'));
  roots.push(root);
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  return root;
}

const VALID = `---
name: 测试助手
mark: 测
tagline: 测试
description: 测试用 agent。
suggestions:
  - 你好
---

你是测试助手。
`;

describe('agent registry', () => {
  it('loads the project agent definitions sorted by filename', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'beta-agent.md'), VALID);
    writeFileSync(join(root, '.pi', 'agents', 'alpha-agent.md'), VALID.replace('测试助手', '甲'));
    const agents = loadAgents(root);
    assert.deepEqual(agents.map((agent) => agent.id), ['alpha-agent', 'beta-agent']);
    assert.equal(agents[0]?.name, '甲');
    assert.equal(agents[0]?.path, '.pi/agents/alpha-agent.md');
    assert.deepEqual(agents[0]?.suggestions, ['你好']);
    assert.equal(agents[0]?.body, '你是测试助手。');
  });

  it('loads the real project agent', () => {
    const agents = loadAgents(getPiProjectRoot());
    assert.ok(agents.length >= 1);
    const assistant = getAgent(getPiProjectRoot(), 'pi-assistant');
    assert.equal(assistant.name, 'Pi 助手');
    assert.equal(assistant.mark, 'π');
    assert.ok(assistant.body.length > 0);
  });

  it('returns an empty list when .pi/agents is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-agents-empty-'));
    roots.push(root);
    assert.deepEqual(loadAgents(root), []);
  });

  it('rejects files with missing frontmatter fields', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'broken-agent.md'), VALID.replace('name: 测试助手\n', ''));
    assert.throws(() => loadAgents(root), /name/);
  });

  it('rejects files without a system prompt body', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'empty-agent.md'), VALID.replace('你是测试助手。', ''));
    assert.throws(() => loadAgents(root), /正文/);
  });

  it('rejects files with invalid suggestions', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'bad-suggestions.md'), VALID.replace('suggestions:\n  - 你好', 'suggestions: 你好'));
    assert.throws(() => loadAgents(root), /suggestions/);
  });

  it('rejects filenames that are not valid agent ids', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'Bad Agent.md'), VALID);
    assert.throws(() => loadAgents(root), /合法 id/);
  });
});

describe('prompt templates', () => {
  it('lists project prompts with metadata', () => {
    const prompts = listPrompts(getPiProjectRoot());
    const explain = prompts.find((prompt) => prompt.name === 'explain');
    assert.ok(explain);
    assert.equal(explain.path, '.pi/prompts/explain.md');
    assert.ok(explain.description);
  });

  it('reads a prompt body without frontmatter and rejects traversal names', () => {
    const document = readPrompt(getPiProjectRoot(), 'explain');
    assert.ok(document);
    assert.ok(!document.content.startsWith('---'));
    assert.match(document.content, /请解释/);
    assert.equal(readPrompt(getPiProjectRoot(), '../settings'), undefined);
    assert.equal(readPrompt(getPiProjectRoot(), 'missing-prompt'), undefined);
  });
});
