import type { AgentToolCall, AgentStats, AgentContext, AgentSubAgent, AgentMention, AgentQueue, AgentMessageDelivery } from "@toonflow/server/agent/types";

export type AgentAttachment = { name: string; path: string; mimeType: string; file?: File };

export type AgentMessagePart =
  | { id: string; type: "text"; content: string }
  | { id: string; type: "thinking"; content: string; collapsed?: boolean; duration?: number }
  | { id: string; type: "tool"; tool: AgentToolCall; collapsed?: boolean };

export type AgentMessage = {
  id: string;
  entryId?: string;
  queueId?: string;
  replyTo?: string;
  delivery?: AgentMessageDelivery;
  role: "user" | "assistant";
  content: string;
  attachments?: AgentAttachment[];
  mentions?: AgentMention[];
  parts?: AgentMessagePart[];
  streaming?: boolean;
  error?: string;
  report?: { file: string; name: string };
  agentMessage?: { fromFile: string; fromName: string; toFile: string; toName: string; startsTurn?: boolean };
  /** 每轮结束挂在 assistant 消息上的余额/消耗（消息下方 pill 用）。unit 区分计费体系：cny=DeepSeek 官方¥，credit=CodeBuddy 积分。 */
  credits?: { balance: number | null; runCost: number | null; unit?: "cny" | "credit" };
};

export type AgentHistory = { file: string; name: string; modified: string; messageCount: number };

export type AgentConversation = {
  file: string;
  name: string;
  messages: AgentMessage[];
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  stats?: AgentStats;
  contextUsage?: AgentContext;
  parentFile?: string;
  subAgents?: AgentSubAgent[];
  running?: boolean;
  runId?: string;
  queue?: AgentQueue;
};
