/**
 * 这个文件启动一个 MCP 服务器，注册了两个工具：
 * - request_clarification：向用户提问，澄清需求歧义。
 * - request_spec_approval：提交产品文档，等待用户确认。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

import { CLARIFICATION_TOOL_NAME, PRODUCT_SPEC_TOOL_NAME } from '../cli/app-tools';
import { ClarificationRequestSchema } from '../core/clarification';
import { ProductSpecRequestSchema } from '../core/product-spec';

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
      'Spec 和 Tickets 已经写入当前工作区后，调用此工具提交待确认产物。',
      'specPath 指向 Spec 文件，ticketsPath 指向包含独立 Ticket 文件的目录。',
      'summary 只写便于快速了解方案的摘要，完整内容保留在文件中。',
      '提交前必须完成需求澄清，确保这份方案已经可以确认。',
      '调用后停止工作，不要实现代码或委派团队成员。',
    ].join(''),
    inputSchema: ProductSpecRequestSchema,
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: '产品文档已交给 Agent OS，等待用户查看。',
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
