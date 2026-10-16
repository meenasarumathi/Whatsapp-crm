// Tiny stand-in for the old public storage endpoint (used by the rehearsal only).
import http from "node:http";
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.SRC_URL });
await c.connect();
const objs = (await c.query("SELECT bucket_id, name, metadata FROM storage.objects")).rows;
http.createServer((req, res) => {
  const m = decodeURIComponent(req.url).match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  const o = m && objs.find((x) => x.bucket_id === m[1] && x.name === m[2]);
  if (!o) { res.writeHead(404); return res.end("{}"); }
  const size = Number(o.metadata.size);
  res.writeHead(200, { "content-type": o.metadata.mimetype });
  res.end(Buffer.alloc(size, 7));
}).listen(Number(process.env.PORT || 9911), "127.0.0.1", () => console.log("fake storage on", process.env.PORT || 9911));
