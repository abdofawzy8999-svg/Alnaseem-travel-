// Runs every ~10 minutes on GitHub Actions.
//  1) ~24h before each flight, looks the flight up (Gemini + Google Search) and flags schedule changes.
//  2) Sends push notifications for due customer messages — only to the employee who owns the booking.
// Credentials come from GitHub OIDC -> Google Workload Identity (no stored key).
import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

const projectId = process.env.FIREBASE_PROJECT || "naseem-rihlat";
const APP_URL = process.env.APP_URL || "https://abdofawzy8999-svg.github.io/Alnaseem-travel-/rihlat/";
const MODELS = (process.env.CHECK_MODELS || "gemini-flash-latest,gemini-flash-lite-latest").split(",");
const db = new Firestore({ projectId });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.messaging", "https://www.googleapis.com/auth/generative-language"] });
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

/* ---------- Gemini via REST with the service account ---------- */
async function gemini(prompt, { search = false } = {}) {
  let last;
  for (const m of MODELS) {
    try {
      const r = await client.request({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        method: "POST", headers: { "x-goog-user-project": projectId }, timeout: 60000,
        data: { contents: [{ role: "user", parts: [{ text: prompt }] }], ...(search ? { tools: [{ google_search: {} }] } : {}), generationConfig: { temperature: 0 } }
      });
      const c = r.data.candidates && r.data.candidates[0];
      const text = ((c && c.content && c.content.parts) || []).map(p => p.text || "").join("");
      const sources = (((c && c.groundingMetadata && c.groundingMetadata.groundingChunks) || []).map(g => g.web && g.web.uri).filter(Boolean)).slice(0, 3);
      return { text, sources, model: m };
    } catch (e) { last = e; console.log(`gemini ${m} failed: ${JSON.stringify((e.response && e.response.data) || e.message).slice(0, 200)}`); }
  }
  throw last;
}
const parseJson = s => { const m = String(s).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ""); return m ? +m[1] * 60 + +m[2] : null; };

async function checkFlight(t) {
  const prompt = `Search the web for the CURRENT status/schedule of flight ${t.flightNo} (${t.airline || "airline"}) from ${t.from} to ${t.to} departing on ${t.depDate} (local date at ${t.from}).
Prefer the airline's official site and flight trackers (FlightAware, Flightradar24, FlightStats, the airport website).
The booking we have says: depart ${t.depDate} ${t.depTime} local, arrive ${t.arrDate || ""} ${t.arrTime || ""} local.
Reply with ONLY this JSON: {"found": boolean, "status": "on_time"|"delayed"|"cancelled"|"rescheduled"|"unknown", "depDate": "YYYY-MM-DD", "depTime": "HH:MM", "arrDate": "YYYY-MM-DD", "arrTime": "HH:MM", "note": "short Arabic note"}
Times are 24h local times at each airport. "found" is true only if you found schedule information for this exact flight number and date. Never invent times; use "" if unknown.`;
  const { text, sources } = await gemini(prompt, { search: true });
  const r = parseJson(text) || { found: false, status: "unknown" };
  const depChanged = r.found && r.depTime && (r.depDate && r.depDate !== t.depDate || Math.abs(toMin(r.depTime) - toMin(t.depTime)) >= 15);
  const changed = !!(r.found && (r.status === "cancelled" || depChanged));
  return { at: now, found: !!r.found, status: r.status || "unknown", depDate: r.depDate || "", depTime: r.depTime || "", arrDate: r.arrDate || "", arrTime: r.arrTime || "", note: String(r.note || "").slice(0, 300), sources, changed, resolved: false };
}

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

/* ---------- optional manual test: workflow_dispatch input ---------- */
if (process.env.TEST_FLIGHT) {
  const [flightNo, from, to, depDate, depTime] = process.env.TEST_FLIGHT.split("|");
  console.log("TEST", JSON.stringify(await checkFlight({ flightNo, from, to, depDate, depTime, airline: "" })));
}

const snap = await db.collection("trips").where("depUtc", ">", now - 3 * 24 * H).get();

// 1) flight checks (~24h before departure, once)
const changesByOwner = {};
for (const d of snap.docs) {
  const t = d.data();
  if (kindOf(t) !== "flight" || !t.flightNo || t.check) continue;
  const left = t.depUtc - now;
  if (left > 27 * H || left < 3 * H) continue;
  try {
    const check = await checkFlight(t);
    await d.ref.update({ check });
    console.log(`check ${t.flightNo} ${t.depDate}: found=${check.found} status=${check.status} changed=${check.changed}`);
    if (check.changed) (changesByOwner[t.createdBy] = changesByOwner[t.createdBy] || []).push({ t, check });
  } catch (e) { console.log(`check failed for ${t.flightNo}: ${e.message}`); }
}
for (const [email, list] of Object.entries(changesByOwner)) {
  if (!email) continue;
  const body = list.map(({ t, check }) => `${t.name} · ${t.flightNo}: ${check.status === "cancelled" ? "اتلغت" : `المعاد الجديد ${check.depDate} ${check.depTime}`}`).join("\n");
  await push(email, list.length === 1 ? `⚠️ تغيير في رحلة ${list[0].t.name}` : `⚠️ تغيير في ${list.length} رحلات`, body + "\nافتح التطبيق واعتمد المعاد الجديد", "naseem-change");
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
