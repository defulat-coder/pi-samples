import type { AgentChatStreamEvent, AgentEventSummary } from '@pi-workbench/contracts';

export type LiveTurnProcess = {
  answer: string;
  thinking: string;
  events: AgentEventSummary[];
};

export type ToolActivity = {
  id: string;
  toolName: string;
  label: string;
  status: 'running' | 'completed' | 'error';
  input?: string;
  output?: string;
  startedAtMs?: number;
  durationMs?: number;
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

export function buildToolActivities(events: AgentEventSummary[]): ToolActivity[] {
  const activities: ToolActivity[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_execution_start' && event.toolName) {
      activities.push({ id: `${event.sequence ?? index}-${event.toolName}`, toolName: event.toolName, label: event.label, status: 'running', input: event.detail, startedAtMs: event.elapsedMs });
      continue;
    }
    if ((event.type === 'tool_execution_update' || event.type === 'tool_execution_end') && event.toolName) {
      const activity = [...activities].reverse().find((item) => item.toolName === event.toolName && item.status === 'running');
      if (!activity) continue;
      if (event.detail) activity.output = event.detail;
      if (event.type === 'tool_execution_end') {
        activity.status = event.category === 'error' ? 'error' : 'completed';
        if (event.elapsedMs !== undefined && activity.startedAtMs !== undefined) activity.durationMs = Math.max(0, event.elapsedMs - activity.startedAtMs);
      }
      continue;
    }
    if (event.category === 'error' && !event.toolName) activities.push({ id: `${event.sequence ?? index}-error`, toolName: 'error', label: event.label, status: 'error', output: event.detail, durationMs: event.durationMs });
  }
  return activities;
}
