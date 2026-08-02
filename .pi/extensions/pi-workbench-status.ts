import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A deliberately read-only Pi extension for the native CLI/RPC runtime.
 * The Web gateway keeps project extensions opt-in and still applies its
 * read/search tool allowlist, so this command cannot grant new capabilities.
 */
export default function registerPiWorkbenchStatus(pi: ExtensionAPI) {
  pi.registerCommand("pi-resource-status", {
    description: "显示当前 Pi 项目的资源与工具状态",
    handler: async (_args, ctx) => {
      const systemPrompt = ctx.getSystemPromptOptions();
      const skills = systemPrompt.skills?.length ?? 0;
      const tools = systemPrompt.selectedTools?.join(", ") || "无";
      const prompts = systemPrompt.cwd ? ".pi/prompts" : "未绑定项目";
      ctx.ui.notify(`Pi 资源：${skills} 个 Skill · 提示词目录 ${prompts} · 工具：${tools}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-workbench", "项目资源已加载");
  });
}
