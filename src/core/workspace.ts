import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * 解析工作目录路径。
 *
 * @param input 用户输入的路径
 * @param baseDirectory 相对路径的基准目录，默认为当前工作目录
 * @returns 解析后的绝对路径
 * @throws 如果输入为空或路径无效，则抛出错误
 */
export function resolveWorkspacePath(input: string, baseDirectory = process.cwd()): string {
  const value = input.trim();
  if (!value) throw new Error('工作目录不能为空');
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

/**
 * 确保工作目录存在且是一个文件夹。
 *
 * @param path 工作目录的绝对路径
 * @throws 如果工作目录不存在或不是文件夹，则抛出错误
 */
export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`工作目录不存在: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`);
}
