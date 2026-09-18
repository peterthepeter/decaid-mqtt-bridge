import net from "node:net";
import mqttPacket from "mqtt-packet";

export async function startBroker({ authenticate, port: fixedPort, maxProtocolVersion = 5 } = {}) {
  const connections = [];
  const publishes = [];
  const subscriptions = [];
  const retained = new Map();
  const sessions = new Map();
  const server = net.createServer((socket) => onConnection(socket));

  const port = await new Promise((resolve) => {
    server.listen(fixedPort ?? 0, "127.0.0.1", () => resolve(server.address().port));
  });

  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    for (const session of sessions.values()) {
      session.socket.destroy();
    }
    sessions.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  function onConnection(socket) {
    socket.setNoDelay(true);
    const parser = mqttPacket.parser();
    parser.on("packet", (packet) => {
      try {
        handlePacket(socket, packet);
      } catch (e) {
        socket.destroy();
      }
    });
    parser.on("error", () => socket.destroy());
    socket.on("data", (chunk) => parser.parse(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      const session = sessionForSocket(socket);
      if (session && !session.cleanClosed) {
        fireWill(session);
      }
      if (session) {
        sessions.delete(session.clientId);
      }
    });
  }

  function sessionForSocket(socket) {
    for (const session of sessions.values()) {
      if (session.socket === socket) return session;
    }
    return null;
  }

  function handlePacket(socket, packet) {
    switch (packet.cmd) {
      case "connect":
        return handleConnect(socket, packet);
      case "subscribe":
        return handleSubscribe(socket, packet);
      case "publish":
        return handlePublish(socket, packet);
      case "puback":
        return;
      case "pingreq":
        return send(socket, { cmd: "pingresp" }, packet.protocolVersion ?? 4);
      case "disconnect": {
        const session = sessionForSocket(socket);
        if (session) session.cleanClosed = true;
        socket.end();
        return;
      }
      default:
        return;
    }
  }

  function handleConnect(socket, packet) {
    const authorized = authenticate
      ? authenticate({
          username: packet.username,
          password: packet.password ? packet.password.toString("utf8") : null,
        })
      : true;
    if (!authorized) {
      send(socket, connack(packet, 5), packet.protocolVersion);
      socket.end();
      return;
    }
    if (packet.protocolVersion > maxProtocolVersion) {
      send(socket, connack(packet, 1), packet.protocolVersion);
      socket.end();
      return;
    }
    const session = {
      socket,
      clientId: packet.clientId,
      clean: packet.clean,
      version: packet.protocolVersion,
      keepalive: packet.keepalive,
      username: packet.username ?? null,
      will: packet.will
        ? {
            topic: packet.will.topic,
            payload: packet.will.payload.toString("utf8"),
            qos: packet.will.qos,
            retain: packet.will.retain,
          }
        : null,
      cleanClosed: false,
      subs: new Map(),
    };
    sessions.set(session.clientId, session);
    connections.push({
      id: session.clientId,
      clean: session.clean,
      version: session.version,
      keepaliveS: session.keepalive,
      will: session.will,
      username: session.username,
    });
    send(socket, connack(packet, 0), packet.protocolVersion);
  }

  function connack(packet, returnCode) {
    if (packet.protocolVersion === 5) {
      return { cmd: "connack", reasonCode: returnCode, sessionPresent: false, properties: {} };
    }
    return { cmd: "connack", returnCode, sessionPresent: false };
  }

  function handleSubscribe(socket, packet) {
    const session = sessionForSocket(socket);
    if (!session) return;
    for (const sub of packet.subscriptions) {
      session.subs.set(sub.topic, sub.qos);
      subscriptions.push({ topic: sub.topic, qos: sub.qos, clientId: session.clientId });
    }
    const granted = packet.subscriptions.map((s) => Math.min(s.qos, 1));
    send(socket, {
      cmd: "suback",
      messageId: packet.messageId,
      granted,
      properties: {},
    }, session.version);

    for (const sub of packet.subscriptions) {
      const stored = retained.get(sub.topic);
      if (stored) {
        deliver(session, { topic: stored.topic, payload: Buffer.from(stored.payload), qos: stored.qos, retain: true });
      }
    }
  }

  function handlePublish(socket, packet) {
    const session = sessionForSocket(socket);
    const record = {
      topic: packet.topic,
      payload: packet.payload.toString("utf8"),
      qos: packet.qos,
      retain: packet.retain,
      clientId: session?.clientId ?? null,
    };
    publishes.push(record);
    if (packet.qos > 0) {
      send(socket, {
        cmd: "puback",
        messageId: packet.messageId,
        reasonCode: 0,
        properties: {},
      }, session?.version ?? 4);
    }
    if (packet.retain) {
      retained.set(packet.topic, {
        topic: packet.topic,
        payload: record.payload,
        qos: packet.qos,
      });
    }
    route(record, session?.clientId ?? null);
  }

  function route(record, senderId) {
    for (const session of sessions.values()) {
      if (session.clientId === senderId) continue;
      for (const [topic, qos] of session.subs) {
        if (topicMatches(topic, record.topic)) {
          deliver(session, {
            topic: record.topic,
            payload: Buffer.from(record.payload),
            qos: Math.min(qos, record.qos),
            retain: false,
          });
          break;
        }
      }
    }
  }

  function deliver(session, packet) {
    const out = {
      cmd: "publish",
      topic: packet.topic,
      payload: packet.payload,
      qos: packet.qos,
      retain: packet.retain,
      messageId: nextMessageId(),
    };
    if (session.version === 5) out.properties = {};
    send(session.socket, out, session.version);
  }

  function nextMessageId() {
    broker._messageId = ((broker._messageId ?? 0) % 65535) + 1;
    return broker._messageId;
  }

  function fireWill(session) {
    if (!session.will) return;
    const record = {
      topic: session.will.topic,
      payload: session.will.payload,
      qos: session.will.qos,
      retain: session.will.retain,
      clientId: session.clientId,
    };
    publishes.push(record);
    if (session.will.retain) {
      retained.set(session.will.topic, {
        topic: session.will.topic,
        payload: session.will.payload,
        qos: session.will.qos,
      });
    }
    route(record, session.clientId);
  }

  function send(socket, packet, protocolVersion = 4) {
    socket.write(mqttPacket.generate(packet, { protocolVersion }));
  }

  function crashClient(clientId) {
    const session = sessions.get(clientId);
    if (!session) return false;
    session.socket.destroy();
    return true;
  }

  function publish(topic, payload, { qos = 1, retain = false } = {}) {
    const record = { topic, payload, qos, retain, clientId: null };
    publishes.push(record);
    if (retain) retained.set(topic, { topic, payload, qos });
    route(record, null);
    return record;
  }

  const broker = {
    port,
    connections,
    publishes,
    subscriptions,
    crashClient,
    publish,
    close,
  };
  return broker;
}

export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === "#") return true;
    if (filterParts[i] === "+") continue;
    if (filterParts[i] !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

export function publishesTo(publishes, topic) {
  return publishes.filter((p) => p.topic === topic);
}

export async function waitFor(fn, timeoutMs = 5000, intervalMs = 20) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
