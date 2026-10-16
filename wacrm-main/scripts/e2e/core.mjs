// End-to-end smoke test against a running app:  BASE=http://localhost:3100 node e2e.mjs
const BASE = process.env.BASE || "http://localhost:3100";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };

class Session {
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

const stamp = Date.now();
const A = new Session(), B = new Session(), anon = new Session();
const emailA = `alice${stamp}@example.com`, emailB = `bob${stamp}@example.com`;

// --- health, anonymous protection
ok("health", (await anon.req("/api/health")).status === 200);
ok("anonymous /api/db is 401", (await anon.db("contacts", [["select", "*"]])).status === 401);
ok("anonymous dashboard redirects to /login", ((r) => r.status === 307 && /\/login/.test(r.headers.get("location")))(await anon.req("/dashboard")));
ok("anonymous whatsapp api is 401", (await anon.req("/api/whatsapp/send", { method: "POST" })).status === 401);

// --- signup / login / me
let r = await A.json("/api/auth/signup", { email: emailA, password: "secret123", fullName: "Alice A" });
ok("signup alice", r.status === 200 && r.body.user?.email === emailA, JSON.stringify(r));
ok("signup sets session cookie", !!A.jar.wacrm_session);
r = await A.json("/api/auth/signup", { email: emailA, password: "secret123" });
ok("duplicate signup is 409", r.status === 409);
r = await A.json("/api/auth/signup", { email: "bad", password: "secret123" });
ok("invalid email is 400", r.status === 400);
r = await B.json("/api/auth/signup", { email: emailB, password: "secret456", fullName: "Bob B" });
ok("signup bob", r.status === 200);
r = await anon.json("/api/auth/login", { email: emailA, password: "wrong-password" });
ok("wrong password is 401", r.status === 401);
const A2 = new Session();
r = await A2.json("/api/auth/login", { email: emailA.toUpperCase(), password: "secret123" });
ok("login (case-insensitive email)", r.status === 200);
r = await A.json("/api/auth/me", undefined, "GET");
ok("me returns user", r.body.user?.email === emailA && r.body.user?.full_name === "Alice A", JSON.stringify(r.body));

// --- profile / account created by trigger
r = await A.db("profiles", [["select", "user_id, email, full_name, account_id, account_role"], ["eq", "user_id", (await A.json("/api/auth/me", undefined, "GET")).body.user.id], ["single"]]);
ok("profile auto-created as owner", r.body?.data?.account_role === "owner" && !!r.body.data.account_id, JSON.stringify(r.body));
const accountA = r.body.data.account_id;
const userA = r.body.data.user_id;
const meB = (await B.json("/api/auth/me", undefined, "GET")).body.user;

// --- CRUD through the gateway
r = await A.db("contacts", [["insert", { user_id: userA, account_id: accountA, phone: "+15551230001", name: "Carol" }], ["select"], ["single"]]);
ok("create contact", r.body?.data?.name === "Carol", JSON.stringify(r.body));
const contactId = r.body.data.id;
r = await A.db("tags", [["insert", { user_id: userA, account_id: accountA, name: "vip", color: "#ff0000" }], ["select"], ["single"]]);
ok("create tag", !!r.body?.data?.id, JSON.stringify(r.body));
const tagId = r.body.data.id;
r = await A.db("contact_tags", [["insert", { contact_id: contactId, tag_id: tagId }]]);
ok("link tag", !r.body.error, JSON.stringify(r.body));
r = await A.db("contacts", [["select", "id, name, tags:contact_tags(tag_id)", { count: "exact" }], ["order", "created_at", { ascending: false }]]);
ok("list with embed + count", r.body.count === 1 && r.body.data[0].tags[0].tag_id === tagId, JSON.stringify(r.body));
r = await A.db("contacts", [["update", { name: "Carol Z" }], ["eq", "id", contactId], ["select", "name"], ["single"]]);
ok("update contact", r.body?.data?.name === "Carol Z");
r = await A.db("contacts", [["insert", { user_id: userA, account_id: accountA, phone: "+15551230001", name: "Dup" }]]);
ok("unique violation surfaces 23505", r.body?.error?.code === "23505", JSON.stringify(r.body));
r = await A.db("conversations", [["insert", { user_id: userA, account_id: accountA, contact_id: contactId }], ["select"], ["single"]]);
ok("create conversation", !!r.body?.data?.id, JSON.stringify(r.body));
const convId = r.body.data.id;

// --- tenant isolation (row level security)
r = await B.db("contacts", [["select", "*"]]);
ok("bob sees none of alice's contacts", Array.isArray(r.body.data) && r.body.data.length === 0, JSON.stringify(r.body));
r = await B.db("contacts", [["update", { name: "hacked" }], ["eq", "id", contactId], ["select"]]);
ok("bob cannot update alice's contact", (r.body.data ?? []).length === 0);
r = await B.db("contacts", [["insert", { user_id: meB.id, account_id: accountA, phone: "+15559990000", name: "Evil" }]]);
ok("bob cannot insert into alice's account", !!r.body.error, JSON.stringify(r.body));
r = await B.db("contacts", [["delete"], ["eq", "id", contactId]]);
r = await A.db("contacts", [["select", "id"], ["eq", "id", contactId]]);
ok("alice's contact survives bob's delete", r.body.data.length === 1);
r = await A.json("/api/db", { kind: "query", table: "users", ops: [["select", "*"]] });
ok("users/password table is not readable through the gateway", !!r.body.error && !r.body.data, JSON.stringify(r.body));
r = await A.json("/api/db", { kind: "query", table: "contacts; drop table x", ops: [] });
ok("bad table name rejected", r.status === 400);
r = await A.json("/api/db", { kind: "query", table: "contacts", ops: [["execute_sql", "x"]] });
ok("unknown operation rejected", r.status === 400);
r = await A.rpc("is_account_member", { target_account_id: accountA });
ok("rpc is_account_member true", r.body.data === true);
r = await B.rpc("is_account_member", { target_account_id: accountA });
ok("rpc is_account_member false for outsider", r.body.data === false);

// --- storage
const form = new FormData();
form.set("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), "a.png");
form.set("path", `account-${accountA}/${stamp}-a.png`); form.set("upsert", "false");
let res = await A.req("/api/storage/chat-media", { method: "POST", body: form });
let j = await res.json();
ok("upload to chat-media", res.status === 200 && j.publicUrl?.includes("/api/files/chat-media/"), JSON.stringify(j));
res = await anon.req(new URL(j.publicUrl, BASE).pathname);
ok("public download returns the bytes", res.status === 200 && res.headers.get("content-type") === "image/png" && (await res.arrayBuffer()).byteLength === 8);
const form2 = new FormData(); form2.set("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "b.png"); form2.set("path", `account-${accountA}/x.png`);
res = await B.req("/api/storage/chat-media", { method: "POST", body: form2 });
ok("outsider cannot upload into alice's account folder", res.status === 403);
const form3 = new FormData(); form3.set("file", new Blob(["x"], { type: "application/x-msdownload" }), "b.exe"); form3.set("path", `account-${accountA}/y.exe`);
res = await A.req("/api/storage/chat-media", { method: "POST", body: form3 });
ok("disallowed mime type rejected", res.status === 415);
res = await anon.req("/api/files/chat-media/..%2F..%2Fetc%2Fpasswd");
ok("path traversal rejected", res.status !== 200);
res = await A.req("/api/storage/chat-media", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [`account-${accountA}/${stamp}-a.png`] }) });
ok("delete object", res.status === 200);
res = await anon.req(new URL(j.publicUrl, BASE).pathname);
ok("deleted object is gone", res.status === 404);

