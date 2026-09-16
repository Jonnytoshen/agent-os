import { fileURLToPath } from 'node:url';

export const CLARIFICATION_TOOL_NAME = 'request_clarification';
export const PRODUCT_SPEC_TOOL_NAME = 'request_spec_approval';
export const DISPATCH_TASK_TOOL_NAME = 'dispatch_task';
export const CLAUDE_CLARIFICATION_TOOL_NAME = `mcp__agent_os__${CLARIFICATION_TOOL_NAME}`;
export const CLAUDE_PRODUCT_SPEC_TOOL_NAME = `mcp__agent_os__${PRODUCT_SPEC_TOOL_NAME}`;
export const CLAUDE_DISPATCH_TASK_TOOL_NAME = `mcp__agent_os__${DISPATCH_TASK_TOOL_NAME}`;

/**
 * 获取服务器启动的命令和参数。
 * 根据当前运行环境（TypeScript 或 JavaScript）生成服务器启动命令和参数。
 * 开发时直接运行 TypeScript，Server 由项目内的 tsx 启动；构建后运行的是 JavaScript，Server 则由
 * 当前 Node.js 进程启动。这样 `pnpm start` 和编译产物都指向正确文件。
 * @returns 服务器启动的命令和参数
 */
function serverInvocation(): { command: string; args: string[] } {
  const runningFromTypeScript = import.meta.url.endsWith('.ts');
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript ? '../mcp/app-tools-server.ts' : '../mcp/app-tools-server.js',
      import.meta.url,
    ),
  );
  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server] };
  }
  const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  return { command: process.execPath, args: [tsxCli, server] };
}

/**
 * 获取 Claude 应用工具的启动参数
 * @returns 启动参数数组
 */
export function claudeAppToolArgs(): string[] {
  const invocation = serverInvocation();
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        agent_os: {
          type: 'stdio',
          command: invocation.command,
          args: invocation.args,
        },
      },
    }),
  ];
}

/**
 * 获取 Codex 应用工具的启动参数
 * @returns 启动参数数组
 */
export function codexAppToolArgs(): string[] {
  const invocation = serverInvocation();
  return [
    '-c',
    `mcp_servers.agent_os.command=${JSON.stringify(invocation.command)}`,
    '-c',
    `mcp_servers.agent_os.args=${JSON.stringify(invocation.args)}`,
  ];
}
