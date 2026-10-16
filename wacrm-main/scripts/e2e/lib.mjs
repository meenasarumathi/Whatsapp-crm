export const BASE = process.env.BASE || "http://localhost:3100";
export const tally = { pass: 0, fail: 0 };
export const ok = (name, cond, extra = "") => { (cond ? tally.pass++ : tally.fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };
export class Session {
  jar = {};
  async req(path, opts = {}) {
    const headers = { ...(opts.headers || {}), cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    const res = await fetch(BASE + path, { ...opts, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") delete this.jar[k]; else this.jar[k] = v;
    }
    return res;
  }
  async json(path, body, method = "POST") {
    const res = await this.req(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, body: j };
  }
  db(table, ops) { return this.json("/api/db", { kind: "query", table, ops }); }
  rpc(fn, args, ops = []) { return this.json("/api/db", { kind: "rpc", fn, args, ops }); }
}

