/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import * as Lark from '@larksuiteoapi/node-sdk';

import type { CardJson } from './card';
import { parseMentions, type Mention } from './message-parser';

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' 单聊 | 'group' 群聊
  messageType: string; // 'text' | 'image' | 'post' | ...
  text: string; // text 消息的正文（其他类型为空串）
  rootId: string;
  threadId: string;
  senderOpenId: string;
  mentions: Mention[];
  rawContent: string;
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
}

export interface Bot {
  client: Lark.Client;
  reply: (messageId: string, text: string, replyInThread?: boolean) => Promise<string | undefined>;
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  updateCard: (messageId: string, card: CardJson) => Promise<void>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

function getHeader(headers: any, name: string): string {
  const value =
    typeof headers?.get === 'function'
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()]);
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function resourceExtension(
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : '';
  if (/^[a-z0-9]{1,10}$/.test(original)) return original;

  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin');
}

function extractText(messageType: string, content: string): string {
  const parsed = JSON.parse(content);
  if (messageType === 'text') {
    return parsed.text ?? '';
  }
  if (messageType === 'post') {
    const paragraphs: any[][] = parsed.content ?? [];
    return paragraphs
      .flat()
      .filter((el) => el.tag === 'text')
      .map((el) => el.text)
      .join('')
      .trim();
  }
  return '';
}

export function startBot(opts: BotOptions): Bot {
  const { appId, appSecret, onMessage } = opts;

  // `Lark.Client` 管出。所有主动调 API 的动作——发消息、回消息、以后的传图片、改卡片都走它。
  // 它拿着 App ID 和 Secret 自己维护鉴权 token，不用操心过期刷新。
  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,
    // 回复消息（文本）
    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },
    // 回复卡片消息
    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },
    // 更新卡片消息
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },
    // 下载图片/文件资源到本地
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(res.headers, 'content-type');
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },
  };

  // `EventDispatcher` 管分发。长连接上下来的事件五花八门，dispatcher 按事件名路由到对应的处理函数。
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const m = data.message;
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractText(m.message_type, m.content),
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      };
      await onMessage(msg, bot);
    },
  });

  // `Lark.WSClient` 管进。它负责建立并维持那条 `WebSocket` 长连接，断了自动重连。
  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
