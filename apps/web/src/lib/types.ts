import type { ChatModelLabel, ChatUsage } from '@pi-workbench/contracts';
import type { ExploreView } from './explore.js';

/** One rendered message in the thread view. */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Collapsed reasoning trace accumulated from thinking_delta events. */
  thinking?: string;
  /** True while the assistant turn is still streaming. */
  streaming?: boolean;
  /** Set when the turn ended with a stream error. */
  error?: string;
  /** Set when the turn was interrupted (client aborted the stream). */
  interrupted?: boolean;
  /** Present while Pi is auto-retrying the turn. */
  retry?: { attempt: number; maxAttempts: number; errorMessage: string };
  model?: ChatModelLabel;
  usage?: ChatUsage;
};

export function newMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

/** 系统页面（用量 / 设置）；同一时间至多打开一个，与会话、收件箱、探索区互斥。 */
export type SystemView = 'usage' | 'settings';

/** 主区域视图状态机：互斥由类型保证，不再手工维护三连 set。 */
export type ViewState =
  | { kind: 'chat' }
  | { kind: 'inbox' }
  | { kind: 'explore'; view: ExploreView }
  | { kind: 'system'; view: SystemView };
