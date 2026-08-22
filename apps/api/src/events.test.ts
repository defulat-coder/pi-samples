import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PendingApproval } from '@pi-workbench/contracts';
import { AgentSessionStore, ApprovalBridge, openWorkbenchDb } from '@pi-workbench/pi-agent';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { WorkbenchEventBus } from './routes/events.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  PI_AGENT_ENABLED: false,
  PI_PROJECT_EXTENSIONS_ENABLED: false,
  LOG_LEVEL: 'error',
};

const approval: PendingApproval = {
  id: 'req-1',
  sessionId: 'session_a',
  agentId: 'pi-assistant',
  agentName: '测试助手',
  message: '运行 bash: ls',
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

/** 最小 mock：hijack 后的 raw response 只需要 write/setHeader/flushHeaders/end/once（add 监听 raw 的 close）。 */
function fakeClient(captured: string[]): { request: FastifyRequest; reply: FastifyReply; raw: { write: (chunk: string) => void; writableEnded: boolean; destroyed: boolean } } {
  const raw = {
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => captured.push(chunk),
    end: () => undefined,
    once: () => undefined,
  };
  const reply = { raw, hijack: () => undefined } as unknown as FastifyReply;
  const request = { raw: { once: () => undefined } } as unknown as FastifyRequest;
  return { request, reply, raw };
}

describe('WorkbenchEventBus', () => {
  it('broadcast 写出 event: approval 帧，写失败的客户端被移除', () => {
    const bus = new WorkbenchEventBus();
    const okChunks: string[] = [];
    const brokenChunks: string[] = [];
    const ok = fakeClient(okChunks);
    const broken = fakeClient(brokenChunks);
    bus.add(ok.request, ok.reply);
    bus.add(broken.request, broken.reply);
    assert.equal(bus.clientCount, 2);

    broken.raw.write = () => {
      throw new Error('client gone');
    };
    bus.broadcast({ type: 'approval', approval });

    assert.equal(bus.clientCount, 1, '写失败的客户端必须被移除');
    assert.equal(brokenChunks.length, 0);
    assert.equal(okChunks.length, 1);
    const [frame] = okChunks;
    assert.ok(frame!.startsWith('event: approval\n'));
    const data = JSON.parse(frame!.split('\n')[1]!.replace(/^data: /, '')) as { type: string; approval: PendingApproval };
    assert.equal(data.type, 'approval');
    assert.equal(data.approval.id, 'req-1');
    assert.equal(data.approval.agentName, '测试助手');

    // 已结束/已销毁的连接在 broadcast 时也会被清出集合。
    ok.raw.writableEnded = true;
    bus.broadcast({ type: 'approval', approval });
    assert.equal(bus.clientCount, 0);
  });
});

describe('GET /api/v1/events', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-api-events-'));
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.pi', 'agents', 'pi-assistant.md'),
    '---\nname: 测试助手\nmark: 测\ntagline: 测试\ndescription: 测试 agent。\nsuggestions:\n  - 你好\n---\n\n你是测试助手。\n',
  );
  const sessions = new AgentSessionStore({ cwd: root, sessionDir: join(root, 'sessions') });
  const db = openWorkbenchDb(':memory:');
  // 与 app.ts 默认桥一致接上 resolveAgentId，验证「反查 agentId → 映射 agentName」的完整链路。
  const bridge = new ApprovalBridge({ db, cwd: root, pollIntervalMs: 0, resolveAgentId: async (id) => (await sessions.getSession(id))?.agentId });
  const app = buildApp(config, { cwd: root, sessionStore: sessions, db, approvalBridge: bridge });
  const requestsDir = join(root, '.pi', 'permission-forwarding', 'sessions', 'permission-forwarding', 'sessions', 'workbench', 'requests');

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('审批请求出现即向已连接客户端推送 approval 帧（agentName 已映射）', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readFrame = (async () => {
      while (!received.includes('\n\n')) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    })();

    // 客户端连上后再触发一次扫描：新请求文件 → 落库 → onPending → 广播。
    // 先建带 agent 绑定的会话，resolveAgentId 才能反查出 agentId。
    await sessions.createSession('pi-assistant', 'session_sse');
    mkdirSync(requestsDir, { recursive: true });
    writeFileSync(
      join(requestsDir, 'req-sse.json'),
      JSON.stringify({
        id: 'req-sse',
        responseNonce: 'nonce-sse',
        createdAt: 1_700_000_000_000,
        requesterSessionId: 'session_sse',
        targetSessionId: 'workbench',
        requesterAgentName: 'unknown',
        message: '运行 bash: echo hi',
      }),
    );
    await bridge.scan();

    await readFrame;
    await reader.cancel();

    assert.ok(received.startsWith('event: approval\n'), `首帧必须是 approval 事件，实际：${received}`);
    const data = JSON.parse(received.split('\n')[1]!.replace(/^data: /, '')) as { type: string; approval: PendingApproval };
    assert.equal(data.type, 'approval');
    assert.equal(data.approval.id, 'req-sse');
    assert.equal(data.approval.sessionId, 'session_sse');
    assert.equal(data.approval.agentId, 'pi-assistant');
    assert.equal(data.approval.agentName, '测试助手', '广播的 agentName 必须由 agentId 映射为真实名');
  });
});
