"use strict";

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 0, unit = "") => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d) + unit);
const safeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
const COLORS = { CRITICAL: "#ef4444", HIGH: "#f97316", MEDIUM: "#eab308", NORMAL: "#22c55e", NONE: "#94a3b8" };
const SEV_ORDER = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, NORMAL: 0 };

function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
const when = (ts) => new Date(ts * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "#");

function tempColor(t) {
  if (t === null || t === undefined) return COLORS.NONE;
  if (t >= 44) return "#dc2626"; if (t >= 40) return "#f97316"; if (t >= 35) return "#eab308";
  if (t >= 25) return "#22c55e"; if (t >= 15) return "#38bdf8"; return "#6366f1";
}
function aqiInfo(a) {
  if (a === null || a === undefined) return { label: "No data", color: COLORS.NONE };
  if (a <= 50) return { label: "Good", color: "#22c55e" };
  if (a <= 100) return { label: "Moderate", color: "#eab308" };
  if (a <= 150) return { label: "Unhealthy (sensitive)", color: "#f97316" };
  if (a <= 200) return { label: "Unhealthy", color: "#ef4444" };
  if (a <= 300) return { label: "Very unhealthy", color: "#a855f7" };
  return { label: "Hazardous", color: "#9f1239" };
}
function cityColor(c, mode) {
  if (c.temperature === null || c.temperature === undefined) return COLORS.NONE;
  if (mode === "temp") return tempColor(c.temperature);
  if (mode === "aqi") return aqiInfo(c.aqi).color;
  return COLORS[c.risk] || COLORS.NONE;
}
function quakeColor(m) { return m >= 6 ? COLORS.CRITICAL : m >= 5 ? COLORS.HIGH : m >= 4 ? COLORS.MEDIUM : "#38bdf8"; }

/* ---------- state ---------- */
const state = { data: null, lastAlertId: null, mode: "risk", alertSev: "ALL", tab: "alerts", sosLoc: null, myMarker: null };

/* ---------- theme + clock ---------- */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  safeSet("theme", t);
  setTiles(t);
}
$("#themeBtn").addEventListener("click", () => applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" }) + " IST";
}, 1000);

/* ---------- map ---------- */
const map = L.map("map", { minZoom: 4, maxZoom: 12, maxBounds: [[0, 58], [42, 108]], worldCopyJump: false }).setView([22.8, 79.5], 5);
let tileLayer = null;
const MT_KEY = (window.APP_CONFIG && window.APP_CONFIG.maptilerKey) || "";
function setTiles(theme) {
  if (tileLayer) map.removeLayer(tileLayer);
  document.documentElement.classList.toggle("tiles-invert", !MT_KEY && theme === "dark");
  if (MT_KEY) {
    const style = theme === "dark" ? "dataviz-dark" : "streets-v2";
    tileLayer = L.tileLayer(`https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(MT_KEY)}`, {
      maxZoom: 18, attribution: "&copy; MapTiler &copy; OpenStreetMap contributors" }).addTo(map);
  } else {
    tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  }
}
const layers = { quakes: L.layerGroup().addTo(map), cities: L.layerGroup().addTo(map), sos: L.layerGroup().addTo(map) };
const cityMarkers = {};

