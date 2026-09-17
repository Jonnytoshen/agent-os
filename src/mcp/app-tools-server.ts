/**
 * 这个文件启动一个 MCP 服务器，注册了两个工具：
 * - request_clarification：向用户提问，澄清需求歧义。
 * - request_spec_approval：提交产品文档，等待用户确认。
 * - dispatch_task：把任务交给团队成员，等待协作完成。
 * - schedule_manage：管理定时任务，支持创建、编辑、删除、暂停、恢复和立即执行。
 *
 * 该服务器通过标准输入输出与调用方通信，适用于在本地运行的 Agent OS。
 * 服务器启动时会读取环境变量 AGENT_OS_CHAT_ID 和 AGENT_OS_OWNER_OPEN_ID，
 * 用于在定时任务管理工具中获取当前会话上下文。
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

import {
  CLARIFICATION_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
} from '../cli/app-tools';
import { ClarificationRequestSchema } from '../core/clarification';
import { DispatchTaskRequestSchema } from '../core/collaboration';
import { ProductSpecRequestSchema } from '../core/product-spec';
import { ScheduleManageRequestSchema } from '../core/schedule';

/**
 * 调用本地的定时任务管理 API，执行相应的操作。
 * @param input 定时任务管理请求参数
 * @returns 返回 API 响应内容
 */
async function callScheduleManage(input: unknown): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  // MCP 子进程通过环境变量拿到当前会话上下文，传给定时任务管理 API
  const chatId = process.env.AGENT_OS_CHAT_ID;
  const creatorOpenId = process.env.AGENT_OS_OWNER_OPEN_ID;
  if (!chatId || !creatorOpenId) {
    return {
      content: [
        {
          type: 'text',
          text: '缺少 AGENT_OS_CHAT_ID / AGENT_OS_OWNER_OPEN_ID，MCP 子进程没有拿到当前会话上下文。',
        },
      ],
      isError: true,
    };
  }
  const port = Number(process.env.SCHEDULE_API_PORT ?? 3101);
  const token = process.env.SCHEDULE_API_TOKEN;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/schedules/manage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-api-token': token } : {}),
      },
      body: JSON.stringify({ request: input, chatId, creatorOpenId }),
    });
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `无法连接 Agent OS 定时任务管理接口：${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { notice?: string; error?: string; issues?: unknown }
    | undefined;
  if (!response.ok) {
    const detail = payload?.issues ? `\n${JSON.stringify(payload.issues, null, 2)}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `定时任务管理失败（${response.status}）：${payload?.error ?? '未知错误'}${detail}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: payload?.notice ?? '定时任务管理完成。',
      },
    ],
  };
}

const server = new McpServer({
  name: 'agent-os',
  version: '1.0.0',
});

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: '向用户提问',
    description: [
      '当产品需求仍有会实质影响方案的歧义时，调用此工具向用户展示飞书问题卡片。',
      '一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。',
      '提交后不要自行补全用户答案，本轮回复可以简短收束。',
    ].join(''),
    inputSchema: ClarificationRequestSchema,
  },
  async ({ questions }) => ({
    content: [
      {
        type: 'text',
        text: `已把 ${questions.length} 个问题交给 Agent OS，请等待用户回答。`,
      },
    ],
  }),
);

server.registerTool(
  PRODUCT_SPEC_TOOL_NAME,
  {
    title: '提交产品文档',
    description: [
      '产品方案已经生成后，调用此工具提交唯一的待确认产物。',
      'deliveryMode=local 时提交 specPath 与 ticketsPath，并确保文件真实存在。',
      'deliveryMode=lark-doc 时只提交 documentUrl，且必须使用 lark-doc 创建或更新成功结果中的 document.url；该文档必须同时包含产品说明与「实现任务（Tickets）」章节。',
      '同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。',
      'summary 只写便于快速了解方案的摘要，完整内容保留在所选产物中。',
      '提交前必须完成需求澄清，确保这份方案已经可以确认。',
      '调用后停止工作，不要实现代码或委派团队成员。',
    ].join(''),
    inputSchema: ProductSpecRequestSchema,
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: '唯一的产品方案产物已交给 Agent OS，等待用户查看。',
      },
    ],
  }),
);

server.registerTool(
  DISPATCH_TASK_TOOL_NAME,
  {
    title: '把任务交给团队成员',
    description: [
      '把任务确定性地交给一名已注册的长期团队成员。',
      '只有 CEO 助理可以在运行时调用；产品经理和开发者调用会被拒绝。',
      'targetBotId 必须是团队名单中的成员 id，不能填写自己。',
      'objective 写协作目标，instruction 写交给对方的完整要求，expectedOutput 写期望产出。',
      '调用后停止工作，等待对方完成并把结果交回。',
    ].join(''),
    inputSchema: DispatchTaskRequestSchema,
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: '派发请求已交给 Agent OS，等待协作任务送达目标成员。',
      },
    ],
  }),
);

/**
 * 注册定时任务管理工具，允许用户通过 CLI 管理定时任务。
 * 该工具会调用本地的定时任务管理 API，执行相应的操作。
 *
 * `/schedule` 命令后面的自然语言不会被正则硬拆，而是交给 CEO 助理理解，再通过 `schedule_manage`
 * MCP 工具转成结构化计划
 */
server.registerTool(
  SCHEDULE_MANAGE_TOOL_NAME,
  {
    title: '管理定时任务',
    description: [
      '统一管理定时任务，action 支持：',
      'list 列出全部计划；add 创建一个；addMany 批量创建；update 编辑一个；remove 删除一个；removeMany 按 ids 批量删除；removeAll 删除全部（必须 confirm=true）；run 立即执行；pause 暂停；resume 恢复；logs 查看运行记录。',
      'targetBotId 选择团队中负责执行的成员，prompt 保留完整任务要求，rule 使用一次性、固定间隔或 Cron 规则。',
      '批量删除和删除全部属于高影响操作，先 list 确认 id 再执行。',
    ].join(''),
    inputSchema: ScheduleManageRequestSchema,
  },
  async (input) => callScheduleManage(input),
);

await server.connect(new StdioServerTransport());
