import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary, AgentTemplate, PromptSummary, SkillSummary } from '@pi-workbench/contracts';
import { agentCardStats, filterSkillItems, mergeSkillItems, templateToCreateRequest } from './explore.js';

const agent: AgentSummary = {
  id: 'pi-assistant',
  name: 'Pi 助手',
  mark: 'π',
  tagline: '通用聊天助手',
  description: '一个通用聊天助手。',
  suggestions: ['问题一', '问题二'],
  sessionCount: 3,
};

const template: AgentTemplate = {
  id: 'translator-pro',
  name: '翻译助手',
  mark: '译',
  tagline: '中英互译与润色',
  description: '在中英文之间互译。',
  suggestions: ['把这段话译成英文'],
  body: '你是翻译助手，专注中英互译。',
};

describe('agent templates', () => {
  it('maps a template into a create request and lets the user override the id', () => {
    const request = templateToCreateRequest(template);
    assert.equal(request.id, template.id);
    assert.deepEqual(request.suggestions, template.suggestions);
    assert.notEqual(request.suggestions, template.suggestions, 'suggestions 应该是拷贝而不是同一引用');
    const renamed = templateToCreateRequest(template, 'my-translator');
    assert.equal(renamed.id, 'my-translator');
    assert.equal(renamed.name, template.name);
  });
});

describe('agentCardStats', () => {
  it('counts suggestions and sessions, defaulting missing session counts to 0', () => {
    assert.deepEqual(agentCardStats(agent), { suggestionCount: 2, sessionCount: 3 });
    const { sessionCount: _dropped, ...withoutCount } = agent;
    assert.deepEqual(agentCardStats(withoutCount), { suggestionCount: 2, sessionCount: 0 });
  });
});

describe('skill items', () => {
  const prompts: PromptSummary[] = [
    { name: 'explain', path: '.pi/prompts/explain.md', description: '解释一个主题', preview: '请解释……' },
  ];
  const skills: SkillSummary[] = [
    { name: '调研助手', path: '.pi/skills/research/SKILL.md', description: '桌面调研', preview: '先搜一手来源。' },
  ];

  it('merges skills before prompts and keeps the kind marker', () => {
    const items = mergeSkillItems(prompts, skills);
    assert.deepEqual(items.map((item) => item.kind), ['skill', 'prompt']);
    assert.equal(items[0]?.name, '调研助手');
    assert.equal(items[1]?.name, 'explain');
  });

  it('filters by name, description or path, case-insensitive', () => {
    const items = mergeSkillItems(prompts, skills);
    assert.deepEqual(filterSkillItems(items, '').length, 2);
    assert.deepEqual(filterSkillItems(items, 'EXPLAIN').map((item) => item.name), ['explain']);
    assert.deepEqual(filterSkillItems(items, '调研').map((item) => item.name), ['调研助手']);
    assert.deepEqual(filterSkillItems(items, 'prompts/').map((item) => item.name), ['explain']);
    assert.deepEqual(filterSkillItems(items, '不存在'), []);
  });
});
