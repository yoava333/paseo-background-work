import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ComponentType, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import {
  type AgentBackgroundWork,
  type BackgroundTask,
  backgroundWorkList,
} from "../shared/background-work";

const POLL_MS = 3000;

interface BackgroundWorkStore {
  get(agentId: string): AgentBackgroundWork | undefined;
  subscribe(listener: () => void): () => void;
}

/** Shows a composer pill on each agent that has Claude Monitors or background shells running. */
export function contributeBackgroundWork(client: PluginClientContext) {
  let agents = new Map<string, AgentBackgroundWork>();
  const listeners = new Set<() => void>();
  const store: BackgroundWorkStore = {
    get: (agentId) => agents.get(agentId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const Content = createTaskList(store);
  const pills = new Map<string, { workspaceId: string; pill: PluginButtonRegistration }>();

  function reconcile(next: readonly AgentBackgroundWork[]) {
    agents = new Map(next.map((work) => [work.agentId, work]));
    for (const [agentId, entry] of pills) {
      const work = agents.get(agentId);
      if (work && work.workspaceId === entry.workspaceId) continue;
      entry.pill.remove();
      pills.delete(agentId);
    }
    for (const work of agents.values()) {
      const label = summarize(work.tasks);
      const existing = pills.get(work.agentId);
      if (existing) {
        existing.pill.update({ label });
        continue;
      }
      const pill = client.addComposerPill({
        id: "background-work",
        workspaceId: work.workspaceId,
        agentId: work.agentId,
        button: {
          title: "Background work",
          icon: "Activity",
          label,
          behavior: { kind: "popover", Content },
        },
      });
      pills.set(work.agentId, { workspaceId: work.workspaceId, pill });
    }
    for (const listener of listeners) listener();
  }

  // Polled: plugin subscriptions are newer than the Paseo 0.15 releases.
  let stopped = false;
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function poll() {
    try {
      const { agents: next } = await client.rpc(backgroundWorkList, {});
      const serialized = JSON.stringify(next);
      if (!stopped && serialized !== last) {
        last = serialized;
        reconcile(next);
      }
    } catch {
      // Disconnected or plugin reloading; the next poll retries.
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }
  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const { pill } of pills.values()) pill.remove();
    pills.clear();
    listeners.clear();
  };
}

// Composer pills are capped at 160px, so mixed kinds collapse to a count.
function summarize(tasks: readonly BackgroundTask[]): string {
  const monitors = tasks.filter((task) => task.kind === "monitor").length;
  if (monitors === tasks.length) return `${monitors} ${monitors === 1 ? "monitor" : "monitors"}`;
  if (monitors === 0) return `${tasks.length} ${tasks.length === 1 ? "shell" : "shells"}`;
  return `${tasks.length} running`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function createTaskList(store: BackgroundWorkStore): ComponentType<PluginButtonContentProps> {
  return function TaskList(props: PluginButtonContentProps) {
    const { theme } = props;
    const agentId = props.context === "agent" ? props.agentId : null;
    const work = useSyncExternalStore(store.subscribe, () =>
      agentId ? store.get(agentId) : undefined,
    );
    const now = useNow(1000);
    const styles = useMemo(
      () => ({
        list: { gap: 12, minWidth: 260 },
        row: { flexDirection: "row" as const, gap: 10, alignItems: "flex-start" as const },
        body: { flex: 1, gap: 2 },
        title: { color: theme.colors.foreground },
        detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
        empty: { color: theme.colors.foregroundMuted },
      }),
      [theme],
    );

    if (!work || work.tasks.length === 0) {
      return <Text style={styles.empty}>Nothing is running in the background.</Text>;
    }
    return (
      <View style={styles.list}>
        {work.tasks.map((task) => (
          <View key={task.taskId} style={styles.row}>
            <Icon
              name={task.kind === "monitor" ? "Radio" : "SquareTerminal"}
              size={16}
              color={theme.colors.foregroundMuted}
            />
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={2}>
                {task.description}
              </Text>
              {task.command && task.command !== task.description ? (
                <Text style={styles.detail} numberOfLines={1}>
                  {task.command}
                </Text>
              ) : null}
              <Text style={styles.detail}>
                {task.kind === "monitor" ? "Monitor" : "Shell"} · running{" "}
                {formatElapsed(now - Date.parse(task.startedAt))}
                {task.expiresAt
                  ? ` · expires in ${formatElapsed(Date.parse(task.expiresAt) - now)}`
                  : ""}
              </Text>
            </View>
          </View>
        ))}
      </View>
    );
  };
}
