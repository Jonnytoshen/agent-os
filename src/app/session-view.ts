import { getCliAdapter } from '../cli/registry';
import { Session, SessionManager } from '../core/session-manager';

const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
};

/**
 * 格式化会话状态信息为可读字符串。
 * @param session 会话对象。
 * @param botId 机器人 ID。
 * @returns 格式化后的会话状态字符串。
 */
export function formatSessionStatus(session: Session, botId: string): string {
  const adapter = getCliAdapter(session.cliId);
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `CLI 会话：${session.cliSessionId ?? '(尚未建立)'}`,
    `工作目录：${session.workspaceDir}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join('\n');
}

/**
 * 将会话标记为空闲状态。
 * @param sessions 会话管理器实例。
 * @param sessionId 会话 ID。
 */
export async function markSessionIdle(sessions: SessionManager, sessionId: string): Promise<void> {
  if (sessions.get(sessionId)?.status !== 'active') return;
  await sessions.transition(sessionId, 'idle');
  console.log(`[会话] id=${sessionId} status=idle`);
}
