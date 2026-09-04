import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { CliId } from '../cli/types';
import { resolveWorkspacePath } from './workspace';

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  role: string;
  skills: string[];
  workspaceDir: string;
  systemPrompt: string;
  reviewBy?: string;
  collaborationMaxRounds: number;
}

export interface AgentOSConfig {
  teamLeaderId: string;
  bots: BotConfig[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'bot id 只能使用小写字母、数字、连字符和下划线'),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(['claude', 'codex']),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(''),
  reviewBy: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
  // 把默认上限提高到 16，同时把可配置范围放宽到 1～32。16 是防止失控循环的安全上限，任务已经完成时
  // 仍会立即结束，不会为了凑满次数继续派发。
  collaborationMaxRounds: z.number().int().min(1).max(32).optional().default(16),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  bots: z.array(BotSchema).min(1),
});

export function parseAgentOSConfig(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): AgentOSConfig {
  const parsed = BotConfigFileSchema.parse(input);
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? '';
      const appSecret = env[bot.appSecretEnv]?.trim() ?? '';
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        reviewBy: bot.reviewBy,
        collaborationMaxRounds: bot.collaborationMaxRounds,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? '.',
          baseDirectory,
        ),
      };
    });
  if (configs.length === 0) throw new Error('至少需要启用一个 bot');
  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  for (const config of configs) {
    if (config.reviewBy && !enabledIds.has(config.reviewBy)) {
      throw new Error(`bot ${config.id} 的 reviewBy 指向未启用的 bot: ${config.reviewBy}`);
    }
    if (config.reviewBy === config.id) {
      throw new Error(`bot ${config.id} 不能把自己配置为 reviewBy`);
    }
  }
  return { teamLeaderId: parsed.teamLeader, bots: configs };
}

export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentOSConfig> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }

  try {
    return parseAgentOSConfig(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

/**
 * 构建 bot 的完整提示信息，包括角色、系统提示、团队上下文、技能要求和当前任务。
 * @param config 包含角色、技能和系统提示的 bot 配置
 * @param prompt 当前任务的描述
 * @param teamContext 团队上下文信息
 * @returns 构建好的完整提示信息
 */
export function buildBotPrompt(
  config: Pick<BotConfig, 'role' | 'skills' | 'systemPrompt'>,
  prompt: string,
  teamContext = '',
): string {
  return [
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    config.skills.length > 0
      ? `本次任务必须按项目 Skill 执行：${config.skills.map((skill) => `$${skill}`).join('、')}`
      : '',
    `当前任务：${prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
