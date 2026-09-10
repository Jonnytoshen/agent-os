import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LocalProductSpecRequest } from '../core/product-spec';

/**
 * 检查工作区中是否存在完整的产品方案文档。
 * 真实性检查：`Spec` 必须是文件，`Tickets` 必须是目录，而且目录里至少有一个 `.md` 文件。
 * @param workspaceDir 工作区目录
 * @param request 产品方案请求
 * @throws 如果缺少 `Spec` 或 `Tickets`，则抛出异常，异常信息包含缺失的文件或目录。
 */
export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  const missing: string[] = [];

  try {
    const info = await stat(resolve(workspaceDir, request.specPath));
    if (!info.isFile()) missing.push(`Spec: ${request.specPath}`);
  } catch {
    missing.push(`Spec: ${request.specPath}`);
  }

  try {
    const ticketsDir = resolve(workspaceDir, request.ticketsPath);
    const info = await stat(ticketsDir);
    const entries = info.isDirectory() ? await readdir(ticketsDir, { withFileTypes: true }) : [];
    const hasTicket = entries.some((entry) => entry.isFile() && entry.name.endsWith('.md'));
    if (!info.isDirectory() || !hasTicket) {
      missing.push(`Tickets: ${request.ticketsPath}`);
    }
  } catch {
    missing.push(`Tickets: ${request.ticketsPath}`);
  }

  if (missing.length) {
    throw new Error(
      ['产品方案尚未完整写入工作区，不能展示。', ...missing.map((item) => `- ${item}`)].join('\n'),
    );
  }
}
