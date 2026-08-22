import type { WorkbenchEvent } from '@pi-workbench/contracts';

export type { WorkbenchEvent };

/**
 * 订阅工作台事件流；返回退订函数（removeEventListener + close）。
 * 心跳为 `:hb` 注释帧不会进 message；网络错误依赖 EventSource 内建自动重连。
 */
export function subscribeWorkbenchEvents(onEvent: (event: WorkbenchEvent) => void): () => void {
  const source = new EventSource('/api/v1/events');
  const handle = (message: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(message.data) as WorkbenchEvent);
    } catch {
      // 忽略无法解析的帧，不中断流。
    }
  };
  source.addEventListener('approval', handle);
  return () => {
    source.removeEventListener('approval', handle);
    source.close();
  };
}
