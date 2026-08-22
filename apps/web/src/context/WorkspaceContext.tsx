import { createContext, useContext, type ReactNode } from 'react';
import type { SessionSummary, WorkspaceResponse } from '@pi-workbench/contracts';

/**
 * 跨组件（Sidebar / Composer / ExploreAgents / InboxView / CommandPalette / SkillsView /
 * ConfigPanel）共享的工作区数据分发。App 顶层的数据获取逻辑不变，只把下发方式从逐层
 * props 换成 context；只传给单个子组件的状态仍走 props。
 */
export interface WorkspaceContextValue {
  workspace: WorkspaceResponse;
  sessionsByAgent: Record<string, SessionSummary[]>;
  notify: (text: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return value;
}
