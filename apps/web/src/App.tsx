import { useEffect, useMemo, useState } from 'react';
import type { AgentChatResponse, AgentChatStreamEvent, AgentEventSummary, AgentResourceSummary } from '@pi-workbench/contracts';
import {
  ArrowUpRight,
  CaretRight,
  CheckCircle,
  Clock,
  DotsThree,
  FileText,
  Plus,
  Sparkle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  response?: AgentChatResponse;
};

type WorkspaceSnapshot = {
  resources: AgentResourceSummary[];
  tools: { enabled: string[]; policy: 'read-only' };
  model: { enabled: boolean; providerConfigured: boolean; provider?: string; model?: string; thinkingLevel?: string };
};

const fallbackResources: AgentResourceSummary[] = [
  { path: '.pi/skills/pi-workbench/SKILL.md', kind: 'skill', title: 'Pi Workbench Agent Skill', status: 'active' },
  { path: '.pi/prompts/agent-chat.md', kind: 'prompt', title: 'Agent 对话提示词', status: 'active' },
  { path: '.pi/knowledge/agent/session-lifecycle.md', kind: 'knowledge', title: 'Pi Session 生命周期', status: 'active' },
  { path: '.pi/knowledge/agent/resource-loading.md', kind: 'knowledge', title: '项目资源加载', status: 'active' },
  { path: '.pi/knowledge/agent/tool-policy.md', kind: 'knowledge', title: '只读工具策略', status: 'active' },
  { path: '.pi/knowledge/agent/answer-contract.md', kind: 'knowledge', title: 'Agent 回答契约', status: 'active' },
  { path: '.pi/knowledge/agent/local-fallback.md', kind: 'knowledge', title: '本地降级模式', status: 'active' },
];

const fallbackWorkspace: WorkspaceSnapshot = {
  resources: fallbackResources,
  tools: { enabled: ['read', 'search_knowledge'], policy: 'read-only' },
  model: { enabled: false, providerConfigured: false, provider: 'kimi-coding', model: 'kimi-for-coding', thinkingLevel: 'low' },
};

const starterPrompts = [
  { label: '解释 session 生命周期', prompt: '请解释一次 Pi Agent session 从创建到结束的生命周期，并引用对应资源。' },
  { label: '查看只读权限', prompt: '当前 Agent 有哪些工具权限？哪些事情明确不能做？' },
  { label: '总结项目资源', prompt: '请总结当前 .pi/ 目录里有哪些资源，以及它们分别负责什么。' },
  { label: '回答契约是什么', prompt: '一个可验证的 Agent 回答应该包含哪些字段？' },
];

function newSessionId() {
  return `session_${Math.random().toString(36).slice(2, 10)}`;
}

function parseStreamPayload(eventName: string, data: string): AgentChatStreamEvent {
  const payload = JSON.parse(data) as Record<string, unknown>;
  if (eventName === 'start') return { type: 'start', sessionId: String(payload.sessionId), model: payload.model as AgentChatResponse['model'] };
  if (eventName === 'event') return { type: 'event', event: payload.event as AgentEventSummary };
  if (eventName === 'text_delta') return { type: 'text_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'thinking_delta') return { type: 'thinking_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'done') return { type: 'done', response: payload.response as AgentChatResponse };
  if (eventName === 'error') return { type: 'error', message: String(payload.message ?? 'Agent stream failed') };
  throw new Error(`Unknown stream event: ${eventName}`);
}

