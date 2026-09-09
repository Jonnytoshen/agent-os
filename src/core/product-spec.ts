/**
 * 定义产品文档的提交格式
 * 模型需要用结构化数据告诉 Agent OS 产物放在哪里。
 */
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

export const ProductSpecRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
});

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;

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
