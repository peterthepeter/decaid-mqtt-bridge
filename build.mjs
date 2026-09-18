import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("mqtt.reaplugin/manifest.json", "utf8"));

const abortControllerPolyfill = `
if (typeof globalThis.navigator === "undefined") {
  globalThis.navigator = { language: "en-US" };
}
if (typeof globalThis.AbortSignal === "undefined") {
  class AbortSignalPolyfill {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._listeners = [];
    }
    addEventListener(type, cb) {
      if (type === "abort" && typeof cb === "function") this._listeners.push(cb);
    }
    removeEventListener(type, cb) {
      this._listeners = this._listeners.filter((l) => l !== cb);
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason ?? new Error("AbortError");
    }
  }
  class AbortControllerPolyfill {
    constructor() {
      this.signal = new AbortSignalPolyfill();
    }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason ?? new Error("AbortError");
      const listeners = this.signal._listeners.splice(0);
      for (const cb of listeners) {
        try {
          cb({ type: "abort", target: this.signal });
        } catch {}
      }
      if (typeof this.signal.onabort === "function") {
        this.signal.onabort({ type: "abort", target: this.signal });
      }
    }
  }
  globalThis.AbortSignal = AbortSignalPolyfill;
  globalThis.AbortController = AbortControllerPolyfill;
}
`;

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  globalName: "__mqttBundle",
  platform: "browser",
  target: "es2022",
  outfile: "mqtt.reaplugin/plugin.js",
  legalComments: "none",
  minify: false,
  banner: { js: abortControllerPolyfill },
  footer: {
    js: "var createPlugin = __mqttBundle.createPlugin;",
  },
});

const out = readFileSync("mqtt.reaplugin/plugin.js", "utf8");
if (!out.includes("function createPlugin") || out.length < 1000) {
  console.error("bundle is missing createPlugin or is suspiciously small");
  process.exit(1);
}
console.log(`built mqtt.reaplugin/plugin.js (${out.length} bytes) for ${manifest.id}@${manifest.version}`);
