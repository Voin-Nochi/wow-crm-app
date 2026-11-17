/*!
 * WOW CRM — сниппет трекинга.
 * 1) При заходе сохраняет fbclid/gclid/ttclid, UTM и ID объявления в cookie на 90 дней (последний клик).
 * 2) Создаёт _fbc / _fbp, если их ещё нет, и постоянный ID посетителя (external_id).
 * 3) При отправке формы с атрибутом data-wow-crm отправляет заявку в CRM и событие в пиксель
 *    с одним и тем же event_id — Meta склеит браузерное и серверное событие.
 *
 * Подключение (перед </body>):
 *   <script>window.WOW_CRM = { endpoint: "https://<project>.supabase.co/functions/v1/collect", siteKey: "<site_key>" };</script>
 *   <script src="/wow-track.js" defer></script>
 *   <form data-wow-crm data-wow-event="Lead" data-wow-form="Консультация"> ... </form>
 * Для своих форм / SPA: window.wowCrm.submit({ name, email, phone, value, category }, "Lead")
 */
(function () {
  "use strict";
  var cfg = window.WOW_CRM || {};
  if (!cfg.endpoint || !cfg.siteKey) { console.warn("[wow-crm] нет endpoint или siteKey"); return; }

  var DAY = 864e5;
  var META_SOURCES = ["facebook", "fb", "meta", "instagram", "ig", "an", "messenger"];

  function getCookie(n) {
    var m = document.cookie.match("(?:^|; )" + n.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }
  // ставим cookie на домен верхнего уровня (site.com), чтобы она работала на поддоменах
  function setCookie(n, v, days) {
    var exp = new Date(Date.now() + days * DAY).toUTCString();
    var parts = location.hostname.split(".");
    for (var i = parts.length - 2; i >= 0; i--) {
      var d = parts.slice(i).join(".");
      document.cookie = n + "=" + encodeURIComponent(v) + "; expires=" + exp + "; path=/; domain=." + d + "; SameSite=Lax";
      if (getCookie(n) === v) return;
    }
    document.cookie = n + "=" + encodeURIComponent(v) + "; expires=" + exp + "; path=/; SameSite=Lax";
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  var qs = new URLSearchParams(location.search);
  var now = Date.now();

  // ── ID посетителя
  var eid = getCookie("wow_eid");
  if (!eid) { eid = uuid(); }
  setCookie("wow_eid", eid, 365);

  // ── _fbc из fbclid, _fbp если пиксель ещё не поставил
  var fbclid = qs.get("fbclid");
  if (fbclid) {
    var curFbc = getCookie("_fbc");
    if (!curFbc || curFbc.split(".").slice(3).join(".") !== fbclid) setCookie("_fbc", "fb.1." + now + "." + fbclid, 90);
  }
  if (!getCookie("_fbp")) setCookie("_fbp", "fb.1." + now + "." + Math.floor(Math.random() * 1e10), 90);

  // ── атрибуция последнего клика
  var attr = {};
  try { attr = JSON.parse(getCookie("wow_attr") || "{}"); } catch (e) { attr = {}; }
  var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "campaign_id", "adset_id", "ad_id"];
  var isNewClick = fbclid || qs.get("gclid") || qs.get("ttclid") || qs.get("utm_source");
  if (isNewClick) {
    attr = { landing_url: location.href.slice(0, 1000), ts: now };
    keys.forEach(function (k) { if (qs.get(k)) attr[k] = qs.get(k); });
    if (qs.get("gclid")) attr.gclid = qs.get("gclid");
    if (qs.get("ttclid")) attr.ttclid = qs.get("ttclid");
    var src = (attr.utm_source || "").toLowerCase();
    attr.meta_click = !!fbclid || META_SOURCES.indexOf(src) > -1;
    setCookie("wow_attr", JSON.stringify(attr), 90);
  } else if (!attr.landing_url) {
    attr = { landing_url: location.href.slice(0, 1000), ts: now };
    setCookie("wow_attr", JSON.stringify(attr), 90);
  }

  function payload(lead, eventName, eventId) {
    return {
      site_key: cfg.siteKey,
      event_name: eventName || "Lead",
      event_id: eventId,
      lead: lead,
      ids: {
        external_id: eid,
        fbc: getCookie("_fbc"),
        fbp: getCookie("_fbp"),
        gclid: attr.gclid || null,
        ttclid: attr.ttclid || null,
        fbclid_present: !!attr.meta_click
      },
      utm: {
        utm_source: attr.utm_source, utm_medium: attr.utm_medium, utm_campaign: attr.utm_campaign,
        utm_content: attr.utm_content, utm_term: attr.utm_term
      },
      ad: { campaign_id: attr.campaign_id, adset_id: attr.adset_id, ad_id: attr.ad_id },
      landing_url: attr.landing_url,
      page_url: location.href.slice(0, 1000),
      hp: lead && lead._hp
    };
  }

  function submit(lead, eventName) {
    var eventId = uuid();
    lead = lead || {};
    // браузерный пиксель — с тем же eventID
    if (typeof window.fbq === "function") {
      var params = {};
      if (lead.value) { params.value = Number(lead.value); params.currency = lead.currency || cfg.currency || "USD"; }
      window.fbq("track", eventName || "Lead", params, { eventID: eventId });
    }
    var body = JSON.stringify(payload(lead, eventName, eventId));
    return fetch(cfg.endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true
    }).then(function (r) { return r.json(); });
  }

  var FIELDS = ["name", "email", "phone", "city", "country", "message", "value", "currency", "category", "product"];
  function readForm(form) {
    var fd = new FormData(form), lead = {};
    FIELDS.forEach(function (f) {
      var map = (cfg.fieldMap && cfg.fieldMap[f]) || f;
      var v = fd.get(map);
      if (v != null && String(v).trim() !== "") lead[f] = String(v).trim();
    });
    if (form.dataset.wowCategory && !lead.category) lead.category = form.dataset.wowCategory;
    if (form.dataset.wowValue && !lead.value) lead.value = form.dataset.wowValue;
    lead.form_name = form.dataset.wowForm || form.getAttribute("name") || form.id || null;
    lead._hp = fd.get("wow_hp"); // скрытое поле-ловушка, если добавлено в форму
    return lead;
  }

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches(cfg.formSelector || "form[data-wow-crm]")) return;
    var lead = readForm(form);
    if (!lead.email && !lead.phone) return;
    var onlyCrm = form.dataset.wowCrm === "only";
    if (onlyCrm) e.preventDefault();
    submit(lead, form.dataset.wowEvent).then(function (res) {
      if (onlyCrm) {
        form.dispatchEvent(new CustomEvent("wow-crm:success", { detail: res, bubbles: true }));
        if (cfg.onSuccess) cfg.onSuccess(res, form);
      }
    }).catch(function (err) {
      console.warn("[wow-crm]", err);
      if (onlyCrm) form.dispatchEvent(new CustomEvent("wow-crm:error", { detail: err, bubbles: true }));
    });
  }, true);

  window.wowCrm = { submit: submit, externalId: eid, attribution: attr };
})();
