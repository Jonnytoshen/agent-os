import { type BotConfig } from '../core/bot-registry';
import { type ClarificationFlowStore } from '../core/clarification';
import { type CollaborationInbox } from '../core/collaboration';
import { type ProductSpecFlowStore } from '../core/product-spec';
import { type SessionManager } from '../core/session-manager';
import { type ActiveRun } from '../core/task-abort';
import { type TeamRegistry } from '../core/team-registry';
import { type AgentOSBot, type BotIdentity } from '../im/lark';

/**
 * Represents a bot that is connected to Feishu (Lark).
 */
export interface AgentOSBotRuntime {
  config: BotConfig;
  bot: AgentOSBot;
  identity: BotIdentity;
}

/**
 * 包含所有 Bot 的运行时信息、会话管理、团队注册表、活跃任务等。
 */
export interface AgentOSRuntime {
  sessions: SessionManager;
  teamRegistry: TeamRegistry;
  activeRuns: Map<string, ActiveRun>;
  contextWindows: Map<string, number>;
  botRuntimes: Map<string, AgentOSBotRuntime>;
  processedCollaborationTurns: Set<string>;
  collaborationInbox: CollaborationInbox;
  clarificationFlows: ClarificationFlowStore;
  productSpecFlows: ProductSpecFlowStore;
}
