const CFG = self.NASEEM, V = CFG.sdk;
// load all SDK modules in parallel (was one after another = slow start on mobile data)
const SDK = n => import(`https://www.gstatic.com/firebasejs/${V}/firebase-${n}.js`);
const [{ initializeApp }, A, F, M, AC] = await Promise.all(["app", "auth", "firestore", "messaging", "app-check"].map(SDK));

const app = initializeApp(CFG.firebase);
if (CFG.recaptchaKey) try { AC.initializeAppCheck(app, { provider: new AC.ReCaptchaEnterpriseProvider(CFG.recaptchaKey), isTokenAutoRefreshEnabled: true }); } catch (e) { console.warn("app check", e); }
const auth = A.getAuth(app);
const db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CAIRO = "Africa/Cairo";
const ADMIN = CFG.ownerEmail.toLowerCase();
const COMPANY_WA = CFG.companyWhatsApp;
const H = 3600e3;

/* ---------------- AI (Gemini via Firebase AI Logic) ---------------- */
const aiModels = {};
let AIMOD = null;
async function getModel(name) {
  if (aiModels[name]) return aiModels[name];
  AIMOD = AIMOD || await SDK("ai");
  const ai = AIMOD.getAI(app, { backend: new AIMOD.GoogleAIBackend() });
  return aiModels[name] = AIMOD.getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: "application/json", temperature: 0 } }, { timeout: 30000 });
}
// hard time limits: the SDK timeout doesn't always fire on mobile, so we race it ourselves
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms)), ms))]);
async function generateWithFallback(parts, deadlineMs = 75000) {
  const names = (CFG.aiModels || ["gemini-flash-lite-latest", "gemini-flash-latest"]).filter(n => !/3\.8/.test(n));
  const end = Date.now() + deadlineMs;
  let lastErr;
  for (const name of names) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = end - Date.now(); if (left < 3000) throw lastErr || new Error("timeout");
      try { const m = await withTimeout(getModel(name), 15000); return await withTimeout(m.generateContent(parts), Math.min(35000, left)); }
      catch (e) {
        lastErr = e; const msg = String(e && e.message || "");
        if (/\[404|no longer available|not found|abort|timeout/i.test(msg)) break;
        if (/\[(429|500|503)|high demand|overloaded|unavailable/i.test(msg)) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw e;
      }
    }
  }
  throw lastErr;
}
// warm up the AI module in the background so the first read starts faster
function warmAI() { setTimeout(() => { getModel((CFG.aiModels || ["gemini-flash-lite-latest"])[0]).catch(() => {}); }, 2500); }

/* ---------------- flight check (~24h before, Gemini + Google Search) ---------------- */
const searchModels = {};
async function getSearchModel(name) {
  if (searchModels[name]) return searchModels[name];
  AIMOD = AIMOD || await import(`https://www.gstatic.com/firebasejs/${V}/firebase-ai.js`);
  const ai = AIMOD.getAI(app, { backend: new AIMOD.GoogleAIBackend() });
  return searchModels[name] = AIMOD.getGenerativeModel(ai, { model: name, tools: [{ googleSearch: {} }], generationConfig: { temperature: 0 } }, { timeout: 60000 });
}
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ""); return m ? +m[1] * 60 + +m[2] : NaN; };
async function lookupFlight(t) {
  const prompt = `Search the web for the CURRENT status/schedule of flight ${t.flightNo} (${t.airline || "airline"}) from ${t.from} to ${t.to} departing on ${t.depDate} (local date at ${t.from}).
Prefer the airline's official website and flight trackers (FlightAware, Flightradar24, FlightStats, airport websites).
Our booking says: depart ${t.depDate} ${t.depTime} local, arrive ${t.arrDate || ""} ${t.arrTime || ""} local.
Reply with ONLY this JSON and nothing else: {"found": boolean, "status": "on_time"|"delayed"|"cancelled"|"rescheduled"|"unknown", "depDate": "YYYY-MM-DD", "depTime": "HH:MM", "arrDate": "YYYY-MM-DD", "arrTime": "HH:MM", "note": "short note in Egyptian Arabic"}
Times are 24h local times at each airport. "found" is true only if you found schedule information for this exact flight number on this date. Never invent times; use "" if unknown.`;
  let last;
  for (const name of (CFG.searchModels || ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.8-flash"])) {
    try {
      const m = await getSearchModel(name);
      const res = await m.generateContent(prompt);
      const txt = res.response.text();
      const j = txt.match(/\{[\s\S]*\}/); const r = j ? JSON.parse(j[0]) : { found: false };
      const cand = res.response.candidates && res.response.candidates[0];
      const sources = ((cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []).map(g => g.web && g.web.uri).filter(Boolean).slice(0, 3);
      const depChanged = r.found && r.depTime && ((r.depDate && r.depDate !== t.depDate) || Math.abs(toMin(r.depTime) - toMin(t.depTime)) >= 15);
      return { at: Date.now(), by: myEmail, found: !!r.found, status: r.status || "unknown", depDate: r.depDate || "", depTime: r.depTime || "", arrDate: r.arrDate || "", arrTime: r.arrTime || "",
        note: String(r.note || "").slice(0, 300), sources, changed: !!(r.found && (r.status === "cancelled" || depChanged)), resolved: false };
    } catch (e) { last = e; console.warn("flight check", name, e); }
  }
  throw last;
}
const checking = new Set(), checkFailed = new Set();
let checkRunning = false;
async function autoCheckFlights() {
  if (!CFG.inAppFlightCheck || checkRunning || !loaded) return;
  const now = Date.now();
  const todo = trips.filter(t => kindOf(t) === "flight" && t.flightNo && !t.check && !checking.has(t.id) && !checkFailed.has(t.id)
    && t.depUtc - now < 30 * H && t.depUtc - now > 2 * H && (isAdmin || t.createdBy === myEmail));
  if (!todo.length) return;
  checkRunning = true;
  try {
    for (const t of todo) {
      checking.add(t.id); render();
      try { const check = await lookupFlight(t); await F.updateDoc(F.doc(db, "trips", t.id), { check }); if (check.changed) toast(`⚠️ فيه تغيير في رحلة ${t.name}`); }
      catch (e) { console.warn(e); checkFailed.add(t.id); if (/429|quota/i.test(String(e && e.message))) { todo.forEach(x => checkFailed.add(x.id)); break; } }
      finally { checking.delete(t.id); }
    }
  } finally { checkRunning = false; render(); }
}
setInterval(autoCheckFlights, 5 * 60000);

/* ---------------- views ---------------- */
function show(id) { ["v-boot", "v-login", "v-wait", "v-app"].forEach(v => $("#" + v).hidden = v !== id); }
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4500); }
function setTab(name) {
  ["queue", "add", "trips", "settings"].forEach(n => { $("#t-" + n).hidden = n !== name; });
  document.querySelectorAll(".nav button").forEach(b => { if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  $("#scope-box").hidden = !isAdmin || !(name === "queue" || name === "trips");
  scrollTo({ top: 0 });
  try { history.replaceState(null, "", "#" + name); } catch (_) {}
}
document.querySelectorAll(".nav button").forEach(b => b.onclick = () => setTab(b.dataset.tab));

/* ---------------- auth ---------------- */
const authErr = e => {
  const c = e && e.code || "";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "الإيميل أو كلمة السر غلط.";
  if (c.includes("email-already-in-use")) return "الإيميل ده عليه حساب بالفعل. دوس «دخول».";
  if (c.includes("weak-password")) return "كلمة السر لازم 6 حروف على الأقل.";
  if (c.includes("invalid-email")) return "الإيميل مكتوب غلط.";
  if (c.includes("network")) return "مفيش إنترنت. جرّب تاني.";
  return "الدخول ماتمّش (" + c + ").";
};
$("#g-login").onclick = async () => {
  $("#l-st").textContent = "";
  const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
  try { await A.signInWithPopup(auth, p); }
  catch (e) {
    if ((e.code || "").includes("popup-blocked") || (e.code || "").includes("operation-not-supported")) { try { await A.signInWithRedirect(auth, p); return; } catch (e2) { e = e2; } }
    $("#l-st").textContent = authErr(e);
  }
};
const creds = () => [$("#l-email").value.trim(), $("#l-pass").value];
$("#e-login").onclick = async () => { $("#l-st").textContent = ""; try { await A.signInWithEmailAndPassword(auth, ...creds()); } catch (e) { $("#l-st").textContent = authErr(e); } };
$("#e-signup").onclick = async () => { $("#l-st").textContent = ""; try { await A.createUserWithEmailAndPassword(auth, ...creds()); } catch (e) { $("#l-st").textContent = authErr(e); } };
document.addEventListener("click", e => { if (e.target.closest("[data-logout]")) A.signOut(auth); });
A.getRedirectResult(auth).catch(e => { $("#l-st").textContent = authErr(e); });

let me = null, myEmail = "", isAdmin = false, unsubTrips = null, unsubTeam = null;
A.onAuthStateChanged(auth, async user => {
  me = user; if (unsubTrips) { unsubTrips(); unsubTrips = null; } if (unsubTeam) { unsubTeam(); unsubTeam = null; }
  if (!user) { show("v-login"); return; }
  myEmail = (user.email || "").toLowerCase();
  isAdmin = myEmail === ADMIN && user.emailVerified;
  $("#me-email").textContent = myEmail;
  $("#w-email").textContent = myEmail;
  show("v-app"); afterEnter();
  startData(); warmAI();
});
$("#w-retry").onclick = () => { if (me) startData(); };

/* ---------------- time helpers ---------------- */
function tzOffset(ts, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const g = t => +p.find(x => x.type === t).value;
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - ts;
}
function localToUtc(date, time, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{1,2}:\d{2}$/.test(time || "")) return null;
  const [y, m, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const ts = guess - tzOffset(guess, tz || CAIRO);
  return guess - tzOffset(ts, tz || CAIRO);
}
const validTz = z => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return !!z; } catch (_) { return false; } };
const fmtCairo = (ts, opt) => new Intl.DateTimeFormat("ar-EG", Object.assign({ timeZone: CAIRO }, opt)).format(new Date(ts));
const fmtDay = ts => fmtCairo(ts, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = ts => fmtCairo(ts, { hour: "numeric", minute: "2-digit" });
const fmtFull = ts => fmtCairo(ts, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
function fmtLocal(date, time) {
  if (!date) return { d: "", t: "" };
  const ts = Date.UTC(...date.split("-").map((v, i) => i === 1 ? v - 1 : +v), ...(time || "00:00").split(":").map(Number));
  return {
    d: new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(ts)),
    t: time ? new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(ts)) : ""
  };
}
function rel(ms) {
  const a = Math.abs(ms), h = Math.floor(a / 3600000), m = Math.round((a % 3600000) / 60000);
  const s = h ? (h + " س" + (m ? " و" + m + " د" : "")) : (m + " دقيقة");
  return ms >= 0 ? "بعد " + s : "من " + s;
}

