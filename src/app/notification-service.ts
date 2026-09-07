import { AgentOSBot, BotIdentity } from '../im/lark';

/**
 * 发送结果通知消息，只负责提醒对应的人回来查看。
 * 普通任务和团队协作可以复用同一套发送方式。
 * @param options 通知选项。
 */
export async function sendResultNotification(options: {
  bot: AgentOSBot;
  replyToMessageId: string;
  target: BotIdentity;
  text: string;
  replyInThread: boolean;
}): Promise<void> {
  try {
    await options.bot.replyMention(
      options.replyToMessageId,
      options.target,
      options.text,
      options.replyInThread,
    );
  } catch (error) {
    console.error('[通知] 结果通知发送失败:', (error as Error).message);
  }
}
