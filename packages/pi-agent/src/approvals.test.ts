import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBridge, ApprovalError, getApproval, listApprovals, loadPermissionExtension, openWorkbenchDb, type WorkbenchDb } from './index.js';

const TARGET_SESSION = 'workbench';
const roots: string[] = [];
const dbs: WorkbenchDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; db: WorkbenchDb; bridge: ApprovalBridge; requestsDir: string; responsesDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-approvals-'));
  roots.push(root);
  const db = openWorkbenchDb(':memory:');
  dbs.push(db);
  const bridge = new ApprovalBridge({ db, cwd: root, pollIntervalMs: 0 });
  const sessionsDir = join(root, '.pi', 'permission-forwarding', 'sessions', 'permission-forwarding', 'sessions');
  return { root, db, bridge, requestsDir: join(sessionsDir, TARGET_SESSION, 'requests'), responsesDir: join(sessionsDir, TARGET_SESSION, 'responses') };
}

function writeRequest(requestsDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const request = {
    id: 'req-1',
    responseNonce: 'nonce-1',
    createdAt: 1_700_000_000_000,
    requesterSessionId: 'session_a',
    targetSessionId: TARGET_SESSION,
    requesterAgentName: 'pi-assistant',
    message: '运行 bash: ls -la',
    ...overrides,
  };
  mkdirSync(requestsDir, { recursive: true });
  writeFileSync(join(requestsDir, `${request.id as string}.json`), JSON.stringify(request));
  return request;
}

describe('ApprovalBridge', () => {
  it('扫描转发树：新请求落库为 pending 并回调，重复扫描幂等', async () => {
    const { root, db, requestsDir } = fixture();
    writeRequest(requestsDir);
    const seen: string[] = [];
    const watched = new ApprovalBridge({ db, cwd: root, pollIntervalMs: 0, onPending: (a) => seen.push(a.id) });

    await watched.scan();
    const row = getApproval(db, 'req-1');
    assert.ok(row);
    assert.equal(row.state, 'pending');
    assert.equal(row.sessionId, 'session_a');
    assert.equal(row.agentName, 'pi-assistant');
    assert.equal(row.message, '运行 bash: ls -la');
    assert.equal(row.responseNonce, 'nonce-1');
    assert.equal(row.createdAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(seen, ['req-1']);

    await watched.scan();
    assert.deepEqual(seen, ['req-1'], '重复扫描不得重复回调');
    assert.equal(listApprovals(db, 'pending').length, 1);
  });

  it('scan 通过 resolveAgentId 反查会话绑定', async () => {
    const { root, db, requestsDir } = fixture();
    writeRequest(requestsDir);
    const bridge = new ApprovalBridge({ db, cwd: root, pollIntervalMs: 0, resolveAgentId: async (id) => (id === 'session_a' ? 'pi-assistant' : undefined) });
    await bridge.scan();
    assert.equal(getApproval(db, 'req-1')?.agentId, 'pi-assistant');
  });

  it('批准：写响应文件（nonce 照抄、responderSessionId=targetSessionId）并落终态', async () => {
    const { bridge, requestsDir, responsesDir } = fixture();
    writeRequest(requestsDir);
    await bridge.scan();

    const record = bridge.respond('req-1', { approved: true });
    assert.equal(record.state, 'approved');
    assert.ok(record.resolvedAt);

    const response = JSON.parse(readFileSync(join(responsesDir, 'req-1.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(response.requestId, 'req-1');
    assert.equal(response.responseNonce, 'nonce-1');
    assert.equal(response.approved, true);
    assert.equal(response.state, 'approved');
    assert.equal(response.responderSessionId, TARGET_SESSION);
    assert.equal(typeof response.respondedAt, 'number');
  });

  it('拒绝带原因 / always 批准的状态映射', async () => {
    const { db, bridge, requestsDir, responsesDir } = fixture();
    writeRequest(requestsDir);
    writeRequest(requestsDir, { id: 'req-2', responseNonce: 'nonce-2' });
    writeRequest(requestsDir, { id: 'req-3', responseNonce: 'nonce-3' });
    await bridge.scan();

    bridge.respond('req-1', { approved: false });
    assert.equal(getApproval(db, 'req-1')?.state, 'denied');
    assert.ok(!('denialReason' in JSON.parse(readFileSync(join(responsesDir, 'req-1.json'), 'utf8'))));

    bridge.respond('req-2', { approved: false, reason: '不允许删除' });
    assert.equal(getApproval(db, 'req-2')?.state, 'denied_with_reason');
    assert.equal(JSON.parse(readFileSync(join(responsesDir, 'req-2.json'), 'utf8')).denialReason, '不允许删除');

    bridge.respond('req-3', { approved: true, always: true });
    assert.equal(getApproval(db, 'req-3')?.state, 'always');
    assert.equal(JSON.parse(readFileSync(join(responsesDir, 'req-3.json'), 'utf8')).state, 'always');
  });

  it('重复决策 409 语义、未知 id 404 语义', async () => {
    const { bridge, requestsDir } = fixture();
    writeRequest(requestsDir);
    await bridge.scan();

    bridge.respond('req-1', { approved: true });
    assert.throws(() => bridge.respond('req-1', { approved: true }), (error) => error instanceof ApprovalError && error.code === 'APPROVAL_ALREADY_RESOLVED');
    assert.throws(() => bridge.respond('no-such', { approved: true }), (error) => error instanceof ApprovalError && error.code === 'APPROVAL_NOT_FOUND');
  });

  it('请求文件消失（扩展超时/外部消费）的 pending 记录被扫描落成 expired', async () => {
    const { db, bridge, requestsDir } = fixture();
    writeRequest(requestsDir);
    await bridge.scan();
    assert.equal(getApproval(db, 'req-1')?.state, 'pending');

    rmSync(join(requestsDir, 'req-1.json'));
    await bridge.scan();
    const row = getApproval(db, 'req-1');
    assert.equal(row?.state, 'expired');
    assert.ok(row?.resolvedAt);
  });
});

describe('审批扩展加载层', () => {
  it('预编译产物可 import 且默认导出是扩展工厂', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-permission-load-'));
    roots.push(root);
    const extension = await loadPermissionExtension(root);
    assert.equal(typeof extension, 'function');
    // env 在 import 前设置，且指向项目内转发目录。
    assert.equal(process.env.PI_IS_SUBAGENT, '1');
    assert.equal(process.env.PI_AGENT_ROUTER_PARENT_SESSION_ID, TARGET_SESSION);
    assert.equal(process.env.PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR, join(root, '.pi', 'permission-forwarding'));
    assert.equal(process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH, join(root, '.pi', 'permission-forwarding', 'pi-permission-system.config.json'));
    assert.equal(process.env.PI_PERMISSION_SYSTEM_LOGS_DIR, join(root, '.pi', 'permission-forwarding', 'logs'));
    assert.ok(existsSync(new URL('./permission-system.mjs', import.meta.url)), 'dist 里必须存在预编译产物');
  });
});