/* ---------------- airports / zones ---------------- */
const AIRPORT_TZ = { CAI: "Africa/Cairo", HBE: "Africa/Cairo", SPX: "Africa/Cairo", HRG: "Africa/Cairo", SSH: "Africa/Cairo", LXR: "Africa/Cairo", ASW: "Africa/Cairo", ATZ: "Africa/Cairo", HMB: "Africa/Cairo", RMF: "Africa/Cairo", ALY: "Africa/Cairo",
  JED: "Asia/Riyadh", RUH: "Asia/Riyadh", MED: "Asia/Riyadh", DMM: "Asia/Riyadh", TIF: "Asia/Riyadh", AHB: "Asia/Riyadh", ELQ: "Asia/Riyadh", TUU: "Asia/Riyadh", YNB: "Asia/Riyadh", GIZ: "Asia/Riyadh", HAS: "Asia/Riyadh", AJF: "Asia/Riyadh", ULH: "Asia/Riyadh", HOF: "Asia/Riyadh", NUM: "Asia/Riyadh",
  DXB: "Asia/Dubai", AUH: "Asia/Dubai", SHJ: "Asia/Dubai", DWC: "Asia/Dubai", RKT: "Asia/Dubai", KWI: "Asia/Kuwait", DOH: "Asia/Qatar", BAH: "Asia/Bahrain", MCT: "Asia/Muscat", SLL: "Asia/Muscat", AMM: "Asia/Amman", IST: "Europe/Istanbul", SAW: "Europe/Istanbul", BEY: "Asia/Beirut",
  TAS: "Asia/Tashkent", SKD: "Asia/Tashkent", ALA: "Asia/Almaty", NQZ: "Asia/Almaty", BKK: "Asia/Bangkok", KUL: "Asia/Kuala_Lumpur", CMN: "Africa/Casablanca", TUN: "Africa/Tunis", KRT: "Africa/Khartoum", LHR: "Europe/London", CDG: "Europe/Paris", FCO: "Europe/Rome" };
const TZ_OPTS = [["Africa/Cairo", "مصر"], ["Asia/Riyadh", "السعودية"], ["Asia/Dubai", "الإمارات"], ["Asia/Kuwait", "الكويت"], ["Asia/Qatar", "قطر"], ["Asia/Bahrain", "البحرين"], ["Asia/Muscat", "عُمان"], ["Asia/Amman", "الأردن"], ["Europe/Istanbul", "تركيا"], ["Asia/Beirut", "لبنان"], ["Asia/Tashkent", "أوزبكستان"], ["Asia/Almaty", "كازاخستان"], ["Asia/Bangkok", "تايلاند"], ["Asia/Kuala_Lumpur", "ماليزيا"], ["Africa/Casablanca", "المغرب"], ["Africa/Tunis", "تونس"], ["Africa/Khartoum", "السودان"], ["Europe/London", "بريطانيا"], ["Europe/Paris", "فرنسا"], ["Europe/Rome", "إيطاليا"]];

/* ---------------- phone ---------------- */
function normPhone(raw) {
  let p = String(raw || "").replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("00")) p = p.slice(2);
  if (/^01\d{9}$/.test(p)) p = "20" + p.slice(1);
  else if (/^05\d{8}$/.test(p)) p = "966" + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = "966" + p;
  return /^\d{10,15}$/.test(p) ? p : null;
}

