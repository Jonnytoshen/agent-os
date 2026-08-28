import { CliId } from '../cli/types';

export type CommandName = 'close' | 'status' | 'help';

export interface SlashCommand {
  name: CommandName;
}

const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/;
const CLI_REQUEST_RE = /^(?:@.+\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1] as CommandName };
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
  console.log(text);
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? '').trim(),
  };
}