function renderLegend() {
  const items = {
    risk: [["Normal", COLORS.NORMAL], ["Medium", COLORS.MEDIUM], ["High", COLORS.HIGH], ["Critical", COLORS.CRITICAL], ["No data", COLORS.NONE]],
    temp: [["< 15°C", "#6366f1"], ["15-25", "#38bdf8"], ["25-35", "#22c55e"], ["35-40", "#eab308"], ["40-44", "#f97316"], ["44°C +", "#dc2626"]],
    aqi: [["Good", "#22c55e"], ["Moderate", "#eab308"], ["Sensitive", "#f97316"], ["Unhealthy", "#ef4444"], ["Very unhealthy", "#a855f7"], ["Hazardous", "#9f1239"]]
  }[state.mode];
  $("#legend").innerHTML = items.map(([l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join("") +
    `<span>◯ Earthquake size = magnitude</span><span><i style="background:#ef4444;border:2px solid #fff"></i>SOS</span>`;
}

function cityPopup(c) {
  const a = aqiInfo(c.aqi);
  const issues = (c.issues || []).map((i) => `<div class="pop-issue"><b>${esc(i.category)}</b> (${esc(i.severity)})</div>`).join("");
  return `<div class="pop-title">${esc(c.city)}, ${esc(c.state)}</div>` +
    `${esc(c.condition || "No data yet")}<br>🌡️ ${fmt(c.temperature, 1, " °C")} &nbsp; 💧 ${fmt(c.humidity, 0, "%")}<br>` +
    `💨 ${fmt(c.wind_speed, 0, " km/h")} (gust ${fmt(c.wind_gust, 0)}) <br>🌧️ ${fmt(c.precipitation, 1, " mm/h")} · today ${fmt(c.rain_today, 0, " mm")}<br>` +
    `😷 AQI ${fmt(c.aqi, 0)} <span style="color:${a.color}">(${esc(a.label)})</span>${issues}`;
}

function renderMap(d) {
  layers.quakes.clearLayers(); layers.cities.clearLayers(); layers.sos.clearLayers();
  
  // 1. Render Earthquakes
  d.quakes.forEach((q) => {
    if (q.magnitude >= 5 && Date.now() - q.time_ms < 172800000) {
      const size = Math.round(q.magnitude * 8);
      L.marker([q.lat, q.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        html: `<div class="qring" style="--c:${quakeColor(q.magnitude)}"></div>` }) }).addTo(layers.quakes);
    }
    L.circleMarker([q.lat, q.lon], {
      radius: Math.max(4, q.magnitude * 2.6), color: quakeColor(q.magnitude), weight: 1.5,
      fillColor: quakeColor(q.magnitude), fillOpacity: 0.35
    }).bindPopup(`<div class="pop-title">M${fmt(q.magnitude, 1)} earthquake</div>${esc(q.place)}<br>Depth ${fmt(q.depth_km, 0)} km<br>` +
      `${esc(when(q.time_ms / 1000))}<br>~${q.near_km} km from ${esc(q.near_city)}`).addTo(layers.quakes);
  });
  
  // 2. Render Cities with Hazard Zones
  d.cities.forEach((c) => {
    // Khatre ka radius draw karna (Hazard Zone)
    if (state.mode === "risk") {
      // Risk ke hisaab se circle ka size (radius) aur transparency
      const rad = { CRITICAL: 60000, HIGH: 40000, MEDIUM: 25000, NORMAL: 15000 }[c.risk] || 15000;
      const op = c.risk === "NORMAL" ? 0.1 : 0.25; 
      
      L.circle([c.lat, c.lon], {
        radius: rad, 
        color: cityColor(c, "risk"), 
        fillColor: cityColor(c, "risk"), 
        fillOpacity: op, 
        weight: 1.5, 
        interactive: false
      }).addTo(layers.cities);
    }

    // Map pin ke andar ka text/icon
    let label;
    if (state.mode === "risk") {
      label = c.risk === "NORMAL" ? "✅" : "⚠️"; // Safe hai toh Tick, Danger hai toh Warning icon
    } else if (state.mode === "aqi") {
      label = fmt(c.aqi, 0);
    } else {
      label = fmt(c.temperature, 0);
    }

    const icon = L.divIcon({ className: "", iconSize: [32, 32], iconAnchor: [16, 16],
      html: `<div class="cpin${c.risk === "CRITICAL" ? " pulse" : ""}" style="--c:${cityColor(c, state.mode)}">${esc(label)}</div>` });
    cityMarkers[c.city] = L.marker([c.lat, c.lon], { icon, riseOnHover: true }).bindPopup(cityPopup(c))
      .bindTooltip(c.city, { direction: "top", offset: [0, -14] }).addTo(layers.cities);
  });
  
  // 3. Render SOS alerts
  d.sos.filter((s) => s.lat !== null && s.status === "OPEN").forEach((s) => {
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: '<div class="sos-pin"></div>', iconSize: [18, 18] }) })
      .bindPopup(`<div class="pop-title">🆘 SOS #${s.id}</div>${esc(s.emergency_type)}<br>${esc(s.near || "")}<br>${esc(ago(s.created_ts))}`).addTo(layers.sos);
  });
  
  // Toggle layers based on checkboxes
  [["lyQuakes", "quakes"], ["lyCities", "cities"], ["lySos", "sos"]].forEach(([id, key]) => {
    if ($("#" + id).checked) { if (!map.hasLayer(layers[key])) map.addLayer(layers[key]); } else map.removeLayer(layers[key]);
  });
}
["lyQuakes", "lyCities", "lySos"].forEach((id) => $("#" + id).addEventListener("change", () => state.data && renderMap(state.data)));
$("#modeSel").addEventListener("change", (e) => { state.mode = e.target.value; renderLegend(); state.data && renderMap(state.data); });

