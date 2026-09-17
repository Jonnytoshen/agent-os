import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import z from 'zod';

import {
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
  ProductSpecFlowStore,
  ProductSpecRequestSchema,
} from './product-spec';

const ProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  request: ProductSpecRequestSchema,
  status: z.enum(['pending', 'approved', 'expired']),
  approvedAt: z.iso.datetime().optional(),
});

/**
 * 基于 JSON 文件的产品说明审批流程存储。
 * 该类继承自 ProductSpecFlowStore，并在内存中维护产品说明审批流程的状态。
 * 所有的创建和审批操作都会立即写入指定的 JSON 文件，以确保数据持久化。
 *
 * @param filePath JSON 文件路径，用于存储产品说明审批流程的状态。
 */
export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`产品方案状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ProductSpecFlowSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