// --- realtime (SSE): alice should get an event for a new message; bob must not
async function listen(session, ms) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(BASE + "/api/realtime", { headers: { cookie: Object.entries(session.jar).map(([k, v]) => `${k}=${v}`).join("; ") }, signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  const done = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const m = chunk.match(/^data: (.*)$/m); if (m) events.push(JSON.parse(m[1])); } } } catch {} })();
  await new Promise((r) => setTimeout(r, ms));
  return { events, stop: () => { ac.abort(); return done; } };
}
const la = await listen(A, 600), lb = await listen(B, 600);
r = await A.db("messages", [["insert", { conversation_id: convId, sender_type: "agent", content_type: "text", content_text: "hello realtime", status: "sent" }], ["select", "id"], ["single"]]);
ok("insert message", !!r.body?.data?.id, JSON.stringify(r.body));
const msgId = r.body.data.id;
await A.db("conversations", [["update", { last_message_text: "hello realtime", last_message_at: new Date().toISOString() }], ["eq", "id", convId]]);
await new Promise((r) => setTimeout(r, 1200));
await la.stop(); await lb.stop();
ok("alice receives ready + message INSERT event", la.events.some((e) => e.type === "ready") && la.events.some((e) => e.table === "messages" && e.eventType === "INSERT" && e.new.id === msgId), JSON.stringify(la.events).slice(0, 300));
ok("alice receives conversation UPDATE event", la.events.some((e) => e.table === "conversations"), JSON.stringify(la.events).slice(0, 300));
ok("bob receives nothing about alice's data", lb.events.filter((e) => e.table).length === 0, JSON.stringify(lb.events).slice(0, 300));
ok("anonymous realtime is 401", (await anon.req("/api/realtime")).status === 401);

