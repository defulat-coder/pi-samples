import { resolve } from 'node:path';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * HITL 工具审批扩展（pi-permission-system）的加载层。
 *
 * 该包只发布 TS 源码且直接静态 import 会拖垮 tsc，因此构建期由
 * scripts/build-permission-ext.mjs 预编译成 dist/permission-system.mjs，
 * 这里只用动态 import 引用编译产物（import 说明符是非字面量，tsc 不解析）。
 *
 * 三个进程级 env 决定扩展的 headless 行为，且部分在扩展模块加载期被捕获，
 * 必须在动态 import 之前设置：
 *  - PI_IS_SUBAGENT=1 让 ask 决策走文件转发而非 UI 弹窗；
 *  - PI_AGENT_ROUTER_PARENT_SESSION_ID 是转发的目标会话 id（固定值，进程全局）；
 *  - PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR 把转发根目录钉在项目内。
 * 另外把扩展自身的 config.json / logs 也重定向进转发目录——默认它会写到
 * 扩展根目录（bundle 场景下就是本包目录，会污染仓库）。
 */

/** 所有会话的审批请求都转发到这个固定的目标 id 下（按 requesterSessionId 区分来源会话）。 */
export const PERMISSION_FORWARDING_TARGET_SESSION = 'workbench';

/** 扩展运行时状态根（gitignored）：转发文件树 + 扩展自身 config/logs。 */
export function getPermissionStateDir(cwd: string): string {
  return resolve(cwd, '.pi/permission-forwarding');
}

/** 转发根：<agentDir>/sessions/permission-forwarding/sessions（扩展在 agentDir 基础上拼出）。 */
export function getPermissionForwardingSessionsDir(cwd: string): string {
  return resolve(getPermissionStateDir(cwd), 'sessions/permission-forwarding/sessions');
}

let cachedExtension: Promise<InlineExtension> | undefined;

/** 加载审批扩展工厂；进程内只 import 一次，后续调用共享同一实例。 */
export function loadPermissionExtension(cwd: string): Promise<InlineExtension> {
  // 已被显式设置时不覆盖（测试或宿主自定义）；扩展运行期也会读这些 env。
  process.env.PI_IS_SUBAGENT ??= '1';
  process.env.PI_AGENT_ROUTER_PARENT_SESSION_ID ??= PERMISSION_FORWARDING_TARGET_SESSION;
  process.env.PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR ??= getPermissionStateDir(cwd);
  process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH ??= resolve(getPermissionStateDir(cwd), 'pi-permission-system.config.json');
  process.env.PI_PERMISSION_SYSTEM_LOGS_DIR ??= resolve(getPermissionStateDir(cwd), 'logs');
  cachedExtension ??= (async () => {
    const artifactUrl = new URL('./permission-system.mjs', import.meta.url);
    const loaded = (await import(artifactUrl.href)) as { default?: unknown };
    if (typeof loaded.default !== 'function') {
      throw new Error('pi-permission-system 预编译产物缺少默认导出（扩展工厂）');
    }
    return loaded.default as InlineExtension;
  })();
  return cachedExtension;
}
