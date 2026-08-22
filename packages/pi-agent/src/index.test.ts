import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgentSession, getPiModelConfig, getPiProjectRoot, KeyedExecutor, listPiModels, PiSessionRegistry, type PiAgentSession, type PiAgentSessionOptions } from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureCwd(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  roots.push(root);
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  for (const id of ['agent-one', 'agent-two']) {
    writeFileSync(join(root, '.pi', 'agents', `${id}.md`), `---\nname: ${id}\nmark: ${id[0]}\ntagline: 测试\ndescription: 测试 agent。\nsuggestions:\n  - 你好\n---\n\n你是 ${id}。\n`);
  }
  return root;
}

describe('pi agent runtime', () => {
  it('resolves the kimi-coding default model config', () => {
    const config = getPiModelConfig({}, getPiProjectRoot());
    assert.equal(config.provider, 'kimi-coding');
    assert.ok(config.model);
  });

  it('lists the static kimi-coding model catalog', async () => {
    const models = await listPiModels();
    const ids = models.map((model) => model.id);
    assert.ok(ids.includes('kimi-for-coding'));
    assert.ok(ids.includes('kimi-for-coding-highspeed'));
    assert.ok(ids.includes('k3'));
    assert.ok(ids.includes('k3-256k'));
  });

  it('creates a pure-chat session without any tools', async () => {
    const runtime = await createPiAgentSession({ cwd: fixtureCwd(), agentId: 'agent-one', persistSession: false });
    try {
      assert.equal(runtime.agentId, 'agent-one');
      assert.deepEqual(runtime.session.getActiveToolNames(), []);
      assert.match(runtime.session.systemPrompt, /你是 agent-one。/);
    } finally {
      runtime.close();
    }
  });

  it('refuses to open another agent session through the direct runtime interface', async () => {
    const cwd = fixtureCwd();
    const sessionDir = join(cwd, '.pi', 'sessions');
    const first = await createPiAgentSession({ cwd, agentId: 'agent-one', sessionId: 'owned-session', sessionDir });
    first.close();
    await assert.rejects(() => createPiAgentSession({ cwd, agentId: 'agent-two', sessionId: 'owned-session', sessionDir }), /AGENT_SESSION_MISMATCH/);
  });

  it('throws explicitly when the configured model is not in the catalog', async () => {
    await assert.rejects(() => createPiAgentSession({ cwd: fixtureCwd(), agentId: 'agent-one', persistSession: false, model: 'no-such-model' }), /Pi model not found/);
  });
});

describe('KeyedExecutor', () => {
  it('serializes tasks per key while different keys stay parallel', async () => {
    const executor = new KeyedExecutor();
    const order: string[] = [];
    const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

    await Promise.all([
      executor.run('a', async () => { order.push('a1:start'); await gate(); order.push('a1:end'); }),
      executor.run('a', async () => { order.push('a2:start'); await gate(); order.push('a2:end'); }),
      executor.run('b', async () => { order.push('b1:start'); await gate(); order.push('b1:end'); }),
    ]);

    assert.ok(order.indexOf('a1:end') < order.indexOf('a2:start'), '同 key 的任务必须串行');
    assert.ok(order.indexOf('b1:start') < order.indexOf('a1:end'), '不同 key 的任务应并行');
  });

  it('propagates task errors without poisoning the queue', async () => {
    const executor = new KeyedExecutor();
    await assert.rejects(() => executor.run('a', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await executor.run('a', async () => 'ok'), 'ok');
  });
});

describe('PiSessionRegistry', () => {
  it('创建失败不缓存 rejected Promise：同 key 重试会重新创建', async () => {
    const cwd = fixtureCwd();
    const sessionDir = join(cwd, '.pi', 'sessions');
    const registry = new PiSessionRegistry();
    try {
      await assert.rejects(
        () => registry.run('agent-one', 'retry-session', '你好', {}, { cwd, sessionDir, model: 'no-such-model' }),
        /no-such-model/,
      );
      // 若 rejected Promise 被缓存，第二次仍会报 no-such-model；重新创建才会看到新的模型名。
      await assert.rejects(
        () => registry.run('agent-one', 'retry-session', '你好', {}, { cwd, sessionDir, model: 'still-missing' }),
        /still-missing/,
      );
      // 失败条目已摘除，abort 不应因残留的 rejected Promise 而上抛。
      await registry.abort('agent-one', 'retry-session');
    } finally {
      await registry.closeAll();
    }
  });
});

describe('PiSessionRegistry 空闲淘汰', () => {
  /** 不触网的假会话工厂：subscribe/prompt 是 collectTurn 的全部依赖，close 记录淘汰。 */
  function fakeFactory(state: { calls: number; closes: string[]; prompt?: () => Promise<void> }) {
    return async (options: PiAgentSessionOptions): Promise<PiAgentSession> => {
      state.calls += 1;
      const tag = `${options.agentId}:${options.sessionId}#${state.calls}`;
      return {
        cwd: options.cwd ?? '',
        agentId: options.agentId,
        session: {
          subscribe: () => () => undefined,
          prompt: () => state.prompt?.() ?? Promise.resolve(),
        } as unknown as PiAgentSession['session'],
        sessionManager: undefined as unknown as PiAgentSession['sessionManager'],
        close: () => state.closes.push(tag),
      };
    };
  }

  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

  it('空闲超过 TTL 的条目在下一次操作时被淘汰重建，未过期则复用', async () => {
    let now = 1_000_000;
    const state = { calls: 0, closes: [] as string[] };
    const registry = new PiSessionRegistry({ idleTtlMs: 1000, now: () => now, createSession: fakeFactory(state) });
    try {
      await registry.run('agent-one', 's1', '你好');
      await registry.run('agent-one', 's1', '复读');
      assert.equal(state.calls, 1, '未过期的条目必须复用');

      now += 2000;
      await registry.run('agent-one', 's1', '换新的');
      assert.equal(state.calls, 2, '过期条目应被淘汰重建而非复用');
      await flushMicrotasks();
      assert.deepEqual(state.closes, ['agent-one:s1#1'], '被淘汰的旧会话应调用 close 释放');
    } finally {
      await registry.closeAll();
    }
  });

  it('进行中的 turn 所在的 key 不会被顺带清扫淘汰', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state: { calls: number; closes: string[]; prompt?: () => Promise<void> } = { calls: 0, closes: [], prompt: () => gate };
    const registry = new PiSessionRegistry({ idleTtlMs: 1000, now: () => now, createSession: fakeFactory(state) });
    try {
      const turn = registry.run('agent-one', 'busy', '卡住');
      await flushMicrotasks();
      assert.equal(state.calls, 1);

      // 另一个 session 的操作触发 lazy sweep；busy 已过期但有 in-flight turn，不能淘汰。
      now += 2000;
      state.prompt = undefined;
      await registry.run('agent-one', 'sweeper', '扫一下');
      await flushMicrotasks();
      assert.deepEqual(state.closes, [], '有进行中 turn 的条目不得被淘汰');

      release();
      await turn;
      await registry.run('agent-one', 'busy', '继续');
      assert.equal(state.calls, 2, 'busy 条目仍在（turn 结束刷新 lastUsedAt），只有 sweeper 新建了一次');
    } finally {
      await registry.closeAll();
    }
  });
});
