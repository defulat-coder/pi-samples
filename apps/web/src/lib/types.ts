import type { ChatModelLabel, ChatUsage } from '@pi-workbench/contracts';

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
  model?: ChatModelLabel;
  usage?: ChatUsage;
};

export function newMessageId(): string {
  return `msg_${Math.random().toString(36).slice(2, 10)}`;
}
