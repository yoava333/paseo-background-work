import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeBackgroundWork } from "./client/background-work";

export default function contribute(client: PluginClientContext) {
  return contributeBackgroundWork(client);
}