/* ---------- renderers ---------- */
function renderStats(s) {
  const cards = [
    ["🌍", fmt(s.quakes), "Earthquakes (7 days)", "#38bdf8"],
    ["📈", s.max_mag === null ? "—" : "M" + fmt(s.max_mag, 1), "Strongest recorded", "#a855f7"],
    ["🔔", fmt(s.alerts), "Total alerts raised", "#eab308"],
    ["🔴", fmt(s.critical), "Critical alerts", "#ef4444"],
    ["🏙️", `${s.cities_at_risk}/${s.cities_total}`, "Cities with active risk", "#f97316"],
    ["🆘", fmt(s.open_sos), "Open SOS requests", "#ef4444"]
  ];
  $("#stats").innerHTML = cards.map(([i, v, l, c]) => `<div class="stat" style="--c:${c}"><div class="ico">${i}</div><div class="val">${esc(v)}</div><div class="lbl">${esc(l)}</div></div>`).join("");
}

function renderBanner(d) {
  const cutoff = Date.now() / 1000 - 86400;
  const top = d.alerts.filter((a) => a.created_ts >= cutoff && SEV_ORDER[a.severity] >= 2)
    .sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || b.created_ts - a.created_ts)[0];
  const b = $("#banner");
  if (top) {
    b.className = "banner " + top.severity;
    b.innerHTML = `<span class="banner-icon">${top.severity === "CRITICAL" ? "🚨" : "⚠️"}</span><span>${esc(top.severity)} · ${esc(top.category)} — ${esc(top.message)}</span>`;
  } else {
    b.className = "banner ok";
    b.innerHTML = '<span class="banner-icon">✅</span><span>No high-severity alerts in the last 24 hours. Monitoring live data across India.</span>';
  }
}

function renderAlerts(d) {
  const list = d.alerts.filter((a) => state.alertSev === "ALL" || a.severity === state.alertSev);
  $("#alertList").innerHTML = list.length ? list.map((a) =>
    `<div class="item" style="--c:${COLORS[a.severity] || COLORS.NONE}"><div class="row"><b>${esc(a.category)}</b><span class="pill">${esc(a.severity)}</span></div>` +
    `<div>${esc(a.message)}</div><div class="meta">${esc(ago(a.created_ts))} · ${esc(when(a.created_ts))}</div></div>`).join("")
    : '<div class="empty">No alerts yet. The system is watching live feeds.</div>';
}

function renderQuakes(d) {
  $("#quakeList").innerHTML = d.quakes.length ? d.quakes.map((q) =>
    `<div class="item" style="--c:${quakeColor(q.magnitude)}"><div class="row"><div><b>${esc(q.place)}</b><div class="meta">Depth ${fmt(q.depth_km, 0)} km · ~${q.near_km} km from ${esc(q.near_city)}</div>` +
    `<div class="meta">${esc(ago(q.time_ms / 1000))} · <a href="${esc(safeUrl(q.url))}" target="_blank" rel="noopener">USGS details</a></div></div>` +
    `<span class="mag" style="--c:${quakeColor(q.magnitude)}">${fmt(q.magnitude, 1)}</span></div></div>`).join("")
    : '<div class="empty">No earthquakes recorded in the India region in the last 7 days (or feed still loading).</div>';
}

function renderCities(d) {
  const f = $("#cityFilter").value.trim().toLowerCase();
  const rows = d.cities.filter((c) => !f || c.city.toLowerCase().includes(f) || c.state.toLowerCase().includes(f))
    .sort((a, b) => SEV_ORDER[b.risk] - SEV_ORDER[a.risk] || a.city.localeCompare(b.city));
  $("#cityList").innerHTML = rows.length ? rows.map((c) =>
    `<div class="item click" data-city="${esc(c.city)}" style="--c:${COLORS[c.risk] || COLORS.NONE}"><div class="row"><b>${esc(c.city)} <span class="meta">${esc(c.state)}</span></b>` +
    `<span class="pill">${c.temperature === null ? "NO DATA" : esc(c.risk)}</span></div>` +
    `<div class="cgrid"><div><b>${fmt(c.temperature, 1)}°C</b>temp</div><div><b>${fmt(c.wind_speed, 0)}</b>km/h wind</div>` +
    `<div><b>${fmt(c.rain_today, 0)}</b>mm rain today</div><div><b style="color:${aqiInfo(c.aqi).color}">${fmt(c.aqi, 0)}</b>AQI</div></div></div>`).join("")
    : '<div class="empty">No city matches your search.</div>';
}
$("#cityFilter").addEventListener("input", () => state.data && renderCities(state.data));
$("#cityList").addEventListener("click", (e) => {
  const el = e.target.closest("[data-city]");
  if (!el) return;
  const c = state.data && state.data.cities.find((x) => x.city === el.dataset.city);
  if (c && cityMarkers[c.city]) { map.flyTo([c.lat, c.lon], 8); cityMarkers[c.city].openPopup(); window.scrollTo({ top: 0, behavior: "smooth" }); }
});