/* ---------------- kinds, schedule, messages ---------------- */
const kindOf = t => t.kind || "flight";
const KIND_NAME = { flight: "طيران", hotel: "فندق", embassy: "سفارة" };
const KEYS = ["d24", "h4", "arr"];
const LABELS = {
  flight: { d24: ["تذكير قبل السفر بـ 24 ساعة", "قبل 24 س"], h4: ["وقت الكاونتر (قبل الإقلاع بـ 4 ساعات)", "الكاونتر"], arr: ["الوصول بالسلامة (لحظة النزول)", "الوصول"] },
  hotel: { d24: ["تذكير الفندق قبلها بيوم", "قبل 24 س"], h4: ["ميعاد دخول الفندق (قبلها بـ 4 ساعات)", "الدخول"], arr: ["الخروج من الفندق", "الخروج"] },
  embassy: { d24: ["تذكير ميعاد السفارة قبلها بيوم", "قبل 24 س"], h4: ["ميعاد السفارة بعد 4 ساعات", "قبل 4 س"], arr: ["متابعة بعد الميعاد", "متابعة"] }
};
function schedule(t) {
  const k = kindOf(t), start = t.depUtc, end = t.arrUtc || (k === "flight" ? start + 3 * H : start + H);
  const third = k === "hotel" ? end - H : k === "embassy" ? end + H : end;
  return { d24: { due: start - 24 * H, until: start - 4 * H }, h4: { due: start - 4 * H, until: start }, arr: { due: third, until: third + 30 * H } };
}
function stateOf(t, k, now) {
  const sc = schedule(t)[k];
  if (t.sent && t.sent[k]) return "sent";
  if (now < sc.due) return "wait";
  if (now <= sc.until) return "due";
  return "late";
}
const titleOf = t => kindOf(t) === "flight" ? `${t.from} ← ${t.to}${t.flightNo ? " · " + t.flightNo : ""}` : `${t.place || KIND_NAME[kindOf(t)]}${t.city ? " · " + t.city : ""}`;
const SLOGAN = "النسيم ترافل نسيمك لعالم اسهل";
const COMPANIONS = [["", "لوحده"], ["family", "عيلة (مش متأكد مين)"], ["spouse", "مع زوجته / زوجها"], ["kids", "مع أطفال"], ["spouse_kids", "زوج وزوجة وأطفال"], ["parent_child", "أب أو أم مع ابن / بنت"]];
const isTasheer = t => /tasheer|tasahel|تأشير|تاشير|تساهيل/i.test((t.place || "") + " " + (t.address || ""));
function tasheerBranch(t) {
  const s = ((t.address || "") + " " + (t.place || "") + " " + (t.city || "")).toLowerCase();
  if (/katam|kattam|قطامي/.test(s)) return "القطامية";
  if (/mohand|مهندس/.test(s)) return "المهندسين";
  if (/zayed|zayid|زايد/.test(s)) return "الشيخ زايد";
  if (/sohag|suhag|سوهاج/.test(s)) return "سوهاج";
  if (/alex|اسكندري|إسكندري/.test(s)) return "الإسكندرية";
  return t.address || "";
}
const BRANCH_MAPS = { "الشيخ زايد": "https://maps.app.goo.gl/tMzGRVhczX8i1kDN8", "المهندسين": "https://maps.app.goo.gl/5NMtCQz3sB8t1PD26", "سوهاج": "https://maps.app.goo.gl/89PDpKtBZhW6LVW37", "القطامية": "https://maps.app.goo.gl/Wc4fDDUepmV9irCw5" };
function mapsLink(t) {
  const br = tasheerBranch(t);
  if (isTasheer(t) && BRANCH_MAPS[br]) return BRANCH_MAPS[br];
  const q = isTasheer(t) ? `Tasheer Saudi Visa Center ${t.address || br || t.city || ""} Egypt` : [t.place, t.address, t.city].filter(Boolean).join(" ");
  return q.trim() ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : "";
}
function familyDocs(c) {
  const sp = "✅ قسيمة زواج موثقة", kd = "✅ شهادة ميلاد موثقة لكل طفل", pc = "✅ شهادة ميلاد موثقة للابن / البنت";
  if (c === "spouse") return [sp];
  if (c === "kids") return [kd];
  if (c === "spouse_kids") return [sp, kd];
  if (c === "parent_child") return [pc];
  if (c === "family") return ["👨‍👩‍👧 لو مسافرين كعيلة:", "• زوج وزوجة: قسيمة زواج موثقة", "• مع أطفال: شهادة ميلاد موثقة لكل طفل", "• أب أو أم مع الابن: شهادة ميلاد موثقة للابن"];
  return [];
}
function msgText(t, k) { return msgBody(t, k).trimEnd() + "\n" + SLOGAN; }
function msgBody(t, k) {
  const first = "أ/ " + ((t.name || "").trim().split(/\s+/)[0] || "");
  const um = t.type === "umrah", kind = kindOf(t);
  const st = fmtLocal(t.depDate, t.depTime), en = fmtLocal(t.arrDate, t.arrTime);
  const sign = `للتواصل: ${COMPANY_WA}`;
  if (kind === "hotel") {
    if (k === "d24") return `أهلاً ${first} 👋\nمعاك النسيم ترافيل 🏨\nتذكير بحجزك بكره:\n\n🏨 ${t.place || "الفندق"}${t.city ? " - " + t.city : ""}\n📅 الدخول: ${st.d}${st.t ? " من الساعة " + st.t : ""}\n📅 الخروج: ${en.d}${en.t ? " الساعة " + en.t : ""}${t.ref ? "\n📌 رقم الحجز: " + t.ref : ""}\n\nخلي معاك الباسبور وتأكيد الحجز.\nإقامة سعيدة 🌷\n${sign}`;
    if (k === "h4") return `أهلاً ${first} 🏨\nفاضل حوالي 4 ساعات على ميعاد دخولك فندق ${t.place || ""} ⏰\n${t.ref ? "📌 رقم الحجز: " + t.ref + "\n" : ""}لو حصلت أي مشكلة في الاستلام كلمنا فوراً: ${COMPANY_WA}\nالنسيم ترافيل`;
    return `أهلاً ${first} 🌷\nتذكير: ميعاد تسجيل الخروج من فندق ${t.place || ""} النهارده${en.t ? " الساعة " + en.t : ""}.\nنتمنى تكون إقامتك كانت مريحة 🙏\nلو محتاج تمديد أو مواصلات للمطار إحنا معاك: ${COMPANY_WA}\nويسعدنا تقييمك لخدمتنا 💙\n${sign}`;
  }
  if (kind === "embassy" && isTasheer(t)) {
    const br = tasheerBranch(t), loc = mapsLink(t);
    const docs = ["✅ أصل جواز السفر", "✅ أصل كشف الحساب البنكي", "✅ تأكيد موعد تأشير", "✅ ملف إنجاز", "✅ إيصال سداد ملف إنجاز", "✅ حجز الفندق المبدئي", "✅ حجز الطيران المبدئي", "✅ كارت بنكي (فيزا) لدفع 700 جنيه رسوم توصيل الجواز للمنزل", ...familyDocs(t.companions)];
    if (k === "d24") return `أهلاً ${first} 👋\nمعاك النسيم ترافيل\nتذكير بميعادك في مركز تأشير بكره:\n\n🏛️ تأشير${br ? " - فرع " + br : ""}\n📅 ${st.d}\n🕐 الساعة ${st.t}${t.ref ? "\n📌 رقم الميعاد: " + t.ref : ""}${loc ? "\n📍 اللوكيشن: " + loc : ""}\n\n📝 تأكد من طباعة الأوراق التالية بشكل واضح:\n${docs.join("\n")}\n\n⏳ لازم توصل قبل الميعاد بربع ساعة\n⚠️ لو اتأخرت عن ميعادك هتدخل «موعد مميز» وتدفع رسوم إضافية\n\nربنا يوفقك 🌷\n${sign}`;
    if (k === "h4") return `أهلاً ${first} 🏛️\nفاضل حوالي 4 ساعات على ميعادك في تأشير${br ? " فرع " + br : ""} (الساعة ${st.t}) ⏰\nلازم توصل قبل الميعاد بربع ساعة، لأن التأخير معناه «موعد مميز» برسوم إضافية.${loc ? "\n📍 اللوكيشن: " + loc : ""}\n\nاتأكد إن معاك مطبوع: الباسبور الأصلي، كشف الحساب الأصلي، ملف إنجاز وإيصال السداد، حجز الفندق والطيران المبدئي، والكارت البنكي لرسوم توصيل الجواز (700 جنيه)${familyDocs(t.companions).length ? "، وأوراق العيلة الموثقة" : ""}.\nلو احتجت أي حاجة كلمنا: ${COMPANY_WA}\nالنسيم ترافيل`;
    return `أهلاً ${first} 🌷\nنتمنى يكون ميعادك في تأشير عدّى على خير 🙏\nهنتابع معاك التأشيرة أول بأول، ولو فيه أي أوراق ناقصة إحنا معاك: ${COMPANY_WA}\n${sign}`;
  }
  if (kind === "embassy") {
    if (k === "d24") return `أهلاً ${first} 👋\nمعاك النسيم ترافيل\nتذكير بميعادك بكره:\n\n🏛️ ${t.place || "السفارة"}${t.city ? " - " + t.city : ""}\n📅 ${st.d}\n🕐 الساعة ${st.t}${t.ref ? "\n📌 رقم الميعاد: " + t.ref : ""}\n\nجهّز معاك:\n✅ الباسبور الأصلي\n✅ كل الأوراق والصور المطلوبة\n✅ تأكيد الميعاد مطبوع\n⏳ يُفضّل توصل قبل الميعاد بنص ساعة\n\nربنا يوفقك 🌷\n${sign}`;
    if (k === "h4") return `أهلاً ${first} 🏛️\nفاضل حوالي 4 ساعات على ميعادك في ${t.place || "السفارة"} (الساعة ${st.t}) ⏰\nاتأكد إن الباسبور والأوراق معاك.\nلو احتجت أي حاجة كلمنا: ${COMPANY_WA}\nالنسيم ترافيل`;
    return `أهلاً ${first} 🌷\nنتمنى يكون ميعادك في ${t.place || "السفارة"} عدّى على خير 🙏\nلو فيه أي أوراق ناقصة أو محتاج متابعة إحنا معاك: ${COMPANY_WA}\n${sign}`;
  }
  const route = t.from + " ← " + t.to;
  const fl = [t.airline, t.flightNo].filter(Boolean).join(" ");
  if (k === "d24") return `أهلاً ${first} 👋\nمعاك النسيم ترافيل ✈️\nتذكير برحلتك بكره:\n\n✈️ ${route}${fl ? " (" + fl + ")" : ""}\n📅 ${st.d}\n🕐 الإقلاع ${st.t} بتوقيت ${t.from}${t.ref || t.pnr ? "\n📌 رقم الحجز: " + (t.ref || t.pnr) : ""}\n\nبرجاء التأكد من:\n✅ جواز السفر ساري\n✅ ${um ? "تأشيرة العمرة وتصريح نُسُك" : "التأشيرة"} وصورة التذكرة معاك\n⏳ يُفضّل الوصول للمطار قبل الإقلاع بـ 3 ساعات\n\nرحلة سعيدة 🌷\n${sign}`;
  if (k === "h4") return `أهلاً ${first} ✈️\nفاضل حوالي 4 ساعات على إقلاع رحلتك${fl ? " " + fl : ""} ⏰\nده وقت التوجّه للمطار والكاونتر.\n\n✅ الباسبور والتذكرة${um ? " وتصريح نُسُك" : ""} في إيدك\n✅ الشنطة في الوزن المسموح\n\nلو احتجت أي حاجة في المطار كلمنا فوراً: ${COMPANY_WA}\nتوصل بالسلامة 🌷\nالنسيم ترافيل`;
  return `حمد الله على السلامة يا ${first} 🌷\nنتمنى تكون وصلت ${t.to} بالسلامة ورحلتك كانت مريحة ✈️\n${um ? "تقبّل الله منك صالح الأعمال، ومتنساناش من دعائك 🤲\n" : ""}\nلو محتاج أي خدمة وأنت هناك إحنا معاك: ${COMPANY_WA}\nويسعدنا جداً تقييمك لخدمتنا على صفحتنا 💙\n${sign}`;
}
/* first message, sent right after saving: all booking details in one message */
function confirmText(list) {
  const t0 = list[0] || {};
  const first = "أ/ " + ((t0.name || "").trim().split(/\s+/)[0] || "");
  const um = t0.type === "umrah";
  const blocks = list.map(t => {
    const k = kindOf(t), st = fmtLocal(t.depDate, t.depTime), en = fmtLocal(t.arrDate, t.arrTime);
    if (k === "hotel") return `🏨 ${t.place || "الفندق"}${t.city ? " - " + t.city : ""}\n📅 الدخول: ${st.d}${st.t ? " من الساعة " + st.t : ""}\n📅 الخروج: ${en.d}${en.t ? " الساعة " + en.t : ""}${t.ref ? "\n📌 رقم الحجز: " + t.ref : ""}`;
    if (k === "embassy") {
      const tas = isTasheer(t), br = tas ? tasheerBranch(t) : "", loc = mapsLink(t);
      return `🏛️ ${tas ? "تأشير" + (br ? " - فرع " + br : "") : (t.place || "السفارة") + (t.city ? " - " + t.city : "")}\n📅 ${st.d} الساعة ${st.t}${t.ref ? "\n📌 رقم الميعاد: " + t.ref : ""}${loc ? "\n📍 اللوكيشن: " + loc : ""}`;
    }
    const fl = [t.airline, t.flightNo].filter(Boolean).join(" ");
    return `✈️ ${t.from} ← ${t.to}${fl ? " (" + fl + ")" : ""}\n📅 ${st.d}\n🕐 الإقلاع ${st.t} بتوقيت ${t.from}${en.t ? " – الوصول " + en.t + (t.arrDate && t.arrDate !== t.depDate ? " (" + en.d + ")" : "") : ""}${t.ref ? "\n📌 رقم الحجز: " + t.ref : ""}`;
  });
  const tas = list.find(t => kindOf(t) === "embassy" && isTasheer(t));
  const docs = tas ? `\n\n📝 تأكد من طباعة الأوراق التالية بشكل واضح:\n✅ أصل جواز السفر\n✅ أصل كشف الحساب البنكي\n✅ تأكيد موعد تأشير\n✅ ملف إنجاز\n✅ إيصال سداد ملف إنجاز\n✅ حجز الفندق المبدئي\n✅ حجز الطيران المبدئي\n✅ كارت بنكي (فيزا) لدفع 700 جنيه رسوم توصيل الجواز للمنزل${familyDocs(tas.companions).length ? "\n" + familyDocs(tas.companions).join("\n") : ""}\n⏳ لازم توصل قبل الميعاد بربع ساعة\n⚠️ لو اتأخرت عن ميعادك هتدخل «موعد مميز» وتدفع رسوم إضافية` : "";
  return `أهلاً ${first} 👋\nمعاك النسيم ترافيل ✅\nتم تأكيد ${list.length > 1 ? "حجوزاتك" : "حجزك"}${um ? " للعمرة 🕋" : ""}، ودي التفاصيل:\n\n${blocks.join("\n\n")}${docs}\n\nلو عندك أي استفسار إحنا معاك 🌷\nللتواصل: ${COMPANY_WA}\n${SLOGAN}`;
}
const waLink = (t, k) => "https://wa.me/" + t.phone + "?text=" + encodeURIComponent(msgText(t, k));

