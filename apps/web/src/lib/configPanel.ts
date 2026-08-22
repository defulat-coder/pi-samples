import type { AgentThinkingLevel } from '@pi-workbench/contracts';
import { defaultStorage, type StorageLike } from './storage.js';

export type ConfigSectionId = 'basic' | 'resources' | 'runtime';

/** 默认展开前两节（基本信息、资源），对应 Fleet 面板的首屏重点。 */
export const DEFAULT_OPEN_SECTIONS: readonly ConfigSectionId[] = ['basic', 'resources'];

/** Toggles one section id in the open-section list. */
export function toggleSection(open: readonly ConfigSectionId[], id: ConfigSectionId): ConfigSectionId[] {
  return open.includes(id) ? open.filter((item) => item !== id) : [...open, id];
}

/** 本地胶囊开关只暴露 off/minimal 两档；其余级别仍是 API 支持的合法值。 */
export type ThinkingPreference = Extract<AgentThinkingLevel, 'off' | 'minimal'>;
export const THINKING_PREFERENCE_OPTIONS: readonly ThinkingPreference[] = ['off', 'minimal'];

const THINKING_KEY_PREFIX = 'pi-workbench.thinking.';

/** Reads the per-agent default thinking level; anything unknown falls back to 'off'. */
export function readThinkingPreference(agentId: string, storage: StorageLike | undefined = defaultStorage()): ThinkingPreference {
  try {
    return storage?.getItem(THINKING_KEY_PREFIX + agentId) === 'minimal' ? 'minimal' : 'off';
  } catch {
    return 'off';
  }
}

/** Persists the per-agent default thinking level; storage failures are non-fatal. */
export function writeThinkingPreference(agentId: string, level: ThinkingPreference, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(THINKING_KEY_PREFIX + agentId, level);
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
}

/** Server-side key (SQLite preferences table) for one agent's thinking preference. */
export function serverKeyForThinking(agentId: string): string {
  return `thinking.${agentId}`;
}

/** Merges server-persisted thinking preferences into the local cache; server values win. */
export function mergeServerThinkingPreferences(items: Record<string, unknown>, storage: StorageLike | undefined = defaultStorage()): void {
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith('thinking.') || (value !== 'off' && value !== 'minimal')) continue;
    try {
      storage?.setItem(THINKING_KEY_PREFIX + key.slice('thinking.'.length), value);
    } catch {
      // 本地缓存失败时下次启动再合并。
    }
  }
}