function myTokens() { try { return JSON.parse(safeGet("sos_tokens") || "{}"); } catch (e) { return {}; } }
function renderSos(d) {
  const tokens = myTokens();
  $("#sosList").innerHTML = d.sos.length ? d.sos.map((s) =>
    `<div class="item" style="--c:${s.status === "OPEN" ? COLORS.CRITICAL : COLORS.NORMAL}"><div class="row"><b>#${s.id} · ${esc(s.emergency_type)}</b><span class="pill">${esc(s.status)}</span></div>` +
    `<div class="meta">${esc(s.name)} · ${esc(s.near || "location not shared")} · ${esc(ago(s.created_ts))}</div>` +
    (tokens[s.id] && s.status === "OPEN" ? `<div style="margin-top:6px"><button class="mini-btn" data-safe="${s.id}">I am safe now</button></div>` : "") + `</div>`).join("")
    : '<div class="empty">No SOS requests. Press the red SOS button to test the feature.</div>';
}
$("#sosList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-safe]");
  if (!btn) return;
  const id = btn.dataset.safe;
  try {
    const r = await fetch(`/api/sos/${encodeURIComponent(id)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: myTokens()[id] }) });
    const j = await r.json();
    toast(j.ok ? "Marked safe" : "Could not update", j.ok ? "Glad you are safe. SOS closed." : (j.error || "Error"), j.ok ? "NORMAL" : "MEDIUM");
    refresh();
  } catch (err) { toast("Network error", "Could not reach the server.", "MEDIUM"); }
});

function renderStatus(d) {
  const names = Object.keys(d.status);
  $("#feedStatus").innerHTML = names.length ? names.map((n) =>
    `<div class="feed"><span class="dot ${d.status[n].ok ? "" : "bad"}"></span><b>${esc(n)}</b><span class="muted">— ${esc(d.status[n].text)}</span></div>`).join("") : '<div class="muted">Waiting for feeds...</div>';
  const b = d.summary.breakdown, total = b.CRITICAL + b.HIGH + b.MEDIUM;
  if (total > 0) {
    const p1 = (b.CRITICAL / total) * 100, p2 = p1 + (b.HIGH / total) * 100;
    $("#donut").style.background = `conic-gradient(${COLORS.CRITICAL} 0 ${p1}%, ${COLORS.HIGH} ${p1}% ${p2}%, ${COLORS.MEDIUM} ${p2}% 100%)`;
  } else $("#donut").style.background = "conic-gradient(var(--border) 0 100%)";
  $("#donutTotal").textContent = total;
  $("#donutLegend").innerHTML = ["CRITICAL", "HIGH", "MEDIUM"].map((k) => `<li><i style="background:${COLORS[k]}"></i>${k.charAt(0) + k.slice(1).toLowerCase()}: <b>${b[k]}</b></li>`).join("");
}

/* ---------- tabs / filters ---------- */
$("#tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + t.dataset.tab));
});
$("#alertFilters").addEventListener("click", (e) => {
  const c = e.target.closest(".fchip");
  if (!c) return;
  state.alertSev = c.dataset.sev;
  $$(".fchip").forEach((x) => x.classList.toggle("active", x === c));
  state.data && renderAlerts(state.data);
});

/* ---------- toasts + beep ---------- */
function toast(title, text, sev) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.style.setProperty("--c", COLORS[sev] || COLORS.MEDIUM);
  el.innerHTML = `<b>${esc(title)}</b>${esc(text)}`;
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), 8000);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "square"; osc.frequency.value = 880; gain.gain.value = 0.04;
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch (e) { /* audio not allowed yet */ }
}

/* ---------- polling ---------- */
async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Server error");
    const maxId = d.alerts.reduce((m, a) => Math.max(m, a.id), 0);
    if (state.lastAlertId !== null) {
      d.alerts.filter((a) => a.id > state.lastAlertId && SEV_ORDER[a.severity] >= 2).slice(0, 3).reverse()
        .forEach((a) => { toast(`${a.severity} · ${a.category}`, a.message, a.severity); beep(); });
    }
    state.lastAlertId = maxId;
    state.data = d;
    $("#thrVal").textContent = d.summary.quake_threshold.toFixed(1);
    renderStats(d.summary); renderBanner(d); renderMap(d); renderAlerts(d);
    renderQuakes(d); renderCities(d); renderSos(d); renderStatus(d); renderInsights(d);
  } catch (err) {
    const b = $("#banner");
    b.className = "banner err";
    b.innerHTML = `<span class="banner-icon">📡</span><span>Cannot reach the server (${esc(err.message)}). Retrying...</span>`;
  }
}

/* ---------- controls ---------- */
$("#thr").addEventListener("input", (e) => { $("#thrVal").textContent = Number(e.target.value).toFixed(1); });
$("#thrBtn").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quake_threshold: Number($("#thr").value) }) });
    const j = await r.json();
    toast(j.ok ? "Threshold updated" : "Error", j.ok ? `New earthquakes of M${j.quake_threshold.toFixed(1)}+ will raise alerts.` : j.error, j.ok ? "NORMAL" : "MEDIUM");
  } catch (e) { toast("Network error", "Could not reach the server.", "MEDIUM"); }
});
$("#refreshBtn").addEventListener("click", async () => {
  try { await fetch("/api/refresh", { method: "POST" }); toast("Refresh requested", "Fetching the latest data from all feeds...", "NORMAL"); setTimeout(refresh, 6000); }
  catch (e) { toast("Network error", "Could not reach the server.", "MEDIUM"); }
});

/* ---------- my location ---------- */
$("#locBtn").addEventListener("click", () => {
  const out = $("#myLoc");
  if (!navigator.geolocation) { out.textContent = "Geolocation is not supported by this browser."; return; }
  out.textContent = "Detecting your location...";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    try {
      const r = await fetch(`/api/nearby?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const c = j.city, a = aqiInfo(c.aqi);
      out.innerHTML = `<div class="item" style="--c:${COLORS[c.risk] || COLORS.NONE}"><div class="row"><b>${esc(c.city)}, ${esc(c.state)}</b><span class="pill">${esc(c.risk)}</span></div>` +
        `<div class="meta">${c.distance_km} km from you · ${esc(c.condition || "no data")}</div>` +
        `<div class="cgrid"><div><b>${fmt(c.temperature, 1)}°C</b>temp</div><div><b>${fmt(c.wind_speed, 0)}</b>km/h</div><div><b>${fmt(c.rain_today, 0)}</b>mm today</div><div><b style="color:${a.color}">${fmt(c.aqi, 0)}</b>AQI</div></div></div>` +
        (j.quakes.length ? "<b>Nearby earthquakes</b>" + j.quakes.map((q) => `<div class="meta">M${fmt(q.magnitude, 1)} · ${q.distance_km} km away · ${esc(ago(q.time_ms / 1000))}</div>`).join("") : '<div class="meta">No earthquakes within 1000 km in the last 7 days.</div>');
      if (state.myMarker) map.removeLayer(state.myMarker);
      state.myMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [16, 16] }) }).addTo(map).bindPopup("You are here");
    } catch (err) { out.textContent = "Could not load nearby data: " + err.message; }
  }, (err) => { out.textContent = "Location permission denied or unavailable (" + err.message + ")."; }, { enableHighAccuracy: true, timeout: 12000 });
});