/* ---------------- data ---------------- */
let trips = [], loaded = false, team = {}, scope = "me";
function startData() {
  if (unsubTrips) unsubTrips();
  const since = Date.now() - 10 * 86400e3;
  const q = isAdmin
    ? F.query(F.collection(db, "trips"), F.where("depUtc", ">", since), F.orderBy("depUtc"))
    : F.query(F.collection(db, "trips"), F.where("createdBy", "==", myEmail), F.where("depUtc", ">", since), F.orderBy("depUtc"));
  unsubTrips = F.onSnapshot(q, snap => {
    trips = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    loaded = true; show("v-app"); afterEnter(); render(); autoCheckFlights();
  }, err => {
    console.warn(err);
    if (err.code === "permission-denied") show("v-wait");
    else { show("v-app"); $("#queue").innerHTML = `<div class="empty">مش قادرين نحمّل البيانات دلوقتي. اتأكد من الإنترنت.</div>`; }
  });
}
let entered = false;
function afterEnter() {
  if (entered) return; entered = true;
  $("#team-box").hidden = !isAdmin;
  if (isAdmin) watchTeam();
  const startTab = (location.hash || "#queue").slice(1);
  setTab(["queue", "add", "trips", "settings"].includes(startTab) ? startTab : "queue");
  setupPushUi();
  setupInstallUi();
}
const nameOf = em => (team[em] && team[em].name) || (em === ADMIN ? "أنا" : String(em || "").split("@")[0]);
function fillScope() {
  const sel = $("#scope"), cur = scope;
  const emails = [...new Set([...Object.keys(team), ...trips.map(t => t.createdBy).filter(Boolean)])].filter(e => e !== ADMIN).sort();
  sel.innerHTML = `<option value="me">رسايلي وحجوزاتي أنا</option><option value="all">كل التيم</option>` + emails.map(e => `<option value="${esc(e)}">${esc(nameOf(e))}</option>`).join("");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "me";
}
$("#scope").addEventListener("change", e => { scope = e.target.value; render(); });
const inScope = t => !isAdmin || scope === "all" ? true : scope === "me" ? (t.createdBy || ADMIN) === myEmail : t.createdBy === scope;

