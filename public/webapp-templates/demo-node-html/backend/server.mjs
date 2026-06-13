import http from "node:http";

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "0", 10);
let visits = 0;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      webappId: process.env.WEBAPP_ID || "",
      serverTime: new Date().toISOString()
    });
    return;
  }

  if (req.url === "/api/demo") {
    visits += 1;
    sendJson(res, 200, {
      ok: true,
      visits,
      webappId: process.env.WEBAPP_ID || "",
      webappRoot: process.env.WEBAPP_ROOT || "",
      serverTime: new Date().toISOString()
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    message: "not found"
  });
});

server.listen(port, host, () => {
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  console.log(`demo backend listening on http://${host}:${resolvedPort}`);
});
