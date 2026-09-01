/**
 * 将文本缩短为指定长度的字符串，超过长度的部分用省略号表示。
 * @param value 要缩短的文本
 * @param maxLength 最大长度，默认为 80
 * @returns 缩短后的文本，如果输入不是字符串则返回 undefined
 */
export function shortText(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
