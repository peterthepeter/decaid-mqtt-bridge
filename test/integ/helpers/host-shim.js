import net from "node:net";
import tls from "node:tls";
import { WebSocket } from "ws";

const KIND_PERMISSION = {
  tcp: "network.tcp",
  tls: "network.tls",
  websocket: "network.websocket",
};

const MAX_TRANSPORTS = 8;

export class PluginPermissionError extends Error {
  constructor(permission) {
    super(`permission denied: ${permission}`);
    this.name = "PluginPermissionError";
    this.code = "plugin_permission";
  }
}

export function createHostShim({ sim, permissions = [], onPluginEvent }) {
  const logs = [];
  const emitted = [];
  const store = new Map();
  const transports = new Map();
  const openCalls = [];
  let nextHandle = 1;

  function deliver(handle, event) {
    const entry = transports.get(handle);
    if (!entry) return;
    if (entry.listener) {
      entry.listener(event);
    } else {
      entry.queue.push(event);
    }
  }

  function wireSocket(handle, socket) {
    socket.on("data", (buf) => {
      deliver(handle, { type: "data", dataType: "binary", data: buf.toString("base64") });
    });
    socket.on("error", (e) => {
      deliver(handle, { type: "error", code: "transport_error", message: String(e?.message ?? e) });
    });
    socket.on("close", () => {
      deliver(handle, { type: "close" });
    });
  }

  function wireWebSocket(handle, ws) {
    ws.on("message", (data, isBinary) => {
      deliver(handle, isBinary
        ? { type: "data", dataType: "binary", data: data.toString("base64") }
        : { type: "data", dataType: "text", data: data.toString("utf8") });
    });
    ws.on("error", (e) => {
      deliver(handle, { type: "error", code: "transport_error", message: String(e?.message ?? e) });
    });
    ws.on("close", () => {
      deliver(handle, { type: "close" });
    });
  }

  const transport = {
    async open(options) {
      openCalls.push({ ...options });
      const permission = KIND_PERMISSION[options.kind];
      if (!permission) throw new Error(`unsupported transport kind: ${options.kind}`);
      if (!permissions.includes(permission)) throw new PluginPermissionError(permission);
      const live = [...transports.values()].filter((e) => !e.closed).length;
      if (live >= MAX_TRANSPORTS) {
        const err = new Error("transport_resource_limit");
        err.code = "transport_resource_limit";
        throw err;
      }
      const handle = `h${nextHandle++}`;
      const entry = { kind: options.kind, listener: null, queue: [], closed: false, raw: null };
      transports.set(handle, entry);

      if (options.kind === "tcp" || options.kind === "tls") {
        await new Promise((resolve, reject) => {
          const connectFn = options.kind === "tls" ? tls.connect : net.connect;
          const socket = connectFn(
            { host: options.host, port: options.port, rejectUnauthorized: true },
            () => resolve(),
          );
          entry.raw = socket;
          socket.once("error", (e) => reject(e));
        });
        wireSocket(handle, entry.raw);
      } else if (options.kind === "websocket") {
        const url = remapLoopback(options.url, sim?.port);
        const ws = new WebSocket(url);
        entry.raw = ws;
        // Decaid streams send their initial snapshot immediately after the
        // upgrade. Attach before awaiting `open` so that frame is queued for
        // the plugin instead of being lost in the test harness.
        wireWebSocket(handle, ws);
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
      } else {
        throw new Error(`unsupported transport kind: ${options.kind}`);
      }
      return { handle };
    },

    onEvent(handle, listener) {
      const entry = transports.get(handle);
      if (!entry) throw transportError("unknown handle");
      entry.listener = listener;
      const queued = entry.queue.splice(0);
      for (const event of queued) listener(event);
    },

    async send(handle, payload) {
      const entry = transports.get(handle);
      if (!entry || entry.closed) throw transportError("handle is not open");
      if (payload.type === "binary") {
        const bytes = Buffer.from(payload.data, "base64");
        await new Promise((resolve, reject) => {
          entry.raw.write(bytes, (e) => (e ? reject(e) : resolve()));
        });
      } else if (entry.kind === "websocket") {
        await new Promise((resolve, reject) => {
          entry.raw.send(payload.data, (e) => (e ? reject(e) : resolve()));
        });
      } else {
        throw transportError("text send is only valid for websocket");
      }
    },

    async close(handle) {
      const entry = transports.get(handle);
      if (!entry) throw transportError("unknown handle");
      if (entry.closed) throw transportError("handle already closed");
      entry.closed = true;
      transports.delete(handle);
      const raw = entry.raw;
      if (!raw) return;
      await new Promise((resolve) => {
        const done = () => resolve();
        raw.once("close", done);
        if (typeof raw.end === "function") raw.end();
        else raw.close();
        setTimeout(done, 200);
      });
    },
  };

  function transportError(message) {
    const err = new Error(message);
    err.code = "transport_error";
    return err;
  }

  const host = {
    transport,

    log(message) {
      logs.push(message);
    },

    emit(name, payload) {
      emitted.push({ name, payload });
    },

    storage(command) {
      if (command?.type === "write") {
        store.set(command.key, command.data);
        return Promise.resolve();
      }
      if (command?.type === "read") {
        setTimeout(() => {
          onPluginEvent({
            name: "storageRead",
            payload: { key: command.key, value: store.get(command.key) ?? null },
          });
        }, 1);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unsupported storage command: ${command?.type}`));
    },

    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      return fetch(remapLoopback(url, sim?.port), init);
    },
  };

  function killTransport(handle) {
    const entry = transports.get(handle);
    if (!entry?.raw) return;
    entry.raw.destroy();
  }

  function liveTransportCount() {
    return [...transports.values()].filter((e) => !e.closed).length;
  }

  return { host, logs, emitted, store, openCalls, killTransport, liveTransportCount };
}

export function remapLoopback(url, port) {
  if (port === undefined) return url;
  return url.replace(/^http:\/\/localhost:8080/, `http://127.0.0.1:${port}`)
    .replace(/^ws:\/\/localhost:8080/, `ws://127.0.0.1:${port}`);
}
