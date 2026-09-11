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
  senderUnionId: string;
  mentions: Mention[];
  rawContent: string;
}

export interface IncomingDocumentComment {
  eventId: string;
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  senderOpenId: string;
  senderUnionId: string;
  mentionedBot: boolean;
}
export interface AgentOSBotOptions {
  appId: string;
  appSecret: string;
  onMessage?: MessageReceiver;
  onCardAction?: CardActionHandler;
  onDocumentComment?: DocumentCommentHandler;
}

export interface BotIdentity {
  openId: string;
  name: string;
}

export const FEISHU_TEXT_LIMIT = 3_000;
export const FEISHU_MENTION_LIMIT = 1_200;
export const FEISHU_COMMENT_LIMIT = 1_000;

export function fitFeishuText(text: string, maxLength: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  const suffix = '\n\n（内容过长，已截断。详细内容请写入文档或工作区文件。）';
  const suffixLength = Array.from(suffix).length;
  return `${characters.slice(0, Math.max(0, maxLength - suffixLength)).join('')}${suffix}`;
}

export type MessageReceiver = (msg: IncomingMessage, bot: AgentOSBot) => Promise<void>;

export type CardActionHandler = (action: CardAction) => Promise<CardActionResponse | undefined>;

export type DocumentCommentHandler = (
  comment: IncomingDocumentComment,
  bot: AgentOSBot,
) => Promise<void>;

export interface CardAction {
  operatorOpenId: string;
  operatorUnionId: string;
  messageId: string;
  value: Record<string, unknown>;
  formValue: Record<string, unknown>;
}
export interface CardActionResponse {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
  card?: { type: 'raw'; data: CardJson };
}

export function parseCardAction(data: any): CardAction {
  const value = data?.action?.value;
  const formValue = data?.action?.form_value;
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? '',
    operatorUnionId: data?.operator?.union_id ?? data?.operator_id?.union_id ?? '',
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? '',
    value: isRecord(value) ? value : {},
    formValue: isRecord(formValue) ? formValue : {},
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
    const { appId, appSecret, onMessage, onCardAction, onDocumentComment } = options;

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
          senderUnionId: data.sender.sender_id?.union_id ?? '',
          mentions: parseMentions(m.mentions),
          rawContent: m.content,
        };
        if (onMessage) {
          await onMessage(msg, this);
        }
      },
      'drive.notice.comment_add_v1': async (data) => {
        if (!onDocumentComment) return;
        const meta = data.notice_meta;
        if (!meta?.file_token || !meta.file_type || !data.comment_id) return;
        await onDocumentComment(
          {
            eventId: data.event_id ?? '',
            fileToken: meta.file_token,
            fileType: meta.file_type,
            commentId: data.comment_id,
            replyId: data.reply_id ?? '',
            senderOpenId: meta.from_user_id?.open_id ?? '',
            senderUnionId: meta.from_user_id?.union_id ?? '',
            mentionedBot: data.is_mentioned ?? false,
          },
          this,
        );
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
        content: JSON.stringify({
          text: fitFeishuText(text, FEISHU_TEXT_LIMIT),
        }),
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
   * 订阅飞书文档评论事件。
   * 订阅后，飞书会在有新的评论或回复时推送事件到 Bot 的长连接。
   */
  async subscribeToDocumentComments(): Promise<void> {
    const response = await this.client.drive.v1.user.subscription({
      data: { event_type: 'drive.notice.comment_add_v1' },
    });
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || '订阅飞书文档评论事件失败');
    }
  }

  /**
   * 回复飞书文档评论。
   *
   * @param comment 要回复的评论信息
   * @param text 回复的文本内容
   */
  async replyToDocumentComment(comment: IncomingDocumentComment, text: string): Promise<void> {
    const response = await this.client.drive.v1.fileCommentReply.create({
      path: {
        file_token: comment.fileToken,
        comment_id: comment.commentId,
      },
      params: {
        file_type: comment.fileType as 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'bitable',
        user_id_type: 'open_id',
      },
      data: {
        content: {
          elements: [
            {
              type: 'text_run',
              text_run: {
                text: fitFeishuText(text, FEISHU_COMMENT_LIMIT),
              },
            },
          ],
        },
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || '回复飞书文档评论失败');
    }
  }

  /**
   * 设置飞书文档评论的工作状态（正在输入）。
   *
   * @param comment 要设置状态的评论信息
   * @param active 是否激活工作状态（true 表示正在输入，false 表示停止输入）
   */
  async setDocumentCommentWorking(
    comment: IncomingDocumentComment,
    active: boolean,
  ): Promise<void> {
    const replyId = comment.replyId || (await findRootCommentReplyId(this.client, comment));
    const response = await this.client.drive.v2.commentReaction.updateReaction({
      path: { file_token: comment.fileToken },
      params: { file_type: comment.fileType },
      data: {
        action: active ? 'add' : 'delete',
        reply_id: replyId,
        reaction_type: 'Typing',
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || '更新飞书文档评论状态失败');
    }
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

/**
 * 查找飞书文档评论的根回复 ID。
 * 飞书文档评论的回复是分层的，根回复是最顶层的回复。
 * 这个函数会调用飞书 API 获取评论的回复列表，并返回第一个回复的 ID。
 *
 * @param client 飞书客户端实例
 * @param comment 要查找的评论信息
 * @returns 根回复 ID
 */
async function findRootCommentReplyId(
  client: Lark.Client,
  comment: IncomingDocumentComment,
): Promise<string> {
  const response = await client.drive.v1.fileCommentReply.list({
    path: {
      file_token: comment.fileToken,
      comment_id: comment.commentId,
    },
    params: {
      file_type: comment.fileType as 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'bitable',
      page_size: 1,
      user_id_type: 'open_id',
    },
  });
  if (response.code && response.code !== 0) {
    throw new Error(response.msg || '读取飞书文档评论回复失败');
  }
  const replyId = response.data?.items?.[0]?.reply_id;
  if (!replyId) throw new Error('飞书文档评论缺少可添加表情的回复 ID');
  return replyId;
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