/* ---------- SOS modal ---------- */
const modal = $("#sosModal");
function openSos() { modal.classList.remove("hidden"); $("#sosOk").classList.add("hidden"); $("#sosErr").textContent = ""; }
function closeSos() { modal.classList.add("hidden"); }
$("#sosBtn").addEventListener("click", openSos);
$("#sosClose").addEventListener("click", closeSos);
modal.addEventListener("click", (e) => { if (e.target === modal) closeSos(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSos(); });

$("#sosLocBtn").addEventListener("click", () => {
  if (!navigator.geolocation) { $("#sosErr").textContent = "Geolocation not supported. Type coordinates manually."; return; }
  $("#sosErr").textContent = "Detecting location...";
  navigator.geolocation.getCurrentPosition((pos) => {
    $("#sosLat").value = pos.coords.latitude.toFixed(5);
    $("#sosLon").value = pos.coords.longitude.toFixed(5);
    $("#sosErr").textContent = "";
  }, (err) => { $("#sosErr").textContent = "Could not get location: " + err.message; }, { enableHighAccuracy: true, timeout: 12000 });
});

$("#sosWa").addEventListener("click", () => {
  const lat = $("#sosLat").value.trim(), lon = $("#sosLon").value.trim();
  let text = `🆘 EMERGENCY (${$("#sosType").value}). I need help!`;
  if (lat && lon && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lon))) text += ` My location: https://maps.google.com/?q=${lat},${lon}`;
  const msg = $("#sosMsg").value.trim();
  if (msg) text += ` Details: ${msg}`;
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
});

