import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalDecisionRequest, ApprovalState, PendingApproval } from '@pi-workbench/contracts';
import { getApproval, getPendingApprovalsBySession, listApprovals, recordPendingApproval, resolveApproval, type StoredApproval, type WorkbenchDb } from './db.js';
import { getPermissionForwardingSessionsDir } from './permissions.js';

/**
 * 审批桥：pi-permission-system 扩展在 headless（无 UI + subagent env）模式下把 ask 决策
 * 写成转发文件——<sessionsDir>/<targetSessionId>/requests/<id>.json，并轮询同级的
 * responses/<id>.json 等回包（最长 10 分钟，消费后自行删除两个文件）。
 * 文件队列只是与扩展之间的传输层：本模块把请求落进 SQLite（通用工作台数据），
 * 审批决策动作由 respond() 写响应文件完成。
 *
 * 多会话路由不指望 targetSessionId（进程级 env 全局固定），而是扫描整个
 * sessions/*\/requests 树，按请求文件里的 requesterSessionId 归属到会话。
 */

export type ApprovalErrorCode = 'APPROVAL_NOT_FOUND' | 'APPROVAL_ALREADY_RESOLVED';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode) {
    super(code);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export interface ApprovalBridgeOptions {
  db: WorkbenchDb;
  /** 项目根；转发目录与扩展 env 推导保持一致（见 permissions.ts）。 */
  cwd: string;
  /** 由会话绑定反查 agentId；会话不存在时返回 undefined。 */
  resolveAgentId?: (sessionId: string) => Promise<string | undefined>;
  /** 新 pending 审批出现时回调（进程级通知，可用于触发 Web 侧刷新）。 */
  onPending?: (approval: PendingApproval) => void;
  /** 定时兜底扫描间隔（fs.watch 可能漏原子 rename）；0 = 关闭（测试用手动 scan）。 */
  pollIntervalMs?: number;
}

/** 扩展请求文件的线格式（参照 permission-forwarding.ts 的 ForwardedPermissionRequest）。 */
interface ForwardedRequest {
  id: string;
  responseNonce: string;
  createdAt: number;
  requesterSessionId: string;
  targetSessionId: string;
  requesterAgentName: string;
  message: string;
}

function parseForwardedRequest(path: string): ForwardedRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ForwardedRequest>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.responseNonce !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.requesterSessionId !== 'string' ||
      typeof parsed.targetSessionId !== 'string' ||
      typeof parsed.requesterAgentName !== 'string' ||
      typeof parsed.message !== 'string'
    ) {
      return undefined;
    }
    return parsed as ForwardedRequest;
  } catch {
    // 半写入/损坏文件：跳过，下一轮扫描再试。
    return undefined;
  }
}

function toPendingApproval(approval: StoredApproval): PendingApproval {
  return {
    id: approval.id,
    sessionId: approval.sessionId,
    ...(approval.agentId ? { agentId: approval.agentId } : {}),
    agentName: approval.agentName,
    message: approval.message,
    createdAt: approval.createdAt,
  };
}

export class ApprovalBridge {
  readonly db: WorkbenchDb;
  /** 监听根：.../permission-forwarding/sessions（其下每个子目录是一个 targetSessionId）。 */
  readonly sessionsDir: string;
  private readonly resolveAgentId?: (sessionId: string) => Promise<string | undefined>;
  private readonly pendingListeners = new Set<(approval: PendingApproval) => void>();
  private readonly pollIntervalMs: number;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** scan 串行化：watch 事件与轮询可能并发触发。 */
  private scanQueue: Promise<void> = Promise.resolve();

