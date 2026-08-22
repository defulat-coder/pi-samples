import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore, ApprovalBridge, getApproval, openWorkbenchDb, recordPendingApproval } from '@pi-workbench/pi-agent';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  PI_AGENT_ENABLED: false,
  PI_PROJECT_EXTENSIONS_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('审批 API', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-api-approvals-'));
  const sessionDir = join(root, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  // agent 定义 fixture：headless 扩展落库的 agentName 固定是 "unknown"，输出层按 agentId 映射真实名。
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.pi', 'agents', 'pi-assistant.md'),
    '---\nname: 测试助手\nmark: 测\ntagline: 测试\ndescription: 测试 agent。\nsuggestions:\n  - 你好\n---\n\n你是测试助手。\n',
  );
  const sessions = new AgentSessionStore({ cwd: root, sessionDir });
  const db = openWorkbenchDb(':memory:');
  const bridge = new ApprovalBridge({ db, cwd: root, pollIntervalMs: 0 });
  const app = buildApp(config, { cwd: root, sessionStore: sessions, db, approvalBridge: bridge });
  const responsesDir = join(root, '.pi', 'permission-forwarding', 'sessions', 'permission-forwarding', 'sessions', 'workbench', 'responses');
  const requestsDir = join(root, '.pi', 'permission-forwarding', 'sessions', 'permission-forwarding', 'sessions', 'workbench', 'requests');

  // 与生产一致：pending 行总是由 watcher 从请求文件落库，这里直插 DB 时补上对应文件，
  // 否则扫描会把「文件已消失」的行落成 expired。agentName 按真实扩展行为写 "unknown"。
  const insertPending = (id: string, sessionId: string) => {
    mkdirSync(requestsDir, { recursive: true });
    writeFileSync(
      join(requestsDir, `${id}.json`),
      JSON.stringify({
        id,
        responseNonce: `nonce-${id}`,
        createdAt: Date.now(),
        requesterSessionId: sessionId,
        targetSessionId: 'workbench',
        requesterAgentName: 'unknown',
        message: `运行 bash: ${id}`,
      }),
    );
    recordPendingApproval(db, {
      id,
      sessionId,
      agentId: 'pi-assistant',
      agentName: 'unknown',
      message: `运行 bash: ${id}`,
      responseNonce: `nonce-${id}`,
      targetSessionId: 'workbench',
      createdAt: new Date().toISOString(),
    });
  };

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /approvals 按 state 过滤且不泄露传输字段', async () => {
    insertPending('ap-1', 'session_x');
    insertPending('ap-2', 'session_x');

    const pending = await app.inject({ method: 'GET', url: '/api/v1/approvals?state=pending' });
    assert.equal(pending.statusCode, 200);
    const body = pending.json();
    assert.equal(body.total, 2);
    const item = body.items.find((entry: { id: string }) => entry.id === 'ap-1');
    assert.equal(item.sessionId, 'session_x');
    assert.equal(item.agentId, 'pi-assistant');
    // 落库的 "unknown"（headless 扩展取不到 agent 名）在输出层映射为真实 agent 名。
    assert.equal(item.agentName, '测试助手');
    assert.equal(item.state, 'pending');
    assert.equal(item.responseNonce, undefined, 'nonce 不得下发给浏览器');
    assert.equal(item.targetSessionId, undefined);
    // SQLite 里保留扩展落库的原值。
    assert.equal(getApproval(db, 'ap-1')?.agentName, 'unknown');

    const approved = await app.inject({ method: 'GET', url: '/api/v1/approvals?state=approved' });
    assert.equal(approved.json().total, 0);

    const badState = await app.inject({ method: 'GET', url: '/api/v1/approvals?state=weird' });
    assert.equal(badState.statusCode, 400);
  });

  it('POST decision 批准：写响应文件 + 落终态', async () => {
    insertPending('ap-approve', 'session_x');
    const response = await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-approve/decision', payload: { approved: true } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, 'approved');
    assert.ok(response.json().resolvedAt);

    const file = join(responsesDir, 'ap-approve.json');
    assert.ok(existsSync(file), '响应文件必须写入扩展的 responses 目录');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(written.responseNonce, 'nonce-ap-approve');
    assert.equal(written.responderSessionId, 'workbench');
    assert.equal(written.state, 'approved');
    assert.equal(getApproval(db, 'ap-approve')?.state, 'approved');
  });

  it('POST decision 拒绝带原因与 always 批准', async () => {
    insertPending('ap-deny', 'session_x');
    insertPending('ap-always', 'session_x');

    const denied = await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-deny/decision', payload: { approved: false, reason: '太危险' } });
    assert.equal(denied.statusCode, 200);
    assert.equal(denied.json().state, 'denied_with_reason');
    assert.equal(JSON.parse(readFileSync(join(responsesDir, 'ap-deny.json'), 'utf8')).denialReason, '太危险');

    const always = await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-always/decision', payload: { approved: true, always: true } });
    assert.equal(always.json().state, 'always');
    // 写出的响应文件 state 必须是扩展认识的 "always"（readForwardedPermissionResponse 校验枚举，
    // persistSessionApprovalDecision 据此写入会话级放行规则）。
    const alwaysFile = JSON.parse(readFileSync(join(responsesDir, 'ap-always.json'), 'utf8'));
    assert.equal(alwaysFile.state, 'always');
    assert.equal(alwaysFile.approved, true);
  });

  it('decision 的 400/404/409 语义', async () => {
    const badBody = await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-1/decision', payload: {} });
    assert.equal(badBody.statusCode, 400);

    const traversal = await app.inject({ method: 'POST', url: '/api/v1/approvals/..%2Fevil/decision', payload: { approved: true } });
    assert.equal(traversal.statusCode, 400);

    const missing = await app.inject({ method: 'POST', url: '/api/v1/approvals/no-such/decision', payload: { approved: true } });
    assert.equal(missing.statusCode, 404);

    // ap-approve 已在上个用例里被批准。
    const replay = await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-approve/decision', payload: { approved: false } });
    assert.equal(replay.statusCode, 409);
  });

  it('有待审批的会话并入 inbox attention，且携带 pendingApproval', async () => {
    const session = await sessions.createSession('pi-assistant', 'approval-session');
    insertPending('ap-inbox', session.id);

    const inbox = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    assert.equal(inbox.statusCode, 200);
    const item = inbox.json().items.find((entry: { id: string }) => entry.id === 'approval-session');
    assert.ok(item, '有待审批的会话必须出现在 attention tab');
    assert.equal(item.needsAttention, false, 'needsAttention 推导不受影响');
    assert.equal(item.pendingApproval.id, 'ap-inbox');
    assert.equal(item.pendingApproval.sessionId, 'approval-session');
    assert.equal(item.pendingApproval.agentName, '测试助手', 'inbox 的 pendingApproval 同样映射 agentName');
    assert.equal(item.pendingApproval.message, '运行 bash: ap-inbox');

    // 决策后不再出现在 attention。
    await app.inject({ method: 'POST', url: '/api/v1/approvals/ap-inbox/decision', payload: { approved: true } });
    const after = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    assert.ok(!after.json().items.some((entry: { id: string }) => entry.id === 'approval-session'));
  });
});
