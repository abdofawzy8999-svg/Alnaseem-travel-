// Customer WhatsApp message texts — copied verbatim from ../app.js so automatic sends match the app's wa.me messages.
// If you change a message in app.js, regenerate this file (same functions, same wording).
export const H = 3600e3;
export const COMPANY_WA = process.env.COMPANY_WA || "01021762000";
function fmtLocal(date, time) {
  if (!date) return { d: "", t: "" };
  const ts = Date.UTC(...date.split("-").map((v, i) => i === 1 ? v - 1 : +v), ...(time || "00:00").split(":").map(Number));
  return {
    d: new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(ts)),
    t: time ? new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(ts)) : ""
  };
}
const kindOf = t => t.kind || "flight";
const KIND_NAME = { flight: "طيران", hotel: "فندق", embassy: "سفارة" };
const SLOGAN = "النسيم ترافل نسيمك لعالم اسهل";
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

export { msgText, confirmText, kindOf };