$("#sosForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#sosErr"), btn = $("#sosSend");
  err.textContent = "";
  btn.disabled = true;
  try {
    const r = await fetch("/api/sos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emergency_type: $("#sosType").value, name: $("#sosName").value, phone: $("#sosPhone").value, message: $("#sosMsg").value, lat: $("#sosLat").value.trim(), lon: $("#sosLon").value.trim() })
    });
    const j = await r.json();
    if (!j.ok) { err.textContent = j.error || "Could not send SOS. Call 112."; return; }
    const tokens = myTokens(); tokens[j.id] = j.token; safeSet("sos_tokens", JSON.stringify(tokens));
    const ok = $("#sosOk");
    ok.classList.remove("hidden");
    ok.innerHTML = `<b>✅ SOS #${esc(j.id)} recorded.</b><br>It is now visible on the dashboard as a CRITICAL alert. This demo cannot dispatch help &mdash; <b>please also call <a href="tel:112">112</a></b>.<br>` +
      "Stay calm, move to a safe place and keep your phone reachable.";
    $("#sosForm").reset();
    refresh();
  } catch (ex) {
    err.textContent = "Network error - please call 112 directly.";
  } finally { btn.disabled = false; }
});

/* ---------- safety guide ---------- */
const GUIDE = {
  "🌍 Earthquake": { before: ["Secure heavy furniture and water heaters to walls", "Identify safe spots: under sturdy tables, away from glass", "Keep a go-bag: water, torch, first-aid, documents, power bank"], during: ["DROP, COVER and HOLD ON", "Stay away from windows, mirrors and heavy objects", "Outdoors: move to an open area away from buildings and wires", "Never use lifts"], after: ["Expect aftershocks", "Check for gas leaks and damaged wiring", "Use stairs, wear shoes, follow official updates", "Call 112 / 108 for injuries"] },
  "🌊 Flood": { before: ["Know your nearest high ground and evacuation route", "Keep documents in waterproof bags", "Store drinking water and dry food for 3 days"], during: ["Move to higher ground immediately", "Do not walk or drive through flood water", "Switch off main power if water enters your home"], after: ["Avoid contaminated water; boil before drinking", "Watch for snakes and broken power lines", "Photograph damage for relief claims"] },
  "🌀 Cyclone": { before: ["Track IMD warnings; charge phones and power banks", "Secure roofs, doors and loose outdoor items", "Stock 3 days of food, water and medicines"], during: ["Stay indoors away from windows", "Evacuate promptly if officials ask you to", "Do not go out in the calm 'eye' of the storm"], after: ["Beware of fallen power lines", "Avoid damaged buildings", "Use only boiled or bottled water"] },
  "🔥 Heatwave": { before: ["Keep ORS, water and light cotton clothing ready", "Use curtains or shades to keep rooms cool"], during: ["Drink water often, even if not thirsty", "Avoid going out between 12 PM and 4 PM", "Never leave children or pets in parked vehicles"], after: ["Heat-stroke signs: confusion, very hot dry skin, fainting", "Cool the person with wet cloths and call 108"] },
  "🏠 Fire": { before: ["Install smoke alarms; know two exits", "Keep fire extinguisher and emergency numbers handy"], during: ["Get out, stay out, call 101", "Crawl low under smoke; close doors behind you", "Stop, Drop and Roll if clothes catch fire", "Never use lifts"], after: ["Do not re-enter until firefighters allow", "Seek medical care for smoke inhalation"] },
  "⛰️ Landslide": { before: ["Avoid building on steep slopes or near drainage paths", "Watch for new cracks, tilting trees or muddy streams"], during: ["Move away from the slide path, uphill sideways, not downhill", "Listen for unusual rumbling sounds", "Evacuate during very heavy rain in hilly areas"], after: ["Stay away from the slide area; more slides may follow", "Report broken utilities and blocked roads"] },
  "⛈️ Thunderstorm": { before: ["Check forecasts; postpone outdoor plans"], during: ["Stay indoors; avoid open fields, hilltops and tall trees", "Stay away from water and metal fences", "Unplug sensitive electronics"], after: ["Wait 30 minutes after the last thunder before going out", "Keep away from fallen wires"] }
};
function renderGuide(key) {
  const g = GUIDE[key];
  $$(".gtab").forEach((t) => t.classList.toggle("active", t.dataset.k === key));
  const col = (title, arr) => `<div class="gcol"><h3>${title}</h3><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  $("#guideBody").innerHTML = col("✅ Before", g.before) + col("⚡ During", g.during) + col("🩹 After", g.after);
}
$("#guideTabs").innerHTML = Object.keys(GUIDE).map((k) => `<button class="gtab" data-k="${esc(k)}">${esc(k)}</button>`).join("");
$("#guideTabs").addEventListener("click", (e) => { const t = e.target.closest(".gtab"); if (t) renderGuide(t.dataset.k); });

/* ---------- insights: highlights, risk gauge, weekly chart, rankings ---------- */
const RANK = {
  aqi: { key: "aqi", unit: "", color: (v) => aqiInfo(v).color },
  temp: { key: "temperature", unit: " °C", color: tempColor },
  wind: { key: "wind_speed", unit: " km/h", color: () => "#38bdf8" },
  rain: { key: "rain_today", unit: " mm", color: () => "#6366f1" }
};
state.rank = "aqi";

function renderHighlights(d) {
  const cs = d.cities.filter((c) => c.temperature !== null && c.temperature !== undefined);
  const pick = (key, dir) => cs.filter((c) => c[key] !== null && c[key] !== undefined).sort((a, b) => dir * (b[key] - a[key]))[0];
  const items = [
    ["🔥", "Hottest", pick("temperature", 1), (c) => fmt(c.temperature, 1, " °C")],
    ["❄️", "Coolest", pick("temperature", -1), (c) => fmt(c.temperature, 1, " °C")],
    ["💨", "Windiest", pick("wind_speed", 1), (c) => fmt(c.wind_speed, 0, " km/h")],
    ["🌧️", "Wettest today", pick("rain_today", 1), (c) => fmt(c.rain_today, 0, " mm")],
    ["😷", "Most polluted", pick("aqi", 1), (c) => "AQI " + fmt(c.aqi, 0)]
  ].filter((x) => x[2]);
  $("#highlights").innerHTML = items.map(([ico, lbl, c, f]) =>
    `<div class="hl"><span class="hl-ico">${ico}</span><div><div class="hl-lbl">${esc(lbl)}</div><div class="hl-city">${esc(c.city)}</div></div><div class="hl-val">${esc(f(c))}</div></div>`).join("");
}

function renderGauge(d) {
  let score = 0, qs = 0;
  d.cities.forEach((c) => { score += { CRITICAL: 12, HIGH: 6, MEDIUM: 2 }[c.risk] || 0; });
  d.quakes.forEach((q) => { if (Date.now() - q.time_ms < 86400000 && q.near_km <= 600) qs += q.magnitude >= 6 ? 25 : q.magnitude >= 5 ? 10 : q.magnitude >= 4 ? 3 : 0; });
  score = Math.min(100, Math.round(score + Math.min(40, qs) + Math.min(15, d.summary.open_sos * 5)));
  const lvl = score < 20 ? ["LOW", COLORS.NORMAL] : score < 45 ? ["MODERATE", COLORS.MEDIUM] : score < 70 ? ["HIGH", COLORS.HIGH] : ["SEVERE", COLORS.CRITICAL];
  const arc = "M 15 105 A 85 85 0 0 1 185 105";
  $("#gauge").innerHTML = `<svg viewBox="0 0 200 125" role="img" aria-label="National risk index ${score} of 100, ${lvl[0]}">` +
    `<path d="${arc}" fill="none" stroke="var(--border)" stroke-width="16" stroke-linecap="round"/>` +
    `<path d="${arc}" fill="none" stroke="${lvl[1]}" stroke-width="16" stroke-linecap="round" pathLength="100" stroke-dasharray="${score} 100"/>` +
    `<text x="100" y="88" text-anchor="middle" class="g-score">${score}</text>` +
    `<text x="100" y="112" text-anchor="middle" class="g-lbl" fill="${lvl[1]}">${lvl[0]}</text></svg>`;
}

function renderWeek(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const s = new Date(today); s.setDate(today.getDate() - i);
    days.push({ start: s.getTime(), end: s.getTime() + 86400000, n: 0, max: 0, label: s.toLocaleDateString("en-IN", { weekday: "short" }) });
  }
  d.quakes.forEach((q) => { const day = days.find((x) => q.time_ms >= x.start && q.time_ms < x.end); if (day) { day.n++; day.max = Math.max(day.max, q.magnitude); } });
  const top = Math.max(1, ...days.map((x) => x.n));
  $("#weekChart").innerHTML = days.map((x) =>
    `<div class="wk" title="${x.n} quakes, max M${x.max ? x.max.toFixed(1) : "-"}"><span class="wk-n">${x.n}</span>` +
    `<div class="wk-bar" style="height:${Math.max(4, (x.n / top) * 100)}%;background:${x.max ? quakeColor(x.max) : "var(--border)"}"></div><span class="wk-l">${esc(x.label)}</span></div>`).join("");
}

function renderRank(d) {
  const cfg = RANK[state.rank];
  const list = d.cities.filter((c) => c[cfg.key] !== null && c[cfg.key] !== undefined)
    .sort((a, b) => b[cfg.key] - a[cfg.key]).slice(0, 8);
  if (!list.length) { $("#rankList").innerHTML = '<div class="empty">Waiting for data...</div>'; return; }
  const max = Math.max(1, list[0][cfg.key]);
  $("#rankList").innerHTML = list.map((c, i) => {
    const v = c[cfg.key];
    return `<div class="rk"><span class="rk-n">${i + 1}</span><span class="rk-c">${esc(c.city)}</span>` +
      `<div class="rk-bar"><i style="width:${Math.max(3, (Math.max(v, 0) / max) * 100)}%;background:${cfg.color(v)}"></i></div><b>${esc(fmt(v, cfg.key === "aqi" ? 0 : 1))}${esc(cfg.unit)}</b></div>`;
  }).join("");
}
$("#rankSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.rank = b.dataset.m;
  $$("#rankSeg button").forEach((x) => x.classList.toggle("active", x === b));
  state.data && renderRank(state.data);
});

function renderInsights(d) { renderHighlights(d); renderGauge(d); renderWeek(d); renderRank(d); }

/* ---------- start ---------- */
applyTheme(safeGet("theme") === "light" ? "light" : "dark");
renderLegend();
renderGuide(Object.keys(GUIDE)[0]);
refresh();
setInterval(refresh, 10000);

/* ---------- town search & on-demand fetch ---------- */
let searchTimer;
$("#townSearch").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $("#searchResults");
  if (q.length < 3) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="muted small" style="padding:8px">Searching towns...</div>';
  
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
      const d = await r.json();
      if (!d.results) { box.innerHTML = '<div class="muted small" style="padding:8px">No results found</div>'; return; }
      
      const ind = d.results.filter(x => x.country_code === "IN");
      if (!ind.length) { box.innerHTML = '<div class="muted small" style="padding:8px">No Indian towns found</div>'; return; }
      
      box.innerHTML = ind.map(x => `<div class="search-item" data-lat="${x.latitude}" data-lon="${x.longitude}" data-name="${esc(x.name)}" data-st="${esc(x.admin1 || '')}"><b>${esc(x.name)}</b>, ${esc(x.admin1 || '')}</div>`).join("");
    } catch (err) { 
      box.innerHTML = '<div class="muted small" style="padding:8px">Search error</div>'; 
    }
  }, 500);
});

$("#searchResults").addEventListener("click", async (e) => {
  const item = e.target.closest(".search-item");
  if (!item) return;
  const { lat, lon, name, st } = item.dataset;
  
  $("#searchResults").innerHTML = "";
  $("#townSearch").value = `${name}, ${st}`;
  const out = $("#myLoc");
  out.innerHTML = '<div class="muted" style="margin-top:12px">Fetching live data for ' + esc(name) + '...</div>';

  try {
    const [wxRes, aqiRes, qkRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation,weather_code&daily=precipitation_sum&timezone=auto`),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=auto`),
      fetch(`/api/nearby?lat=${lat}&lon=${lon}`)
    ]);
    
    const wData = await wxRes.json();
    const aData = await aqiRes.json();
    const qData = await qkRes.json();

    const t = wData.current.temperature_2m;
    const w = wData.current.wind_speed_10m;
    const r = wData.daily?.precipitation_sum?.[0] || 0;
    const a = aData.current?.us_aqi || null;
    const aqiInf = aqiInfo(a);

    out.innerHTML = `<div class="item" style="--c:${tempColor(t)}; margin-top:12px;">
      <div class="row"><b>${esc(name)}, ${esc(st)}</b><span class="pill" style="background:${tempColor(t)}">Live</span></div>
      <div class="cgrid">
        <div><b>${fmt(t, 1)}°C</b>temp</div>
        <div><b>${fmt(w, 0)}</b>km/h</div>
        <div><b>${fmt(r, 0)}</b>mm today</div>
        <div><b style="color:${aqiInf.color}">${fmt(a, 0)}</b>AQI</div>
      </div>
    </div>` + (qData.quakes?.length ? "<b>Nearby earthquakes</b>" + qData.quakes.map(q => `<div class="meta">M${fmt(q.magnitude, 1)} · ${q.distance_km} km away · ${esc(ago(q.time_ms / 1000))}</div>`).join("") : '<div class="meta">No earthquakes within 1000 km.</div>');
    
    if (state.myMarker) map.removeLayer(state.myMarker);
    state.myMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [16, 16] }) }).addTo(map).bindPopup(`<b>${esc(name)}</b>`).openPopup();
    map.flyTo([lat, lon], 9);
  } catch (err) { 
    out.textContent = "Error loading details for this town."; 
  }
});