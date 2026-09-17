import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { type CollaborationOrigin } from './collaboration';

const OptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(100),
});

const QuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    prompt: z.string().trim().min(1).max(300),
    options: z.array(OptionSchema).min(2).max(4), // 每题 2～4 个选项
    recommendedOptionId: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.id);
    // 检查选项 ID 是否重复
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: 'custom',
        message: '同一道问题的选项 ID 不能重复',
        path: ['options'],
      });
    }
    // 检查推荐项是否存在于当前问题的选项中
    if (question.recommendedOptionId && !optionIds.includes(question.recommendedOptionId)) {
      ctx.addIssue({
        code: 'custom',
        message: '推荐项必须指向当前问题中的选项',
        path: ['recommendedOptionId'],
      });
    }
  });

export const ClarificationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80).default('需求澄清'),
    intro: z.string().trim().max(300).optional().default(''),
    questions: z.array(QuestionSchema).min(1).max(5), // 一次最多提交 5 个问题
  })
  .superRefine((request, ctx) => {
    const questionIds = request.questions.map((question) => question.id);
    // 检查问题 ID 是否重复
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: 'custom',
        message: '同一份澄清请求的问题 ID 不能重复',
        path: ['questions'],
      });
    }
  });

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

export interface ClarificationAnswer {
  questionId: string;
  prompt: string;
  answer: string;
  source: 'user' | 'agent';
}

export interface ClarificationFlow {
  // 澄清卡片标识
  token: string;
  // 绑定飞书话题
  taskId: string;
  botId: string;
  // 指向 Agent OS 会话
  sessionId: string;
  // ownerOpenId 与 ownerUnionId 用来限制答题人
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  request: ClarificationRequest;
  // currentIndex 和 answers 保存答题进度
  currentIndex: number;
  answers: ClarificationAnswer[];
}

export interface CreateClarificationFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  request: ClarificationRequest;
}

/**
 * 从工具调用记录中查找最新的澄清请求
 * @param toolCalls 工具调用记录数组
 * @returns 最新的澄清请求，如果不存在则返回 undefined
 */
export function findClarificationRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ClarificationRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'request_clarification') continue;
    const parsed = ClarificationRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * 检查当前操作人是否是澄清流程的所有者
 * @param flow 澄清流程对象
 * @param operator 当前操作人的身份信息
 * @returns 如果是所有者则返回 true，否则返回 false
 */
