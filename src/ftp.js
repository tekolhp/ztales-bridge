/**
 * The bridge between the pure FTP protocol (ftp-core.js) and Cloudflare's TCP.
 * This is the only file that imports `cloudflare:sockets`.
 */

import { connect } from "cloudflare:sockets";
import { withFtp } from "./ftp-core.js";

export { FtpError } from "./ftp-core.js";

export function cloudflareOpen(host, port, { secure } = {}) {
  return connect({ hostname: host, port: Number(port) },
    { secureTransport: secure ? "on" : "starttls", allowHalfOpen: false });
}

/** cfg: { host, port, user, pass, tls } from the Worker's vars and secrets. */
export function withServerFtp(cfg, fn) {
  return withFtp(cloudflareOpen, cfg, fn);
}