async function consumeAgentStream(response: Response, onEvent: (event: AgentChatStreamEvent) => void): Promise<AgentChatResponse> {
  if (!response.body) throw new Error('Agent Gateway 没有返回可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: AgentChatResponse | undefined;

  const consumeBlock = (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const event = parseStreamPayload(eventName, dataLines.join('\n'));
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') finalResponse = event.response;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consumeBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!finalResponse) throw new Error('Agent stream 在 done 事件前结束');
  return finalResponse;
}

function resourceGroup(resources: AgentResourceSummary[], kind: AgentResourceSummary['kind']) {
  return resources.filter((resource) => resource.kind === kind);
}

function ResourceGlyph({ kind }: { kind: AgentResourceSummary['kind'] }) {
  if (kind === 'skill') return <span className="resource-glyph resource-glyph-skill">S</span>;
  if (kind === 'prompt') return <span className="resource-glyph resource-glyph-prompt">P</span>;
  return <FileText size={15} weight="duotone" />;
}

function EventRow({ event }: { event: AgentEventSummary }) {
  const isTool = event.type.startsWith('tool_execution');
  const isThinking = event.category === 'thinking';
  return <div className="event-row"><span className={isTool ? 'event-marker event-marker-tool' : isThinking ? 'event-marker event-marker-thinking' : 'event-marker'}>{isTool ? 'T' : isThinking ? '∴' : '·'}</span><span className="event-copy"><strong>{event.label}</strong>{event.detail && <code>{event.detail}</code>}</span><small>{event.type}</small></div>;
}

function SourceList({ response }: { response: AgentChatResponse }) {
  if (!response.sources.length) return <div className="empty-source">本次没有额外文件证据</div>;
  return <div className="source-list">{response.sources.map((source) => <div className="source-row" key={source.ref}><span className="source-kind">MD</span><span><strong>{source.title}</strong><small>{source.ref}</small></span></div>)}</div>;
}

function AssistantMessage({ message }: { message: Message }) {
  const isWorking = !message.response;
  return <article className="message message-assistant"><div className="message-avatar"><Sparkle size={15} weight="fill" /></div><div className="message-body"><div className="message-meta"><strong>Pi Agent</strong><span>{isWorking ? 'working' : '刚刚'}</span></div>{message.text ? <p>{message.text}</p> : isWorking && <div className="typing-line"><i /><i /><i /></div>}{message.thinking && <details className="thinking-trace" open={isWorking}><summary>thinking trace · {message.thinking.length} chars</summary><pre>{message.thinking}</pre></details>}{message.response && <div className="message-evidence"><div className="evidence-head"><span>evidence</span><span className={`response-tag response-tag-${message.response.source === 'pi-coding-agent' ? 'live' : 'local'}`}>{message.response.source === 'pi-coding-agent' ? 'Pi session' : 'local fallback'}</span><span className="route-tag">observed · {message.response.route}</span></div><SourceList response={message.response} /></div>}</div></article>;
}

function UserMessage({ message }: { message: Message }) {
  return <article className="message message-user"><div className="message-body"><div className="message-meta"><strong>You</strong><span>刚刚</span></div><p>{message.text}</p></div></article>;
}

function ResourceSection({ title, resources, selected, onSelect }: { title: string; resources: AgentResourceSummary[]; selected: string; onSelect: (path: string) => void }) {
  return <section className="resource-section"><div className="resource-section-title"><span>{title}</span><small>{resources.length}</small></div>{resources.map((resource) => <button className={selected === resource.path ? 'resource-item selected' : 'resource-item'} key={resource.path} onClick={() => onSelect(resource.path)}><ResourceGlyph kind={resource.kind} /><span>{resource.title}</span>{selected === resource.path && <CaretRight size={12} />}</button>)}</section>;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(fallbackWorkspace);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState(false);
  const [selectedResource, setSelectedResource] = useState(fallbackResources[0]!.path);
  const [lastResponse, setLastResponse] = useState<AgentChatResponse | undefined>();
  const [streamingEvents, setStreamingEvents] = useState<AgentEventSummary[]>([]);
  const [streamingThinking, setStreamingThinking] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/v1/agent/workspace').then(async (response) => {
      if (!response.ok) throw new Error('workspace unavailable');
      return response.json() as Promise<WorkspaceSnapshot>;
    }).then(setWorkspace).catch(() => undefined);
  }, []);

  const selectedResourceData = useMemo(() => workspace.resources.find((resource) => resource.path === selectedResource) ?? workspace.resources[0], [selectedResource, workspace.resources]);
  const events = lastResponse?.events ?? streamingEvents;

  function resetSession() {
    setSessionId(newSessionId());
    setMessages([]);
    setLastResponse(undefined);
    setStreamingEvents([]);
    setStreamingThinking('');
    setError('');
  }

  async function send(message = prompt) {
    const text = message.trim();
    if (!text || pending) return;
    const userId = `${Date.now()}-user`;
    const assistantId = `${Date.now()}-assistant`;
    setPrompt('');
    setError('');
    setLastResponse(undefined);
    setStreamingEvents([]);
    setStreamingThinking('');
    setMessages((current) => [...current, { id: userId, role: 'user', text }, { id: assistantId, role: 'assistant', text: '' }]);
    setPending(true);
    let streamedAnswer = '';
    let streamedThinking = '';
    try {
      const response = await fetch('/api/v1/agent/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: text, sessionId, debug: true }) });
      if (!response.ok) throw new Error('Agent Gateway 返回错误');
      const data = await consumeAgentStream(response, (event) => {
        if (event.type === 'event') {
          setStreamingEvents((current) => [...current, event.event]);
        }
        if (event.type === 'text_delta') {
          streamedAnswer += event.delta;
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: streamedAnswer, thinking: streamedThinking } : item));
        }
        if (event.type === 'thinking_delta') {
          streamedThinking += event.delta;
          setStreamingThinking(streamedThinking);
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, thinking: streamedThinking } : item));
        }
      });
      setLastResponse(data);
      setStreamingEvents(data.events);
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, text: data.answer, thinking: streamedThinking, response: data } : item));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Agent Gateway 暂时不可用');
    } finally {
      setPending(false);
    }
  }

  return <div className="workbench-shell">
    <aside className="workbench-sidebar">
      <div className="brand-lockup"><div className="brand-symbol">π</div><div><strong>Pi Workbench</strong><span>agent playground</span></div></div>
      <button className="new-session" onClick={resetSession}><Plus size={16} weight="bold" />New session</button>
      <nav className="side-nav"><span className="side-nav-label">Workspace</span><button className="side-nav-item active"><span className="nav-signal" />Conversation</button><button className="side-nav-item" onClick={() => setSelectedResource(workspace.resources[0]?.path ?? '')}><FileText size={15} />Resources <small>{workspace.resources.length}</small></button></nav>
      <div className="resource-divider" />
      <div className="resource-list"><ResourceSection title="Skills" resources={resourceGroup(workspace.resources, 'skill')} selected={selectedResource} onSelect={setSelectedResource} /><ResourceSection title="Prompts" resources={resourceGroup(workspace.resources, 'prompt')} selected={selectedResource} onSelect={setSelectedResource} /><ResourceSection title="Knowledge" resources={resourceGroup(workspace.resources, 'knowledge')} selected={selectedResource} onSelect={setSelectedResource} /></div>
      <div className="sidebar-footer"><div className="read-only-badge"><span className="read-only-dot" /><span><strong>read only</strong><small>no side effects</small></span></div><button className="sidebar-more" aria-label="更多设置"><DotsThree size={19} /></button></div>
    </aside>

    <main className="conversation-column">
      <header className="conversation-header"><div><div className="crumb"><span>Pi Workbench</span><CaretRight size={12} /><strong>Conversation</strong></div><div className="header-title"><span className="live-pulse" />Agent is ready</div></div><div className="header-actions"><span className="session-chip"><span>session</span>{sessionId}</span><button className="header-icon" onClick={resetSession} aria-label="重置 session"><span>↻</span></button><button className="header-icon" aria-label="更多"><DotsThree size={19} /></button></div></header>
      <section className="conversation-stage">
        <div className="conversation-scroll">
      {messages.length === 0 ? <div className="welcome-state"><div className="welcome-mark"><Sparkle size={23} weight="fill" /></div><span className="welcome-kicker">PI CODING AGENT / PLAYGROUND</span><h1>Observe the agent.<br /><em>Understand the turn.</em></h1><p>用一个真实的 Web 对话，验证资源加载、只读工具和 Pi session 的回答链路。</p><div className="prompt-grid">{starterPrompts.map((item) => <button className="prompt-card" key={item.label} onClick={() => void send(item.prompt)}><span>{item.label}</span><ArrowUpRight size={15} /></button>)}</div></div> : <div className="message-list">{messages.map((message) => message.role === 'user' ? <UserMessage key={message.id} message={message} /> : <AssistantMessage key={message.id} message={message} />)}</div>}
        </div>
        <div className="composer-wrap"><div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask the agent about this workspace…" rows={1} /><button className="send-button" onClick={() => void send()} disabled={pending || !prompt.trim()} aria-label="发送"><ArrowUpRight size={18} weight="bold" /></button></div><div className="composer-foot"><span>Enter to send · Shift + Enter for new line</span><span><span className="composer-lock" />read-only context</span></div></div>
      </section>
    </main>

    <aside className="inspector-panel"><div className="inspector-header"><div><span className="inspector-kicker">INSPECTOR</span><h2>Runtime</h2></div><button className="header-icon" aria-label="关闭面板"><X size={17} /></button></div><div className="runtime-state"><div className={workspace.model.enabled ? 'runtime-orb runtime-orb-live' : 'runtime-orb'}><Sparkle size={18} weight="fill" /></div><div><strong>{workspace.model.enabled ? 'Pi enabled' : 'Local fallback'}</strong><span>{workspace.model.provider ? `${workspace.model.provider} · ${workspace.model.model ?? 'default model'} · thinking ${workspace.model.thinkingLevel ?? 'default'}` : workspace.model.providerConfigured ? `provider detected · thinking ${workspace.model.thinkingLevel ?? 'default'}` : 'no provider key detected'}</span></div><span className="runtime-status-dot" /></div><div className="inspector-block"><div className="block-heading"><span>Current turn</span><span className="block-rule" /></div>{lastResponse ? <div className="turn-summary"><div><span>decision</span><strong>{lastResponse.decision.decidedBy === 'pi' ? 'Pi selected' : 'fallback'}</strong></div><div><span>observed</span><strong>{lastResponse.route}</strong></div><div><span>source</span><strong>{lastResponse.source === 'pi-coding-agent' ? 'Pi session' : 'local rules'}</strong></div><div><span>latency</span><strong>{lastResponse.latencyMs}ms</strong></div></div> : pending ? <div className="turn-summary turn-summary-live"><div><span>state</span><strong>streaming</strong></div><div><span>events</span><strong>{events.length}</strong></div><div><span>thinking</span><strong>{streamingThinking ? `${streamingThinking.length} chars` : 'waiting'}</strong></div></div> : <div className="inspector-empty"><Clock size={16} /><span>Send a message to inspect the turn.</span></div>}</div><div className="inspector-block"><div className="block-heading"><span>Event stream</span><span className="event-count">{events.length || '—'}</span></div>{events.length ? <div className="event-list">{events.map((event, index) => <EventRow key={`${event.type}-${index}`} event={event} />)}</div> : <div className="inspector-empty"><span className="empty-line" /><span>Events will appear here.</span></div>}</div><div className="inspector-block"><div className="block-heading"><span>Tool policy</span><span className="policy-tag">locked</span></div><div className="tool-policy"><div className="tool-row"><span className="tool-icon">R</span><div><strong>read</strong><small>inspect project files</small></div><CheckCircle size={15} /></div><div className="tool-row"><span className="tool-icon">⌕</span><div><strong>search_knowledge</strong><small>query local Markdown</small></div><CheckCircle size={15} /></div><div className="denied-copy">write, bash and external side effects are disabled.</div></div></div><div className="inspector-block inspector-resource"><div className="block-heading"><span>Selected resource</span><span className="block-rule" /></div>{selectedResourceData ? <><div className="selected-resource-head"><ResourceGlyph kind={selectedResourceData.kind} /><div><strong>{selectedResourceData.title}</strong><span>{selectedResourceData.kind}</span></div></div><code>{selectedResourceData.path}</code><p>此文件通过项目资源加载器进入 Agent 上下文。</p></> : <div className="inspector-empty">暂无资源</div>}</div><div className="inspector-footer"><span>workspace</span><strong>.pi/</strong><button className="refresh-link" onClick={() => window.location.reload()}>refresh</button></div></aside>
    {error && <div className="error-toast"><WarningCircle size={17} weight="fill" /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
  </div>;
}
