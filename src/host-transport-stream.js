function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

function base64ToBytes(b64) {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array((end * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)];
    if (v === 255) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

function bytesToBase64(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] + "=";
  }
  return out;
}

class TinyEmitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return this;
  }
  once(event, cb) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      cb(...args);
    };
    return this.on(event, wrapper);
  }
  removeListener(event, cb) {
    this._listeners.get(event)?.delete(cb);
    return this;
  }
  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return false;
    for (const cb of Array.from(set)) cb(...args);
    return true;
  }
}

export class HostTransportStream extends TinyEmitter {
  constructor(hostTransport, openOptions) {
    super();
    this._hostTransport = hostTransport;
    this._openOptions = openOptions;
    this._handle = null;
    this._writable = true;
    this._pendingWrites = [];
    this._flushing = false;
    this._closed = false;
    this._openPromise = null;
    this._onTransportEvent = (event) => this._handleTransportEvent(event);
  }

  async open() {
    this._openPromise = this._open();
    return this._openPromise;
  }

  async _open() {
    const opened = await this._hostTransport.open(this._openOptions);
    this._handle = opened.handle;
    this._hostTransport.onEvent(this._handle, this._onTransportEvent);
  }

  _handleTransportEvent(event) {
    if (this._closed) return;
    switch (event.type) {
      case "data": {
        const bytes = event.dataType === "binary"
          ? base64ToBytes(event.data)
          : utf8Encode(String(event.data));
        this.emit("data", bytes);
        break;
      }
      case "error":
        this.emit("error", new Error(event.message ?? "transport_error"));
        break;
      case "close":
        this._markClosed();
        break;
      default:
        break;
    }
  }

  _markClosed() {
    if (this._closed) return;
    this._closed = true;
    this._writable = false;
    this.emit("close");
  }

  write(chunk, encodingOrCb, maybeCb) {
    const cb = typeof encodingOrCb === "function" ? encodingOrCb : maybeCb;
    if (this._closed || !this._writable) {
      const err = new Error("stream is closed");
      if (typeof cb === "function") cb(err);
      else this.emit("error", err);
      return false;
    }
    const bytes = chunk instanceof Uint8Array ? chunk : utf8Encode(String(chunk));
    this._pendingWrites.push({ bytes, cb });
    this._flush();
    return true;
  }

  _flush() {
    if (this._flushing || this._pendingWrites.length === 0) return;
    this._flushing = true;
    const next = this._pendingWrites.shift();
    const payload = { type: "binary", data: bytesToBase64(next.bytes) };
    const sendPromise = this._openPromise
      ? this._openPromise
        .then(() => this._hostTransport.send(this._handle, payload))
      : this._hostTransport.send(this._handle, payload);
    sendPromise
      .then(() => {
        if (typeof next.cb === "function") next.cb();
        this._flushing = false;
        if (this._pendingWrites.length > 0) this._flush();
      })
      .catch((e) => {
        this._flushing = false;
        if (typeof next.cb === "function") next.cb(e);
        else this.emit("error", e);
        if (this._pendingWrites.length > 0) this._flush();
      });
  }

  async end() {
    await this._hostTransport.close(this._handle).catch(() => {});
    this._markClosed();
  }

  destroy() {
    this.end();
  }

  pipe(dest) {
    this.on("data", (chunk) => dest.write(chunk));
    return dest;
  }

  setMaxListeners() {
    return this;
  }

  cork() {}

  uncork() {}
}
