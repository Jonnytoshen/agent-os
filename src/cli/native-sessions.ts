import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { isRecord } from '../utils/check';
import { shortText } from '../utils/text';
import { killCli, spawnCli } from './spawn-cli';
import type { CliAdapter, CliSessionSummary } from './types';

const SESSION_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ListNativeCliSessionsOptions {
  adapter: CliAdapter;
  cwd: string;
}

interface JsonMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function userPrompt(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === 'string') return shortText(message.content);
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join(' ');
  return shortText(text);
}

function claudeProjectDirectory(configDir: string, cwd: string): string {
  const key = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(configDir, 'projects', key);
}

/**
 * 读取 Claude 会话文件，提取会话摘要信息。
 * 读取 Claude Code 按项目保存的本地 JSONL 文件拿到 session 列表。
 * 标题优先使用 Claude Code 生成的标题，没有标题时再退回最近提示词或第一条用户消息。
 *
 * @param filePath 会话文件路径
 * @param expectedCwd 期望的工作目录，用于验证会话是否属于当前项目
 * @returns 如果会话有效，则返回会话摘要；否则返回 undefined
 */
async function readClaudeSession(
  filePath: string,
  expectedCwd: string,
): Promise<CliSessionSummary | undefined> {
  const lines = createInterface({ input: createReadStream(filePath) });
  let sessionId: string | undefined;
  let observedCwd: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let title: string | undefined;

  for await (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    if (typeof row.sessionId === 'string') sessionId = row.sessionId;
    if (typeof row.cwd === 'string') observedCwd = row.cwd;
    if (row.type === 'ai-title') title = shortText(row.aiTitle) ?? title;
    if (row.type === 'last-prompt') {
      lastPrompt = shortText(row.lastPrompt) ?? lastPrompt;
    }
    if (row.type === 'user' && !firstPrompt) {
      firstPrompt = userPrompt(row.message);
    }
  }

  if (!sessionId || observedCwd !== expectedCwd) return undefined;
  const metadata = await stat(filePath);
  return {
    id: sessionId,
    title: title ?? lastPrompt ?? firstPrompt ?? '未命名会话',
    updatedAt: metadata.mtime.toISOString(),
  };
}

/**
 * 读取 Claude 会话列表。
 * 通过读取 Claude Code 按项目保存的本地 JSONL 文件获取会话列表。
 *
 * @param options 列表选项，包括工作目录
 * @returns 会话摘要列表
 */
async function listClaudeSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projectDir = claudeProjectDirectory(configDir, options.cwd);
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sessions = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readClaudeSession(join(projectDir, name), options.cwd)),
  );
  return sessions
    .filter((session): session is CliSessionSummary => session !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, SESSION_LIMIT);
}

function protocolError(message: JsonMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === 'string'
    ? message.error.message
    : 'Codex 会话列表读取失败';
}

/**
 * 读取 Codex 会话列表。
 * 通过启动 Codex 的 app-server 子进程，使用 JSON-RPC 协议请求会话列表。
 *
 * @param options 列表选项，包括 CLI 适配器和工作目录
 * @returns 会话摘要列表
 */
function listCodexSessions(options: ListNativeCliSessionsOptions): Promise<CliSessionSummary[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(options.adapter.command, ['app-server', '--stdio'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    let settled = false;

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const cleanup = () => clearTimeout(timer);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      reject(error);
    };
    const succeed = (sessions: CliSessionSummary[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      resolve(sessions);
    };
    const timer = setTimeout(() => fail(new Error('Codex 会话列表读取超时')), REQUEST_TIMEOUT_MS);

    lines.on('line', (line) => {
      let message: JsonMessage;
      try {
        message = JSON.parse(line) as JsonMessage;
      } catch {
        return;
      }
      const error = protocolError(message);
      if (error) {
        fail(new Error(error));
        return;
      }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({
          id: 2,
          method: 'thread/list',
          params: {
            cwd: options.cwd,
            limit: SESSION_LIMIT,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          },
        });
        return;
      }
      if (message.id !== 2 || !isRecord(message.result)) return;
      const data = Array.isArray(message.result.data) ? message.result.data.filter(isRecord) : [];
      succeed(
        data.flatMap((thread): CliSessionSummary[] => {
          if (typeof thread.id !== 'string') return [];
          const updatedAt =
            typeof thread.updatedAt === 'number'
              ? new Date(thread.updatedAt * 1000).toISOString()
              : new Date().toISOString();
          return [
            {
              id: thread.id,
              title: shortText(thread.name) ?? shortText(thread.preview) ?? '未命名会话',
              updatedAt,
            },
          ];
        }),
      );
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => fail(error));
    child.once('close', (code) => {
      if (settled) return;
      fail(new Error(stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`));
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agent_os',
          title: 'Agent OS',
          version: '0.1.0',
        },
      },
    });
  });
}

export function listNativeCliSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  return options.adapter.id === 'claude' ? listClaudeSessions(options) : listCodexSessions(options);
}
