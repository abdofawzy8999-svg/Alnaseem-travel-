// Runs every ~10 minutes on GitHub Actions. Finds customer messages that are due
// and sends a push notification to every team phone that enabled notifications.
import admin from "firebase-admin";

// Credentials come from GitHub OIDC -> Google Workload Identity (no stored key).
const projectId = process.env.FIREBASE_PROJECT || "naseem-rihlat";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
const db = admin.firestore();
const APP_URL = process.env.APP_URL || "https://abdofawzy8999-svg.github.io/Alnaseem-travel-/rihlat/";
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

let ok = 0;
for (let i = 0; i < tokens.length; i += 500) {
  const chunk = tokens.slice(i, i + 500);
  const res = await admin.messaging().sendEachForMulticast({
    tokens: chunk,
    notification: { title, body },
    webpush: {
      headers: { Urgency: "high", TTL: String(4 * 3600) },
      notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "badge.png", tag: "naseem-due", renotify: true, dir: "rtl", lang: "ar", requireInteraction: true },
      fcmOptions: { link: APP_URL + "#queue" }
    }
  });
  ok += res.successCount;
  const dead = [];
  res.responses.forEach((r, j) => {
    const c = r.error && r.error.code;
    if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token" || c === "messaging/invalid-argument") dead.push(chunk[j]);
  });
  await Promise.all(dead.map(t => db.collection("tokens").doc(t).delete().catch(() => {})));
  if (dead.length) console.log(`removed ${dead.length} dead tokens`);
}
console.log(`sent to ${ok}/${tokens.length} devices`);

// mark as notified so the team isn't pinged again for the same message
const batch = db.batch();
for (const x of due) batch.update(x.ref, { [`notified.${x.k}`]: now });
await batch.commit();
