/**
 * 定义产品文档的提交格式
 * 模型需要用结构化数据告诉 Agent OS 产物放在哪里。
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
    '文档路径必须位于当前工作目录内',
  );

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
});

const LarkDocumentUrlSchema = z
  .url()
  .refine(
    (value) => /\/(?:docx|wiki)\//.test(new URL(value).pathname),
    'documentUrl 必须是飞书云文档或知识库文档链接',
  );

export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('local'),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict();

export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

export const ProductSpecRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<typeof LocalProductSpecRequestSchema>;

/**
 * 产品说明的审批流程。
 *
 * 产品方案会经历三种状态：
 * - pending 表示文档已经落盘，正在等待发起人确认。
 * - approved 表示发起人已经确认，并记录了 approvedAt。
 * - expired 表示同一任务已经提交了更新方案，旧卡不能再操作。
 */
export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  request: ProductSpecRequest;
  status: 'pending' | 'approved' | 'expired';
  approvedAt?: string;
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  request: ProductSpecRequest;
}

/**
 * 从工具调用记录中找到最新的产品说明提交请求。
 * `request_spec_approval` 只接收已经澄清完整、可以由任务发起人审阅的方案。
 * @param toolCalls 工具调用记录
 * @returns 找到的产品说明提交请求，或 undefined
 */
export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'request_spec_approval') continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * 判断当前操作人是否是产品说明的发起人。
 * @param flow 产品说明审批流程
 * @param operator 当前操作人
 * @returns 如果是发起人，返回 true；否则返回 false
 */
export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

/**
 * 产品说明审批流程存储。
 * 目前仅在内存中存储，重启后会丢失。
 */
export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();

  /**
   * 创建一个新的产品说明审批流程。
   * 如果同一任务已经存在未审批的流程，会将其标记为过期。
   * @param options 创建选项
   * @returns 新创建的产品说明审批流程
   */
  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (
        flow.taskId === options.taskId &&
        flow.botId === options.botId &&
        flow.status === 'pending'
      ) {
        flow.status = 'expired';
      }
    }
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      status: 'pending',
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  /**
   * 根据令牌获取产品说明审批流程。
   * @param token 流程令牌
   * @returns 产品说明审批流程，或 undefined
   */
  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 审批一个产品说明审批流程，将其状态更新为 approved，并记录审批时间。
   * @param token 流程令牌
   * @returns 审批后的产品说明审批流程，或 undefined
   */
  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;
    flow.status = 'approved';
    flow.approvedAt = new Date().toISOString();
    return flow;
  }
}
