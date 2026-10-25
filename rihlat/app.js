const CFG = self.NASEEM, V = CFG.sdk;
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
const M = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-messaging.js`);
const AC = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app-check.js`);

const app = initializeApp(CFG.firebase);
if (CFG.recaptchaKey) try { AC.initializeAppCheck(app, { provider: new AC.ReCaptchaEnterpriseProvider(CFG.recaptchaKey), isTokenAutoRefreshEnabled: true }); } catch (e) { console.warn("app check", e); }
const aiModels = {};
let AIMOD = null;
async function getModel(name) {
  if (aiModels[name]) return aiModels[name];
  AIMOD = AIMOD || await import(`https://www.gstatic.com/firebasejs/${V}/firebase-ai.js`);
  const ai = AIMOD.getAI(app, { backend: new AIMOD.GoogleAIBackend() });
  return aiModels[name] = AIMOD.getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: "application/json", temperature: 0 } }, { timeout: 30000 });
}
// Try the configured models in order; retry briefly when Google is busy.
async function generateWithFallback(parts) {
  const names = CFG.aiModels || ["gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"];
  let lastErr;
  for (const name of names) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const m = await getModel(name); return await m.generateContent(parts); }
      catch (e) {
        lastErr = e; const msg = String(e && e.message || "");
        if (/\[404|no longer available|not found|abort|timeout/i.test(msg)) break;           // model gone: next model
        if (/\[(429|500|503)|high demand|overloaded|unavailable/i.test(msg)) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw e;
      }
    }
  }
  throw lastErr;
}
const auth = A.getAuth(app);
const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CAIRO = "Africa/Cairo";
const OWNER = CFG.ownerEmail.toLowerCase();
const COMPANY_WA = CFG.companyWhatsApp;

