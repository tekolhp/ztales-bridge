/** A Cloudflare-style socket over Node's net, so ftp-core.js runs unchanged in the tests. */
import net from "node:net";
import { Duplex } from "node:stream";

export function nodeOpen(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port }, () => {
      const { readable, writable } = Duplex.toWeb(s);
      resolve({
        readable,
        writable,
        close: async () => { s.destroy(); },
      });
    });
    s.once("error", reject);
  });
}
