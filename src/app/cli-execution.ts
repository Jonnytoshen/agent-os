import { runCli } from '../cli/runner';
import { type CliAdapter } from '../cli/types';

export function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]['onEvent'],
  env?: Record<string, string>,
) {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId,
    signal,
    env,
    onEvent,
  });
}
