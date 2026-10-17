import { Session, ok, tally, BASE } from "./lib.mjs";
const stamp = Date.now();
const O = new Session(), M = new Session(), anon = new Session();
const emailO = `owner${stamp}@example.com`, emailM = `member${stamp}@example.com`;
let r;
r = await O.json("/api/auth/signup", { email: emailO, password: "secret123", fullName: "Olive Owner" });
ok("owner signs up", r.status === 200);

// account
r = await O.json("/api/account", undefined, "GET");
ok("GET /api/account", r.status === 200 && r.body.role === "owner" && !!r.body.account?.id, JSON.stringify(r.body));
const accountId = r.body.account.id;
r = await O.json("/api/account", { name: "Acme Inc" }, "PATCH");
ok("PATCH /api/account renames", r.status === 200, JSON.stringify(r.body));
r = await O.json("/api/account", undefined, "GET");
ok("account name persisted", r.body.account.name === "Acme Inc");

// quick replies
r = await O.json("/api/quick-replies", { title: "Hello", content_text: "Hi there!" });
ok("quick reply create", r.status === 200 || r.status === 201, JSON.stringify(r));
const qr = r.body?.quick_reply ?? r.body?.data ?? r.body;
const qrId = qr?.id;
r = await O.json("/api/quick-replies", undefined, "GET");
ok("quick reply list", r.status === 200 && JSON.stringify(r.body).includes("Hello"), JSON.stringify(r.body).slice(0, 200));
if (qrId) {
  r = await O.json(`/api/quick-replies/${qrId}`, { title: "Hello 2", content_text: "Yo" }, "PATCH");
  ok("quick reply update", r.status === 200, JSON.stringify(r));
  r = await O.json(`/api/quick-replies/${qrId}`, undefined, "DELETE");
  ok("quick reply delete", r.status === 200 || r.status === 204, JSON.stringify(r));
}

// automations
r = await O.json("/api/automations", { name: "Welcome", trigger_type: "new_contact", trigger_config: {}, actions: [], steps: [] });
ok("automation create", r.status === 200 || r.status === 201, JSON.stringify(r));
r = await O.json("/api/automations", undefined, "GET");
ok("automation list", r.status === 200 && JSON.stringify(r.body).includes("Welcome"), JSON.stringify(r.body).slice(0, 200));

// flows
r = await O.json("/api/flows", { name: "Support flow", trigger_type: "keyword" });
ok("flow create", r.status === 200 || r.status === 201, JSON.stringify(r));
const flowId = (r.body?.flow ?? r.body?.data ?? r.body)?.id;
r = await O.json("/api/flows", undefined, "GET");
ok("flow list", r.status === 200 && JSON.stringify(r.body).includes("Support flow"));
if (flowId) {
  r = await O.json(`/api/flows/${flowId}`, undefined, "GET");
  ok("flow get", r.status === 200, JSON.stringify(r).slice(0, 200));
  r = await O.json(`/api/flows/${flowId}/runs`, undefined, "GET");
  ok("flow runs list", r.status === 200, JSON.stringify(r).slice(0, 200));
}
r = await O.json("/api/flows/templates", undefined, "GET");
ok("flow templates", r.status === 200);

