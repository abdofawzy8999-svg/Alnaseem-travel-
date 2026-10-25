// Runs every ~10 minutes on GitHub Actions.
//  1) ~24h before each flight, checks its live schedule (AeroDataBox) and alerts the owner if it changed.
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

/* ---------- flight check via AeroDataBox (RapidAPI) ---------- */
const ADB_KEY = process.env.AERODATABOX_KEY || "";
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ""); return m ? +m[1] * 60 + +m[2] : NaN; };
const splitLocal = s => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s || ""); return m ? { date: m[1], time: m[2] } : { date: "", time: "" }; };
async function adbFlight(number, date) {
  const r = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=false&dateLocalRole=Departure`,
    { headers: { "X-RapidAPI-Key": ADB_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } });
  if (r.status === 204 || r.status === 404) return [];
  if (!r.ok) throw new Error(`AeroDataBox ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function checkFlight(t) {
  const number = String(t.flightNo || "").replace(/\s+/g, "").toUpperCase();
  const list = await adbFlight(number, t.depDate);
  const f = (list || []).find(x => x.departure && x.departure.airport && x.departure.airport.iata === t.from) || (list || [])[0];
  if (!f) return { at: now, source: "aerodatabox", found: false, status: "unknown", changed: false, resolved: false };
  const sched = splitLocal(f.departure.scheduledTime && f.departure.scheduledTime.local);
  const rev = splitLocal(f.departure.revisedTime && f.departure.revisedTime.local);
  const arrS = splitLocal(f.arrival && (f.arrival.revisedTime || f.arrival.scheduledTime) && (f.arrival.revisedTime || f.arrival.scheduledTime).local);
  const dep = rev.time ? rev : sched;
  const st = String(f.status || "").toLowerCase();
  const cancelled = /cancel/.test(st);
  const diff = dep.time ? Math.abs((dep.date === t.depDate ? 0 : 1440 * Math.sign(dep.date.localeCompare(t.depDate))) + toMin(dep.time) - toMin(t.depTime)) : 0;
  const changed = cancelled || (dep.date && dep.date !== t.depDate) || diff >= 20;
  return { at: now, source: "aerodatabox", found: true, status: cancelled ? "cancelled" : (rev.time && diff >= 20 ? "delayed" : changed ? "rescheduled" : "on_time"),
    depDate: dep.date, depTime: dep.time, arrDate: arrS.date, arrTime: arrS.time,
    note: cancelled ? "الرحلة ظاهرة ملغية على أنظمة الطيران" : changed ? `المعاد على أنظمة الطيران ${dep.date} ${dep.time}` : "المعاد زي ما هو", sources: [`https://www.flightradar24.com/data/flights/${number.toLowerCase()}`],
    changed: !!changed, resolved: false };
}

if (process.env.TEST_FLIGHT && ADB_KEY) {
  const [flightNo, from, depDate, depTime] = process.env.TEST_FLIGHT.split("|");
  console.log("TEST", JSON.stringify(await checkFlight({ flightNo, from, depDate, depTime })));
}

const snap = await db.collection("trips").where("depUtc", ">", now - 3 * 24 * H).get();

// 1) flight checks ~24h before departure (once per flight), then alert on changes
if (ADB_KEY) for (const d of snap.docs) {
  const t = d.data();
  if (kindOf(t) !== "flight" || !t.flightNo || t.check) continue;
  const left = t.depUtc - now;
  if (left > 26 * H || left < 3 * H) continue;
  try { const check = await checkFlight(t); await d.ref.update({ check }); t.check = check; console.log(`check ${t.flightNo} ${t.depDate}: found=${check.found} ${check.status} changed=${check.changed}`); }
  catch (e) { console.log(`check failed ${t.flightNo}: ${e.message}`); }
}
else console.log("AERODATABOX_KEY not set: flight checks skipped");
const changesByOwner = {};
for (const d of (await db.collection("trips").where("depUtc", ">", now).get()).docs) {
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
