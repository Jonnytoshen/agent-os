import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * ScheduleRuleSchema 是一个 zod 的 discriminated union 类型，用于定义调度规则的三种可能类型：
 * 1. 一次性调度（once）：包含一个 runAt 字段，表示任务将在指定的时间运行。
 * 2. 固定间隔调度（interval）：包含一个 everyMs 字段，表示任务将以固定的毫秒间隔运行。该值必须在 60,000 毫秒（1 分钟）到 86,400,000 毫秒（24 小时）之间。
 * 3. Cron 调度（cron）：包含一个 expression 字段，表示任务将根据指定的 Cron 表达式运行，并且可以选择指定一个时区（默认为 'Asia/Shanghai'）。
 */
export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal('interval'),
    everyMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).default('Asia/Shanghai'),
  }),
]);

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

export const CreateScheduledTaskSchema = z.object({
  creatorOpenId: z.string().min(1),
  chatId: z.string().min(1),
  targetBotId: z.string().min(1),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

export type CreateScheduledTask = z.infer<typeof CreateScheduledTaskSchema>;

const ScheduleAddSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

/**
 * 管理定时任务不应该拆成三个工具，模型还要猜该用哪个。把创建、查看、删除、编辑、批量操作全部收进一个
 *  `schedule_manage`，通过 `action` 区分操作。
 *
 * ScheduleManageRequestSchema 是一个 zod 的 discriminated union 类型，用于定义调度任务管理请求的多种操作：
 * 1. 列出所有调度任务（list）。
 * 2. 添加一个新的调度任务（add）。
 * 3. 批量添加多个调度任务（addMany）。
 * 4. 更新一个现有的调度任务（update）。
 * 5. 删除一个调度任务（remove）。
 * 6. 批量删除多个调度任务（removeMany）。
 * 7. 删除所有调度任务（removeAll）。
 * 8. 立即运行一个调度任务（run）。
 * 9. 暂停一个调度任务（pause）。
 * 10. 恢复一个暂停的调度任务（resume）。
 * 11. 查看一个调度任务的运行日志（logs）。
 */
export const ScheduleManageRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('add'), ...ScheduleAddSchema.shape }),
  z.object({
    action: z.literal('addMany'),
    schedules: z.array(ScheduleAddSchema).min(1).max(20),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().trim().min(1).max(64),
    targetBotId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
      .optional(),
    prompt: z.string().trim().min(1).max(2_000).optional(),
    rule: ScheduleRuleSchema.optional(),
  }),
  z.object({ action: z.literal('remove'), id: z.string().trim().min(1).max(64) }),
  z.object({
    action: z.literal('removeMany'),
    ids: z.array(z.string().trim().min(1)).min(1).max(100),
  }),
  z.object({ action: z.literal('removeAll'), confirm: z.literal(true) }),
  z.object({ action: z.literal('run'), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('pause'), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('resume'), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('logs'), id: z.string().trim().min(1).optional() }),
]);

export type ScheduleManageRequest = z.infer<typeof ScheduleManageRequestSchema>;

/**
 * ScheduledTask 接口定义了一个调度任务的结构，包括任务的唯一标识、创建者、关联的聊天和机器人、提示词、调度规则、状态以及时间戳信息。
 *
 * - `chatId` 是任务创建时所在的飞书话题，到点执行时任务内容如果需要推送结果会回到这里。
 * - `creatorOpenId` 代表真正发起的人。
 */
export interface ScheduledTask {
  id: string;
  creatorOpenId: string;
  chatId: string;
  targetBotId: string;
  prompt: string;
  rule: ScheduleRule;
  status: 'active' | 'paused' | 'completed';
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function createScheduledTask(options: CreateScheduledTask & { id?: string }): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: options.id ?? randomUUID().replaceAll('-', '').slice(0, 12),
    creatorOpenId: options.creatorOpenId,
    chatId: options.chatId,
    targetBotId: options.targetBotId,
    prompt: options.prompt,
    rule: options.rule,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export function scheduleKindLabel(rule: ScheduleRule): string {
  if (rule.kind === 'once') return '一次性';
  if (rule.kind === 'interval') return '固定间隔';
  return 'Cron';
}

export function scheduleDescription(rule: ScheduleRule): string {
  if (rule.kind === 'once') return rule.runAt;
  if (rule.kind === 'interval') return `每 ${Math.round(rule.everyMs / 60_000)} 分钟`;
  return `${rule.expression} (${rule.timezone})`;
}
