import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApprovalRecord, InboxItem, PendingApproval, SessionSummary } from '@pi-workbench/contracts';
import App from './App.js';

/** App 级测试：全量 fetch 桩，聚焦「聊天视图内嵌审批横幅」与「SSE 审批推送」的数据通路。 */

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

/** jsdom 没有 EventSource：构造时登记实例，测试手动 emit 触发 message 监听。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

const AGENT = { id: 'agent-one', name: 'Nova', mark: 'No', tagline: '', description: '', suggestions: [] };

const S1: SessionSummary = {
  id: 's1',
  agentId: 'agent-one',
  title: '排查构建失败',
  createdAt: '2026-08-21T08:00:00.000Z',
  updatedAt: '2026-08-21T09:00:00.000Z',
  questionCount: 1,
  needsAttention: false,
};
const S2: SessionSummary = { ...S1, id: 's2', title: '整理文档' };

const APPROVAL: PendingApproval = {
  id: 'ap1',
  sessionId: 's1',
  agentId: 'agent-one',
  agentName: 'Nova',
  message: "Current agent requested bash command 'npm test' (matched '*'). Allow this command?",
  createdAt: '2026-08-21T09:00:00.000Z',
};

const INBOX_ITEM: InboxItem = { ...S1, read: false, pendingApproval: APPROVAL };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

type FetchCall = { method: string; url: string; body?: string };

function stubFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined });
    if (method === 'POST' && url.includes('/api/v1/approvals/')) {
      const record: ApprovalRecord = { ...APPROVAL, state: 'approved', resolvedAt: '2026-08-21T09:01:00.000Z' };
      return jsonResponse(record);
    }
    if (url.includes('/messages')) return jsonResponse({ items: [{ id: 'm1', role: 'user', content: '你好', timestamp: S1.createdAt }] });
    if (url.includes('/api/v1/inbox')) return jsonResponse({ items: [INBOX_ITEM], total: 1, unreadCount: 1 });
    if (url.includes('/api/v1/workspace')) return jsonResponse({ agents: [AGENT], prompts: [], models: { current: {}, available: [] } });
    if (url.endsWith('/sessions')) return jsonResponse({ items: [S1, S2], total: 2 });
    if (url.includes('/api/v1/settings')) {
      return jsonResponse({ model: { available: [] }, thinkingLevel: 'medium', resources: { agents: 1, prompts: 0, skills: 0, appendSystem: false }, workspace: { name: 'pi-samples', sessionDir: '.pi/sessions' } });
    }
    if (url.includes('/api/v1/preferences')) return jsonResponse({ items: {} });
    return jsonResponse({});
  }) as typeof fetch;
  return calls;
}

/** 打开会话 s1（带待审批）：等会话列表出现并点击对应行。 */
async function openSession(title: string) {
  const row = await screen.findByRole('button', { name: new RegExp(title) });
  fireEvent.click(row);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

describe('App 聊天视图内嵌审批横幅', () => {
  it('当前会话有待审批时，消息流与输入框之间出现审批卡片', async () => {
    stubFetch();
    render(<App />);

    await openSession('排查构建失败');

    const card = await screen.findByRole('region', { name: '审批请求' });
    assert.ok(card.closest('.chat-branch'), '卡片应挂在聊天分支内');
    assert.ok(screen.getByText(APPROVAL.message), '卡片应显示审批摘要');
    assert.ok(screen.getByRole('button', { name: '批准' }));
    assert.ok(screen.getByRole('button', { name: '始终允许' }));
    assert.ok(screen.getByRole('button', { name: '拒绝' }));
  });

  it('「批准」就地调 POST /approvals/:id/decision { approved: true }', async () => {
    const calls = stubFetch();
    render(<App />);

    await openSession('排查构建失败');
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/v1/approvals/ap1/decision'));
      assert.ok(post, '应发起审批决策 POST');
      assert.deepEqual(JSON.parse(post.body!), { approved: true });
    });
  });

  it('切换到无审批的会话后卡片跟着消失', async () => {
    stubFetch();
    render(<App />);

    await openSession('排查构建失败');
    await screen.findByRole('region', { name: '审批请求' });

    await openSession('整理文档');
    // 断言里不要直接携带 DOM 元素：AssertionError 会 inspect jsdom Element（巨大且循环引用），打印时卡死。
    await waitFor(() => assert.ok(screen.queryByRole('region', { name: '审批请求' }) === null, 's2 无待审批，卡片应消失'));

    await openSession('排查构建失败');
    assert.ok(await screen.findByRole('region', { name: '审批请求' }), '切回 s1 卡片应重新出现');
  });
});

describe('App SSE 审批推送（/api/v1/events）', () => {
  const inboxFetchCount = (calls: FetchCall[]) => calls.filter((call) => call.url.includes('/api/v1/inbox')).length;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('挂载即订阅 approval 事件；收到事件触发收件箱重新拉取', async () => {
    const calls = stubFetch();
    render(<App />);

    await waitFor(() => assert.ok(inboxFetchCount(calls) > 0, '挂载后应有首次收件箱拉取'));
    const source = FakeEventSource.instances.at(-1);
    assert.ok(source, '应创建 EventSource');
    assert.equal(source.url, '/api/v1/events');
    assert.equal(source.closed, false);

    const before = inboxFetchCount(calls);
    await act(async () => source.emit('approval', { type: 'approval', approval: APPROVAL }));
    await waitFor(() => assert.ok(inboxFetchCount(calls) > before, 'approval 事件应触发收件箱重新拉取'));
  });

  it('卸载后退订并 close，之后的事件不再触发拉取', async () => {
    const calls = stubFetch();
    const view = render(<App />);

    await waitFor(() => assert.ok(inboxFetchCount(calls) > 0));
    const source = FakeEventSource.instances.at(-1)!;
    view.unmount();
    assert.equal(source.closed, true, '卸载应关闭 EventSource');

    const before = inboxFetchCount(calls);
    source.emit('approval', { type: 'approval', approval: APPROVAL });
    await sleep(150);
    assert.equal(inboxFetchCount(calls), before, '卸载后事件不应再触发拉取');
  });
});
