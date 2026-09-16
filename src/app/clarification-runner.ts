import { getCliAdapter } from '../cli/registry';
import type { BotConfig, ProductDeliveryMode } from '../core/bot-registry';
import {
  type ClarificationFlow,
  findClarificationRequest,
  formatClarificationAnswers,
} from '../core/clarification';
import { TaskProgressTracker } from '../core/task-progress';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from '../im/card';
import { AgentOSBot } from '../im/lark';
import { executeCli } from './cli-execution';
import { sendResultNotification } from './notification-service';
import { assertProductSpecDocuments } from './product-spec-documents';
import { ensureProductSpecSubmission } from './product-spec-submission';
import type { AgentOSRuntime } from './runtime';
import { markSessionIdle } from './session-view';

/**
 * 继续执行澄清问题的流程，直到所有问题都被回答。
 * @param options 选项，包括运行时、机器人、配置、澄清流程和中止控制器。
 */
export async function continueClarificationFlow(options: {
  runtime: AgentOSRuntime;
  bot: AgentOSBot;
  config: BotConfig;
  flow: ClarificationFlow;
  run: AbortController;
  defaultDeliveryMode: ProductDeliveryMode;
}): Promise<void> {
  const { bot, config, flow, run, runtime, defaultDeliveryMode } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error('需求澄清对应的会话已经失效');

  const adapter = getCliAdapter(session.cliId);
  const progress = new TaskProgressTracker(Date.now, runtime.contextWindows.get(session.id), false);
  const progressCardMessageId = await bot.replyCard(
    flow.originalMessageId,
    buildTaskCard({
      title: adapter.displayName,
      status: 'running',
      detail: '正在基于你的选择整理需求',
      progress: progress.snapshot(),
      abortSessionId: session.id,
    }),
    flow.replyInThread,
  );
  if (!progressCardMessageId) {
    throw new Error('飞书没有返回需求整理进度卡片的 message_id');
  }

  const cardUpdater = new ThrottledCardUpdater((card) =>
    bot.updateCard(progressCardMessageId, card),
  );
  const renderProgress = () => {
    const snapshot = progress.snapshot();
    cardUpdater.push(
      buildTaskCard({
        title: adapter.displayName,
        status: 'running',
        detail: snapshot.current || '正在整理需求',
        progress: snapshot,
        abortSessionId: session.id,
      }),
    );
  };
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  try {
    const result = await executeCli(
      adapter,
      formatClarificationAnswers(flow),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      (event) => {
        if (event.type !== 'tool_start' && event.type !== 'tool_end' && event.type !== 'context')
          return;
        progress.accept(event);
        renderProgress();
      },
    );
    clearInterval(heartbeat);
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }

    const nextRequest = config.skills.includes('grill-me')
      ? findClarificationRequest(result.toolCalls)
      : undefined;
    if (nextRequest) {
      const nextFlow = runtime.clarificationFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        // 当产品经理先走需求澄清卡（用户在卡片上勾选完提交后），也需要把 `flow.collaboration` 原样
        // 透传给后续创建的 flow，否则经过澄清交互后协作来源就会断掉
        collaboration: flow.collaboration,
        originalMessageId: flow.originalMessageId,
        cardMessageId: progressCardMessageId,
        replyInThread: flow.replyInThread,
        request: nextRequest,
      });
      await cardUpdater.finish(buildClarificationCard({ flow: nextFlow }));
      await sendResultNotification({
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: `还需要确认 ${nextRequest.questions.length} 个问题，请在上方卡片中选择。`,
        replyInThread: flow.replyInThread,
      });
      return;
    }

    const managesProductSpec =
      config.skills.includes('to-spec') || config.skills.includes('lark-doc');

    if (managesProductSpec) {
      // 如果当前澄清流程已经完成，检查是否需要生成产品说明审批流程
      const submission = await ensureProductSpecSubmission({
        result,
        defaultDeliveryMode,
        retry: (retryPrompt, resultSessionId) =>
          executeCli(
            adapter,
            retryPrompt,
            session.workspaceDir,
            resultSessionId ?? session.cliSessionId,
            run.signal,
            (event) => {
              if (
                event.type !== 'tool_start' &&
                event.type !== 'tool_end' &&
                event.type !== 'context'
              )
                return;
              progress.accept(event);
              renderProgress();
            },
          ),
      });
      const { request: productSpecRequest } = submission;
      if (submission.result.sessionId) {
        await runtime.sessions.setCliSessionId(session.id, submission.result.sessionId);
      }
      if (submission.result.stats?.contextWindowTokens) {
        runtime.contextWindows.set(session.id, submission.result.stats.contextWindowTokens);
      }
      if (productSpecRequest.deliveryMode === 'local') {
        await assertProductSpecDocuments(session.workspaceDir, productSpecRequest);
      }
      const productSpecFlow = runtime.productSpecFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        collaboration: flow.collaboration,
        request: productSpecRequest,
      });
      await cardUpdater.finish(buildProductSpecApprovalCard(productSpecFlow));
      await sendResultNotification({
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: '产品方案已生成，请查看上方确认卡。',
        replyInThread: flow.replyInThread,
      });
      return;
    }

    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: 'success',
        detail: '需求已经整理完成',
        progress: progress.snapshot(),
        answer: result.answer,
        stats: result.stats,
      }),
    );
    if (answerNeedsContinuation(result.answer)) {
      for (const chunk of splitLongText(answerContinuation(result.answer))) {
        await bot.reply(flow.originalMessageId, chunk, flow.replyInThread);
      }
    }
    await sendResultNotification({
      bot,
      replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: '' },
      text: '需求澄清已完成，请查看上方结果。',
      replyInThread: flow.replyInThread,
    });
  } catch (error) {
    clearInterval(heartbeat);
    const aborted = run.signal.aborted;
    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: aborted ? 'cancelled' : 'failed',
        detail: aborted
          ? '需求整理已停止。你可以继续在当前话题里补充。'
          : '需求整理没有完成。请在当前话题里重试。',
        technicalDetail: aborted ? undefined : (error as Error).message,
        progress: progress.snapshot(),
      }),
    );
  } finally {
    clearInterval(heartbeat);
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}
