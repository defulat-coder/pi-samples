import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary, AgentTemplate } from '@pi-workbench/contracts';
import { agentCardStats, formatInstallCount, templateToCreateRequest } from './explore.js';

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

describe('formatInstallCount', () => {
  it('formats compact install counts', () => {
    assert.equal(formatInstallCount(3_100_000), '3.1M');
    assert.equal(formatInstallCount(2_000_000), '2M');
    assert.equal(formatInstallCount(653_000), '653K');
    assert.equal(formatInstallCount(12_300), '12.3K');
    assert.equal(formatInstallCount(999), '999');
    assert.equal(formatInstallCount(0), '0');
  });
});
