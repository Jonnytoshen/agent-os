import { CliId } from '../cli/types';

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' | 'new' | 'resume' }
  | { name: 'compact'; instructions?: string }
  | { name: 'cd'; path?: string };

// 解析命令行输入，识别是否为支持的斜杠命令（Slash Command）。
// 飞书集群人名称不能包含空格，因此命令前的 @mention 可以忽略。
// 例如，以下输入将被识别为斜杠命令：
// - "/close"
// - "@bot /status"
// - "/cd /path/to/directory"
const COMMAND_RE = /(?:@\S+\s+)?\/(close|status|help|new|resume)\s*$/;
const CD_RE = /^(?:@\S+\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@\S+\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const CLI_REQUEST_RE = /^(?:@\S+\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();

  // 解析 /cd 命令
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) {
    return { name: 'cd', path: cdMatch[1]?.trim() || undefined };
  }

  // 解析 /compact 命令
  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: 'compact',
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }

  // 解析其他斜杠命令
  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return { name: match[1] as 'close' | 'status' | 'help' | 'new' | 'resume' };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

/**
 * 解析 CLI 请求命令。
 * @param text 待解析的文本。
 * @returns 如果文本符合 CLI 请求命令格式，则返回解析结果；否则返回 undefined。
 *
 * @example
 * ```ts
 * const request = parseCliRequest("/claude Hello, world!");
 * if (request) {
 *   console.log(request.cliId); // 输出: "claude"
 *   console.log(request.prompt); // 输出: "Hello, world!"
 * }
 * ```
 *
 * @throws 如果文本中指定的 CLI ID 不受支持，则抛出错误。
 *
 * @see {@link CliId} 获取支持的 CLI ID 列表。
 */
export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? '').trim(),
  };
}
