import { type ScheduledTask } from '../core/schedule';
import { type AgentOSRuntime } from './runtime';
import { runScheduledTaskDirectly } from './scheduled-task-runner';

export async function dispatchScheduledTask(options: {
  runtime: AgentOSRuntime;
  task: ScheduledTask;
  scheduledFor: string;
  defaultProductDeliveryMode: 'local' | 'lark-doc';
}): Promise<{ sessionId?: string }> {
  return runScheduledTaskDirectly(options);
}
