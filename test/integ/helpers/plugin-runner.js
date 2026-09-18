import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { createHostShim } from "./host-shim.js";
import { waitFor } from "./broker.js";

const BUNDLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../mqtt.reaplugin/plugin.js",
);

const PERMISSIONS = [
  "log",
  "api",
  "pluginStorage",
  "events.machine",
  "events.shots",
  "network.tcp",
  "network.tls",
  "network.websocket",
];

export async function loadMqttPlugin({ sim, settings, seedStore }) {
  const code = readFileSync(BUNDLE_PATH, "utf8");
  const shim = createHostShim({
    sim,
    permissions: PERMISSIONS,
    onPluginEvent: (event) => {
      try {
        plugin.onEvent(event);
      } catch (e) {
        shim.logs.push(`plugin onEvent threw: ${e?.message ?? e}`);
      }
    },
  });

  const sandbox = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    fetch: shim.host.fetch,
    URL,
    URLSearchParams,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: "plugin.js" });
  const plugin = context.__mqttBundle.createPlugin(shim.host);

  for (const [key, value] of Object.entries(seedStore ?? {})) {
    shim.store.set(key, value);
  }
  await plugin.onLoad(settings ?? {});

  return {
    plugin,
    shim,
    logs: shim.logs,
    event: (name, payload) => plugin.onEvent({ name, payload }),
    unload: () => plugin.onUnload(),
    waitForLog: async (pattern, timeoutMs = 5000) => {
      await waitFor(() => shim.logs.some((l) => typeof l === "string" && pattern.test(l)), timeoutMs);
    },
  };
}
