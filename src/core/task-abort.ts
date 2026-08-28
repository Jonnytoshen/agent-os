export interface ActiveRun {
  controller: AbortController;
  ownerOpenId: string;
  cancelMode?: 'stop' | 'close';
}

export type AbortTaskOutcome = 'stopped' | 'already_stopping' | 'not_found' | 'forbidden';

/**
 * 请求中止一个正在执行的任务。
 * @param activeRuns 当前活跃的任务集合。
 * @param sessionId 需要中止的任务对应的会话 ID。
 * @param operatorOpenId 发起中止请求的操作者的 OpenID。
 * @returns 中止请求的结果，可能是 'stopped'、'already_stopping'、'not_found' 或 'forbidden'。
 */
export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  operatorOpenId: string,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  if (!active) return 'not_found';
  if (operatorOpenId !== active.ownerOpenId) return 'forbidden';
  if (active.controller.signal.aborted) return 'already_stopping';
  active.cancelMode = 'stop';
  active.controller.abort();
  return 'stopped';
}