/* ---------------- add form: items ---------------- */
const tzSel = (v, extra) => { const opts = TZ_OPTS.slice(); if (v && !opts.some(o => o[0] === v) && validTz(v)) opts.push([v, v]); return opts.map(([z, n]) => `<option value="${z}"${z === v ? " selected" : ""}>${n}</option>`).join(""); };
function itemRow(it = {}) {
  const el = document.createElement("div"); el.className = "seg"; el.dataset.kind = it.kind || "flight";
  const draw = () => {
    const k = el.dataset.kind, v = it;
    const head = `<div class="row" style="justify-content:space-between"><select class="i-kind" style="width:auto">${["flight", "hotel", "embassy"].map(x => `<option value="${x}"${x === k ? " selected" : ""}>${{ flight: "✈️ طيران", hotel: "🏨 فندق", embassy: "🏛️ سفارة" }[x]}</option>`).join("")}</select><button type="button" class="btn ghost small rm" style="min-height:36px;padding:4px 10px">حذف</button></div>`;
    let body = "";
    if (k === "flight") body = `<div class="fields">
      <label>من (كود المطار)<input class="mono i-from" maxlength="3" autocapitalize="characters" value="${esc(v.from || "")}" placeholder="CAI"></label>
      <label>إلى<input class="mono i-to" maxlength="3" autocapitalize="characters" value="${esc(v.to || "")}" placeholder="JED"></label>
      <label>شركة الطيران<input class="i-air" value="${esc(v.airline || "")}"></label>
      <label>رقم الرحلة<input class="mono i-fl" autocapitalize="characters" value="${esc(v.flightNo || "")}" placeholder="MS 671"></label>
      <label>تاريخ الإقلاع<input type="date" class="i-sd" value="${esc(v.depDate || "")}"></label>
      <label>ساعة الإقلاع (محلي)<input type="time" class="i-st" value="${esc(v.depTime || "")}"></label>
      <label>تاريخ الوصول<input type="date" class="i-ed" value="${esc(v.arrDate || "")}"></label>
      <label>ساعة الوصول (محلي)<input type="time" class="i-et" value="${esc(v.arrTime || "")}"></label>
      <label>توقيت بلد الإقلاع<select class="i-ftz">${tzSel(v.fromTz || AIRPORT_TZ[v.from] || CAIRO)}</select></label>
      <label>توقيت بلد الوصول<select class="i-ttz">${tzSel(v.toTz || AIRPORT_TZ[v.to] || "Asia/Riyadh")}</select></label>
      <label>رقم الحجز (PNR)<input class="mono i-ref" value="${esc(v.ref || "")}"></label></div>`;
    else if (k === "hotel") body = `<div class="fields">
      <label>اسم الفندق<input class="i-place" value="${esc(v.place || "")}"></label>
      <label>المدينة<input class="i-city" value="${esc(v.city || "")}"></label>
      <label>تاريخ الدخول<input type="date" class="i-sd" value="${esc(v.depDate || "")}"></label>
      <label>ساعة الدخول<input type="time" class="i-st" value="${esc(v.depTime || "14:00")}"></label>
      <label>تاريخ الخروج<input type="date" class="i-ed" value="${esc(v.arrDate || "")}"></label>
      <label>ساعة الخروج<input type="time" class="i-et" value="${esc(v.arrTime || "12:00")}"></label>
      <label>توقيت البلد<select class="i-tz">${tzSel(v.fromTz || "Asia/Riyadh")}</select></label>
      <label>رقم الحجز<input class="mono i-ref" value="${esc(v.ref || "")}"></label></div>`;
    else body = `<div class="fields">
      <label>السفارة / مركز التأشيرات<input class="i-place" value="${esc(v.place || "")}"></label>
      <label>المدينة<input class="i-city" value="${esc(v.city || "")}"></label>
      <label>تاريخ الميعاد<input type="date" class="i-sd" value="${esc(v.depDate || "")}"></label>
      <label>ساعة الميعاد<input type="time" class="i-st" value="${esc(v.depTime || "")}"></label>
      <label>توقيت البلد<select class="i-tz">${tzSel(v.fromTz || CAIRO)}</select></label>
      <label>رقم الميعاد<input class="mono i-ref" value="${esc(v.ref || "")}"></label>
      <label>الفرع / العنوان<input class="i-addr" value="${esc(v.address || "")}" placeholder="مثلاً: القطامية"></label>
      <label>مسافر مع مين؟<select class="i-comp">${COMPANIONS.map(([val, txt]) => `<option value="${val}"${val === (v.companions || "") ? " selected" : ""}>${txt}</option>`).join("")}</select></label></div>`;
    el.innerHTML = head + body;
    el.querySelector(".i-kind").onchange = e => { it = Object.assign(readItem(el), { kind: e.target.value }); el.dataset.kind = e.target.value; draw(); };
    el.querySelector(".rm").onclick = () => el.remove();
    const sync = (inp, sel) => inp && sel && inp.addEventListener("input", () => { const z = AIRPORT_TZ[inp.value.trim().toUpperCase()]; if (z) sel.value = z; });
    sync(el.querySelector(".i-from"), el.querySelector(".i-ftz"));
    sync(el.querySelector(".i-to"), el.querySelector(".i-ttz"));
    const sd = el.querySelector(".i-sd"), ed = el.querySelector(".i-ed");
    if (sd && ed && k === "flight") sd.addEventListener("change", () => { if (!ed.value) ed.value = sd.value; });
  };
  draw();
  return el;
}
function readItem(el) {
  const v = c => { const x = el.querySelector(c); return x ? x.value.trim() : ""; };
  const kind = el.dataset.kind;
  if (kind === "flight") return { kind, from: v(".i-from").toUpperCase(), to: v(".i-to").toUpperCase(), airline: v(".i-air"), flightNo: v(".i-fl").toUpperCase(), depDate: v(".i-sd"), depTime: v(".i-st"), arrDate: v(".i-ed") || v(".i-sd"), arrTime: v(".i-et"), fromTz: v(".i-ftz"), toTz: v(".i-ttz"), ref: v(".i-ref").toUpperCase() };
  if (kind === "hotel") return { kind, place: v(".i-place"), city: v(".i-city"), depDate: v(".i-sd"), depTime: v(".i-st") || "14:00", arrDate: v(".i-ed"), arrTime: v(".i-et") || "12:00", fromTz: v(".i-tz"), toTz: v(".i-tz"), ref: v(".i-ref") };
  return { kind, place: v(".i-place"), city: v(".i-city"), depDate: v(".i-sd"), depTime: v(".i-st"), arrDate: v(".i-sd"), arrTime: "", fromTz: v(".i-tz"), toTz: v(".i-tz"), ref: v(".i-ref"), address: v(".i-addr"), companions: v(".i-comp") };
}
const readItems = () => [...document.querySelectorAll("#items .seg")].map(readItem);
document.querySelectorAll("[data-additem]").forEach(b => b.onclick = () => {
  const cur = readItems().filter(x => x.kind === "flight"), last = cur[cur.length - 1];
  const seed = b.dataset.additem === "flight" && last ? { kind: "flight", from: last.to, to: last.from, fromTz: last.toTz, toTz: last.fromTz } : { kind: b.dataset.additem };
  $("#items").appendChild(itemRow(seed));
});

/* ---------------- images: pick several, read all ---------------- */
let images = []; // {id, data}
function loadImage(file) { return new Promise((res, rej) => { const url = URL.createObjectURL(file); const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; }); }
async function compress(file) {
  const im = await loadImage(file);
  let max = 1280, q = 0.7, out = "";
  for (let i = 0; i < 5; i++) {
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    out = c.toDataURL("image/jpeg", q);
    if (out.length < 850000) return out;
    max *= 0.8; q -= 0.08;
  }
  return out.length < 1000000 ? out : null;
}
function drawThumbs() {
  $("#thumbs").innerHTML = images.map((im, i) => `<figure><img src="${im.data}" alt="صورة ${i + 1}"><button type="button" data-rmimg="${i}" aria-label="شيل الصورة">×</button></figure>`).join("");
  $("#pick-t").textContent = images.length ? `${images.length} ${images.length === 1 ? "صورة" : "صور"} ✓ — اضغط لإضافة صور تانية` : "صوّر أو اختار الاسكرينات";
}
$("#thumbs").addEventListener("click", e => { const b = e.target.closest("[data-rmimg]"); if (!b) return; images.splice(+b.dataset.rmimg, 1); drawThumbs(); });
$("#f-file").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  const st = $("#f-readst"); st.className = "status"; st.textContent = "بنجهّز الصور…";
  const fresh = [];
  for (const f of files) { try { const d = await compress(f); if (d) fresh.push({ data: d }); } catch (_) {} }
  if (!fresh.length) { st.className = "status err"; st.textContent = "الصور دي ماتفتحتش، جرّب تاني."; return; }
  images.push(...fresh); drawThumbs();
  readImages(fresh);
});

