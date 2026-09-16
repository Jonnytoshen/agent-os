import z from 'zod';

/**
 * `CollaborationMessage` 是程序内部的交接单。
 *
 *  - taskId 标识整项协作
 *  - dispatchId 则标识当前这一次投递
 *  - ownerOpenId / ownerUnionId：整个任务的用户发起人，贯穿所有轮次。
 *  - reportToBotId：成员完成当前环节后，结果自动回到谁那里。
 *  - objective：这一轮协作要完成什么，直接展示在协作卡片上。
 *  - instruction：交给对方的完整要求。
 *  - expectedOutput：期望产出，给接收方一个清晰的验收方向。
 *
 * 飞书消息负责提醒目标 bot，真正执行所需的任务内容和目录由这张交接单保存。
 */
export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  fromBotId: string;
  toBotId: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
}

export interface CollaborationOrigin {
  taskId: string;
  fromBotId: string;
  reportToBotId: string;
  round: number;
  maxRounds: number;
}

export const DispatchTaskRequestSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  objective: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(2_000),
  expectedOutput: z.string().trim().min(1).max(500).optional(),
});

export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>;

/**
 * 从工具调用列表中查找最近一次的 dispatch_task 请求。
 * 如果找到符合条件的请求，则返回解析后的 DispatchTaskRequest 对象；否则返回 undefined。
 * `dispatch_task` 是 MCP 工具，CLI 跑完以后，Agent OS 在 toolCalls 里找到这个调用，再真正执行派发。
 *
 * @param toolCalls 工具调用列表，可能包含多个工具调用记录
 * @returns 最近一次的 DispatchTaskRequest 对象或 undefined
 */
export function findDispatchTaskRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): DispatchTaskRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'dispatch_task') continue;
    const parsed = DispatchTaskRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * 从交接单里提取任务编号、来源、结果接收人和轮次信息，用于在产品说明流程中记录协作来源。
 * @param message 协作消息对象
 * @returns 协作来源信息对象
 */
export function collaborationOrigin(message: CollaborationMessage): CollaborationOrigin {
  return {
    taskId: message.taskId,
    fromBotId: message.fromBotId,
    reportToBotId: message.reportToBotId,
    round: message.round,
    maxRounds: message.maxRounds,
  };
}

/**
 * 构建协作卡片的文本内容，包含目标、执行要求和期望产出。
 * @param message 协作消息对象
 * @returns 协作卡片的文本内容
 */
export function buildCollaborationPrompt(message: CollaborationMessage): string {
  return [
    `协作目标：${message.objective}`,
    `执行要求：${message.instruction}`,
    message.expectedOutput ? `期望产出：${message.expectedOutput}` : '',
    `完成后，把结果交回 ${message.reportToBotId} 继续组织后续工作；已经可以交付时，明确给出最终结论。`,
  ]
    .filter(Boolean)
    .join('\n\n');
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
