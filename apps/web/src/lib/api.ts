import type { AgentDetail, AgentResources, AgentTemplate, AgentTemplatesResponse, AgentThinkingLevel, ChatRequest, ChatStreamEvent, CreateAgentRequest, PreferencesResponse, PromptDocument, SessionMessage, SessionMessagesResponse, SessionSummary, SettingsResponse, SkillSummary, UsageResponse, WorkspaceResponse } from '@pi-workbench/contracts';
import { decodeStreamEvent, extractSseBlocks, flushSseBlocks } from './stream.js';

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the fallback message when the error body is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchWorkspace(): Promise<WorkspaceResponse> {
  return readJson(await fetch('/api/v1/workspace'), '工作区信息暂时无法读取');
}

export async function fetchAgent(agentId: string): Promise<AgentDetail> {
  return readJson(await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`), 'Agent 详情暂时无法读取');
}

export async function fetchAgentResources(agentId: string): Promise<AgentResources> {
  return readJson(await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/resources`), 'Agent 资源信息暂时无法读取');
}

export async function fetchSessions(agentId: string): Promise<SessionSummary[]> {
  const payload = await readJson<{ items: SessionSummary[] }>(await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions`), '会话列表暂时无法读取');
  return payload.items;
}

/** Replays the persisted messages of one session (the JSONL file is the source of truth). */
export async function fetchSessionMessages(agentId: string, sessionId: string): Promise<SessionMessage[]> {
  const payload = await readJson<SessionMessagesResponse>(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`),
    '历史消息暂时无法读取',
  );
  return payload.items;
}

export async function fetchInbox(): Promise<SessionSummary[]> {
  const payload = await readJson<{ items: SessionSummary[] }>(await fetch('/api/v1/inbox'), '收件箱暂时无法读取');
  return payload.items;
}

export async function renameSession(agentId: string, sessionId: string, title: string): Promise<SessionSummary> {
  return readJson(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
    '会话名称暂时无法保存',
  );
}

export async function deleteSession(agentId: string, sessionId: string): Promise<void> {
  const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error('会话暂时无法删除');
}

export async function fetchPrompt(name: string): Promise<PromptDocument> {
  return readJson(await fetch(`/api/v1/prompts/${encodeURIComponent(name)}`), '提示词暂时无法读取');
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  const payload = await readJson<{ items: SkillSummary[] }>(await fetch('/api/v1/skills'), '技能列表暂时无法读取');
  return payload.items;
}

export async function fetchAgentTemplates(): Promise<AgentTemplate[]> {
  const payload = await readJson<AgentTemplatesResponse>(await fetch('/api/v1/templates'), '模板列表暂时无法读取');
  return payload.items;
}

export async function fetchUsage(): Promise<UsageResponse> {
  return readJson(await fetch('/api/v1/usage'), '用量数据暂时无法读取');
}

export async function fetchSettings(): Promise<SettingsResponse> {
  return readJson(await fetch('/api/v1/settings'), '设置信息暂时无法读取');
}

export async function fetchPreferences(): Promise<Record<string, unknown>> {
  const payload = await readJson<PreferencesResponse>(await fetch('/api/v1/preferences'), '偏好设置暂时无法读取');
  return payload.items;
}

/** Fire-and-forget preference write-through; the local cache stays authoritative on failure. */
export async function savePreference(key: string, value: unknown): Promise<void> {
  const response = await fetch('/api/v1/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!response.ok) throw new Error('偏好暂时无法保存');
}

/** Creates .pi/agents/<id>.md via the API; server errors (400/409) surface their message. */
export async function createAgent(request: CreateAgentRequest): Promise<AgentDetail> {
  return readJson(
    await fetch('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    'Agent 暂时无法创建',
  );
}

/** POSTs a chat turn and streams typed events to `onEvent`; resolves with the final `done` event. */
export async function streamChat(request: ChatRequest & { thinking?: AgentThinkingLevel }, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<ChatStreamEvent & { type: 'done' }> {
  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) await readJson(response, '发送消息失败');
  if (!response.body) throw new Error('服务没有返回可读流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: (ChatStreamEvent & { type: 'done' }) | undefined;
  let failure: Error | undefined;

  const dispatch = (data: string, event: string) => {
    const parsed = decodeStreamEvent({ event, data });
    onEvent(parsed);
    if (parsed.type === 'done') final = parsed;
    if (parsed.type === 'error') failure = new Error(parsed.error);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { blocks, rest } = extractSseBlocks(buffer);
    buffer = rest;
    for (const block of blocks) dispatch(block.data, block.event);
    if (done) break;
  }
  for (const block of flushSseBlocks(buffer)) dispatch(block.data, block.event);

  if (failure) throw failure;
  if (!final) throw new Error('响应流在完成事件前结束');
  return final;
}