let readSeq = 0;
async function readImages(list) {
  const st = $("#f-readst"), my = ++readSeq;
  const label = `بنقرأ ${list.length === 1 ? "الصورة" : list.length + " صور"} أوتوماتيك… استنى ثواني`;
  st.className = "status"; st.textContent = label;
  $("#f-save").disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { if (my !== readSeq) return clearInterval(tick); const s = Math.round((Date.now() - t0) / 1000); st.textContent = `${label} (${s} ث)`; }, 1000);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `These ${list.length} image(s) are screenshots for ONE customer of an Egyptian travel agency. They can be airline e-tickets/itineraries, hotel booking confirmations, and embassy / visa-center appointment confirmations (VFS, TLS, BLS, etc.), in English or Arabic.
Extract every booking exactly as printed. Return ONLY one JSON object:
{"customerName": string, "otherNames": [string], "isUmrah": boolean,
 "items": [
  {"kind":"flight","airline":string,"flightNo":string,"from":"IATA","to":"IATA","fromTz":"IANA timezone of departure airport","toTz":"IANA timezone of arrival airport","depDate":"YYYY-MM-DD","depTime":"HH:MM","arrDate":"YYYY-MM-DD","arrTime":"HH:MM","ref":"PNR / booking reference"},
  {"kind":"hotel","place":"hotel name","city":string,"tz":"IANA timezone","checkInDate":"YYYY-MM-DD","checkInTime":"HH:MM","checkOutDate":"YYYY-MM-DD","checkOutTime":"HH:MM","ref":"confirmation number"},
  {"kind":"embassy","place":"embassy / visa center name","city":string,"address":"branch / location / address exactly as printed (e.g. Katameya, Mohandessin, Sheikh Zayed)","applicants":number of applicants listed,"tz":"IANA timezone","date":"YYYY-MM-DD","time":"HH:MM","ref":"appointment / reference number"}
 ]}
Rules: one item per flight segment (outbound, connections, return) in travel order, one per hotel stay, one per appointment. Times are 24h LOCAL times as printed. Convert city/airport names to IATA codes (Cairo=CAI, Jeddah=JED, Madinah=MED, Riyadh=RUH, Sharjah=SHJ, Dubai=DXB, Borg El Arab=HBE, Sphinx=SPX).
Hotel check-in/out times: use the printed ones, else "" (we default to 14:00 / 12:00). "isUmrah" true only if Umrah/عمرة is mentioned. Never guess: use "" when not visible. If a year is missing use the next future date after ${today}. Don't repeat the same booking twice if it appears in two images.`;
    const parts = [prompt, ...list.map(im => ({ inlineData: { data: im.data.split(",")[1], mimeType: "image/jpeg" } }))];
    const res = await generateWithFallback(parts);
    if (my !== readSeq) return;
    const r = JSON.parse(res.response.text().trim().replace(/^```(?:json)?/i, "").replace(/```$/, ""));
    if (r.customerName && !$("#f-name").value) $("#f-name").value = r.customerName;
    if (r.isUmrah) $("#f-type").value = "umrah";
    const got = (Array.isArray(r.items) ? r.items : []).map(x => {
      if (x.kind === "hotel") return { kind: "hotel", place: x.place, city: x.city, depDate: x.checkInDate, depTime: x.checkInTime || "14:00", arrDate: x.checkOutDate, arrTime: x.checkOutTime || "12:00", fromTz: validTz(x.tz) ? x.tz : "", ref: x.ref };
      if (x.kind === "embassy") return { kind: "embassy", place: x.place, city: x.city, address: x.address || "", companions: (+x.applicants > 1 || (r.otherNames || []).filter(Boolean).length) ? "family" : "", depDate: x.date, depTime: x.time, fromTz: validTz(x.tz) ? x.tz : CAIRO, ref: x.ref };
      const from = String(x.from || "").toUpperCase().slice(0, 3), to = String(x.to || "").toUpperCase().slice(0, 3);
      return { kind: "flight", airline: x.airline, flightNo: String(x.flightNo || "").toUpperCase(), from, to, depDate: x.depDate, depTime: x.depTime, arrDate: x.arrDate || x.depDate, arrTime: x.arrTime,
        fromTz: AIRPORT_TZ[from] || (validTz(x.fromTz) ? x.fromTz : CAIRO), toTz: AIRPORT_TZ[to] || (validTz(x.toTz) ? x.toTz : "Asia/Riyadh"), ref: String(x.ref || "").toUpperCase() };
    }).filter(x => x.depDate || x.place || x.from);
    // drop empty placeholder rows, then add what we read
    document.querySelectorAll("#items .seg").forEach(el => { const v = readItem(el); if (!v.depDate && !v.place && !v.from) el.remove(); });
    got.forEach(x => $("#items").appendChild(itemRow(x)));
    const missing = got.some(x => !x.depDate || !x.depTime || (x.kind === "flight" && (!x.from || !x.to)));
    const others = (r.otherNames || []).filter(Boolean);
    const counts = ["flight", "hotel", "embassy"].map(k => [k, got.filter(x => x.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${KIND_NAME[k]}`).join("، ");
    st.className = !got.length || missing ? "status err" : "status good";
    st.textContent = (!got.length ? "مالقيناش حجوزات في الصور دي. جرّب صور أوضح أو ضيف بإيدك." : missing ? `اتقرا (${counts}) بس فيه بيانات ناقصة، كمّلها تحت.` : `اتقرا ✓ ${counts}. اكتب رقم واتساب العميل واحفظ.`)
      + (others.length ? ` (فيه أسماء تانية: ${others.join("، ")})` : "");
    if (!$("#f-phone").value) setTimeout(() => $("#f-phone").focus(), 50);
  } catch (e) {
    if (my !== readSeq) return;
    console.warn("read", e);
    const slow = /timeout/i.test(String(e && e.message));
    st.className = "status err";
    st.innerHTML = (slow ? "القراءة خدت وقت طويل (النت ضعيف أو الخدمة مزحومة)." : "ماقدرناش نقرأ الصور دي أوتوماتيك.")
      + ` <button type="button" class="btn" id="f-reread" style="margin-inline-start:8px">اقرا تاني</button> أو ضيف البيانات بإيدك.`;
    $("#f-reread").onclick = () => readImages(images.length ? images : list);
  } finally { clearInterval(tick); if (my === readSeq) $("#f-save").disabled = false; }
}

/* ---------------- save ---------------- */
function resetForm() {
  $("#form").reset(); images = []; drawThumbs(); $("#items").innerHTML = ""; $("#f-readst").textContent = ""; readSeq++; $("#f-save").disabled = false;
}
$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  const st = $("#f-st"); st.className = "status err";
  const name = $("#f-name").value.trim(), phone = normPhone($("#f-phone").value);
  const items = readItems();
  if (!items.length) { st.textContent = images.length ? "استنى لحد ما الصور تتقري، أو ضيف حجز بإيدك." : "ارفع صور الحجوزات الأول، أو ضيف حجز بإيدك."; return; }
  if (!name) { st.textContent = "اكتب اسم العميل."; return; }
  if (!phone) { st.textContent = "رقم الواتساب مش مظبوط. اكتبه زي 01012345678 أو بكود الدولة."; return; }
  for (const it of items) {
    if (!it.depDate || !it.depTime) { st.textContent = "كل حجز محتاج تاريخ وساعة."; return; }
    if (it.kind === "flight" && (!it.from || !it.to)) { st.textContent = "كل رحلة طيران محتاجة: من وإلى."; return; }
    if (it.kind === "hotel" && !it.arrDate) { st.textContent = "الفندق محتاج تاريخ الخروج."; return; }
  }
  const btn = $("#f-save"); btn.disabled = true; st.className = "status"; st.textContent = "بنحفظ…";
  try {
    const batch = F.writeBatch(db);
    const ticketIds = images.slice(0, 8).map(im => { const r = F.doc(F.collection(db, "tickets")); batch.set(r, { data: im.data, createdAt: Date.now(), by: myEmail }); return r.id; });
    const group = Date.now().toString(36);
    const saved = [];
    for (const it of items) {
      const depUtc = localToUtc(it.depDate, it.depTime, it.fromTz);
      let arrUtc = it.kind === "embassy" ? depUtc + H : (it.arrTime || it.kind === "hotel") ? localToUtc(it.arrDate, it.arrTime || "12:00", it.toTz) : null;
      if (it.kind === "flight" && arrUtc && arrUtc < depUtc) arrUtc += 24 * H;
      const rec = {
        kind: it.kind, name, phone, type: $("#f-type").value, ref: it.ref || "", pnr: it.kind === "flight" ? (it.ref || "") : "",
        from: it.from || "", to: it.to || "", airline: it.airline || "", flightNo: it.flightNo || "", place: it.place || "", city: it.city || "", address: it.address || "", companions: it.companions || "",
        fromTz: it.fromTz || CAIRO, toTz: it.toTz || it.fromTz || CAIRO,
        depDate: it.depDate, depTime: it.depTime, arrDate: it.arrDate || "", arrTime: it.arrTime || "", depUtc, arrUtc,
        ticketIds, group, createdAt: Date.now(), createdBy: myEmail, sent: {}, notified: {}
      };
      batch.set(F.doc(F.collection(db, "trips")), rec); saved.push(rec);
    }
    await batch.commit();
    saved.sort((a, b) => a.depUtc - b.depUtc);
    const link = "https://wa.me/" + phone + "?text=" + encodeURIComponent(confirmText(saved));
    resetForm(); toast("اتحفظ ✓");
    st.className = "status good";
    st.innerHTML = `اتحفظ ✓ ${items.length} ${items.length === 1 ? "حجز" : "حجوزات"} واتجدولت رسايلهم. <a class="btn" href="${esc(link)}" target="_blank" rel="noopener" style="margin-inline-start:8px">📩 ابعت رسالة التأكيد للعميل</a>`;
    setTimeout(() => { location.href = link; }, 400);
  } catch (err) {
    console.warn(err);
    st.className = "status err"; st.textContent = err && err.code === "permission-denied" ? "معندكش صلاحية تضيف." : "الحفظ ماتمّش. اتأكد من الإنترنت وجرّب تاني.";
  } finally { btn.disabled = false; }
});

/* ---------------- actions ---------------- */
async function markSent(id, k) {
  try { await F.updateDoc(F.doc(db, "trips", id), { ["sent." + k]: { at: Date.now(), by: myEmail } }); toast("اتسجّلت إنها اتبعتت ✓"); }
  catch (_) { toast("ماتسجّلتش. جرّب تاني."); }
}
async function undoSent(id, k) { try { await F.updateDoc(F.doc(db, "trips", id), { ["sent." + k]: F.deleteField() }); } catch (_) {} }
async function removeTrip(t) {
  try {
    const b = F.writeBatch(db); b.delete(F.doc(db, "trips", t.id));
    const ids = t.ticketIds || (t.ticketId ? [t.ticketId] : []);
    ids.forEach(id => { if (!trips.some(x => x.id !== t.id && (x.ticketIds || []).includes(id))) b.delete(F.doc(db, "tickets", id)); });
    await b.commit(); toast("اتحذف");
  } catch (_) { toast("الحذف ماتمّش"); }
}
async function applyChange(t) {
  const c = t.check || {};
  if (c.status === "cancelled") { try { await F.updateDoc(F.doc(db, "trips", t.id), { "check.resolved": true }); toast("اتسجّل. عدّل الحجز أو امسحه."); } catch (_) {} return; }
  const depDate = c.depDate || t.depDate, depTime = c.depTime || t.depTime, arrDate = c.arrDate || t.arrDate, arrTime = c.arrTime || t.arrTime;
  const depUtc = localToUtc(depDate, depTime, t.fromTz);
  let arrUtc = arrTime ? localToUtc(arrDate || depDate, arrTime, t.toTz) : null;
  if (arrUtc && arrUtc < depUtc) arrUtc += 24 * H;
  try { await F.updateDoc(F.doc(db, "trips", t.id), { depDate, depTime, arrDate, arrTime, depUtc, arrUtc, "check.resolved": true, "check.appliedAt": Date.now(), notified: {} }); toast("المعاد اتعدّل والرسايل اتظبطت ✓"); }
  catch (_) { toast("التعديل ماتمّش"); }
}
async function dismissChange(t) { try { await F.updateDoc(F.doc(db, "trips", t.id), { "check.resolved": true }); } catch (_) {} }
async function showTickets(btn, ids) {
  const box = btn.parentElement.querySelector(".tk"); if (!box) return;
  if (box.innerHTML) { box.innerHTML = ""; btn.textContent = "الصور"; return; }
  btn.textContent = "بنحمّل…";
  try {
    const docs = await Promise.all(ids.map(id => F.getDoc(F.doc(db, "tickets", id))));
    box.innerHTML = docs.filter(s => s.exists()).map(s => `<img class="ticket-img" alt="صورة الحجز" src="${esc(s.data().data)}" style="margin-top:6px">`).join("") || `<div class="small muted">الصور مش موجودة</div>`;
    btn.textContent = "إخفاء الصور";
  } catch (_) { btn.textContent = "الصور"; toast("الصور ماتحمّلتش"); }
}

/* ---------------- render ---------------- */
function render() {
  const now = Date.now();
  $("#now").textContent = "آخر تحديث " + fmtTime(now) + " (توقيت القاهرة)";
  if (!loaded) return;
  if (isAdmin) fillScope();
  const view = trips.filter(inScope);
  const mine = trips.filter(t => (t.createdBy || ADMIN) === myEmail);
  const items = [];
  view.forEach(t => KEYS.forEach(k => { const s = stateOf(t, k, now); if (s === "due" || (s === "late" && now - schedule(t)[k].until < 48 * H)) items.push({ t, k, s, due: schedule(t)[k].due }); }));
  items.sort((a, b) => a.due - b.due);
  const myDue = mine.reduce((n, t) => n + KEYS.filter(k => { const st = stateOf(t, k, now); return st === "due" || (st === "late" && now - schedule(t)[k].until < 48 * H); }).length, 0);
  $("#stats").innerHTML = `<span class="chip">${view.filter(t => t.depUtc > now).length} حجز جاي</span>`;
  const badge = $("#nav-badge"); badge.hidden = !myDue; badge.textContent = myDue;
  document.title = myDue ? `(${myDue}) رحلات النسيم` : "رحلات النسيم";
  try { if (navigator.setAppBadge) myDue ? navigator.setAppBadge(myDue) : navigator.clearAppBadge(); } catch (_) {}

  // schedule-change alerts from the 24h flight check
  const changes = view.filter(t => t.check && t.check.changed && !t.check.resolved && t.depUtc > now - 6 * H);
  $("#changes").hidden = !changes.length;
  $("#changes").innerHTML = changes.map(t => { const c = t.check; return `<div class="change">
      <strong>⚠️ ${esc(t.name)} · ${esc(t.flightNo)} ${esc(t.from)} ← ${esc(t.to)}</strong>
      <div class="small">${c.status === "cancelled" ? "الرحلة ظاهرة إنها <b>اتلغت</b>." : `المعاد في الحجز: ${esc(t.depDate)} ${esc(t.depTime)} — المعاد الجديد: <b>${esc(c.depDate)} ${esc(c.depTime)}</b>${c.arrTime ? ` (وصول ${esc(c.arrDate)} ${esc(c.arrTime)})` : ""}`}</div>
      ${c.note ? `<div class="small">${esc(c.note)}</div>` : ""}
      ${(c.sources || []).length ? `<div class="small">المصدر: ${(c.sources || []).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">رابط ${i + 1}</a>`).join(" · ")}</div>` : ""}
      <div class="small muted">اتأكد من موقع شركة الطيران قبل ما تعتمد.${isAdmin && t.createdBy !== myEmail ? " · " + esc(nameOf(t.createdBy)) : ""}</div>
      <div class="row"><button class="btn brand" data-apply="${t.id}">${c.status === "cancelled" ? "تمام، شفتها" : "اعتمد المعاد الجديد"}</button><button class="btn ghost" data-dismiss="${t.id}">تجاهل</button></div>
    </div>`; }).join("");

  $("#queue").innerHTML = items.length ? items.map(({ t, k, s, due }) => `
    <article class="msg ${s === "late" ? "late" : ""}">
      <div class="msg-top"><span class="msg-who">${esc(t.name)} <span class="kind">${KIND_NAME[kindOf(t)]}</span></span><span class="msg-kind">${LABELS[kindOf(t)][k][0]}</span></div>
      <div class="small muted"><span class="mono">+${esc(t.phone)}</span> · ${esc(titleOf(t))}${isAdmin && scope !== "me" ? " · " + esc(nameOf(t.createdBy)) : ""}</div>
      <div class="small muted">${kindOf(t) === "flight" ? "إقلاع" : kindOf(t) === "hotel" ? "دخول" : "الميعاد"} ${fmtFull(t.depUtc)} · ${s === "late" ? "<b style='color:var(--late)'>فات معادها</b>" : "معادها " + rel(due - now)}</div>
      ${kindOf(t) === "flight" && k !== "arr" ? (checking.has(t.id) ? `<div class="small muted">⏳ بنتأكد من معاد الرحلة على النت قبل ما تبعت…</div>` : t.check ? (t.check.changed && !t.check.resolved ? `<div class="small" style="color:var(--late)"><b>⚠️ فيه تغيير في معاد الرحلة، شوف التنبيه فوق قبل ما تبعت.</b></div>` : t.check.found ? `<div class="ok-badge">✓ اتأكدنا من الرحلة ومفيش تغيير</div>` : `<div class="small muted">الفحص مالقاش بيانات للرحلة، اتأكد من موقع الشركة.</div>`) : "") : ""}
      <details><summary>نص الرسالة</summary><div class="msg-text">${esc(msgText(t, k))}</div></details>
      <div class="row"><a class="btn wa" href="${waLink(t, k)}" target="_blank" rel="noopener">افتح واتساب وابعت</a><button class="btn" data-sent="${t.id}" data-k="${k}">اتبعتت ✓</button></div>
    </article>`).join("") : `<div class="empty">مفيش رسايل مطلوبة دلوقتي ✓<br>أول ما ييجي معاد أي رسالة هيوصلك إشعار وهتظهر هنا بزرار واتساب جاهز.</div>`;

  const showPast = $("#showPast").checked, q = $("#search").value.trim().toLowerCase();
  const list = view.filter(t => (showPast || (t.arrUtc || t.depUtc) + 30 * H > now) &&
    (!q || [t.name, t.phone, t.pnr, t.ref, t.flightNo, t.place].some(v => String(v || "").toLowerCase().includes(q))));
  if (!list.length) { $("#upcoming").innerHTML = `<div class="empty">${q ? "مفيش نتايج." : "لسه مفيش حجوزات هنا."}</div>`; return; }
  const days = {}; list.forEach(t => { const d = fmtDay(t.depUtc); (days[d] = days[d] || []).push(t); });
  $("#upcoming").innerHTML = Object.entries(days).map(([d, ts]) => `<div class="day"><h3>${d}</h3>${ts.map(t => {
    const sc = schedule(t), kind = kindOf(t);
    const dots = KEYS.map(k => { const s = stateOf(t, k, now); const lbl = { sent: "اتبعتت ✓", wait: fmtFull(sc[k].due), due: "دلوقتي", late: "فاتت" }[s];
      return `<span class="dot ${s === "wait" ? "" : s}"${s === "sent" ? ` data-undo="${t.id}" data-k="${k}" title="اضغط لو اتسجّلت غلط"` : ""}>${LABELS[kind][k][1]}: ${lbl}</span>`; }).join("");
    const when = kind === "flight" ? `إقلاع ${fmtTime(t.depUtc)}${t.arrUtc ? " · وصول " + fmtFull(t.arrUtc) : ""}` : kind === "hotel" ? `دخول ${fmtFull(t.depUtc)}${t.arrUtc ? " · خروج " + fmtFull(t.arrUtc) : ""}` : `الميعاد ${fmtTime(t.depUtc)}`;
    const chk = kind === "flight" && checking.has(t.id) ? `<span class="small muted">⏳ بنتأكد من الرحلة على النت…</span>` : kind === "flight" && t.check ? (t.check.changed ? (t.check.resolved ? `<span class="ok-badge">✓ اتعدّل بعد الفحص</span>` : `<span class="dot late">⚠️ فيه تغيير</span>`) : t.check.found ? `<span class="ok-badge">✓ اتفحصت قبلها بيوم ومفيش تغيير</span>` : `<span class="small muted">الفحص مالقاش بيانات للرحلة</span>`) : "";
    const ids = t.ticketIds || (t.ticketId ? [t.ticketId] : []);
    return `<div class="trip">
      <div class="route">${esc(t.name)} <span class="kind">${KIND_NAME[kind]}</span> · ${esc(titleOf(t))}</div>
      <div class="small muted">${when}${t.type === "umrah" ? " · عمرة" : ""}${t.ref || t.pnr ? ` · <span class="mono">${esc(t.ref || t.pnr)}</span>` : ""}</div>
      <div class="small muted"><span class="mono">+${esc(t.phone)}</span>${isAdmin ? " · " + esc(nameOf(t.createdBy || ADMIN)) : ""}</div>
      <div class="dots">${dots}</div>${chk}
      <div class="row">${ids.length ? `<button class="btn ghost small" data-tk="${ids.join(",")}" style="min-height:36px;padding:4px 10px">الصور</button>` : ""}<button class="btn ghost small" data-del="${t.id}" style="min-height:36px;padding:4px 10px">حذف</button><div class="tk" style="flex-basis:100%"></div></div>
    </div>`; }).join("")}</div>`).join("");
}
document.addEventListener("click", async e => {
  const s = e.target.closest("[data-sent]"); if (s) { s.disabled = true; await markSent(s.dataset.sent, s.dataset.k); return; }
  const u = e.target.closest("[data-undo]"); if (u) { if (u.dataset.confirm) { await undoSent(u.dataset.undo, u.dataset.k); } else { u.dataset.confirm = "1"; u.textContent = "إلغاء «اتبعتت»؟ اضغط تاني"; setTimeout(() => { if (u.isConnected) render(); }, 4000); } return; }
  const tk = e.target.closest("[data-tk]"); if (tk) { showTickets(tk, tk.dataset.tk.split(",")); return; }
  const ap = e.target.closest("[data-apply]"); if (ap) { ap.disabled = true; const t = trips.find(x => x.id === ap.dataset.apply); if (t) await applyChange(t); return; }
  const di = e.target.closest("[data-dismiss]"); if (di) { const t = trips.find(x => x.id === di.dataset.dismiss); if (t) await dismissChange(t); return; }
  const d = e.target.closest("[data-del]");
  if (d) {
    if (d.dataset.confirm) { d.disabled = true; const t = trips.find(x => x.id === d.dataset.del); if (t) await removeTrip(t); }
    else { d.dataset.confirm = "1"; d.textContent = "متأكد؟ اضغط تاني"; setTimeout(() => { if (d.isConnected) { delete d.dataset.confirm; d.textContent = "حذف"; } }, 4000); }
  }
});
$("#showPast").addEventListener("change", render);
$("#search").addEventListener("input", render);
setInterval(render, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

/* ---------------- push notifications ---------------- */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let swReg = null;
async function getReg() {
  if (swReg) return swReg;
  swReg = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
  await navigator.serviceWorker.ready;
  return swReg;
}
if ("serviceWorker" in navigator) getReg().catch(() => {});
async function enablePush(silent) {
  const st = $("#n-st"); st.className = "status";
  if (isIOS && !standalone) { st.className = "status err"; st.textContent = "على الآيفون لازم تثبّت التطبيق على الشاشة الرئيسية الأول، وتفتحه من الأيقونة، وبعدين تفعّل الإشعارات."; return false; }
  if (!(await M.isSupported().catch(() => false))) { st.className = "status err"; st.textContent = "المتصفح ده مش بيدعم الإشعارات. افتح التطبيق من Chrome."; return false; }
  if (!silent) st.textContent = "بنفعّل…";
  try {
    const perm = Notification.permission === "granted" ? "granted" : (silent ? Notification.permission : await Notification.requestPermission());
    if (perm !== "granted") { if (!silent) { st.className = "status err"; st.textContent = perm === "denied" ? "الإشعارات مقفولة للتطبيق ده. افتحها من إعدادات الموبايل." : "لازم توافق على الإشعارات."; } return false; }
    const messaging = M.getMessaging(app);
    const token = await M.getToken(messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: await getReg() });
    if (!token) throw new Error("no token");
    await F.setDoc(F.doc(db, "tokens", token), { uid: me.uid, email: myEmail, ua: navigator.userAgent.slice(0, 160), updatedAt: Date.now() });
    st.className = "status good"; st.textContent = "الإشعارات شغالة على الموبايل ده ✓";
    $("#n-on").textContent = "الإشعارات شغالة ✓"; $("#push-hint").hidden = true;
    M.onMessage(messaging, async p => {
      const n = p.notification || p.data || {};
      toast((n.title || "رسايل للعملاء") + (n.body ? ": " + n.body.split("\n")[0] : ""));
      try { const reg = await getReg(); await reg.showNotification(n.title || "النسيم: رسايل للعملاء", { body: n.body || "", icon: "./icon-192.png", badge: "./badge.png", tag: "naseem-fg", renotify: true, dir: "rtl", lang: "ar", vibrate: [300, 150, 300], data: { link: "./#queue" } }); } catch (_) {}
      try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (_) {}
      setTab("queue"); render();
    });
    return true;
  } catch (e) {
    if (!silent) { st.className = "status err"; st.textContent = "التفعيل ماتمّش. جرّب تاني بعد شوية."; }
    console.warn(e); return false;
  }
}
async function testNotification() {
  const st = $("#n-st");
  try {
    if (Notification.permission !== "granted") { st.className = "status err"; st.textContent = "الإشعارات مش مسموحة. دوس «فعّل الإشعارات» الأول."; return; }
    const reg = await getReg();
    await reg.showNotification("تجربة إشعار من رحلات النسيم", { body: "لو شايف الإشعار ده في شريط الموبايل يبقى الإشعارات شغالة ✓", icon: "./icon-192.png", badge: "./badge.png", tag: "naseem-test", dir: "rtl", lang: "ar", vibrate: [300, 150, 300], data: { link: "./#queue" } });
    st.className = "status good"; st.textContent = "اتبعت إشعار تجريبي. لو مظهرش في شريط الموبايل، الإشعارات مقفولة من إعدادات الموبايل.";
  } catch (e) { st.className = "status err"; st.textContent = "الموبايل رفض يعرض الإشعار: " + (e && e.message || e); }
}
function setupPushUi() {
  $("#n-on").onclick = () => enablePush(false);
  $("#n-test").onclick = testNotification;
  if ("Notification" in window && Notification.permission === "granted") enablePush(true);
  else {
    const h = $("#push-hint");
    h.innerHTML = isIOS && !standalone ? "عشان توصلك الإشعارات على الآيفون: ثبّت التطبيق على الشاشة الرئيسية من «الإعدادات»." : `الإشعارات لسه مش متفعّلة على الموبايل ده. <button class="btn brand" style="margin-top:8px;width:100%" id="hint-on">فعّل الإشعارات</button>`;
    h.hidden = false;
    const b = $("#hint-on"); if (b) b.onclick = async () => { if (await enablePush(false)) h.hidden = true; else setTab("settings"); };
  }
}

