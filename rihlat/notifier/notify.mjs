// Runs every ~10 minutes on GitHub Actions. Finds customer messages that are due
// and sends a push notification to every team phone that enabled notifications.
// Credentials come from GitHub OIDC -> Google Workload Identity (no stored key).
import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

const projectId = process.env.FIREBASE_PROJECT || "naseem-rihlat";
const APP_URL = process.env.APP_URL || "https://abdofawzy8999-svg.github.io/Alnaseem-travel-/rihlat/";
const db = new Firestore({ projectId });
const H = 3600e3, now = Date.now();
const LABEL = { d24: "تذكير قبل السفر بـ 24 ساعة", h4: "وقت الكاونتر", arr: "الوصول بالسلامة" };

function schedule(t) {
  const arr = t.arrUtc || t.depUtc + 3 * H;
  return { d24: [t.depUtc - 24 * H, t.depUtc - 4 * H], h4: [t.depUtc - 4 * H, t.depUtc], arr: [arr + H, arr + 30 * H] };
}

const snap = await db.collection("trips").where("depUtc", ">", now - 3 * 24 * H).get();
const due = [];
for (const d of snap.docs) {
  const t = d.data(); if (!t.depUtc) continue;
  const sc = schedule(t);
  for (const k of Object.keys(sc)) {
    const [from, until] = sc[k];
    if (t.sent && t.sent[k]) continue;
    if (t.notified && t.notified[k]) continue;
    if (now >= from - 5 * 60e3 && now <= until) due.push({ ref: d.ref, t, k });
  }
}
console.log(`trips=${snap.size} due=${due.length}`);
if (!due.length) process.exit(0);

const tokSnap = await db.collection("tokens").get();
const tokens = tokSnap.docs.map(d => d.id);
const title = due.length === 1 ? `رسالة واتساب لـ ${due[0].t.name}` : `${due.length} رسايل واتساب للعملاء لازم تتبعت`;
const body = due.slice(0, 6).map(x => `${x.t.name} · ${LABEL[x.k]} (${x.t.from}←${x.t.to})`).join("\n") + (due.length > 6 ? `\n+${due.length - 6} كمان` : "");

const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] }).getClient();
let ok = 0;
for (const token of tokens) {
  try {
    await client.request({
      url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      method: "POST",
      data: { message: {
        token,
        notification: { title, body },
        webpush: {
          headers: { Urgency: "high", TTL: String(4 * 3600) },
          notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "badge.png", tag: "naseem-due", renotify: true, dir: "rtl", lang: "ar", requireInteraction: true },
          fcm_options: { link: APP_URL + "#queue" }
        }
      } }
    });
    ok++;
  } catch (e) {
    const st = e.response && e.response.status;
    const msg = JSON.stringify((e.response && e.response.data) || e.message);
    console.log(`send failed (${st}): ${msg.slice(0, 200)}`);
    if (st === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(msg)) await db.collection("tokens").doc(token).delete().catch(() => {});
  }
}
console.log(`sent to ${ok}/${tokens.length} devices`);

// mark as notified so the team isn't pinged again for the same message
const batch = db.batch();
for (const x of due) batch.update(x.ref, { [`notified.${x.k}`]: now });
await batch.commit();
