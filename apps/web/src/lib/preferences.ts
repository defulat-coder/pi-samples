/** 界面偏好：真实生效的本地设置，持久化在 localStorage。 */
export interface UiPreferences {
  /** 消息紧凑模式：缩小会话消息的纵向间距，立即生效。 */
  compactMessages: boolean;
  /** 侧边栏默认收起：刷新页面后生效。 */
  sidebarCollapsed: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = { compactMessages: false, sidebarCollapsed: false };

const PREFERENCE_KEYS: Record<keyof UiPreferences, string> = {
  compactMessages: 'pi-workbench.pref.compact-messages',
  sidebarCollapsed: 'pi-workbench.pref.sidebar-collapsed',
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Reads all UI preferences; unknown or missing values fall back to the defaults. */
export function readUiPreferences(storage: StorageLike | undefined = defaultStorage()): UiPreferences {
  const read = (key: keyof UiPreferences): boolean => {
    try {
      return storage?.getItem(PREFERENCE_KEYS[key]) === '1';
    } catch {
      return DEFAULT_UI_PREFERENCES[key];
    }
  };
  return { compactMessages: read('compactMessages'), sidebarCollapsed: read('sidebarCollapsed') };
}

/** Persists one preference; storage failures are non-fatal. Returns the next preference set. */
export function writeUiPreference(
  current: UiPreferences,
  key: keyof UiPreferences,
  value: boolean,
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  try {
    storage?.setItem(PREFERENCE_KEYS[key], value ? '1' : '0');
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
  return { ...current, [key]: value };
}
