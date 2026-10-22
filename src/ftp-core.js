/**
 * A minimal FTP client, pure protocol. The socket comes from an `open` function, so the same
 * code runs on Cloudflare's TCP (ftp.js) and on Node's net in the tests (test/net-socket.js).
 *
 * open(host, port, { secure }) must return a Cloudflare-style socket:
 *   { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>,
 *     close(): Promise, startTls?(): socket }
 *
 * Passive mode only (EPSV, then PASV). One control connection per session; the caller closes it.
 * Explicit TLS ("AUTH TLS") is supported for hosts that require it, data channels included.
 */

export class FtpError extends Error {
  constructor(message, code = 0) {
    super(message);
    this.name = "FtpError";
    this.code = code;
  }
}

const enc = new TextEncoder();

export function withDeadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FtpError(`timeout: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Reads CRLF lines from a ReadableStream. */
class LineReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.dec = new TextDecoder();
    this.buf = "";
  }

  async line(ms) {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const out = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        return out;
      }
      const { value, done } = await withDeadline(this.reader.read(), ms, "reply");
      if (done) throw new FtpError("control connection closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }

  release() {
    try { this.reader.releaseLock(); } catch { /* already released */ }
  }
}

/** One reply, multi-line aware ("150-..." up to "150 ..."). */
export async function readReply(lines, ms) {
  const first = await lines.line(ms);
  const m = /^(\d{3})([ -])(.*)$/.exec(first);
  if (!m) throw new FtpError(`bad reply: ${first.slice(0, 80)}`);
  const code = Number(m[1]);
  const text = [m[3]];
  if (m[2] === "-") {
    for (;;) {
      const l = await lines.line(ms);
      if (l.startsWith(`${m[1]} `)) { text.push(l.slice(4)); break; }
      text.push(l);
    }
  }
  return { code, text: text.join("\n") };
}

/** "229 Entering Extended Passive Mode (|||6446|)" -> 6446 */
export function parseEpsv(text) {
  const m = /\(([^\d])\1\1(\d+)\1\)/.exec(text);
  return m ? Number(m[2]) : null;
}

/** "227 Entering Passive Mode (192,168,1,2,25,46)" -> { host, port } */
export function parsePasv(text) {
  const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(text);
  if (!m) return null;
  return { host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, port: Number(m[5]) * 256 + Number(m[6]) };
}

function isPrivate(ip) {
  return /^(10\.|127\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

async function readAll(readable, ms, maxBytes) {
  const reader = readable.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await withDeadline(reader.read(), ms, "data");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new FtpError(`file larger than ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export class FtpSession {
  constructor(open, cfg) {
    this.open = open;
    this.cfg = { port: 21, timeout: 15000, maxBytes: 4 * 1024 * 1024, tls: false, ...cfg };
    this.socket = null;
    this.lines = null;
    this.writer = null;
    this.binary = false;
  }

  static async connect(open, cfg) {
    const s = new FtpSession(open, cfg);
    try {
      await s.start();
    } catch (e) {
      // a refused login or a silent host must not leave the socket open
      try { s.lines?.release(); s.writer?.releaseLock(); } catch { /* ignore */ }
      try { await s.socket?.close(); } catch { /* ignore */ }
      throw e;
    }
    return s;
  }

  attach(socket) {
    this.socket = socket;
    this.lines = new LineReader(socket.readable);
    this.writer = socket.writable.getWriter();
  }

  async start() {
    const { host, port, user, pass, timeout } = this.cfg;
    if (!host || !user || pass == null) throw new FtpError("incomplete FTP settings (host, user, password)");
    this.attach(await this.open(host, port, { secure: false }));
    this.expect(await readReply(this.lines, timeout), [220], "greeting");
    if (this.cfg.tls) {
      this.expect(await this.cmd("AUTH TLS"), [234], "AUTH TLS");
      if (typeof this.socket.startTls !== "function") throw new FtpError("this socket cannot start TLS");
      this.lines.release();
      this.writer.releaseLock();
      this.attach(this.socket.startTls());
    }
    let r = await this.cmd(`USER ${user}`);
    if (r.code === 331) r = await this.cmd(`PASS ${pass}`);
    // never echo the reply text of a failed login: some servers repeat the user name back
    if (r.code !== 230) throw new FtpError(`login refused (${r.code})`, r.code);
    if (this.cfg.tls) {
      await this.cmd("PBSZ 0");
      this.expect(await this.cmd("PROT P"), [200], "PROT P");
    }
  }

  expect(reply, codes, what) {
    if (!codes.includes(reply.code)) throw new FtpError(`${what}: ${reply.code} ${reply.text.slice(0, 120)}`, reply.code);
    return reply;
  }

  async cmd(line) {
    await this.writer.write(enc.encode(`${line}\r\n`));
    return readReply(this.lines, this.cfg.timeout);
  }

  async ensureBinary() {
    if (this.binary) return;
    this.expect(await this.cmd("TYPE I"), [200], "TYPE I");
    this.binary = true;
  }

  /** Opens a passive data connection. EPSV first; PASV with a private address uses the control host. */
  async dataSocket() {
    const host = this.cfg.host;
    const secure = !!this.cfg.tls;
    const e = await this.cmd("EPSV");
    if (e.code === 229) {
      const port = parseEpsv(e.text);
      if (port) return this.open(host, port, { secure });
    }
    const p = this.expect(await this.cmd("PASV"), [227], "PASV");
    const addr = parsePasv(p.text);
    if (!addr) throw new FtpError("PASV reply without an address");
    const target = isPrivate(addr.host) ? host : addr.host;
    return this.open(target, addr.port, { secure });
  }

  /** Names directly inside dir (NLST). A missing or empty directory gives []. */
  async list(dir) {
    await this.ensureBinary();
    const data = await this.dataSocket();
    const r = await this.cmd(`NLST ${dir}`);
    if (r.code === 550 || r.code === 450) {
      await data.close().catch(() => {});
      return [];
    }
    this.expect(r, [125, 150], `NLST ${dir}`);
    const bytes = await readAll(data.readable, this.cfg.timeout, this.cfg.maxBytes);
    await data.close().catch(() => {});
    this.expect(await readReply(this.lines, this.cfg.timeout), [226, 250], "NLST end");
    return new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean)
      .map((n) => n.replace(/^.*\//, ""));
  }

  /** Whole file as text, or null when it does not exist. */
  async get(path) {
    await this.ensureBinary();
    const data = await this.dataSocket();
    const r = await this.cmd(`RETR ${path}`);
    if (r.code === 550 || r.code === 450) {
      await data.close().catch(() => {});
      return null;
    }
    this.expect(r, [125, 150], `RETR ${path}`);
    const bytes = await readAll(data.readable, this.cfg.timeout, this.cfg.maxBytes);
    await data.close().catch(() => {});
    this.expect(await readReply(this.lines, this.cfg.timeout), [226, 250], "RETR end");
    return new TextDecoder().decode(bytes);
  }

  async put(path, text) {
    await this.ensureBinary();
    const data = await this.dataSocket();
    this.expect(await this.cmd(`STOR ${path}`), [125, 150], `STOR ${path}`);
    const w = data.writable.getWriter();
    await w.write(enc.encode(text));
    await w.close();
    await data.close().catch(() => {});
    this.expect(await readReply(this.lines, this.cfg.timeout), [226, 250], "STOR end");
  }

  /** Renames a file (RNFR/RNTO). */
  async rename(from, to) {
    this.expect(await this.cmd(`RNFR ${from}`), [350], `RNFR ${from}`);
    this.expect(await this.cmd(`RNTO ${to}`), [250], `RNTO ${to}`);
  }

  /** true when deleted, false when it was not there. */
  async del(path) {
    const r = await this.cmd(`DELE ${path}`);
    if (r.code === 550 || r.code === 450) return false;
    this.expect(r, [250], `DELE ${path}`);
    return true;
  }

  /** Creates a directory; one that already exists is fine. */
  async mkdir(path) {
    const r = await this.cmd(`MKD ${path}`);
    return r.code === 257;
  }

  async close() {
    try {
      await withDeadline(this.cmd("QUIT"), 3000, "QUIT");
    } catch { /* closing anyway */ }
    try { this.lines?.release(); this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.socket?.close(); } catch { /* ignore */ }
  }
}

/** Runs fn(session) and always closes the connection. */
export async function withFtp(open, cfg, fn) {
  const s = await FtpSession.connect(open, cfg);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}