  constructor(options: ApprovalBridgeOptions) {
    this.db = options.db;
    this.sessionsDir = getPermissionForwardingSessionsDir(options.cwd);
    this.resolveAgentId = options.resolveAgentId;
    if (options.onPending) this.pendingListeners.add(options.onPending);
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  /** 追加 pending 监听器（如 API 层的 SSE 广播）；监听器异常不影响扫描与其他监听器。 */
  addPendingListener(callback: (approval: PendingApproval) => void): void {
    this.pendingListeners.add(callback);
  }

  private emitPending(approval: PendingApproval): void {
    for (const listener of this.pendingListeners) {
      try {
        listener(approval);
      } catch {
        // 监听器故障（如 SSE 客户端集体断开）不应中断扫描。
      }
    }
  }

  /** 启动时全量扫一遍兜底，再挂 fs.watch + 低频轮询。 */
  start(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    this.enqueueScan();
    try {
      this.watcher = watch(this.sessionsDir, { recursive: true, persistent: false }, () => this.enqueueScan());
    } catch {
      // 目录不可 watch 时仅靠轮询兜底。
    }
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => this.enqueueScan(), this.pollIntervalMs);
      this.timer.unref();
    }
  }

  close(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }

  private enqueueScan(): void {
    this.scanQueue = this.scanQueue.then(() => this.scan());
  }

  /** 扫一遍转发树：新请求落库并回调；文件已消失的 pending 记录标记 expired。 */
  async scan(): Promise<void> {
    let targetDirs: string[];
    try {
      targetDirs = readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const target of targetDirs) {
      const requestsDir = join(this.sessionsDir, target, 'requests');
      let files: string[];
      try {
        files = readdirSync(requestsDir).filter((name) => name.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        const request = parseForwardedRequest(join(requestsDir, file));
        if (!request) continue;
        const agentId = await this.resolveAgentId?.(request.requesterSessionId);
        const inserted = recordPendingApproval(this.db, {
          id: request.id,
          sessionId: request.requesterSessionId,
          ...(agentId ? { agentId } : {}),
          agentName: request.requesterAgentName,
          message: request.message,
          responseNonce: request.responseNonce,
          targetSessionId: request.targetSessionId,
          createdAt: new Date(request.createdAt).toISOString(),
        });
        if (inserted) {
          const stored = getApproval(this.db, request.id);
          if (stored) this.emitPending(toPendingApproval(stored));
        }
      }
    }
    // 请求文件消失但未被我们决策（扩展超时/外部消费）：落终态，避免永远挂在收件箱。
    for (const row of listApprovals(this.db, 'pending')) {
      if (!existsSync(this.requestPath(row))) resolveApproval(this.db, row.id, 'expired');
    }
  }

  private requestPath(row: StoredApproval): string {
    return join(this.sessionsDir, encodeURIComponent(row.targetSessionId), 'requests', `${row.id}.json`);
  }

  /** 审批决策：写响应文件（原子 tmp+rename）+ 更新 SQLite。 */
  respond(requestId: string, decision: ApprovalDecisionRequest): StoredApproval {
    const row = getApproval(this.db, requestId);
    if (!row) throw new ApprovalError('APPROVAL_NOT_FOUND');
    if (row.state !== 'pending') throw new ApprovalError('APPROVAL_ALREADY_RESOLVED');

    const state: ApprovalState = decision.approved ? (decision.always ? 'always' : 'approved') : decision.reason ? 'denied_with_reason' : 'denied';
    const responsesDir = join(this.sessionsDir, encodeURIComponent(row.targetSessionId), 'responses');
    mkdirSync(responsesDir, { recursive: true });
    const response = {
      requestId: row.id,
      // nonce 照抄、responderSessionId 必须等于请求的 targetSessionId，否则扩展拒收。
      responseNonce: row.responseNonce,
      approved: decision.approved,
      state,
      ...(decision.reason ? { denialReason: decision.reason } : {}),
      responderSessionId: row.targetSessionId,
      respondedAt: Date.now(),
    };
    const file = join(responsesDir, `${row.id}.json`);
    const tmp = join(responsesDir, `${row.id}.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(response));
    renameSync(tmp, file);
    resolveApproval(this.db, row.id, state);
    return getApproval(this.db, row.id)!;
  }

  /** 收件箱集成的便捷转发（保持路由层不直接感知表结构）。 */
  pendingBySession(): Map<string, StoredApproval> {
    return getPendingApprovalsBySession(this.db);
  }
}
