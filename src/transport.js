/**
 * The game server's ZTales folder (Zomboid/Lua/ZTales), seen the same way whether it is reached
 * over FTP or held in memory for the tests. Paths are relative to that folder: "outbox/seq.json".
 *
 *   list(dir) -> names directly inside, [] when missing
 *   get(path) -> text, or null when missing
 *   put(path, text)
 *   del(path) -> true when something was deleted
 */

const join = (root, rel) => `${root.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;

export class FtpTransport {
  /** session: an open FtpSession; root: the ZTales folder on the host, e.g. "/Zomboid/Lua/ZTales" */
  constructor(session, root) {
    this.s = session;
    this.root = root;
    this.made = new Set();
  }

  list(dir) { return this.s.list(join(this.root, dir)); }
  get(path) { return this.s.get(join(this.root, path)); }

  async put(path, text) {
    // the mod creates outbox/ and catalog/ itself, but nothing creates inbox/ before the first drop
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !this.made.has(dir)) {
      await this.s.mkdir(join(this.root, dir));
      this.made.add(dir);
    }
    // never let the mod read half a file: write under a name it ignores, then rename it into
    // place (an existing target is removed first: not every FTP server renames over a file)
    const full = join(this.root, path);
    const part = `${full}.part`;
    await this.s.put(part, text);
    await this.s.del(full);
    await this.s.rename(part, full);
  }

  del(path) { return this.s.del(join(this.root, path)); }
}

export class MemoryTransport {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.ops = [];
  }

  async list(dir) {
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    this.ops.push(`list ${dir}`);
    return [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((k) => k.slice(prefix.length));
  }

  async get(path) {
    this.ops.push(`get ${path}`);
    return this.files.has(path) ? this.files.get(path) : null;
  }

  async put(path, text) {
    this.ops.push(`put ${path}`);
    this.files.set(path, text);
  }

  async del(path) {
    this.ops.push(`del ${path}`);
    return this.files.delete(path);
  }
}
