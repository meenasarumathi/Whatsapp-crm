import crypto from "node:crypto";
import pg from "pg";
import { Session, ok, tally, BASE } from "./lib.mjs";

const stamp = Date.now();
const O = new Session();
let r = await O.json("/api/auth/signup", { email: `wh${stamp}@example.com`, password: "secret123", fullName: "Webhook Owner" });
ok("owner signs up", r.status === 200);
const me = (await O.json("/api/auth/me", undefined, "GET")).body.user;
const prof = (await O.db("profiles", [["select", "account_id"], ["eq", "user_id", me.id], ["single"]])).body.data;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:strong_password@127.0.0.1:5433/wacrm" });
const pnid = `pn${stamp}`;
function encryptToken(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.ENCRYPTION_KEY, "hex"), iv);
  const enc = c.update(text, "utf8", "hex") + c.final("hex");
  return `${iv.toString("hex")}:${enc}:${c.getAuthTag().toString("hex")}`;
}
await pool.query("INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token, status, mirror_inbound_media) VALUES ($1,$2,$3,$4,'connected', false)", [me.id, prof.account_id, pnid, encryptToken("EAAtoken")]);

async function post(payload, secret = process.env.META_APP_SECRET || "x") {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const res = await fetch(BASE + "/api/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });
  return res.status;
}
const waId = `1555${String(stamp).slice(-7)}`;
const wamid = `wamid.${stamp}`;
const payload = (id, text) => ({ object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: pnid }, contacts: [{ profile: { name: "Dana Customer" }, wa_id: waId }], messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });

let st = await post(payload(wamid, "Hi, is this open?"), "wrong-secret");
ok("bad signature is rejected", st === 401 || st === 403, String(st));
st = await post(payload(wamid, "Hi, is this open?"));
ok("signed inbound message accepted", st === 200, String(st));
await new Promise((r) => setTimeout(r, 1500));

let c = (await O.db("contacts", [["select", "id, name, phone, wa_user_id"], ["eq", "phone_normalized", waId]])).body;
ok("contact auto-created from inbound", c.data?.length === 1 && c.data[0].name === "Dana Customer", JSON.stringify(c));
const conv = (await O.db("conversations", [["select", "id, unread_count, last_message_text, status"], ["eq", "contact_id", c.data[0].id], ["single"]])).body;
ok("conversation created with unread=1", conv.data?.unread_count === 1 && conv.data?.last_message_text === "Hi, is this open?", JSON.stringify(conv));
let msgs = (await O.db("messages", [["select", "id, sender_type, content_text, message_id"], ["eq", "conversation_id", conv.data.id]])).body.data;
ok("message stored once", msgs.length === 1 && msgs[0].sender_type === "customer" && msgs[0].message_id === wamid, JSON.stringify(msgs));

st = await post(payload(wamid, "Hi, is this open?"));
await new Promise((r) => setTimeout(r, 800));
msgs = (await O.db("messages", [["select", "id"], ["eq", "conversation_id", conv.data.id]])).body.data;
const conv2 = (await O.db("conversations", [["select", "unread_count"], ["eq", "id", conv.data.id], ["single"]])).body.data;
ok("replayed delivery is idempotent (no dup message, no unread bump)", msgs.length === 1 && conv2.unread_count === 1, JSON.stringify({ msgs: msgs.length, unread: conv2.unread_count }));

st = await post(payload(wamid + "b", "Second message"));
await new Promise((r) => setTimeout(r, 1000));
const conv3 = (await O.db("conversations", [["select", "unread_count, last_message_text"], ["eq", "id", conv.data.id], ["single"]])).body.data;
ok("second message bumps unread atomically (rpc)", conv3.unread_count === 2 && conv3.last_message_text === "Second message", JSON.stringify(conv3));

// status update
const statusPayload = { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: pnid }, statuses: [{ id: wamid + "b", status: "read", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: waId }] } }] }] };
st = await post(statusPayload);
ok("status webhook accepted", st === 200);

// webhook verification handshake
await pool.query("UPDATE whatsapp_config SET verify_token='vt123' WHERE phone_number_id=$1", [pnid]);
const vres = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt123&hub.challenge=777`);
console.log("INFO  verify handshake ->", vres.status, (await vres.text()).slice(0, 40));

// inbound image mirrored to disk is covered by unit tests (needs Meta); here the dispatch of outbound webhooks etc. is skipped
await pool.end();
console.log(`\n${tally.pass} passed, ${tally.fail} failed`);
process.exit(tally.fail ? 1 : 0);
