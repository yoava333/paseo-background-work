import type { PluginServerContext } from "@getpaseo/plugin/server";
import { type BackgroundWorkTracker, startBackgroundWorkTracker } from "./server/tracker";
import { backgroundWorkList } from "./shared/background-work";

export default function contribute(server: PluginServerContext) {
  let tracker: BackgroundWorkTracker | null = null;

  server.handle(backgroundWorkList, (_input, { paseo }) => {
    // Setup has no Paseo client, so the tracker starts with the first call.
    tracker ??= startBackgroundWorkTracker(paseo);
    return { agents: tracker.snapshot() };
  });

  return () => {
    tracker?.stop();
    tracker = null;
  };
}
