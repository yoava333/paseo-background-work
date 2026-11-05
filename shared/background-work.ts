import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const backgroundTaskSchema = z.object({
  taskId: z.string(),
  toolCallId: z.string(),
  kind: z.enum(["monitor", "shell"]),
  description: z.string(),
  command: z.string(),
  startedAt: z.string(),
  /** Monitors die at their deadline even if the expiry notification never arrives. */
  expiresAt: z.string().nullable(),
});

export type BackgroundTask = z.output<typeof backgroundTaskSchema>;

export const agentBackgroundWorkSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  tasks: z.array(backgroundTaskSchema),
});

export type AgentBackgroundWork = z.output<typeof agentBackgroundWorkSchema>;

/** Agents with background work; agents without work are omitted. */
export const backgroundWorkList = defineRpc({
  name: "background-work.list",
  input: z.object({}),
  output: z.object({ agents: z.array(agentBackgroundWorkSchema) }),
});

/** The fields of a Paseo `tool_call` timeline item this model reads. */
export interface ToolCallLike {
  type: string;
  callId?: string;
  name?: string;
  detail?: unknown;
  metadata?: Record<string, unknown>;
}

// Claude Code's own result text; the timeline keeps no structured background flag. Anchored so
// a foreground command that prints the phrase (a log, a transcript) does not count.
const MONITOR_STARTED = /^Monitor started \(task ([\w-]+)/;
const SHELL_BACKGROUNDED = /^Command running in background with ID: ([\w-]+)/;
const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
const MONITOR_MAX_TIMEOUT_MS = 3_600_000;

const monitorDetailSchema = z.object({
  type: z.literal("unknown"),
  input: z.object({
    command: z.string().optional(),
    description: z.string().optional(),
    timeout_ms: z.number().optional(),
  }),
  output: z.object({ output: z.string() }),
});

const shellDetailSchema = z.object({
  type: z.literal("shell"),
  command: z.string(),
  output: z.string().optional(),
});

const notificationMetadataSchema = z.object({
  source: z.literal("claude_task_notification"),
  taskId: z.string(),
  status: z.string().optional(),
});

/**
 * The background tasks of one Claude session, folded from its timeline. Tasks live inside the
 * Claude Code process, so `clear()` must run whenever that process is known to be gone.
 */
export class BackgroundTaskModel {
  private readonly tasks = new Map<string, BackgroundTask>();

  list(now: number): BackgroundTask[] {
    return [...this.tasks.values()]
      .filter((task) => !task.expiresAt || Date.parse(task.expiresAt) > now)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Returns whether the item changed the model. */
  observe(item: ToolCallLike, timestamp: string): boolean {
    if (item.type !== "tool_call" || !item.callId) return false;
    if (item.name === "task_notification") return this.observeNotification(item);
    const task = toBackgroundTask(item, item.callId, timestamp);
    if (!task || this.tasks.has(task.taskId)) return false;
    this.tasks.set(task.taskId, task);
    return true;
  }

  clear(): boolean {
    const changed = this.tasks.size > 0;
    this.tasks.clear();
    return changed;
  }

  private observeNotification(item: ToolCallLike): boolean {
    const metadata = notificationMetadataSchema.safeParse(item.metadata);
    // Monitor events carry no status; only a terminal notification ends the task.
    if (!metadata.success || !metadata.data.status || metadata.data.status === "running") {
      return false;
    }
    return this.tasks.delete(metadata.data.taskId);
  }
}

function toBackgroundTask(
  item: ToolCallLike,
  toolCallId: string,
  timestamp: string,
): BackgroundTask | null {
  if (item.name === "Monitor") {
    const detail = monitorDetailSchema.safeParse(item.detail);
    const taskId = detail.success ? MONITOR_STARTED.exec(detail.data.output.output)?.[1] : null;
    if (!detail.success || !taskId) return null;
    const { command = "", description, timeout_ms } = detail.data.input;
    const timeoutMs = Math.min(timeout_ms ?? MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS);
    return {
      taskId,
      toolCallId,
      kind: "monitor",
      description: description || command,
      command,
      startedAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + timeoutMs).toISOString(),
    };
  }
  const shell = shellDetailSchema.safeParse(item.detail);
  const taskId = shell.success ? SHELL_BACKGROUNDED.exec(shell.data.output ?? "")?.[1] : null;
  if (!shell.success || !taskId) return null;
  return {
    taskId,
    toolCallId,
    kind: "shell",
    description: shell.data.command,
    command: shell.data.command,
    startedAt: timestamp,
    expiresAt: null,
  };
}
