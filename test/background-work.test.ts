import { describe, expect, it } from "vitest";
import { BackgroundTaskModel } from "../shared/background-work";

// Shapes captured from a real Claude Code 2.1 session on the Paseo 0.15 timeline.
const monitorStarted = {
  type: "tool_call",
  callId: "toolu_monitor",
  name: "Monitor",
  status: "completed",
  detail: {
    type: "unknown",
    input: {
      command: "for i in 1 2 3; do echo tick-$i; sleep 4; done",
      description: "probe ticks",
      timeout_ms: 60000,
    },
    output: {
      type: "command",
      command: "for i in 1 2 3; do echo tick-$i; sleep 4; done",
      output:
        "Monitor started (task bla02l1gn, expires in 1m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event.",
    },
  },
};

const shellBackgrounded = {
  type: "tool_call",
  callId: "toolu_shell",
  name: "Bash",
  status: "completed",
  detail: {
    type: "shell",
    command: "sleep 25 && echo bg-done",
    output:
      "Command running in background with ID: b38aht4fg. Output is being written to: /tmp/tasks/b38aht4fg.output. You will be notified when it completes.",
  },
};

function notification(taskId: string, status?: string) {
  return {
    type: "tool_call",
    callId: `task_notification_${taskId}_${status ?? "event"}`,
    name: "task_notification",
    status: "completed",
    detail: { type: "plain_text", label: "Monitor event" },
    metadata: {
      synthetic: true,
      source: "claude_task_notification",
      taskId,
      ...(status ? { status } : {}),
    },
  };
}

const startedAt = "2026-11-05T08:19:56.259Z";
const start = Date.parse(startedAt);

describe("background work model", () => {
  it("tracks a Monitor and a backgrounded Bash command until their completion notices", () => {
    const model = new BackgroundTaskModel();
    expect(model.observe(monitorStarted, startedAt)).toBe(true);
    expect(model.observe(shellBackgrounded, startedAt)).toBe(true);

    expect(model.list(start + 1000)).toEqual([
      {
        taskId: "bla02l1gn",
        toolCallId: "toolu_monitor",
        kind: "monitor",
        description: "probe ticks",
        command: "for i in 1 2 3; do echo tick-$i; sleep 4; done",
        startedAt,
        expiresAt: "2026-11-05T08:20:56.259Z",
      },
      {
        taskId: "b38aht4fg",
        toolCallId: "toolu_shell",
        kind: "shell",
        description: "sleep 25 && echo bg-done",
        command: "sleep 25 && echo bg-done",
        startedAt,
        expiresAt: null,
      },
    ]);

    expect(model.observe(notification("bla02l1gn"), startedAt)).toBe(false);
    expect(model.observe(notification("bla02l1gn", "completed"), startedAt)).toBe(true);
    expect(model.observe(notification("b38aht4fg", "failed"), startedAt)).toBe(true);
    expect(model.list(start + 1000)).toEqual([]);
  });

  it("ignores foreground shells and repeated start items", () => {
    const model = new BackgroundTaskModel();
    const foreground = {
      ...shellBackgrounded,
      detail: { type: "shell", command: "ls", output: "a" },
    };
    expect(model.observe(foreground, startedAt)).toBe(false);
    const printsPhrase = {
      ...shellBackgrounded,
      detail: {
        type: "shell",
        command: "cat transcript.json",
        output: '{"output":"Command running in background with ID: b38aht4fg."}',
      },
    };
    expect(model.observe(printsPhrase, startedAt)).toBe(false);
    expect(model.observe(shellBackgrounded, startedAt)).toBe(true);
    expect(model.observe(shellBackgrounded, "2026-11-05T09:00:00.000Z")).toBe(false);
    expect(model.list(start).map((task) => task.startedAt)).toEqual([startedAt]);
  });

  it("drops a Monitor past its deadline and everything when the process is gone", () => {
    const model = new BackgroundTaskModel();
    model.observe(monitorStarted, startedAt);
    model.observe(shellBackgrounded, startedAt);
    expect(model.list(start + 61_000).map((task) => task.kind)).toEqual(["shell"]);
    expect(model.clear()).toBe(true);
    expect(model.list(start)).toEqual([]);
    expect(model.clear()).toBe(false);
  });
});
