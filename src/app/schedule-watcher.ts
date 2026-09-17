/**
 * 监听 schedules.json 文件的变更，并在变更时自动调用 reconcileScheduleFile 方法进行热更新。
 *
 * reconcile 只比较任务的功能字段：`chatId`、`creatorOpenId`、`targetBotId`、`prompt`、`rule`、`status`。
 * `nextRunAt`、`lastRunAt`、`updatedAt` 这类运行状态不会触发更新；
 * 新增任务保留文件里的 `id`，规则变更会重新计算下一次执行时间。
 *
 * 日常改定时任务可以完全数据化：命令、schedule_manage、API、直接改文件四条路都在运行时生效。
 * 命令最终也走 schedule_manage，只有 Agent OS 自身代码变更才需要一次受控 reload。
 * @module ScheduleWatcher
 */
import { readFileSync, unwatchFile, watchFile } from 'node:fs';

import { type ScheduledTask } from '../core/schedule';
import { ScheduledTaskSchema } from '../core/schedule-store';
import { type Scheduler } from './scheduler';

export interface ScheduleWatcherOptions {
  scheduler: Scheduler;
  filePath: string;
  intervalMs?: number;
  debounceMs?: number;
}

const SCHEDULE_FIELDS = [
  'chatId',
  'creatorOpenId',
  'targetBotId',
  'prompt',
  'rule',
  'status',
] as const;

/**
 * 读取 schedules.json 文件中的任务列表，并进行合法性校验。
 * @param filePath schedules.json 文件路径
 * @returns 任务列表
 */
function readScheduleTasks(filePath: string): ScheduledTask[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error('schedules.json 必须是任务数组');
  }
  return rows.map((row, index) => {
    const parsed = ScheduledTaskSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `schedules.json 第 ${index + 1} 条不合法：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
      );
    }
    return parsed.data;
  });
}

/**
 * 比较两个 ScheduledTask 是否相同（仅比较功能字段）。
 * @param current 当前任务
 * @param next 新任务
 * @returns 是否相同
 */
function sameSchedule(current: ScheduledTask, next: ScheduledTask): boolean {
  return SCHEDULE_FIELDS.every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]));
}

/**
 * 将 schedules.json 中的任务与当前 Scheduler 中的任务进行对比，删除多余的任务，新增缺失的任务，更新有差异的任务。
 *
 * **一个要注意的行为**：scheduler.update 会清掉旧 timer 再按新配置重排，所以 interval 任务即使只改 prompt，
 * 下一次执行也会从当前时刻重新算；Cron 任务本来就要重算下一次触发，影响不大。
 *
 * @param scheduler Scheduler 实例
 * @param filePath schedules.json 文件路径
 * @returns 变更的任务 ID 列表
 */
export function reconcileScheduleFile(scheduler: Scheduler, filePath: string): string[] {
  const fileTasks = readScheduleTasks(filePath);
  const currentTasks = scheduler.list();
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const fileIds = new Set(fileTasks.map((task) => task.id));
  const changes: string[] = [];

  for (const task of currentTasks) {
    if (fileIds.has(task.id)) continue;
    if (scheduler.delete(task.id)) changes.push(`删除 ${task.id}`);
  }

  for (const fileTask of fileTasks) {
    const current = currentById.get(fileTask.id);
    if (!current) {
      scheduler.create({
        id: fileTask.id,
        chatId: fileTask.chatId,
        creatorOpenId: fileTask.creatorOpenId,
        targetBotId: fileTask.targetBotId,
        prompt: fileTask.prompt,
        rule: fileTask.rule,
      });
      if (fileTask.status !== 'active') {
        scheduler.update(fileTask.id, { status: fileTask.status });
      }
      changes.push(`新增 ${fileTask.id}`);
      continue;
    }
    if (sameSchedule(current, fileTask)) continue;
    scheduler.update(fileTask.id, {
      chatId: fileTask.chatId,
      creatorOpenId: fileTask.creatorOpenId,
      targetBotId: fileTask.targetBotId,
      prompt: fileTask.prompt,
      rule: fileTask.rule,
      status: fileTask.status,
    });
    changes.push(`更新 ${fileTask.id}`);
  }

  return changes;
}

/**
 * 监听 schedules.json 文件的变更，并在变更时自动调用 reconcileScheduleFile 方法进行热更新。
 * @param options ScheduleWatcherOptions
 * @returns 停止监听的函数
 */
export function startScheduleFileWatcher(options: ScheduleWatcherOptions): () => void {
  const { scheduler, filePath, intervalMs = 1_000, debounceMs = 300 } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let applying = false;
  let pending = false;

  const apply = () => {
    if (applying) {
      pending = true;
      return;
    }
    applying = true;
    pending = false;
    try {
      const changes = reconcileScheduleFile(scheduler, filePath);
      if (changes.length > 0) {
        console.log(`[定时] schedules.json 已热更新：${changes.join('、')}`);
      }
    } catch (error) {
      console.error('[定时] schedules.json 热更新失败:', (error as Error).message);
    } finally {
      applying = false;
      if (pending) {
        pending = false;
        timer = setTimeout(apply, debounceMs);
      }
    }
  };

  const scheduleApply = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, debounceMs);
  };

  watchFile(filePath, { interval: intervalMs }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    scheduleApply();
  });

  return () => unwatchFile(filePath);
}