/* ---------------- views ---------------- */
function show(id) { ["v-boot", "v-login", "v-wait", "v-app"].forEach(v => $("#" + v).hidden = v !== id); }
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4500); }
function setTab(name) {
  ["queue", "add", "trips", "settings"].forEach(n => { $("#t-" + n).hidden = n !== name; });
  document.querySelectorAll(".nav button").forEach(b => { if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  scrollTo({ top: 0 });
  try { history.replaceState(null, "", "#" + name); } catch (_) {}
}
document.querySelectorAll(".nav button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
const startTab = (location.hash || "#queue").slice(1);
setTab(["queue", "add", "trips", "settings"].includes(startTab) ? startTab : "queue");

/* ---------------- auth ---------------- */
const authErr = e => {
  const c = e && e.code || "";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "الإيميل أو كلمة السر غلط.";
  if (c.includes("email-already-in-use")) return "الإيميل ده عليه حساب بالفعل. دوس «دخول».";
  if (c.includes("weak-password")) return "كلمة السر لازم 6 حروف على الأقل.";
  if (c.includes("invalid-email")) return "الإيميل مكتوب غلط.";
  if (c.includes("unauthorized-domain")) return "الدومين ده مش مسموح في إعدادات Firebase.";
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

let me = null, unsubTrips = null, unsubTeam = null, isOwner = false;
A.onAuthStateChanged(auth, async user => {
  me = user; if (unsubTrips) { unsubTrips(); unsubTrips = null; } if (unsubTeam) { unsubTeam(); unsubTeam = null; }
  if (!user) { show("v-login"); return; }
  const email = (user.email || "").toLowerCase();
  isOwner = email === OWNER && user.emailVerified;
  $("#me-email").textContent = email;
  $("#w-email").textContent = email;
  startData();
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
  let ts = guess - tzOffset(guess, tz || CAIRO);
  return guess - tzOffset(ts, tz || CAIRO);
}
const fmtCairo = (ts, opt) => new Intl.DateTimeFormat("ar-EG", Object.assign({ timeZone: CAIRO }, opt)).format(new Date(ts));
const fmtDay = ts => fmtCairo(ts, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = ts => fmtCairo(ts, { hour: "numeric", minute: "2-digit" });
const fmtFull = ts => fmtCairo(ts, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
function fmtLocal(date, time) {
  const ts = Date.UTC(...date.split("-").map((v, i) => i === 1 ? v - 1 : +v), ...time.split(":").map(Number));
  return {
    d: new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(ts)),
    t: new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(ts))
  };
}
function rel(ms) {
  const a = Math.abs(ms), h = Math.floor(a / 3600000), m = Math.round((a % 3600000) / 60000);
  const s = h ? (h + " س" + (m ? " و" + m + " د" : "")) : (m + " دقيقة");
  return ms >= 0 ? "بعد " + s : "من " + s;
}

/* ---------------- airports ---------------- */
const AIRPORT_TZ = { CAI: "Africa/Cairo", HBE: "Africa/Cairo", SPX: "Africa/Cairo", HRG: "Africa/Cairo", SSH: "Africa/Cairo", LXR: "Africa/Cairo", ASW: "Africa/Cairo", ATZ: "Africa/Cairo", HMB: "Africa/Cairo", RMF: "Africa/Cairo", ALY: "Africa/Cairo",
  JED: "Asia/Riyadh", RUH: "Asia/Riyadh", MED: "Asia/Riyadh", DMM: "Asia/Riyadh", TIF: "Asia/Riyadh", AHB: "Asia/Riyadh", ELQ: "Asia/Riyadh", TUU: "Asia/Riyadh", YNB: "Asia/Riyadh", GIZ: "Asia/Riyadh", HAS: "Asia/Riyadh", AJF: "Asia/Riyadh", ULH: "Asia/Riyadh", HOF: "Asia/Riyadh", NUM: "Asia/Riyadh",
  DXB: "Asia/Dubai", AUH: "Asia/Dubai", SHJ: "Asia/Dubai", DWC: "Asia/Dubai", RKT: "Asia/Dubai", KWI: "Asia/Kuwait", DOH: "Asia/Qatar", BAH: "Asia/Bahrain", MCT: "Asia/Muscat", SLL: "Asia/Muscat", AMM: "Asia/Amman", IST: "Europe/Istanbul", SAW: "Europe/Istanbul", BEY: "Asia/Beirut", TAS: "Asia/Tashkent", SKD: "Asia/Tashkent", ALA: "Asia/Almaty", NQZ: "Asia/Almaty", BKK: "Asia/Bangkok", KUL: "Asia/Kuala_Lumpur", CMN: "Africa/Casablanca", TUN: "Africa/Tunis", KRT: "Africa/Khartoum", LHR: "Europe/London", CDG: "Europe/Paris", FCO: "Europe/Rome" };
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

/* ---------------- messages ---------------- */
const KINDS = [
  { key: "d24", label: "تذكير قبل السفر بـ 24 ساعة", short: "قبل 24 س" },
  { key: "h4", label: "وقت الكاونتر (قبل الإقلاع بـ 4 ساعات)", short: "الكاونتر" },
  { key: "arr", label: "رسالة الوصول بالسلامة", short: "الوصول" }
];
function schedule(t) {
  const arr = t.arrUtc || t.depUtc + 3 * 3600e3;
  return {
    d24: { due: t.depUtc - 24 * 3600e3, until: t.depUtc - 4 * 3600e3 },
    h4: { due: t.depUtc - 4 * 3600e3, until: t.depUtc },
    arr: { due: arr + 3600e3, until: arr + 30 * 3600e3 }
  };
}
function msgText(t, k) {
  const first = (t.name || "").trim().split(/\s+/)[0] || "";
  const um = t.type === "umrah";
  const dep = fmtLocal(t.depDate, t.depTime);
  const route = t.from + " ← " + t.to;
  const fl = [t.airline, t.flightNo].filter(Boolean).join(" ");
  if (k === "d24") return `أهلاً ${first} 👋\nمعاك النسيم ترافيل ✈️\nتذكير برحلتك بكره:\n\n✈️ ${route}${fl ? " (" + fl + ")" : ""}\n📅 ${dep.d}\n🕐 الإقلاع ${dep.t} بتوقيت ${t.from}${t.pnr ? "\n📌 رقم الحجز: " + t.pnr : ""}\n\nبرجاء التأكد من:\n✅ جواز السفر ساري\n✅ ${um ? "تأشيرة العمرة وتصريح نُسُك" : "التأشيرة"} وصورة التذكرة معاك\n⏳ يُفضّل الوصول للمطار قبل الإقلاع بـ 3 ساعات\n\nرحلة سعيدة 🌷\nالنسيم ترافيل - سافرها صح\nللتواصل: ${COMPANY_WA}`;
  if (k === "h4") return `أهلاً ${first} ✈️\nفاضل حوالي 4 ساعات على إقلاع رحلتك${fl ? " " + fl : ""} ⏰\nده وقت التوجّه للمطار والكاونتر.\n\n✅ الباسبور والتذكرة${um ? " وتصريح نُسُك" : ""} في إيدك\n✅ الشنطة في الوزن المسموح\n\nلو احتجت أي حاجة في المطار كلمنا فوراً: ${COMPANY_WA}\nتوصل بالسلامة 🌷\nالنسيم ترافيل`;
  return `حمد الله على السلامة يا ${first} 🌷\nنتمنى تكون وصلت ${t.to} بالسلامة ورحلتك كانت مريحة ✈️\n${um ? "تقبّل الله منك صالح الأعمال، ومتنساناش من دعائك 🤲\n" : ""}\nلو محتاج أي خدمة وأنت هناك إحنا معاك: ${COMPANY_WA}\nويسعدنا جداً تقييمك لخدمتنا على صفحتنا 💙\nالنسيم ترافيل - سافرها صح`;
}
const waLink = (t, k) => "https://wa.me/" + t.phone + "?text=" + encodeURIComponent(msgText(t, k));
function stateOf(t, k, now) {
  const sc = schedule(t)[k];
  if (t.sent && t.sent[k]) return "sent";
  if (now < sc.due) return "wait";
  if (now <= sc.until) return "due";
  return "late";
}

/* ---------------- data ---------------- */
let trips = [], loaded = false;
function startData() {
  if (unsubTrips) unsubTrips();
  const q = F.query(F.collection(db, "trips"), F.where("depUtc", ">", Date.now() - 10 * 86400e3), F.orderBy("depUtc"));
  unsubTrips = F.onSnapshot(q, snap => {
    trips = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    loaded = true; show("v-app"); render(); afterEnter();
  }, err => {
    if (err.code === "permission-denied") show("v-wait");
    else { show("v-app"); $("#queue").innerHTML = `<div class="empty">مش قادرين نحمّل الرحلات دلوقتي. اتأكد من الإنترنت.</div>`; }
  });
}
let entered = false;
function afterEnter() {
  if (entered) return; entered = true;
  $("#team-box").hidden = !isOwner;
  if (isOwner) watchTeam();
  setupPushUi();
  setupInstallUi();
}

/* ---------------- form ---------------- */
function segRow(s = {}) {
  const el = document.createElement("div"); el.className = "seg";
  const tzSel = v => TZ_OPTS.map(([z, n]) => `<option value="${z}"${z === v ? " selected" : ""}>${n}</option>`).join("");
  el.innerHTML = `<div class="row" style="justify-content:space-between"><strong class="small">رحلة</strong><button type="button" class="btn ghost small rm" style="min-height:36px;padding:4px 10px">حذف</button></div>
  <div class="fields">
    <label>من (كود المطار)<input class="mono s-from" maxlength="3" autocapitalize="characters" value="${esc(s.from || "")}" placeholder="CAI"></label>
    <label>إلى<input class="mono s-to" maxlength="3" autocapitalize="characters" value="${esc(s.to || "")}" placeholder="JED"></label>
    <label>شركة الطيران<input class="s-air" value="${esc(s.airline || "")}"></label>
    <label>رقم الرحلة<input class="mono s-fl" autocapitalize="characters" value="${esc(s.flightNo || "")}" placeholder="MS 671"></label>
    <label>تاريخ الإقلاع<input type="date" class="s-dd" value="${esc(s.depDate || "")}"></label>
    <label>ساعة الإقلاع (محلي)<input type="time" class="s-dt" value="${esc(s.depTime || "")}"></label>
    <label>تاريخ الوصول<input type="date" class="s-ad" value="${esc(s.arrDate || "")}"></label>
    <label>ساعة الوصول (محلي)<input type="time" class="s-at" value="${esc(s.arrTime || "")}"></label>
    <label>توقيت بلد الإقلاع<select class="s-ftz">${tzSel(s.fromTz || CAIRO)}</select></label>
    <label>توقيت بلد الوصول<select class="s-ttz">${tzSel(s.toTz || "Asia/Riyadh")}</select></label>
  </div>`;
  el.querySelector(".rm").onclick = () => { el.remove(); if (!$("#segs").children.length) $("#segs").appendChild(segRow()); };
  const sync = (inp, sel) => inp.addEventListener("input", () => { const z = AIRPORT_TZ[inp.value.trim().toUpperCase()]; if (z) sel.value = z; });
  sync(el.querySelector(".s-from"), el.querySelector(".s-ftz"));
  sync(el.querySelector(".s-to"), el.querySelector(".s-ttz"));
  const dd = el.querySelector(".s-dd"), ad = el.querySelector(".s-ad");
  dd.addEventListener("change", () => { if (!ad.value) ad.value = dd.value; });
  return el;
}
function readSegs() {
  return [...document.querySelectorAll("#segs .seg")].map(el => {
    const v = c => el.querySelector(c).value.trim();
    return { from: v(".s-from").toUpperCase(), to: v(".s-to").toUpperCase(), airline: v(".s-air"), flightNo: v(".s-fl").toUpperCase(), depDate: v(".s-dd"), depTime: v(".s-dt"), arrDate: v(".s-ad") || v(".s-dd"), arrTime: v(".s-at"), fromTz: v(".s-ftz"), toTz: v(".s-ttz") };
  });
}
function resetSegs() { $("#segs").innerHTML = ""; $("#segs").appendChild(segRow()); }
resetSegs();
$("#f-manual").onclick = () => { $("#f-auto").hidden = false; $("#f-name").focus(); };
$("#f-addseg").onclick = () => { const cur = readSegs(), last = cur[cur.length - 1] || {}; $("#segs").appendChild(segRow({ from: last.to, to: last.from, fromTz: last.toTz, toTz: last.fromTz })); };

let ticketData = null;
function loadImage(file) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}
async function compress(file) {
  const im = await loadImage(file);
  let max = 1400, q = 0.72, out = "";
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
$("#f-file").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  $("#pick-t").textContent = "بنجهّز الصورة…";
  try {
    ticketData = await compress(f);
    if (!ticketData) throw 0;
    $("#f-prev").src = ticketData; $("#f-prev").hidden = false;
    $("#pick-t").textContent = "الصورة اتحطت ✓"; $("#pick-s").textContent = "اضغط تاني لو عايز تغيّرها";
  } catch (_) { ticketData = null; $("#pick-t").textContent = "الصورة دي ماتفتحتش، جرّب صورة تانية"; return; }
  readTicket();
});

/* ---------------- read the ticket automatically (Gemini via Firebase AI Logic) ---------------- */
let readSeq = 0;
async function readTicket() {
  const st = $("#f-readst"), my = ++readSeq;
  st.className = "status"; st.textContent = "بنقرأ بيانات التذكرة أوتوماتيك… استنى ثواني";
  $("#f-auto").hidden = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `This image is a screenshot of an airline e-ticket, booking confirmation or itinerary for a customer of an Egyptian travel agency.
Extract exactly what is printed. Return ONLY a JSON object of this shape:
{"passengerName": string, "otherPassengers": [string], "pnr": string, "isUmrah": boolean,
 "segments": [{"airline": string, "flightNo": string, "from": "3-letter IATA code", "to": "3-letter IATA code",
   "depDate": "YYYY-MM-DD", "depTime": "HH:MM 24h local time at the departure airport", "arrDate": "YYYY-MM-DD", "arrTime": "HH:MM 24h local time at the arrival airport"}]}
Rules: include every flight segment in travel order (outbound, connections and return). Convert city or airport names to IATA codes (Cairo=CAI, Jeddah=JED, Madinah=MED, Riyadh=RUH, Sharjah=SHJ, Dubai=DXB, Borg El Arab=HBE, Sphinx=SPX, Tashkent=TAS).
"isUmrah" true only if the ticket mentions Umrah/عمرة.
Use "" for anything not visible and never guess. If the year is missing, use the next future date after ${today}.`;
    const b64 = ticketData.split(",")[1];
    const res = await generateWithFallback([prompt, { inlineData: { data: b64, mimeType: "image/jpeg" } }]);
    if (my !== readSeq) return;
    let txt = res.response.text().trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
    const r = JSON.parse(txt);
    const segs = (Array.isArray(r.segments) ? r.segments : []).filter(s => s && (s.from || s.to || s.depDate));
    if (r.passengerName) $("#f-name").value = r.passengerName;
    if (r.pnr) $("#f-pnr").value = String(r.pnr).toUpperCase();
    if (r.isUmrah) $("#f-type").value = "umrah";
    if (segs.length) {
      $("#segs").innerHTML = "";
      segs.forEach(s => {
        const from = String(s.from || "").toUpperCase().slice(0, 3), to = String(s.to || "").toUpperCase().slice(0, 3);
        $("#segs").appendChild(segRow({ ...s, from, to, flightNo: String(s.flightNo || "").toUpperCase(), arrDate: s.arrDate || s.depDate,
          fromTz: AIRPORT_TZ[from] || CAIRO, toTz: AIRPORT_TZ[to] || "Asia/Riyadh" }));
      });
    }
    const missing = segs.some(s => !s.depDate || !s.depTime || !s.from || !s.to) || !segs.length;
    const others = (r.otherPassengers || []).filter(Boolean);
    st.className = missing ? "status err" : "status good";
    st.textContent = (missing ? "اتقرت جزئياً، كمّل الناقص تحت." : "اتقرت ✓ " + segs.length + (segs.length === 1 ? " رحلة" : " رحلات") + ". اكتب رقم واتساب العميل واحفظ.")
      + (others.length ? ` (التذكرة فيها كمان: ${others.join("، ")})` : "");
    $("#f-auto").hidden = false;
    if (!$("#f-phone").value) setTimeout(() => $("#f-phone").focus(), 50);
  } catch (e) {
    if (my !== readSeq) return;
    console.warn("read ticket", e);
    st.className = "status err";
    st.textContent = "ماقدرناش نقرأ التذكرة دي أوتوماتيك. جرّب اسكرين أوضح، أو اكتب البيانات بإيدك.";
    $("#f-auto").hidden = false;
  }
}

$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  const st = $("#f-st"); st.className = "status err";
  const name = $("#f-name").value.trim(), phone = normPhone($("#f-phone").value);
  if (!name) { $("#f-auto").hidden = false; st.textContent = ticketData ? "استنى لحد ما التذكرة تتقري، أو اكتب اسم العميل." : "ارفع صورة التذكرة الأول."; return; }
  if (!phone) { st.textContent = "رقم الواتساب مش مظبوط. اكتبه زي 01012345678 أو بكود الدولة."; return; }
  const segs = readSegs();
  for (const s of segs) if (!s.from || !s.to || !s.depDate || !s.depTime) { $("#f-auto").hidden = false; st.textContent = "كل رحلة محتاجة: من، إلى، تاريخ وساعة الإقلاع."; return; }
  const btn = $("#f-save"); btn.disabled = true; st.className = "status"; st.textContent = "بنحفظ…";
  try {
    const batch = F.writeBatch(db);
    let ticketId = null;
    if (ticketData) { const tr = F.doc(F.collection(db, "tickets")); ticketId = tr.id; batch.set(tr, { data: ticketData, createdAt: Date.now(), by: me.email || "" }); }
    const group = Date.now().toString(36);
    for (const s of segs) {
      const depUtc = localToUtc(s.depDate, s.depTime, s.fromTz);
      let arrUtc = s.arrTime ? localToUtc(s.arrDate, s.arrTime, s.toTz) : null;
      if (arrUtc && arrUtc < depUtc) arrUtc += 24 * 3600e3;
      batch.set(F.doc(F.collection(db, "trips")), {
        name, phone, type: $("#f-type").value, pnr: $("#f-pnr").value.trim().toUpperCase(),
        from: s.from, to: s.to, fromTz: s.fromTz, toTz: s.toTz, airline: s.airline, flightNo: s.flightNo,
        depDate: s.depDate, depTime: s.depTime, arrDate: s.arrDate, arrTime: s.arrTime, depUtc, arrUtc,
        ticketId, group, createdAt: Date.now(), createdBy: (me.email || "").toLowerCase(), sent: {}, notified: {}
      });
    }
    await batch.commit();
    st.className = "status good"; st.textContent = "اتحفظ ✓ الرسايل هتظهر وهيوصلكم إشعار في معادها.";
    $("#form").reset(); ticketData = null; $("#f-prev").hidden = true; $("#pick-t").textContent = "صوّر أو اختار اسكرين التذكرة"; $("#pick-s").textContent = "البيانات هتتقري منها أوتوماتيك"; resetSegs(); $("#f-auto").hidden = true; $("#f-readst").textContent = ""; readSeq++;
    toast("اتحفظ ✓");
  } catch (err) {
    st.className = "status err"; st.textContent = err && err.code === "permission-denied" ? "معندكش صلاحية تضيف رحلات." : "الحفظ ماتمّش. اتأكد من الإنترنت وجرّب تاني.";
  } finally { btn.disabled = false; }
});

