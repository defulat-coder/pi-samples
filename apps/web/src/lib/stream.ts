import type { ChatModelLabel, ChatStreamEvent, ChatUsage } from '@pi-workbench/contracts';

export type SseBlock = { event: string; data: string };

/** Splits an SSE text buffer into complete blocks; returns the trailing partial block as `rest`. */
export function extractSseBlocks(buffer: string): { blocks: SseBlock[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks: SseBlock[] = [];
  let rest = normalized;
  let boundary = rest.indexOf('\n\n');
  while (boundary >= 0) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf('\n\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) blocks.push({ event, data: dataLines.join('\n') });
  }
  return { blocks, rest };
}

/** Flushes whatever complete block remains after the stream closes. */
export function flushSseBlocks(buffer: string): SseBlock[] {
  return extractSseBlocks(`${buffer}\n\n`).blocks;
}

/** Turns one SSE block into a typed chat stream event; throws on unknown event names. */
export function decodeStreamEvent(block: SseBlock): ChatStreamEvent {
  const payload = JSON.parse(block.data) as Record<string, unknown>;
  switch (block.event) {
    case 'start':
      return { type: 'start', sessionId: String(payload.sessionId), agentId: String(payload.agentId), model: payload.model as ChatModelLabel };
    case 'text_delta':
      return { type: 'text_delta', delta: String(payload.delta ?? '') };
    case 'thinking_delta':
      return { type: 'thinking_delta', delta: String(payload.delta ?? '') };
    case 'tool':
      return {
        type: 'tool',
        phase: payload.phase === 'update' || payload.phase === 'end' ? payload.phase : 'start',
        toolCallId: String(payload.toolCallId ?? ''),
        toolName: String(payload.toolName ?? ''),
        ...(payload.args !== undefined ? { args: String(payload.args) } : {}),
        ...(payload.result !== undefined ? { result: String(payload.result) } : {}),
        ...(payload.isError !== undefined ? { isError: Boolean(payload.isError) } : {}),
      };
    case 'done':
      return { type: 'done', answer: String(payload.answer ?? ''), ...(payload.usage ? { usage: payload.usage as ChatUsage } : {}) };
    case 'retry':
      return { type: 'retry', attempt: Number(payload.attempt), maxAttempts: Number(payload.maxAttempts), errorMessage: String(payload.errorMessage ?? '') };
    case 'error':
      return { type: 'error', error: String(payload.error ?? '流式响应失败') };
    default:
      throw new Error(`未知的流式事件：${block.event}`);
  }
}

/** 一次工具调用在流式 turn 里的可见状态（委派卡片、bash 卡片共用）。 */
export type LiveToolCall = {
  id: string;
  name: string;
  args?: string;
  result?: string;
  isError?: boolean;
  /** end 帧到达后置真；运行中用于 spinner。 */
  done: boolean;
};

/** Accumulates the visible state of one streaming assistant turn. */
export type LiveTurn = {
  answer: string;
  thinking: string;
  sessionId?: string;
  model?: ChatModelLabel;
  usage?: { input: number; output: number; total: number };
  /** Set while Pi is auto-retrying the turn after a failure. */
  retry?: { attempt: number; maxAttempts: number; errorMessage: string };
  /** 本论已发生的工具调用，按 toolCallId 去重、按到达顺序排列。 */
  tools: LiveToolCall[];
};

export function createLiveTurn(): LiveTurn {
  return { answer: '', thinking: '', tools: [] };
}

function reduceToolEvent(turn: LiveTurn, event: ChatStreamEvent & { type: 'tool' }): LiveTurn {
  const tools = [...turn.tools];
  const index = tools.findIndex((tool) => tool.id === event.toolCallId);
  const current = tools[index] ?? { id: event.toolCallId, name: event.toolName, done: false };
  const next: LiveToolCall = {
    ...current,
    name: event.toolName || current.name,
    ...(event.args !== undefined ? { args: event.args } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.isError !== undefined ? { isError: event.isError } : {}),
    done: current.done || event.phase === 'end',
  };
  if (index >= 0) tools[index] = next;
  else tools.push(next);
  return { ...turn, tools };
}

export function reduceStreamEvent(turn: LiveTurn, event: ChatStreamEvent): LiveTurn {
  switch (event.type) {
    case 'start':
      return { ...turn, sessionId: event.sessionId, model: event.model };
    case 'text_delta':
      return { ...turn, answer: turn.answer + event.delta };
    case 'thinking_delta':
      return { ...turn, thinking: turn.thinking + event.delta };
    case 'tool':
      return reduceToolEvent(turn, event);
    case 'done':
      return { ...turn, answer: event.answer || turn.answer, ...(event.usage ? { usage: event.usage } : {}) };
    case 'retry':
      return { ...turn, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage } };
    case 'error':
      return turn;
  }
}
