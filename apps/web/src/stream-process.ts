import type { AgentChatStreamEvent, AgentEventSummary } from '@pi-workbench/contracts';

export type LiveTurnProcess = {
  answer: string;
  thinking: string;
  events: AgentEventSummary[];
};

export function createLiveTurnProcess(): LiveTurnProcess {
  return { answer: '', thinking: '', events: [] };
}

export function isVisibleProcessEvent(event: AgentEventSummary): boolean {
  return event.category === 'tool' || event.category === 'thinking' || event.category === 'error';
}

export function applyAgentStreamEvent(process: LiveTurnProcess, event: AgentChatStreamEvent): LiveTurnProcess {
  if (event.type === 'text_delta') return { ...process, answer: process.answer + event.delta };
  if (event.type === 'thinking_delta') return { ...process, thinking: process.thinking + event.delta };
  if (event.type === 'event' && isVisibleProcessEvent(event.event)) return { ...process, events: [...process.events, event.event] };
  return process;
}
