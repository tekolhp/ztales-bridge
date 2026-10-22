/**
 * A tiny FTP server for the tests: one user, an in-memory file tree, passive mode only.
 * Enough to exercise the client the way a host's server does (multi-line greeting, EPSV or PASV,
 * 150 then 226 around transfers, 550 for missing files). Not a general server.
 */
import net from "node:net";

export async function startFakeFtp({ user = "u", pass = "p", files = {}, epsv = true, pasvIp = "127,0,0,1", tree: given = null, port = 0 } = {}) {
  // `tree` may be any Map-like store (serve-folder-ftp.mjs passes one backed by a real folder)
  const tree = given || new Map(Object.entries(files));
  const log = [];
  const sockets = new Set();

  const server = net.createServer((ctl) => {
    sockets.add(ctl);
    ctl.on("close", () => sockets.delete(ctl));
    ctl.on("error", () => {});
    let authed = false;
    let pendingUser = null;
    let dataServer = null;
    let dataConn = null;
    let renameFrom = null;
    const send = (l) => ctl.write(`${l}\r\n`);

    const openPassive = () => new Promise((resolve) => {
      if (dataServer) dataServer.close();
      dataConn = new Promise((res) => {
        dataServer = net.createServer((d) => { sockets.add(d); d.on("close", () => sockets.delete(d)); res(d); });
      });
      dataServer.listen(0, "127.0.0.1", () => resolve(dataServer.address().port));
    });

    const takeData = async () => {
      const d = await dataConn;
      dataServer.close();
      dataServer = null;
      return d;
    };

    send("220-Welcome to the fake host");
    send("220 ready");
    let buf = "";
    ctl.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [verb, ...rest] = line.split(" ");
        const arg = rest.join(" ");
        log.push(verb === "PASS" ? "PASS ***" : line);
        const V = verb.toUpperCase();
        if (V === "USER") { pendingUser = arg; send("331 password please"); continue; }
        if (V === "PASS") {
          if (pendingUser === user && arg === pass) { authed = true; send("230 logged in"); }
          else send("530 Login incorrect");
          continue;
        }
        if (V === "QUIT") { send("221 bye"); ctl.end(); continue; }
        if (!authed) { send("530 not logged in"); continue; }
        if (V === "TYPE") { send("200 type set"); continue; }
        if (V === "EPSV") {
          if (!epsv) { send("500 EPSV not understood"); continue; }
          const port = await openPassive();
          send(`229 Entering Extended Passive Mode (|||${port}|)`);
          continue;
        }
        if (V === "PASV") {
          const port = await openPassive();
          send(`227 Entering Passive Mode (${pasvIp},${port >> 8},${port & 255})`);
          continue;
        }
        if (V === "NLST") {
          const dir = arg.replace(/\/$/, "");
          const names = [...tree.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/"))
            .map((k) => k);
          const d = await takeData();
          if (names.length === 0) { d.end(); send("550 No files found"); continue; }
          send("150 Here comes the listing");
          d.end(`${names.join("\r\n")}\r\n`, () => send("226 Transfer complete"));
          continue;
        }
        if (V === "RETR") {
          const d = await takeData();
          if (!tree.has(arg)) { d.end(); send("550 No such file"); continue; }
          send("150 Opening data connection");
          d.end(tree.get(arg), () => send("226 Transfer complete"));
          continue;
        }
        if (V === "STOR") {
          const d = await takeData();
          send("150 Ok to send data");
          const parts = [];
          d.on("data", (c) => parts.push(c));
          d.on("end", () => { tree.set(arg, Buffer.concat(parts).toString("utf8")); send("226 Transfer complete"); });
          continue;
        }
        if (V === "DELE") {
          if (tree.delete(arg)) send("250 Deleted"); else send("550 No such file");
          continue;
        }
        if (V === "MKD") { send(`257 "${arg}" created`); continue; }
        if (V === "RNFR") {
          if (!tree.has(arg)) { send("550 No such file"); continue; }
          renameFrom = arg; send("350 Ready for RNTO"); continue;
        }
        if (V === "RNTO") {
          if (!renameFrom) { send("503 RNFR first"); continue; }
          tree.set(arg, tree.get(renameFrom)); tree.delete(renameFrom); renameFrom = null;
          send("250 Renamed"); continue;
        }
        send(`502 ${V} not implemented`);
      }
    });
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    port: server.address().port,
    tree,
    log,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
