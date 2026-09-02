/**
 * `CollaborationMessage` 是程序内部的交接单。
 *
 *  - taskId 标识整项协作
 *  - dispatchId 则标识当前这一次投递
 *
 * 飞书消息负责提醒目标 bot，真正执行所需的任务内容和目录由这张交接单保存。
 */
export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  fromBotId: string;
  toBotId: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
}

/**
 * `collaborationTurnKey` 用于生成协作消息的唯一标识。
 * 它由 taskId、round 和 toBotId 组成，确保每一轮的协作消息都能被唯一识别。
 *
 * 第一轮可以得到 `T123:1:reviewer`，第二轮则是 `T123:2:developer`。
 * 同一个任务的两次交接不会被误判成重复消息。
 *
 * @param message 协作消息对象
 * @returns 唯一标识字符串
 */
export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.round}:${message.toBotId}`;
}

/**
 * CollaborationInbox 用于管理协作消息的收发。
 * 它允许注册新的协作消息，并根据 dispatchId 和目标 botId 消费消息。
 */
export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  /**
   * 注册一条新的协作消息。
   * @param message 要注册的协作消息
   */
  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
  }

  /**
   * 消费一条协作消息。
   * @param dispatchId 要消费的协作消息的 dispatchId
   * @param toBotId 目标 botId
   * @returns 如果找到匹配的消息，则返回该消息并从收件箱中移除；否则返回 undefined
   */
  consume(dispatchId: string, toBotId: string): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }
}
