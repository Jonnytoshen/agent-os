/**
 * 执行引擎的注册表
 *
 * 注册表集中处理三件事：
 *  - 按 ID 取适配器
 *  - 列出当前支持的引擎
 *  - 校验环境变量。
 *
 * 入口层以后只拿 `CliAdapter`，不会再直接创建 `ClaudeAdapter`。再增加新引擎时，也非常方便，往现在的
 * 架构里面注册 `adapter` 就行。
 */
import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import type { CliAdapter, CliId } from './types';

const adapters: Record<CliId, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

export function getCliAdapter(id: CliId): CliAdapter {
  return adapters[id];
}

export function listCliAdapters(): CliAdapter[] {
  return Object.values(adapters);
}

export function parseCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`不支持的 DEFAULT_CLI: ${value}，请填写 claude 或 codex`);
}
