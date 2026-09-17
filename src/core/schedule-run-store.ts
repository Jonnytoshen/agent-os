import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

/**
 * ScheduledRun 接口定义了一个调度任务运行记录的结构，包括运行记录的唯一标识、关联的调度任务、计划
 * 运行时间、开始和完成时间、状态以及可选的任务 ID 和错误信息。
 *
 * 同一 scheduleId + scheduledFor 只允许一条运行记录，防止重复触发。
 *
 * - `scheduleId` 是关联的调度任务的唯一标识。
 * - `scheduledFor` 是计划运行的时间，表示该运行记录对应的调度任务应该在这个时间点执行。
 * - `startedAt` 是实际开始执行的时间。
 * - `completedAt` 是实际完成执行的时间（可选）。
 * - `status` 表示运行记录的状态，可以是 'running'（正在运行）、'succeeded'（成功）、'failed'（失败）或 'skipped'（跳过）。
 * - `taskId` 是关联的任务 ID（可选）。
 * - `error` 是错误信息（可选），用于记录失败或跳过的原因。
 */
export interface ScheduledRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  taskId?: string;
  error?: string;
}

const ScheduledRunSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  scheduledFor: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
  taskId: z.string().optional(),
  error: z.string().optional(),
});

// 运行记录的最大数量限制，超过该数量的旧记录将被删除，以防止无限增长。
const MAX_RUNS_PER_SCHEDULE = 100;

/**
 * ScheduleRunStore 是一个用于管理调度任务运行记录的类。它提供了创建、查找、列出和更新调度任务运行记录的方法。
 *
 * - `create(scheduleId, scheduledFor)`：创建一个新的调度任务运行记录，如果已经存在相同的 scheduleId 和 scheduledFor，则返回 undefined。
 * - `find(scheduleId, scheduledFor)`：查找指定 scheduleId 和 scheduledFor 的调度任务运行记录。
 * - `latestRunning(scheduleId)`：获取指定 scheduleId 的最新正在运行的调度任务运行记录。
 * - `list(scheduleId)`：列出指定 scheduleId 的所有调度任务运行记录，按开始时间降序排序。
 * - `markSucceeded(id, taskId?)`：将指定 id 的调度任务运行记录标记为成功，并可选地设置关联的 taskId。
 * - `markFailed(id, error)`：将指定 id 的调度任务运行记录标记为失败，并设置错误信息。
 * - `markSkipped(id, reason)`：将指定 id 的调度任务运行记录标记为跳过，并设置跳过原因。
 *
 * 该类还提供了快照和恢复功能，以便在操作失败时回滚到之前的状态。
 */
export class ScheduleRunStore {
  private readonly runs = new Map<string, ScheduledRun>();

  constructor(initialRuns: ScheduledRun[] = []) {
    for (const run of initialRuns) this.runs.set(run.id, run);
  }

  create(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    if (this.find(scheduleId, scheduledFor)) return undefined;
    const run: ScheduledRun = {
      id: randomUUID().replaceAll('-', '').slice(0, 12),
      scheduleId,
      scheduledFor,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    this.runs.set(run.id, run);
    this.prune(scheduleId);
    return run;
  }

  find(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    return [...this.runs.values()].find(
      (run) => run.scheduleId === scheduleId && run.scheduledFor === scheduledFor,
    );
  }

  latestRunning(scheduleId: string): ScheduledRun | undefined {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId && run.status === 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  list(scheduleId: string): ScheduledRun[] {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  markSucceeded(id: string, taskId?: string): void {
    this.update(id, { status: 'succeeded', taskId });
  }

  markFailed(id: string, error: string): void {
    this.update(id, { status: 'failed', error });
  }

  markSkipped(id: string, reason: string): void {
    this.update(id, { status: 'skipped', error: reason });
  }

  private update(id: string, patch: Partial<ScheduledRun>): void {
    const current = this.runs.get(id);
    if (!current) return;
    this.runs.set(id, {
      ...current,
      ...patch,
      completedAt: new Date().toISOString(),
    });
  }

  private prune(scheduleId: string): void {
    const runs = this.list(scheduleId);
    if (runs.length <= MAX_RUNS_PER_SCHEDULE) return;
    for (const run of runs.slice(MAX_RUNS_PER_SCHEDULE)) {
      this.runs.delete(run.id);
    }
  }

  protected snapshot(): ScheduledRun[] {
    return structuredClone([...this.runs.values()]);
  }

  protected restore(runs: ScheduledRun[]): void {
    this.runs.clear();
    for (const run of runs) this.runs.set(run.id, run);
  }
}

export class JsonScheduleRunStore extends ScheduleRunStore {
  constructor(private readonly filePath: string) {
    super(loadRuns(filePath));
  }

  override create(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    return this.mutate(() => super.create(scheduleId, scheduledFor));
  }

  override markSucceeded(id: string, taskId?: string): void {
    this.mutate(() => {
      super.markSucceeded(id, taskId);
      return true;
    });
  }

  override markFailed(id: string, error: string): void {
    this.mutate(() => {
      super.markFailed(id, error);
      return true;
    });
  }

  override markSkipped(id: string, reason: string): void {
    this.mutate(() => {
      super.markSkipped(id, reason);
      return true;
    });
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

function loadRuns(filePath: string): ScheduledRun[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`定时任务运行记录文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ScheduledRunSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
