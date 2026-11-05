import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  type AgentBackgroundWork,
  BackgroundTaskModel,
  type ToolCallLike,
} from "../shared/background-work";

type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelineEvent = Parameters<Parameters<AgentHandle["timeline"]["subscribe"]>[0]>[0];

interface AgentFacts {
  id: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
}

interface FollowedAgent {
  workspaceId: string;
  model: BackgroundTaskModel;
  stop(): void;
}

export interface BackgroundWorkTracker {
  snapshot(): AgentBackgroundWork[];
  stop(): void;
}

const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 10;
// Written by the Claude provider when its process exits between turns.
const RUNTIME_DIED = "Claude stopped unexpectedly";

/** Follows every live agent's timeline and folds Claude background tasks out of it. */
export function startBackgroundWorkTracker(paseo: PaseoApi): BackgroundWorkTracker {
  const followed = new Map<string, FollowedAgent>();
  // Agents whose process ended while we watched. Their history holds only dead tasks.
  const ended = new Set<string>();
  const lifetime = new AbortController();

  function observe(agent: AgentFacts) {
    const live = !agent.archivedAt && agent.status !== "closed" && Boolean(agent.workspaceId);
    const current = followed.get(agent.id);
    if (!live || !agent.workspaceId) {
      if (current) unfollow(agent.id);
      else ended.add(agent.id);
      return;
    }
    if (current) {
      current.workspaceId = agent.workspaceId;
      return;
    }
    follow(agent.id, agent.workspaceId, !ended.has(agent.id));
  }

  function unfollow(agentId: string) {
    followed.get(agentId)?.stop();
    followed.delete(agentId);
    ended.add(agentId);
  }

  function follow(agentId: string, workspaceId: string, replayHistory: boolean) {
    const model = new BackgroundTaskModel();
    const handle = paseo.agents.ref(agentId);
    let pending: TimelineEvent[] | null = replayHistory ? [] : null;

    function apply(event: TimelineEvent) {
      if (!("timestamp" in event)) {
        // A replaced timeline (rewind) no longer proves its tasks; wait for new ones.
        if (event.event.type === "replacement") model.clear();
        return;
      }
      const stream = event.event;
      if (stream.type === "timeline") model.observe(stream.item as ToolCallLike, event.timestamp);
      else if (stream.type === "thread_started") model.clear();
      else if (stream.type === "turn_failed" && stream.error.startsWith(RUNTIME_DIED)) {
        model.clear();
      }
    }

    const subscription = handle.timeline.subscribe((event) => {
      if (pending) pending.push(event);
      else apply(event);
    });
    followed.set(agentId, { workspaceId, model, stop: () => subscription() });

    if (!pending) return;
    void (async () => {
      try {
        await subscription.ready;
        for (const entry of await readHistory(handle)) {
          model.observe(entry.item as ToolCallLike, entry.timestamp);
        }
      } catch (error) {
        if (!lifetime.signal.aborted)
          console.error(`Background work history failed for ${agentId}`, error);
      } finally {
        const buffered = pending ?? [];
        pending = null;
        for (const event of buffered) apply(event);
      }
    })();
  }

  void paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of followed.keys()) if (!seen.has(agentId)) unfollow(agentId);
          for (const { agent } of entries) observe(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            if (followed.has(update.agentId)) unfollow(update.agentId);
          } else observe(update.agent);
        },
      });
      lifetime.signal.addEventListener("abort", () => void subscription.release(), { once: true });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted)
        console.error("Background work agent observation failed", error);
    });

  return {
    snapshot() {
      const now = Date.now();
      const agents: AgentBackgroundWork[] = [];
      for (const [agentId, agent] of followed) {
        const tasks = agent.model.list(now);
        if (tasks.length > 0) agents.push({ agentId, workspaceId: agent.workspaceId, tasks });
      }
      return agents;
    },
    stop() {
      lifetime.abort();
      for (const agent of followed.values()) agent.stop();
      followed.clear();
    },
  };
}

/** Oldest first, bounded so a huge session does not stall startup. */
async function readHistory(handle: AgentHandle) {
  const pages: Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>["entries"][] = [];
  let page = await handle.timeline.refetch({
    direction: "tail",
    limit: HISTORY_PAGE_SIZE,
    projection: "canonical",
  });
  pages.push(page.entries);
  while (page.hasOlder && page.startCursor && pages.length < HISTORY_MAX_PAGES) {
    page = await handle.timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: HISTORY_PAGE_SIZE,
      projection: "canonical",
    });
    pages.push(page.entries);
  }
  return pages.toReversed().flat();
}