/* ---------------- render ---------------- */
async function markSent(id, k) {
  try { await F.updateDoc(F.doc(db, "trips", id), { ["sent." + k]: { at: Date.now(), by: (me.email || "").toLowerCase() } }); toast("اتسجّلت إنها اتبعتت ✓"); }
  catch (_) { toast("ماتسجّلتش. جرّب تاني."); }
}
async function undoSent(id, k) { try { await F.updateDoc(F.doc(db, "trips", id), { ["sent." + k]: F.deleteField() }); } catch (_) {} }
async function removeTrip(t) {
  try {
    const b = F.writeBatch(db); b.delete(F.doc(db, "trips", t.id));
    if (t.ticketId && !trips.some(x => x.id !== t.id && x.ticketId === t.ticketId)) b.delete(F.doc(db, "tickets", t.ticketId));
    await b.commit(); toast("اتحذفت");
  } catch (_) { toast("الحذف ماتمّش"); }
}
async function showTicket(btn, id) {
  const box = btn.parentElement.querySelector(".tk"); if (!box) return;
  if (box.innerHTML) { box.innerHTML = ""; btn.textContent = "صورة التذكرة"; return; }
  btn.textContent = "بنحمّل…";
  try { const s = await F.getDoc(F.doc(db, "tickets", id)); box.innerHTML = s.exists() ? `<img class="ticket-img" alt="صورة التذكرة" src="${esc(s.data().data)}">` : `<div class="small muted">الصورة مش موجودة</div>`; btn.textContent = "إخفاء الصورة"; }
  catch (_) { btn.textContent = "صورة التذكرة"; toast("الصورة ماتحمّلتش"); }
}

