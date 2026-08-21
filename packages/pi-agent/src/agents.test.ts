import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCreateError, createAgent, deriveAgentId, getAgent, listPrompts, listSkills, loadAgents, readPrompt } from './agents.js';
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
    assert.ok(explain.preview && !explain.preview.startsWith('---'));
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

describe('createAgent', () => {
  const input = {
    name: '翻译助手 Pro',
    mark: '译',
    tagline: '双语互译',
    description: '在中英文之间互译，保留语气。',
    suggestions: ['把这段话译成英文'],
    body: '你是翻译助手，专注中英互译。',
  };

  it('writes .pi/agents/<id>.md with parseable frontmatter', () => {
    const root = fixtureRoot();
    const agent = createAgent(root, { ...input, id: 'translator-pro' });
    assert.equal(agent.id, 'translator-pro');
    assert.equal(agent.path, '.pi/agents/translator-pro.md');
    const reloaded = getAgent(root, 'translator-pro');
    assert.equal(reloaded.name, input.name);
    assert.deepEqual(reloaded.suggestions, input.suggestions);
    assert.equal(reloaded.body, input.body);
  });

  it('derives the id from ascii names and rejects underivable ones', () => {
    assert.equal(deriveAgentId('Code Review Bot'), 'code-review-bot');
    assert.equal(deriveAgentId('翻译助手'), undefined);
    const root = fixtureRoot();
    const agent = createAgent(root, { ...input, name: 'Brainstorm Buddy' });
    assert.equal(agent.id, 'brainstorm-buddy');
    assert.throws(() => createAgent(root, { ...input, name: '翻译助手' }), (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID');
    assert.throws(() => createAgent(root, { ...input, id: 'Bad Id' }), (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_ID');
  });

  it('rejects conflicts without overwriting the existing file', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.pi', 'agents', 'taken.md'), VALID);
    assert.throws(() => createAgent(root, { ...input, id: 'taken' }), (error: unknown) => error instanceof AgentCreateError && error.code === 'CONFLICT');
    assert.equal(readFileSync(join(root, '.pi', 'agents', 'taken.md'), 'utf8'), VALID);
  });

  it('rejects oversized bodies and multiline frontmatter fields', () => {
    const root = fixtureRoot();
    assert.throws(
      () => createAgent(root, { ...input, id: 'big-body', body: '长'.repeat(40 * 1024) }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'TOO_LARGE',
    );
    assert.throws(
      () => createAgent(root, { ...input, id: 'bad-name', name: '两行\n名称' }),
      (error: unknown) => error instanceof AgentCreateError && error.code === 'INVALID_FIELD',
    );
  });
});

describe('listSkills', () => {
  it('returns an empty list when .pi/skills is absent or empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-empty-'));
    roots.push(root);
    assert.deepEqual(listSkills(root), []);
    mkdirSync(join(root, '.pi', 'skills'), { recursive: true });
    assert.deepEqual(listSkills(root), []);
  });

  it('lists SKILL.md entries with frontmatter metadata and body preview', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-'));
    roots.push(root);
    mkdirSync(join(root, '.pi', 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(root, '.pi', 'skills', 'research', 'SKILL.md'),
      `---\nname: 调研助手\ndescription: 按来源做桌面调研。\n---\n\n先搜一手来源，再写结论。\n`,
    );
    mkdirSync(join(root, '.pi', 'skills', 'no-frontmatter'), { recursive: true });
    writeFileSync(join(root, '.pi', 'skills', 'no-frontmatter', 'SKILL.md'), '只有正文。');
    const skills = listSkills(root);
    assert.deepEqual(skills.map((skill) => skill.name), ['no-frontmatter', '调研助手']);
    const research = skills.find((skill) => skill.name === '调研助手');
    assert.equal(research?.path, '.pi/skills/research/SKILL.md');
    assert.equal(research?.description, '按来源做桌面调研。');
    assert.equal(research?.preview, '先搜一手来源，再写结论。');
    const plain = skills.find((skill) => skill.path.includes('no-frontmatter'));
    assert.equal(plain?.name, 'no-frontmatter');
    assert.equal(plain?.preview, '只有正文。');
  });

  it('returns an empty list for the real project while .pi/skills is empty', () => {
    assert.deepEqual(listSkills(getPiProjectRoot()), []);
  });
});
