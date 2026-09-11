import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { callbackListenHosts, listenCallbackServers } = require("../dist-electron/main/modules/identity/callback-listener.js");

function close(servers) {
  return Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}

function request(host, port) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: "/api/auth/oidc/callback", agent: false }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

for (const platform of ["win32", "darwin"]) {
  test(`${platform} localhost uses both loopbacks and preserves explicit hosts`, () => {
    assert.deepEqual(callbackListenHosts("localhost", platform), ["127.0.0.1", "::1"]);
    assert.deepEqual(callbackListenHosts("127.0.0.1", platform), ["127.0.0.1"]);
    assert.deepEqual(callbackListenHosts("::1", platform), ["::1"]);
  });
}

test("localhost serves the same callback through IPv4 and IPv6 and releases both ports", async () => {
  const servers = [http.createServer((_request, response) => response.end("callback reached"))];
  try {
    const port = await listenCallbackServers(servers, 0, "localhost");
    assert.equal(servers.length, 2);
    assert.deepEqual(servers.map(server => server.address().address), ["127.0.0.1", "::1"]);
    assert.equal(await request("127.0.0.1", port), "callback reached");
    assert.equal(await request("::1", port), "callback reached");
    await close(servers);
    for (const host of ["127.0.0.1", "::1"]) {
      const replacement = http.createServer();
      replacement.listen({ host, port });
      await once(replacement, "listening");
      await close([replacement]);
    }
  } finally {
    await close(servers);
  }
});

test("an IPv6 port conflict fails startup and releases the IPv4 listener", async () => {
  const occupied = http.createServer();
  occupied.listen({ host: "::1", port: 0, ipv6Only: true });
  await once(occupied, "listening");
  const port = occupied.address().port;
  const servers = [http.createServer()];
  try {
    await assert.rejects(listenCallbackServers(servers, port, "localhost"), { code: "EADDRINUSE" });
    const replacement = http.createServer();
    replacement.listen({ host: "127.0.0.1", port });
    await once(replacement, "listening");
    await close([replacement]);
  } finally {
    await close([...servers, occupied]);
  }
});

test("explicit IPv4 ephemeral callbacks keep a single listener", async () => {
  const servers = [http.createServer((_request, response) => response.end("callback reached"))];
  try {
    const port = await listenCallbackServers(servers, 0, "127.0.0.1");
    assert.equal(servers.length, 1);
    assert.equal(await request("127.0.0.1", port), "callback reached");
  } finally {
    await close(servers);
  }
});