// API keys + public API v1
r = await O.json("/api/account/api-keys", { name: "ci", scopes: ["contacts:read", "contacts:write", "conversations:read", "messages:read", "messages:send", "webhooks:manage", "broadcasts:send"] });
ok("api key create", r.status === 200 || r.status === 201, JSON.stringify(r));
const rawKey = r.body?.plaintext;
ok("api key shown once", typeof rawKey === "string" && rawKey.startsWith("wacrm_"), JSON.stringify(r.body));
r = await O.json("/api/account/api-keys", undefined, "GET");
ok("api key list (no secret)", r.status === 200 && !JSON.stringify(r.body).includes(rawKey));
const bearer = { headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" } };
async function v1(path, method = "GET", body) {
  const res = await fetch(BASE + path, { method, ...bearer, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}
r = await v1("/api/v1/me");
ok("v1/me with API key", r.status === 200 && r.body?.data?.account?.id === accountId || r.body?.account?.id === accountId, JSON.stringify(r));
r = await fetch(BASE + "/api/v1/me", { headers: { authorization: "Bearer wacrm_live_nope" } });
ok("v1 rejects bad key", r.status === 401);
r = await v1("/api/v1/contacts", "POST", { phone: "+15557770001", name: "API Contact", tags: ["lead"] });
ok("v1 create contact", r.status === 200 || r.status === 201, JSON.stringify(r));
const cid = (r.body?.data ?? r.body)?.id;
r = await v1("/api/v1/contacts?search=API");
ok("v1 search contacts", r.status === 200 && JSON.stringify(r.body).includes("API Contact"), JSON.stringify(r).slice(0, 300));
const leadTag = (await O.db("tags", [["select", "id"], ["eq", "name", "lead"], ["single"]])).body.data;
r = await v1(`/api/v1/contacts?tag=${leadTag.id}`);
ok("v1 filter contacts by tag", r.status === 200 && JSON.stringify(r.body).includes("API Contact"), JSON.stringify(r).slice(0, 300));
if (cid) {
  r = await v1(`/api/v1/contacts/${cid}`, "PATCH", { name: "API Contact 2", tags: ["lead", "vip"] });
  ok("v1 update contact + tags", r.status === 200, JSON.stringify(r));
  r = await v1(`/api/v1/contacts/${cid}`);
  ok("v1 get contact", r.status === 200 && JSON.stringify(r.body).includes("vip"), JSON.stringify(r).slice(0, 300));
}
r = await v1("/api/v1/conversations");
ok("v1 list conversations", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await v1("/api/v1/webhooks", "POST", { url: "https://example.com/hook", events: ["message.received"] });
ok("v1 create webhook", r.status === 200 || r.status === 201, JSON.stringify(r).slice(0, 300));
r = await v1("/api/v1/webhooks");
ok("v1 list webhooks", r.status === 200 && JSON.stringify(r.body).includes("example.com"));
r = await v1("/api/v1/broadcasts", "POST", { template_name: "nope", recipients: [] });
ok("v1 broadcast validates input (no template/recipients -> 4xx, not 5xx)", r.status >= 400 && r.status < 500, JSON.stringify(r).slice(0, 200));

// invitations + members
r = await O.json("/api/account/invitations", { role: "agent", label: "Bob" });
ok("invitation create", r.status === 200 || r.status === 201, JSON.stringify(r));
const invUrl = r.body?.url ?? r.body?.inviteUrl ?? r.body?.invite_url ?? r.body?.link;
const token = r.body?.token ?? (invUrl ? invUrl.split("/").pop() : undefined);
ok("invitation has token", !!token, JSON.stringify(r.body));
r = await anon.json(`/api/invitations/${token}/peek`, undefined, "GET");
ok("invitation peek (anonymous)", r.status === 200, JSON.stringify(r));
r = await M.json("/api/auth/signup", { email: emailM, password: "secret123", fullName: "Mia Member" });
ok("member signs up", r.status === 200);
r = await M.json(`/api/invitations/${token}/redeem`, {});
ok("invitation redeem", r.status === 200, JSON.stringify(r));
r = await M.json("/api/account", undefined, "GET");
ok("member now in owner's account as agent", r.body.account?.id === accountId && r.body.role === "agent", JSON.stringify(r.body));
r = await O.json("/api/account/members", undefined, "GET");
ok("members list has 2", r.status === 200 && JSON.stringify(r.body).includes(emailM) , JSON.stringify(r.body).slice(0, 300));
const mid = (await M.json("/api/auth/me", undefined, "GET")).body.user.id;
r = await M.json("/api/account/api-keys", { name: "nope" });
ok("agent cannot create API keys (role enforced)", r.status === 403, JSON.stringify(r));
r = await M.db("contacts", [["select", "id, name"], ["eq", "account_id", accountId]]);
ok("member can read shared contacts via gateway", Array.isArray(r.body.data) && r.body.data.length >= 1, JSON.stringify(r.body));
r = await O.json(`/api/account/members/${mid}`, { role: "viewer" }, "PATCH");
ok("owner changes member role", r.status === 200, JSON.stringify(r));
r = await M.db("contacts", [["insert", { user_id: mid, account_id: accountId, phone: "+15550009999", name: "Viewer write" }]]);
ok("viewer is read-only (RLS)", !!r.body.error, JSON.stringify(r.body));
r = await O.json(`/api/account/members/${mid}`, undefined, "DELETE");
ok("owner removes member", r.status === 200, JSON.stringify(r));

// AI config, platform, backup, db-config
r = await O.json("/api/ai/config", undefined, "GET");
ok("ai config GET", r.status === 200 && r.body.configured === false, JSON.stringify(r.body));
r = await O.json("/api/ai/config", { provider: "openai", model: "gpt-4o-mini", api_key: "sk-test-123456789", system_prompt: "Be nice", is_active: true });
console.log("INFO  ai config save validates the key against the provider (needs internet) ->", r.status, JSON.stringify(r.body).slice(0, 100));
r = await O.json("/api/ai/usage", undefined, "GET");
ok("ai usage", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/ai/knowledge", undefined, "GET");
ok("ai knowledge list", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/platform/me", undefined, "GET");
ok("platform/me", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/backup", undefined, "GET");
ok("backup (account scope) downloads", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/db-config", undefined, "GET");
ok("db-config is locked to super admin", r.status === 403 || r.status === 401, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/whatsapp/config", undefined, "GET");
ok("whatsapp config GET", r.status === 200, JSON.stringify(r).slice(0, 200));
r = await O.json("/api/whatsapp/templates/sync", {});
console.log("INFO  templates/sync ->", r.status, JSON.stringify(r.body).slice(0, 120));

console.log(`\n${tally.pass} passed, ${tally.fail} failed`);
process.exit(tally.fail ? 1 : 0);