// --- password change / reset / sessions
r = await A.json("/api/auth/change-password", { current: "nope", next: "newsecret1" });
ok("change password needs current password", r.status === 403);
r = await A.json("/api/auth/change-password", { current: "secret123", next: "newsecret1" });
ok("change password", r.status === 200);
r = await anon.json("/api/auth/login", { email: emailA, password: "secret123" });
ok("old password rejected", r.status === 401);
r = await A.json("/api/auth/change-email", { email: `alice2${stamp}@example.com` });
ok("change email", r.status === 200);
r = await A.db("profiles", [["select", "email"], ["eq", "user_id", userA], ["single"]]);
ok("profiles.email follows", r.body.data.email === `alice2${stamp}@example.com`);
r = await A.json("/api/auth/forgot-password", { email: "nobody@example.com" });
ok("forgot-password never reveals unknown emails", r.status === 200);
r = await A.json("/api/auth/forgot-password", { email: `alice2${stamp}@example.com` });
ok("forgot-password accepted", r.status === 200);
const resetFile = process.env.MAIL_LOG;
let token = process.env.RESET_TOKEN;
if (resetFile) { const fs = await import("node:fs"); const m = [...fs.readFileSync(resetFile, "utf8").matchAll(/reset-password\?token=([\w-]+)/g)].pop(); token = m?.[1]; }
if (token) {
  r = await anon.json("/api/auth/reset-password", { token, password: "resetpass9" });
  ok("reset password with emailed token", r.status === 200 && !!anon.jar.wacrm_session);
  r = await anon.json("/api/auth/reset-password", { token, password: "again12345" });
  ok("reset token is single-use", r.status === 400);
  r = await A.json("/api/auth/me", undefined, "GET");
  ok("old session is invalidated by reset", r.body.user === null);
  const C = new Session(); r = await C.json("/api/auth/login", { email: `alice2${stamp}@example.com`, password: "resetpass9" });
  ok("login with new password", r.status === 200);
  r = await C.json("/api/auth/logout", { scope: "global" });
  r = await anon.json("/api/auth/me", undefined, "GET");
  ok("global sign-out invalidates other sessions", r.body.user === null);
} else console.log("SKIP  reset flow (set MAIL_LOG to the server log)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