function render() {
  const now = Date.now();
  $("#now").textContent = "آخر تحديث " + fmtTime(now) + " (توقيت القاهرة)";
  if (!loaded) return;
  const items = [];
  trips.forEach(t => KINDS.forEach(k => { const s = stateOf(t, k.key, now); if (s === "due" || (s === "late" && now - schedule(t)[k.key].until < 48 * 3600e3)) items.push({ t, k, s, due: schedule(t)[k.key].due }); }));
  items.sort((a, b) => a.due - b.due);
  const dueN = items.filter(i => i.s === "due").length, lateN = items.filter(i => i.s === "late").length;
  const upN = trips.filter(t => t.depUtc > now).length;
  $("#stats").innerHTML = `<span class="chip">${upN} رحلة جاية</span>`;
  const badge = $("#nav-badge"); badge.hidden = !dueN; badge.textContent = dueN;
  document.title = dueN ? `(${dueN}) رحلات النسيم` : "رحلات النسيم";
  try { if (navigator.setAppBadge) dueN ? navigator.setAppBadge(dueN) : navigator.clearAppBadge(); } catch (_) {}

  $("#queue").innerHTML = items.length ? items.map(({ t, k, s, due }) => `
    <article class="msg ${s === "late" ? "late" : ""}">
      <div class="msg-top"><span class="msg-who">${esc(t.name)}</span><span class="msg-kind">${k.label}</span></div>
      <div class="small muted"><span class="mono">+${esc(t.phone)}</span> · ${esc(t.from)} ← ${esc(t.to)} · ${esc([t.airline, t.flightNo].filter(Boolean).join(" "))}</div>
      <div class="small muted">إقلاع ${fmtFull(t.depUtc)} · ${s === "late" ? "<b style='color:var(--late)'>فات معادها</b>" : "معادها " + rel(due - now)}</div>
      <details><summary>نص الرسالة</summary><div class="msg-text">${esc(msgText(t, k.key))}</div></details>
      <div class="row"><a class="btn wa" href="${waLink(t, k.key)}" target="_blank" rel="noopener">افتح واتساب وابعت</a><button class="btn" data-sent="${t.id}" data-k="${k.key}">اتبعتت ✓</button></div>
    </article>`).join("") : `<div class="empty">مفيش رسايل مطلوبة دلوقتي ✓<br>أول ما ييجي معاد أي رسالة هيوصلك إشعار وهتظهر هنا بزرار واتساب جاهز.</div>`;

  const showPast = $("#showPast").checked, q = $("#search").value.trim().toLowerCase();
  const list = trips.filter(t => (showPast || (t.arrUtc || t.depUtc) + 30 * 3600e3 > now) &&
    (!q || [t.name, t.phone, t.pnr, t.flightNo].some(v => String(v || "").toLowerCase().includes(q))));
  if (!list.length) { $("#upcoming").innerHTML = `<div class="empty">${q ? "مفيش نتايج." : "لسه مفيش رحلات. ضيف أول عميل من «إضافة»."}</div>`; return; }
  const days = {}; list.forEach(t => { const d = fmtDay(t.depUtc); (days[d] = days[d] || []).push(t); });
  $("#upcoming").innerHTML = Object.entries(days).map(([d, ts]) => `<div class="day"><h3>${d}</h3>${ts.map(t => {
    const sc = schedule(t);
    const dots = KINDS.map(k => { const s = stateOf(t, k.key, now); const lbl = { sent: "اتبعتت ✓", wait: fmtFull(sc[k.key].due), due: "دلوقتي", late: "فاتت" }[s];
      return `<span class="dot ${s === "wait" ? "" : s}"${s === "sent" ? ` data-undo="${t.id}" data-k="${k.key}" title="اضغط لو اتسجّلت غلط"` : ""}>${k.short}: ${lbl}</span>`; }).join("");
    return `<div class="trip">
      <div class="route">${esc(t.name)} · ${esc(t.from)} ← ${esc(t.to)}</div>
      <div class="small muted">${esc([t.airline, t.flightNo].filter(Boolean).join(" "))} · إقلاع ${fmtTime(t.depUtc)}${t.arrUtc ? " · وصول " + fmtFull(t.arrUtc) : ""}${t.type === "umrah" ? " · عمرة" : ""}${t.pnr ? ` · <span class="mono">${esc(t.pnr)}</span>` : ""}</div>
      <div class="small muted"><span class="mono">+${esc(t.phone)}</span>${t.createdBy ? " · أضافه " + esc(t.createdBy.split("@")[0]) : ""}</div>
      <div class="dots">${dots}</div>
      <div class="row">${t.ticketId ? `<button class="btn ghost small" data-tk="${t.ticketId}" style="min-height:36px;padding:4px 10px">صورة التذكرة</button>` : ""}<button class="btn ghost small" data-del="${t.id}" style="min-height:36px;padding:4px 10px">حذف</button><div class="tk" style="flex-basis:100%"></div></div>
    </div>`; }).join("")}</div>`).join("");
}
document.addEventListener("click", async e => {
  const s = e.target.closest("[data-sent]"); if (s) { s.disabled = true; await markSent(s.dataset.sent, s.dataset.k); return; }
  const u = e.target.closest("[data-undo]"); if (u) { if (u.dataset.confirm) { await undoSent(u.dataset.undo, u.dataset.k); } else { u.dataset.confirm = "1"; u.textContent = "إلغاء «اتبعتت»؟ اضغط تاني"; setTimeout(() => { if (u.isConnected) render(); }, 4000); } return; }
  const tk = e.target.closest("[data-tk]"); if (tk) { showTicket(tk, tk.dataset.tk); return; }
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
  if (isIOS && !standalone) { st.className = "status err"; st.textContent = "على الآيفون لازم تثبّت التطبيق على الشاشة الرئيسية الأول (شوف «تثبيت التطبيق» تحت)، وتفتحه من الأيقونة، وبعدين تفعّل الإشعارات."; return false; }
  if (!(await M.isSupported().catch(() => false))) { st.className = "status err"; st.textContent = "المتصفح ده مش بيدعم الإشعارات. افتح التطبيق من Chrome."; return false; }
  if (!silent) st.textContent = "بنفعّل…";
  try {
    const perm = Notification.permission === "granted" ? "granted" : (silent ? Notification.permission : await Notification.requestPermission());
    if (perm !== "granted") { if (!silent) { st.className = "status err"; st.textContent = perm === "denied" ? "الإشعارات مقفولة للتطبيق ده. افتحها من إعدادات الموبايل ← التطبيقات ← Chrome ← الإشعارات، أو من القفل جنب العنوان." : "لازم توافق على الإشعارات."; } return false; }
    const messaging = M.getMessaging(app);
    const token = await M.getToken(messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: await getReg() });
    if (!token) throw new Error("no token");
    await F.setDoc(F.doc(db, "tokens", token), { uid: me.uid, email: (me.email || "").toLowerCase(), ua: navigator.userAgent.slice(0, 160), updatedAt: Date.now() });
    try { localStorage.setItem("naseem-push", token); } catch (_) {}
    st.className = "status good"; st.textContent = "الإشعارات شغالة على الموبايل ده ✓";
    $("#n-on").textContent = "الإشعارات شغالة ✓"; $("#push-hint").hidden = true;
    M.onMessage(messaging, p => {
      const n = p.notification || p.data || {};
      toast((n.title || "رسايل للعملاء") + (n.body ? ": " + n.body.split("\n")[0] : ""));
      try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (_) {}
      setTab("queue"); render();
    });
    return true;
  } catch (e) {
    if (!silent) { st.className = "status err"; st.textContent = "التفعيل ماتمّش. جرّب تاني بعد شوية."; }
    console.warn(e); return false;
  }
}
function setupPushUi() {
  $("#n-on").onclick = () => enablePush(false);
  const granted = "Notification" in window && Notification.permission === "granted";
  if (granted) enablePush(true);
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

/* ---------------- team (owner) ---------------- */
function watchTeam() {
  unsubTeam = F.onSnapshot(F.collection(db, "team"), snap => {
    const list = snap.docs.map(d => d.id).sort();
    $("#team-list").innerHTML = list.length ? list.map(em => `<div class="team-row"><span class="mono small">${esc(em)}</span><button class="btn ghost small" data-rm-team="${esc(em)}" style="min-height:36px;padding:4px 10px">شيل</button></div>`).join("") : `<div class="small muted">لسه مفيش حد متضاف.</div>`;
  }, () => {});
}
$("#t-add").onclick = async () => {
  const em = $("#t-email").value.trim().toLowerCase(), st = $("#t-st");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { st.className = "status err"; st.textContent = "اكتب إيميل صحيح."; return; }
  try { await F.setDoc(F.doc(db, "team", em), { addedAt: Date.now(), by: me.email }); $("#t-email").value = ""; st.className = "status good"; st.textContent = "اتضاف ✓ ابعتله لينك التطبيق يدخل بنفس الإيميل."; }
  catch (_) { st.className = "status err"; st.textContent = "الإضافة ماتمّتش."; }
};
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-rm-team]"); if (!b) return;
  if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "متأكد؟"; return; }
  try { await F.deleteDoc(F.doc(db, "team", b.dataset.rmTeam)); } catch (_) { toast("ماتشالش"); }
});
