/**
 * 检查给定的值是否为一个对象（Record）。
 * @param value 要检查的值
 * @returns 如果值是一个对象，则返回 true；否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
