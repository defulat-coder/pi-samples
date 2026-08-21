import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPEN_SECTIONS, readThinkingPreference, toggleSection, writeThinkingPreference, type ConfigSectionId } from './lib/configPanel.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

describe('toggleSection', () => {
  it('收起已展开的节，展开未展开的节', () => {
    const open: ConfigSectionId[] = [...DEFAULT_OPEN_SECTIONS];
    assert.deepEqual(toggleSection(open, 'basic'), ['resources']);
    assert.deepEqual(toggleSection(open, 'runtime'), ['basic', 'resources', 'runtime']);
  });

  it('不修改原数组', () => {
    const open: ConfigSectionId[] = ['basic'];
    toggleSection(open, 'basic');
    assert.deepEqual(open, ['basic']);
  });
});

describe('thinking preference', () => {
  it('缺省与未知值都回落到 off', () => {
    assert.equal(readThinkingPreference('agent-a', fakeStorage()), 'off');
    assert.equal(readThinkingPreference('agent-a', fakeStorage({ 'pi-workbench.thinking.agent-a': 'high' })), 'off');
  });

  it('按 agentId 分别持久化', () => {
    const storage = fakeStorage();
    writeThinkingPreference('agent-a', 'minimal', storage);
    assert.equal(readThinkingPreference('agent-a', storage), 'minimal');
    assert.equal(readThinkingPreference('agent-b', storage), 'off');
    writeThinkingPreference('agent-a', 'off', storage);
    assert.equal(readThinkingPreference('agent-a', storage), 'off');
  });

  it('storage 不可用时读 off、写不抛错', () => {
    assert.equal(readThinkingPreference('agent-a', undefined), 'off');
    assert.doesNotThrow(() => writeThinkingPreference('agent-a', 'minimal', undefined));
  });

  it('storage 抛错时静默降级', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    assert.equal(readThinkingPreference('agent-a', throwing), 'off');
    assert.doesNotThrow(() => writeThinkingPreference('agent-a', 'minimal', throwing));
  });
});
