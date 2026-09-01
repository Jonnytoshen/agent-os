/**
 * 检查给定的值是否为一个有限的数字。
 * @param value 要检查的值
 * @returns 如果值是一个有限的数字，则返回该数字；否则返回 undefined
 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
