import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InboxItem, InboxResponse } from '@pi-workbench/contracts';
import { WorkspaceProvider, type WorkspaceContextValue } from '../context/WorkspaceContext.js';
import { InboxView } from './InboxView.js';

/** InboxView 经 lib/api 走全局 fetch；测试在 fetch 这一层按 URL/方法打桩。 */

const originalFetch = globalThis.fetch;

const ITEM: InboxItem = {
  id: 's1',
  agentId: 'agent-one',
  title: '排查构建失败',
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-21T08:00:00.000Z',
  questionCount: 2,
  needsAttention: true,
  attentionReason: 'error',
  attentionDetail: '模型请求失败',
  preview: '构建在打包阶段失败',
  read: false,
};

const WORKSPACE: WorkspaceContextValue = {
  workspace: {
    agents: [{ id: 'agent-one', name: 'Nova', mark: 'No', tagline: '', description: '', suggestions: [] }],
    prompts: [],
    models: { current: {}, available: [] },
  },
  sessionsByAgent: {},
  notify: () => {},
  reloadWorkspace: () => {},
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

type FetchCall = { method: string; url: string; body?: string };

/** 安装 fetch 桩并返回调用记录；inbox 列表始终返回给定条目。 */
function stubFetch(items: InboxItem[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined });
    if (method === 'PATCH' && url.endsWith('/inbox')) {
      const patch = JSON.parse(String(init?.body)) as { read?: boolean };
      const item = items.find((it) => url.includes(`/sessions/${it.id}/`));
      return jsonResponse({ ...item, ...(patch.read === undefined ? {} : { read: patch.read }) });
    }
    if (url.includes('/messages')) return jsonResponse({ items: [{ id: 'm1', role: 'user', content: '你好', timestamp: ITEM.createdAt }] });
    if (url.includes('/api/v1/inbox')) {
      const payload: InboxResponse = { items, total: items.length, unreadCount: items.filter((it) => !it.read).length };
      return jsonResponse(payload);
    }
    return jsonResponse({});
  }) as typeof fetch;
  return calls;
}

function renderInbox(overrides: { onOpen?: (agentId: string, sessionId: string) => void; onInboxChanged?: () => void } = {}) {
  const opened: string[] = [];
  let changed = 0;
  const view = render(
    <WorkspaceProvider value={WORKSPACE}>
      <InboxView
        onOpen={overrides.onOpen ?? ((agentId, sessionId) => opened.push(`${agentId}/${sessionId}`))}
        onInboxChanged={overrides.onInboxChanged ?? (() => { changed += 1; })}
      />
    </WorkspaceProvider>,
  );
  return { ...view, opened, isChanged: () => changed };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('InboxView', () => {
  it('挂载时拉取 attention tab；切换 tab 触发对应 fetchInbox 参数', async () => {
    const calls = stubFetch([ITEM]);
    renderInbox();

    await waitFor(() => assert.ok(calls.some((call) => call.url.includes('/api/v1/inbox?tab=attention')), '挂载应请求 attention tab'));
    assert.ok(await screen.findByText('排查构建失败'));

    fireEvent.click(screen.getByRole('tab', { name: /已完成/ }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.includes('tab=completed')), '切 tab 应请求 completed'));

    fireEvent.click(screen.getByRole('tab', { name: /全部/ }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.includes('tab=all')), '切 tab 应请求 all'));
  });

  it('单击未读行调用 updateInboxState 标记已读并乐观去掉未读态', async () => {
    const calls = stubFetch([ITEM]);
    const changed: number[] = [];
    renderInbox({ onInboxChanged: () => changed.push(1) });

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    assert.ok(row.className.includes('unread'), '未读行应带 unread 样式');

    fireEvent.click(row);
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url.includes('/sessions/s1/inbox'));
      assert.ok(patch, '单击应发起 inbox PATCH');
      assert.deepEqual(JSON.parse(patch.body!), { read: true });
    });
    await waitFor(() => assert.ok(!row.className.includes('unread'), '已读后应去掉 unread 样式'));
    assert.ok(changed.length > 0, '已读变更应通知 App 刷新徽标');
  });

  it('双击行打开分栏详情并拉取消息', async () => {
    const calls = stubFetch([ITEM]);
    const { opened } = renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);

    await waitFor(() => assert.ok(calls.some((call) => call.url.includes('/sessions/s1/messages')), '详情应拉取会话消息'));
    assert.ok(await screen.findByText('在聊天中打开'));
    assert.ok(screen.getByText('模型请求失败'), '需处理详情应显示提示条');
    assert.ok(await screen.findByText('你好'), '详情应渲染历史消息');

    fireEvent.click(screen.getAllByText('在聊天中打开')[0]!);
    assert.deepEqual(opened, ['agent-one/s1']);

    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    await waitFor(() => assert.ok(document.querySelector('.inbox-body.split') === null, '关闭后回到纯列表'));
  });
});
