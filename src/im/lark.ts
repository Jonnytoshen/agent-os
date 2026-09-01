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
  senderType: string;
  senderOpenId: string;
  mentions: Mention[];
  rawContent: string;
}

export interface AgentOSBotOptions {
  appId: string;
  appSecret: string;
  onMessage?: MessageReceiver;
  onCardAction?: CardActionHandler;
}

export interface BotIdentity {
  openId: string;
  name: string;
}

export type MessageReceiver = (msg: IncomingMessage, bot: AgentOSBot) => Promise<void>;

export type CardActionHandler = (action: CardAction) => Promise<CardActionResponse | undefined>;

export interface CardAction {
  operatorOpenId: string;
  messageId: string;
  value: Record<string, unknown>;
}
export interface CardActionResponse {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
  card?: { type: 'raw'; data: CardJson };
}

export function parseCardAction(data: any): CardAction {
  const value = data?.action?.value;
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? '',
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? '',
    value: isRecord(value) ? value : {},
  };
}

/**
 * 构建飞书消息内容，@ 指定的 Bot 并附带文本。
 * 飞书 post 消息的 content 是带语言节点的二维数组。直接把普通文本塞进去的话，接口会报错。
 *
 * @param target 要 @ 的 Bot 身份信息
 * @param text 要发送的文本内容
 * @returns 飞书消息内容对象
 */
export function buildMentionPostContent(
  target: BotIdentity,
  text: string,
): Record<string, unknown> {
  return {
    zh_cn: {
      title: '',
      content: [
        [
          {
            tag: 'at',
            user_id: target.openId,
            ...(target.name ? { user_name: target.name } : {}),
          },
          { tag: 'text', text: ` ${text}` },
        ],
      ],
    },
  };
}

/**
 * 获取飞书自建应用 Bot 的身份信息。
 *
 * @param client 飞书客户端实例
 * @returns Bot 的身份信息，包括 openId 和名称
 */
async function fetchBotIdentity(client: Lark.Client): Promise<BotIdentity> {
  const response = await client.request({
    url: '/open-apis/bot/v3/info',
    method: 'GET',
  });
  const bot = (response as { bot?: { open_id?: string; app_name?: string } }).bot;
  if (!bot?.open_id) throw new Error('飞书没有返回 bot open_id');
  return { openId: bot.open_id, name: bot.app_name?.trim() || 'Bot' };
}

/**
 * 启动一个飞书自建应用 Bot。
 *
 * @param options 配置项
 * @param options.appId 飞书自建应用的 App ID
 * @param options.appSecret 飞书自建应用的 App Secret
 * @param options.onMessage 可选的消息接收器，收到消息时会被调用
 * @param options.onCardAction 可选的卡片动作处理器，收到卡片动作时会被调用
 */
export class AgentOSBot {
  readonly client: Lark.Client;

  constructor(options: AgentOSBotOptions) {
    const { appId, appSecret, onMessage, onCardAction } = options;

    // `Lark.Client` 管出。所有主动调 API 的动作——发消息、回消息、以后的传图片、改卡片都走它。
    // 它拿着 App ID 和 Secret 自己维护鉴权 token，不用操心过期刷新。
    this.client = new Lark.Client({ appId, appSecret });

    // `EventDispatcher` 管分发。长连接上下来的事件五花八门，dispatcher 按事件名路由到对应的处理函数。
    const dispatcher = new Lark.EventDispatcher({}).register({
      'card.action.trigger': async (data: any) => {
        if (!onCardAction) return undefined;
        return onCardAction(parseCardAction(data));
      },
      'im.message.receive_v1': async (data) => {
        const m = data.message;
        const msg: IncomingMessage = {
          messageId: m.message_id,
          chatId: m.chat_id,
          chatType: m.chat_type,
          messageType: m.message_type,
          text: extractMessageText(m.message_type, m.content),
          rootId: m.root_id ?? '',
          threadId: m.thread_id ?? '',
          senderType: data.sender.sender_type ?? '',
          senderOpenId: data.sender.sender_id?.open_id ?? '',
          mentions: parseMentions(m.mentions),
          rawContent: m.content,
        };
        if (onMessage) {
          await onMessage(msg, this);
        }
      },
    });

    // `Lark.WSClient` 管进。它负责建立并维持那条 `WebSocket` 长连接，断了自动重连。
    const wsClient = new Lark.WSClient({ appId, appSecret });
    wsClient.start({ eventDispatcher: dispatcher });
  }

  /**
   * 获取 Bot 的身份信息，包括 openId 和名称。
   *
   * @returns Bot 的身份信息
   */
  async getIdentity(): Promise<BotIdentity> {
    return await fetchBotIdentity(this.client);
  }

  /**
   * 回复消息（文本）。
   *
   * @param messageId 要回复的消息 ID
   * @param text 回复的文本内容
   * @param replyInThread 是否在消息线程中回复
   * @returns 回复的消息 ID（如果有）
   */
  async reply(messageId: string, text: string, replyInThread = false): Promise<string | undefined> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    return res.data?.message_id;
  }

  async replyMention(
    messageId: string,
    target: BotIdentity,
    text: string,
    replyInThread = false,
  ): Promise<string | undefined> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content: JSON.stringify(buildMentionPostContent(target, text)),
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    return res.data?.message_id;
  }

  /**
   * 回复卡片消息。
   *
   * @param messageId 要回复的消息 ID
   * @param card 卡片内容
   * @param replyInThread 是否在消息线程中回复
   * @returns 回复的消息 ID（如果有）
   */
  async replyCard(
    messageId: string,
    card: CardJson,
    replyInThread = false,
  ): Promise<string | undefined> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    return res.data?.message_id;
  }

  /**
   * 更新卡片消息。
   *
   * @param messageId 要更新的消息 ID
   * @param card 新的卡片内容
   */
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /**
   * 下载图片/文件资源到本地。
   *
   * @param messageId 消息 ID
   * @param fileKey 资源 key（image_key / file_key）
   * @param type 资源类型
   * @param saveDir 保存目录
   * @param fileName 原始文件名（可选）
   * @returns 本地保存路径
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ): Promise<string> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const contentType = getHeader(res.headers, 'content-type');
    const extension = resourceExtension(type, fileName, contentType);
    const savePath = join(saveDir, `${fileKey}.${extension}`);
    await mkdir(saveDir, { recursive: true });
    await res.writeFile(savePath);
    return savePath;
  }
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

interface PostElement {
  tag?: string;
  text?: string;
  user_id?: string;
}

function renderPostElement(element: PostElement): string {
  if (element.tag === 'at') return element.user_id ?? '';
  if (element.tag === 'br') return '\n';
  if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
    return element.text ?? '';
  }
  return '';
}

export function extractMessageText(messageType: string, content: string): string {
  const parsed = JSON.parse(content);
  if (messageType === 'text') {
    return parsed.text ?? '';
  }
  if (messageType === 'post') {
    const paragraphs: PostElement[][] = parsed.content ?? [];
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