export function isClarificationOwner(
  flow: Pick<ClarificationFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

/**
 * 格式化澄清问题的答案，用于在 Agent OS 中生成可读的文本内容。
 * @param flow 澄清流程对象
 * @returns 格式化后的答案文本
 */
export function formatClarificationAnswers(flow: ClarificationFlow): string {
  const lines = flow.answers.map((answer, index) =>
    [
      `${index + 1}. ${answer.prompt}`,
      answer.source === 'agent'
        ? `Agent 采用推荐方案：${answer.answer}`
        : `用户回答：${answer.answer}`,
    ].join('\n'),
  );
  return [
    '用户已经通过飞书卡片回答了上一轮需求澄清问题。',
    ...lines,
    '请基于这些答案继续工作。如果仍有会实质影响方案的未决问题，再次调用 request_clarification；否则直接整理清晰、可验收的产品结论。',
  ].join('\n\n');
}

/**
 * 格式化用户在同一话题中补充的新消息，提示 Agent OS 重新评估需求澄清流程。
 * @param flow 澄清流程对象
 * @param message 用户的新消息内容
 * @returns 格式化后的消息文本
 */
export function formatClarificationMessage(flow: ClarificationFlow, message: string): string {
  const confirmed = flow.answers.length
    ? formatClarificationAnswers(flow)
    : '此前还没有确认任何选项。';
  const currentQuestion = flow.request.questions[flow.currentIndex];
  return [
    '用户没有继续点击上一张需求澄清卡片，而是在同一个飞书话题里补充了新的信息。旧卡片已经失效，这条消息仍属于同一个任务。',
    confirmed,
    currentQuestion ? `上一张卡片正在询问：${currentQuestion.prompt}` : '',
    `用户的新消息：${message}`,
    '请优先理解这条新消息对既有需求的修正。如果仍有关键歧义，重新调用 request_clarification；信息已经足够时，直接整理可验收的需求结论。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 澄清流程存储器，用于在内存中管理澄清请求的状态和进度。
 * 主要用于在 Agent OS 中处理用户与澄清卡片的交互。
 */
export class ClarificationFlowStore {
  private readonly flows = new Map<string, ClarificationFlow>();

  /**
   * 创建一个新的澄清流程，并将其存储在内存中。
   * 如果已经存在相同任务和机器人 ID 的流程，则会覆盖旧的流程。
   * @param options 创建澄清流程所需的选项
   * @returns 新创建的澄清流程对象
   */
  create(options: CreateClarificationFlowOptions): ClarificationFlow {
    for (const [token, flow] of this.flows) {
      if (flow.taskId === options.taskId && flow.botId === options.botId) {
        this.flows.delete(token);
      }
    }
    const flow: ClarificationFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      currentIndex: 0,
      answers: [],
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  /**
   * 根据 token 获取澄清流程。
   * @param token 澄清流程的唯一标识符
   * @returns 对应的澄清流程对象，如果不存在则返回 undefined
   */
  get(token: string): ClarificationFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 根据任务 ID 和机器人 ID 查找澄清流程。
   * @param taskId 任务的唯一标识符
   * @param botId 机器人的唯一标识符
   * @returns 对应的澄清流程对象，如果不存在则返回 undefined
   */
  findForTask(taskId: string, botId: string): ClarificationFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.taskId === taskId && flow.botId === botId) return flow;
    }
    return undefined;
  }

  /**
   * 删除指定 token 的澄清流程。
   * @param token 澄清流程的唯一标识符
   */
  delete(token: string): void {
    this.flows.delete(token);
  }

  /**
   * 记录用户或 Agent 对澄清问题的回答，并更新流程状态。
   * @param token 澄清流程的唯一标识符
   * @param questionId 当前问题的唯一标识符
   * @param answer 用户或 Agent 的回答内容
   * @param source 回答来源，默认为 'user'
   * @returns 更新后的澄清流程对象和是否完成所有问题的标志，如果无效则返回 undefined
   */
  answer(
    token: string,
    questionId: string,
    answer: string,
    source: ClarificationAnswer['source'] = 'user',
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token);
    const question = flow?.request.questions[flow.currentIndex];
    const normalized = answer.trim();
    if (!flow || !question || question.id !== questionId || !normalized) {
      return undefined;
    }
    flow.answers.push({
      questionId: question.id,
      prompt: question.prompt,
      answer: normalized,
      source,
    });
    flow.currentIndex += 1;
    return {
      flow,
      complete: flow.currentIndex >= flow.request.questions.length,
    };
  }

  /**
   * 自动回答当前问题的推荐选项，并可选择是否回答所有剩余问题。
   * @param token 澄清流程的唯一标识符
   * @param allRemaining 是否自动回答所有剩余问题，默认为 false
   * @returns 更新后的澄清流程对象和是否完成所有问题的标志，如果无效则返回 undefined
   */
  answerWithRecommendation(
    token: string,
    allRemaining: boolean,
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;

    do {
      const question = flow.request.questions[flow.currentIndex];
      if (!question) break;
      const recommended =
        question.options.find((option) => option.id === question.recommendedOptionId) ??
        question.options[0];
      if (!recommended) return undefined;
      const result = this.answer(token, question.id, recommended.label, 'agent');
      if (!result || result.complete || !allRemaining) return result;
    } while (flow.currentIndex < flow.request.questions.length);

    return {
      flow,
      complete: flow.currentIndex >= flow.request.questions.length,
    };
  }
}