/* ---------------- install ---------------- */
let deferredPrompt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; $("#i-btn").hidden = false; });
function setupInstallUi() {
  const help = $("#i-help");
  if (standalone) { help.textContent = "التطبيق متثبّت على الموبايل ده ✓"; return; }
  help.innerHTML = isIOS
    ? "من Safari: دوس زرار المشاركة (المربع اللي طالع منه سهم) ← «إضافة إلى الشاشة الرئيسية» ← «إضافة». بعدها افتح التطبيق من الأيقونة."
    : "لو الزرار مظهرش: من Chrome دوس الثلاث نقط ⋮ فوق ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».";
  $("#i-btn").onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {}); deferredPrompt = null; $("#i-btn").hidden = true; };
}

/* ---------------- team (admin) ---------------- */
function watchTeam() {
  unsubTeam = F.onSnapshot(F.collection(db, "team"), snap => {
    team = {}; snap.docs.forEach(d => team[d.id] = d.data());
    const list = Object.keys(team).sort();
    $("#team-list").innerHTML = list.length ? list.map(em => `<div class="team-row"><span><b>${esc(team[em].name || "")}</b> <span class="mono small">${esc(em)}</span></span><button class="btn ghost small" data-rm-team="${esc(em)}" style="min-height:36px;padding:4px 10px">شيل</button></div>`).join("") : `<div class="small muted">لسه مفيش حد متضاف.</div>`;
    render();
  }, () => {});
}
$("#team-add").onclick = async () => {
  const em = $("#t-email").value.trim().toLowerCase(), nm = $("#t-name").value.trim(), st = $("#t-st");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { st.className = "status err"; st.textContent = "اكتب إيميل صحيح."; return; }
  try { await F.setDoc(F.doc(db, "team", em), { name: nm, addedAt: Date.now(), by: myEmail }); $("#t-email").value = ""; $("#t-name").value = ""; st.className = "status good"; st.textContent = "اتضاف ✓ ابعتله لينك التطبيق يدخل بنفس الإيميل."; }
  catch (_) { st.className = "status err"; st.textContent = "الإضافة ماتمّتش."; }
};
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-rm-team]"); if (!b) return;
  if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "متأكد؟"; return; }
  try { await F.deleteDoc(F.doc(db, "team", b.dataset.rmTeam)); } catch (_) { toast("ماتشالش"); }
});
