import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApprovalRecord, InboxItem, InboxResponse, PendingApproval } from '@pi-workbench/contracts';
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

/** 待审批会话：无需处理（needsAttention=false），仅 pendingApproval 使其进入 attention tab。 */
const APPROVAL: PendingApproval = {
  id: 'ap1',
  sessionId: 's1',
  agentId: 'agent-one',
  agentName: 'Nova',
  message: "Current agent requested bash command 'npm test' (matched '*'). Allow this command?",
  createdAt: '2026-08-21T07:58:00.000Z',
};

const APPROVAL_ITEM: InboxItem = {
  ...ITEM,
  needsAttention: false,
  attentionReason: undefined,
  attentionDetail: undefined,
  pendingApproval: APPROVAL,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

type FetchCall = { method: string; url: string; body?: string };

/** 安装 fetch 桩并返回调用记录；inbox 列表始终返回给定条目。 */
function stubFetch(items: InboxItem[], options: { decisionStatus?: number } = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined });
    if (method === 'POST' && url.includes('/api/v1/approvals/')) {
      if (options.decisionStatus === 409) {
        return new Response(JSON.stringify({ error: 'already resolved' }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      const decision = JSON.parse(String(init?.body)) as { approved: boolean; always?: boolean };
      const record: ApprovalRecord = {
        ...APPROVAL,
        state: !decision.approved ? 'denied' : decision.always ? 'always' : 'approved',
        resolvedAt: '2026-08-21T08:01:00.000Z',
      };
      return jsonResponse(record);
    }
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

function renderInbox(overrides: {
  onOpen?: (agentId: string, sessionId: string) => void;
  onResume?: (agentId: string, sessionId: string, mode: 'retry' | 'continue') => void;
  onInboxChanged?: () => void;
  notify?: (text: string) => void;
} = {}) {
  const opened: string[] = [];
  const resumed: string[] = [];
  let changed = 0;
  const view = render(
    <WorkspaceProvider value={overrides.notify ? { ...WORKSPACE, notify: overrides.notify } : WORKSPACE}>
      <InboxView
        onOpen={overrides.onOpen ?? ((agentId, sessionId) => opened.push(`${agentId}/${sessionId}`))}
        onResume={overrides.onResume ?? ((agentId, sessionId, mode) => resumed.push(`${agentId}/${sessionId}/${mode}`))}
        onInboxChanged={overrides.onInboxChanged ?? (() => { changed += 1; })}
      />
    </WorkspaceProvider>,
  );
  return { ...view, opened, resumed, isChanged: () => changed };
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

  it('error 会话的详情提示条提供「重试」主按钮，回调 mode 为 retry', async () => {
    stubFetch([ITEM]);
    const { resumed } = renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    assert.deepEqual(resumed, ['agent-one/s1/retry']);
  });

  it('aborted 会话的详情提示条提供「继续」主按钮，回调 mode 为 continue', async () => {
    stubFetch([{ ...ITEM, attentionReason: 'aborted', attentionDetail: undefined }]);
    const { resumed } = renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);

    fireEvent.click(await screen.findByRole('button', { name: '继续' }));
    assert.deepEqual(resumed, ['agent-one/s1/continue']);
  });

  it('已完成的会话不再显示恢复按钮', async () => {
    stubFetch([{ ...ITEM, completedAt: '2026-08-21T09:00:00.000Z' }]);
    renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);

    await screen.findByText('在聊天中打开');
    assert.equal(screen.queryByRole('button', { name: '重试' }), null, 'completedAt 已置位时不显示重试');
    assert.equal(screen.queryByRole('button', { name: '继续' }), null, 'completedAt 已置位时不显示继续');
  });
});

describe('InboxView 工具审批（HITL）', () => {
  /** 打开待审批条目的详情分栏，返回行元素。 */
  async function openApprovalDetail(items: InboxItem[]) {
    renderInbox();
    const row = (await screen.findByText(items[0]!.title)).closest('.inbox-row')!;
    fireEvent.doubleClick(row);
    await screen.findByRole('region', { name: '审批请求' });
    return row;
  }

  it('pendingApproval 行追加蓝色「待审批」药丸，详情顶部渲染审批卡片', async () => {
    stubFetch([APPROVAL_ITEM]);
    const row = await openApprovalDetail([APPROVAL_ITEM]);

    assert.ok(row.querySelector('.inbox-status.approval'), '行应带 approval 药丸');
    assert.ok(screen.getByText('待审批'));
    assert.equal(row.querySelector('.inbox-status:not(.approval)'), null, 'needsAttention=false 时不显示出错药丸');

    assert.ok(screen.getByText(APPROVAL.message), '卡片应显示审批摘要');
    assert.ok(screen.getByText('审批请求'));
    assert.ok(screen.getByText('10 分钟内未处理将过期'));
    assert.ok(screen.getByRole('button', { name: '批准' }));
    assert.ok(screen.getByRole('button', { name: '始终允许' }));
    assert.ok(screen.getByRole('button', { name: '拒绝' }));
  });

  it('「批准」POST { approved: true } 并触发收件箱刷新', async () => {
    const calls = stubFetch([APPROVAL_ITEM]);
    const changed: number[] = [];
    renderInbox({ onInboxChanged: () => changed.push(1) });

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/v1/approvals/ap1/decision'));
      assert.ok(post, '应发起审批决策 POST');
      assert.deepEqual(JSON.parse(post.body!), { approved: true });
    });
    assert.ok(changed.length > 0, '决策成功后应触发 onInboxChanged 刷新收件箱');
  });

  it('「始终允许」POST { approved: true, always: true }，并注明写入项目权限策略', async () => {
    const calls = stubFetch([APPROVAL_ITEM]);
    renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);
    const always = await screen.findByRole('button', { name: '始终允许' });
    assert.equal(always.getAttribute('title'), '写入项目权限策略，长期生效');
    fireEvent.click(always);

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/v1/approvals/ap1/decision'));
      assert.ok(post);
      assert.deepEqual(JSON.parse(post.body!), { approved: true, always: true });
    });
  });

  it('「拒绝」先展开理由输入框，确认后 POST { approved: false, reason }', async () => {
    const calls = stubFetch([APPROVAL_ITEM]);
    renderInbox();

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));

    const input = await screen.findByLabelText('拒绝理由');
    assert.equal(screen.queryByRole('button', { name: '批准' }), null, '展开理由输入后三个决策按钮应收起');
    fireEvent.change(input, { target: { value: '构建机不允许跑测试' } });
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/v1/approvals/ap1/decision'));
      assert.ok(post);
      assert.deepEqual(JSON.parse(post.body!), { approved: false, reason: '构建机不允许跑测试' });
    });
  });

  it('409 时提示「该审批已被处理或已过期」并刷新收件箱', async () => {
    stubFetch([APPROVAL_ITEM], { decisionStatus: 409 });
    const notes: string[] = [];
    const changed: number[] = [];
    renderInbox({ notify: (text) => notes.push(text), onInboxChanged: () => changed.push(1) });

    const row = (await screen.findByText('排查构建失败')).closest('.inbox-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));

    await waitFor(() => assert.ok(notes.includes('该审批已被处理或已过期'), '409 应提示已处理/已过期'));
    assert.ok(changed.length > 0, '409 后也应刷新收件箱让条目出队');
  });
});
