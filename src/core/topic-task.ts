import { createHash } from 'node:crypto';

export interface TopicAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export function topicIdOf(message: TopicAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

/**
 * Generates a unique task ID for a given topic address.
 * @param message The topic address for which to generate a task ID.
 * @returns A unique task ID.
 */
export function topicTaskId(message: TopicAddress): string {
  return createHash('sha256')
    .update(`${message.chatId}:${topicIdOf(message)}`)
    .digest('hex')
    .slice(0, 24);
}
