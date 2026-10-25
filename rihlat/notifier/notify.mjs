// Runs every ~10 minutes on GitHub Actions.
//  1) Pushes an alert when the in-app flight check found a schedule change.
//  2) Sends push notifications for due customer messages — only to the employee who owns the booking.
// Credentials come from GitHub OIDC -> Google Workload Identity (no stored key).
import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

const projectId = process.env.FIREBASE_PROJECT || "naseem-rihlat";
const APP_URL = process.env.APP_URL || "https://abdofawzy8999-svg.github.io/Alnaseem-travel-/rihlat/";
const db = new Firestore({ projectId });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.messaging"] });
const client = await auth.getClient();
const H = 3600e3, now = Date.now();

const kindOf = t => t.kind || "flight";
function schedule(t) {
  const start = t.depUtc, end = t.arrUtc || (kindOf(t) === "flight" ? start + 3 * H : start + H);
  const third = kindOf(t) === "hotel" ? end - H : kindOf(t) === "embassy" ? end + H : end;
  return { d24: [start - 24 * H, start - 4 * H], h4: [start - 4 * H, start], arr: [third, third + 30 * H] };
}
const LABEL = {
  flight: { d24: "تذكير قبل السفر بـ 24 ساعة", h4: "وقت الكاونتر", arr: "الوصول بالسلامة" },
  hotel: { d24: "تذكير الفندق قبلها بيوم", h4: "ميعاد دخول الفندق", arr: "الخروج من الفندق" },
  embassy: { d24: "تذكير ميعاد السفارة قبلها بيوم", h4: "ميعاد السفارة بعد 4 ساعات", arr: "متابعة بعد ميعاد السفارة" }
};
const what = t => kindOf(t) === "flight" ? `${t.from}←${t.to}` : kindOf(t) === "hotel" ? (t.place || "فندق") : (t.place || "سفارة");

/* ---------- push ---------- */
async function tokensFor(email) {
  const s = await db.collection("tokens").where("email", "==", email).get();
  return s.docs.map(d => d.id);
}
async function push(email, title, body, tag) {
  const tokens = await tokensFor(email);
  let ok = 0;
  for (const token of tokens) {
    try {
      await client.request({
        url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, method: "POST",
        data: { message: { token, notification: { title, body },
          webpush: { headers: { Urgency: "high", TTL: String(4 * 3600) },
            notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "badge.png", tag, renotify: true, dir: "rtl", lang: "ar", requireInteraction: true },
            fcm_options: { link: APP_URL + "#queue" } } } }
      });
      ok++;
    } catch (e) {
      const st = e.response && e.response.status, msg = JSON.stringify((e.response && e.response.data) || e.message);
      console.log(`send failed (${st}): ${msg.slice(0, 160)}`);
      if (st === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(msg)) await db.collection("tokens").doc(token).delete().catch(() => {});
    }
  }
  console.log(`push to ${email}: ${ok}/${tokens.length} devices`);
}

const snap = await db.collection("trips").where("depUtc", ">", now - 3 * 24 * H).get();

// 1) schedule changes found by the in-app flight check (runs when the team opens the app ~24h before)
const changesByOwner = {};
for (const d of snap.docs) {
  const t = d.data(), c = t.check;
  if (!c || !c.changed || c.resolved || c.alerted || t.depUtc < now) continue;
  (changesByOwner[t.createdBy] = changesByOwner[t.createdBy] || []).push({ t, check: c, ref: d.ref });
}
for (const [email, list] of Object.entries(changesByOwner)) {
  if (!email) continue;
  const body = list.map(({ t, check }) => `${t.name} · ${t.flightNo}: ${check.status === "cancelled" ? "اتلغت" : `المعاد الجديد ${check.depDate} ${check.depTime}`}`).join("\n");
  await push(email, list.length === 1 ? `⚠️ تغيير في رحلة ${list[0].t.name}` : `⚠️ تغيير في ${list.length} رحلات`, body + "\nافتح التطبيق واعتمد المعاد الجديد", "naseem-change");
  for (const x of list) await x.ref.update({ "check.alerted": now });
}

// 2) due customer messages, grouped by the employee who owns them
const dueByOwner = {};
for (const d of snap.docs) {
  const t = d.data(); if (!t.depUtc) continue;
  const sc = schedule(t);
  for (const k of Object.keys(sc)) {
    const [from, until] = sc[k];
    if ((t.sent && t.sent[k]) || (t.notified && t.notified[k])) continue;
    if (now >= from - 5 * 60e3 && now <= until) (dueByOwner[t.createdBy || ""] = dueByOwner[t.createdBy || ""] || []).push({ ref: d.ref, t, k });
  }
}
const all = Object.values(dueByOwner).flat();
console.log(`trips=${snap.size} due=${all.length}`);
for (const [email, due] of Object.entries(dueByOwner)) {
  if (!email) continue;
  const title = due.length === 1 ? `رسالة واتساب لـ ${due[0].t.name}` : `${due.length} رسايل واتساب للعملاء لازم تتبعت`;
  const body = due.slice(0, 6).map(x => `${x.t.name} · ${LABEL[kindOf(x.t)][x.k]} (${what(x.t)})`).join("\n") + (due.length > 6 ? `\n+${due.length - 6} كمان` : "");
  await push(email, title, body, "naseem-due");
}
if (all.length) {
  const batch = db.batch();
  for (const x of all) batch.update(x.ref, { [`notified.${x.k}`]: now });
  await batch.commit();
}
