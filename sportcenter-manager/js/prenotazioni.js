// ============================================================
// prenotazioni.js — pannello OPERATORE (dietro login, permesso
// prenotazioni:gestisci) per il campo padel. Le prenotazioni vere si
// fanno dalla pagina pubblica prenota-padel.html; qui l'operatore
// verifica/gestisce: ricerca per codice, tabellone del giorno, annulla
// e converti in credito, lista giornaliera stampabile (terzo livello di
// verifica al campo se QR e codice non sono disponibili, es. senza
// internet).
//
// Legge "bookingTickets" (dati completi, list riservata a
// prenotazioni:gestisci — vedi firestore.rules) e "bookings" (stato
// aggiornato) incrociandoli per bookingId.
// ============================================================

let currentProfile = null;

const COURT_ID = "1";
const NR_GIORNI_STRIP = 14;
const GIORNI_BREVI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

// Stessa logica anti-buco di js/prenota-padel.js e functions/index.js —
// duplicata anche qui (terza copia): se cambia va cambiata ovunque.
const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const CLOSE_WEEKEND = 20 * 60 + 30;
const BOUNDARY = 17 * 60;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const PX_PER_MIN = 1.1;
const EDGE_PAD = 10;
const FESTIVI = [];

// Duplicato da js/prenota-padel.js e functions/index.js — vedi lì per il
// perché del fuso orario esplicito invece di new Date() nudo.
function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}
function escludiOrariPassati(starts, dataIso) {
  const ora = oraLocaleZurigo();
  if (dataIso !== ora.dataIso) return starts;
  return starts.filter(s => s > ora.minuti);
}

function chiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return (giorno === 0 || giorno === 6 || FESTIVI.includes(dataIso)) ? CLOSE_WEEKEND : CLOSE;
}
function px(min) { return (min - OPEN) * PX_PER_MIN + EDGE_PAD; }
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}
function label(min) { return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); }

function freeIntervals(bookings, close) {
  const sorted = [...bookings].sort((a, b) => a.start - b.start);
  const free = [];
  let cursor = OPEN;
  sorted.forEach(b => {
    if (b.start > cursor) free.push([cursor, b.start]);
    cursor = Math.max(cursor, b.end);
  });
  if (cursor < close) free.push([cursor, close]);
  return free;
}
function gapPrimaOk(t, a) {
  const gap = t - a;
  return gap === 0 || gap >= 60;
}
function slotsInInterval(a, b, duration) {
  const starts = [];
  if (duration === 90) {
    for (let t = a; t < BOUNDARY && t + 90 <= b; t += 30) {
      const remain = b - (t + 90);
      if ((remain === 0 || remain >= 60) && gapPrimaOk(t, a)) starts.push(t);
    }
    const primoChain = Math.max(a, BOUNDARY);
    if (gapPrimaOk(primoChain, a)) {
      for (let t = primoChain; t + 90 <= b; t += 90) starts.push(t);
    }
    if (SLOT_FISSO_PRANZO >= a && SLOT_FISSO_PRANZO + 90 <= b && gapPrimaOk(SLOT_FISSO_PRANZO, a)) {
      const remain = b - (SLOT_FISSO_PRANZO + 90);
      if (remain === 0 || remain >= 60) starts.push(SLOT_FISSO_PRANZO);
    }
  } else {
    const limit = Math.min(b, BOUNDARY + 30);
    for (let t = a; t + 60 <= limit; t += 30) {
      const remain = limit - (t + 60);
      if ((remain === 0 || remain >= 60) && gapPrimaOk(t, a)) starts.push(t);
    }
    if (SLOT_FISSO_PRANZO >= a && SLOT_FISSO_PRANZO + 60 <= limit && gapPrimaOk(SLOT_FISSO_PRANZO, a)) {
      const remain = limit - (SLOT_FISSO_PRANZO + 60);
      if (remain === 0 || remain >= 60) starts.push(SLOT_FISSO_PRANZO);
    }
  }
  return starts;
}
function validStarts(bookings, duration, close) {
  const free = freeIntervals(bookings, close);
  let starts = [];
  free.forEach(([a, b]) => { starts = starts.concat(slotsInInterval(a, b, duration)); });
  return [...new Set(starts)].sort((x, y) => x - y);
}

const STATO_LABEL = {
  PENDING_PAYMENT: "In pagamento",
  CONFIRMED: "Confermata",
  COMPLETED: "Completata",
  CANCELLED: "Annullata",
  CREDITED: "Convertita in credito"
};
const STATO_STILE = {
  CONFIRMED: "border-color:#7f9e4a;color:#c1e08f;",
  COMPLETED: "border-color:#7f9e4a;color:#c1e08f;",
  PENDING_PAYMENT: "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);",
  CANCELLED: "border-color:var(--danger);color:var(--danger);",
  CREDITED: "border-color:#4a7f9e;color:#8fc1e0;"
};

let state = { data: null, duration: null, selected: null, bookingsMinuti: [] };

function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}
function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "—";
  const d = ts.toDate();
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} alle ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------- Day strip ----------

function buildDayStrip() {
  const el = document.getElementById("dayStrip");
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);

  const giorni = [];
  for (let i = 0; i < NR_GIORNI_STRIP; i++) {
    const d = new Date(oggi);
    d.setDate(oggi.getDate() + i);
    giorni.push(d);
  }

  el.innerHTML = giorni.map(d => {
    const iso = toISO(d);
    return `
      <button type="button" class="day-btn" role="tab" data-data="${iso}" aria-pressed="${iso === state.data}">
        <span class="d">${GIORNI_BREVI[d.getDay()]}</span>
        <span class="n">${d.getDate()}</span>
      </button>
    `;
  }).join("");

  el.querySelectorAll(".day-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.data = btn.dataset.data;
      document.querySelectorAll(".day-btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.data === state.data)));
      caricaGiorno();
    });
  });
}

// ---------- Tabellone del giorno ----------

async function caricaGiorno() {
  const list = document.getElementById("lista-giorno");
  const errorEl = document.getElementById("lista-error");
  errorEl.innerHTML = "";
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  try {
    const [ticketsSnap, bookingsSnap] = await Promise.all([
      db.collection("bookingTickets").where("date", "==", state.data).where("courtId", "==", COURT_ID).get(),
      db.collection("bookings").where("date", "==", state.data).where("courtId", "==", COURT_ID).get()
    ]);

    const infoPerBookingId = {};
    bookingsSnap.docs.forEach(d => { infoPerBookingId[d.id] = d.data(); });

    let righe = ticketsSnap.docs
      .map(d => ({ token: d.id, ...d.data() }))
      .map(t => ({
        ...t,
        status: (infoPerBookingId[t.bookingId] || {}).status || "CONFIRMED",
        type: (infoPerBookingId[t.bookingId] || {}).type || "CUSTOMER"
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    // I blocchi hanno un motivo in una collection separata (non
    // pubblica, vedi firestore.rules) — lo si recupera solo per loro.
    const idBlocchi = righe.filter(t => t.type === "BLOCK").map(t => t.bookingId);
    if (idBlocchi.length > 0) {
      const motivi = await Promise.all(idBlocchi.map(id => db.collection("blockDetails").doc(id).get()));
      const motivoPerBookingId = {};
      motivi.forEach(doc => { if (doc.exists) motivoPerBookingId[doc.id] = doc.data().motivo; });
      righe = righe.map(t => t.type === "BLOCK" ? { ...t, motivo: motivoPerBookingId[t.bookingId] } : t);
    }

    renderGiorno(list, righe);

    // Per il selettore orario sotto (blocco/esente): stessi impegni del
    // giorno, in minuti, usati dall'anti-buco.
    state.bookingsMinuti = bookingsSnap.docs
      .map(d => d.data())
      .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
      .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));
    state.selected = null;
    renderPicker();
  } catch (err) {
    showError(errorEl, "Errore nel caricamento: " + err.message);
    list.innerHTML = "";
  }
}

function rigaHtml(t) {
  const stato = t.type === "BLOCK" ? "Bloccato" : (t.type === "STAFF_EXEMPT" ? "Esente (maestro)" : (STATO_LABEL[t.status] || t.status));
  const stile = t.type === "BLOCK" ? "border-color:var(--danger);color:var(--danger);"
    : t.type === "STAFF_EXEMPT" ? "border-color:#9e4a7f;color:#e08fc1;"
    : (STATO_STILE[t.status] || "");
  return `
    <div class="entry-card" data-booking-id="${t.bookingId}">
      <div class="entry-main">
        <span class="badge" style="${stile}">${stato}</span>
        <div class="entry-tipo">${t.startTime} – ${t.endTime}</div>
        <div class="entry-meta">Codice: ${escapeHtml(t.bookingCode)} · CHF ${(t.price || 0).toFixed(2)}</div>
        ${t.type === "BLOCK" && t.motivo ? `<div class="entry-meta">Motivo: ${escapeHtml(t.motivo)}</div>` : ""}
        <div class="entry-meta">Prenotato il ${formatTimestamp(t.createdAt)}</div>
      </div>
      ${(t.type === "CUSTOMER" && (t.status === "CONFIRMED" || t.status === "COMPLETED")) ? `<button type="button" class="btn btn-danger annulla-credito-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-booking-id="${t.bookingId}">Annulla e converti in credito</button>` : ""}
    </div>
  `;
}

function renderGiorno(list, righe) {
  if (righe.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessuna prenotazione</div></div>`;
    return;
  }
  list.innerHTML = righe.map(rigaHtml).join("");
  wireAnnullaCredito(list);
}

function wireAnnullaCredito(container) {
  container.querySelectorAll(".annulla-credito-btn").forEach(btn => {
    btn.addEventListener("click", () => annullaEConverti(btn.dataset.bookingId, btn));
  });
}

async function annullaEConverti(bookingId, btn) {
  if (!confirm("Annullare questa prenotazione e convertirla in credito per il cliente?")) return;
  btn.disabled = true;
  try {
    const fn = firebase.functions().httpsCallable("annullaEConvertiInCredito");
    const result = await fn({ bookingId });
    alert(`Credito creato: ${result.data.creditCode} — CHF ${result.data.importo.toFixed(2)}\n\nComunicalo al cliente per una prenotazione futura.`);
    await caricaGiorno();
  } catch (err) {
    alert("Errore: " + err.message);
    btn.disabled = false;
  }
}

// ---------- Selettore orario: blocco slot / prenotazione esente ----------
//
// Stesso giorno scelto sopra. Entrambi i casi passano dalla Cloud
// Function creaPrenotazioneOperatore (mai una scrittura diretta), che
// ricontrolla permessi e slot lato server.

function hourGridHtml(close) {
  let html = `<div class="gutter-line"></div>`;
  const ultimaOra = Math.floor(close / 60);
  for (let h = 8; h <= ultimaOra; h++) {
    const top = px(h * 60);
    html += `<div class="hour-row" style="top:${top}px"></div>
             <div class="hour-label" style="top:${top}px">${pad2(h)}:00</div>`;
    if (h * 60 + 30 <= close) {
      const halfTop = px(h * 60 + 30);
      html += `<div class="half-row" style="top:${halfTop}px"></div>
               <div class="half-label" style="top:${halfTop}px">${pad2(h)}:30</div>`;
    }
  }
  const bTop = px(BOUNDARY);
  html += `<div class="boundary-line" style="top:${bTop}px"></div>
           <div class="boundary-label" style="top:${bTop}px">17:00 → solo 90'</div>`;
  return html;
}

function renderPicker() {
  const timelineEl = document.getElementById("timeline");
  if (!timelineEl || !state.data) return;

  const close = chiusuraGiorno(state.data);
  timelineEl.style.height = (px(close) + EDGE_PAD) + "px";

  let html = hourGridHtml(close);
  html += state.bookingsMinuti.map(b => `
    <div class="busy" style="top:${px(b.start)}px;height:${px(b.end) - px(b.start)}px">
      <span class="name">Occupato</span>
      <span class="time">${label(b.start)}–${label(b.end)}</span>
    </div>
  `).join("");

  if (state.duration) {
    const starts = escludiOrariPassati(validStarts(state.bookingsMinuti, state.duration, close), state.data);
    html += starts.map(s => {
      const end = s + state.duration;
      const isSel = state.selected && state.selected.start === s;
      return `<div class="slot" role="button" tabindex="0" data-selected="${!!isSel}"
                data-start="${s}" data-end="${end}"
                style="top:${px(s)}px;height:${px(end) - px(s)}px"
                aria-label="${label(s)}–${label(end)}">
                <span class="time">${label(s)}–${label(end)}</span>
              </div>`;
    }).join("");
  }

  timelineEl.innerHTML = html;

  timelineEl.querySelectorAll(".slot").forEach(el => {
    const activate = () => {
      state.selected = { start: parseInt(el.dataset.start, 10), end: parseInt(el.dataset.end, 10) };
      renderPicker();
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
  });

  const bar = document.getElementById("summaryBar");
  if (state.selected) {
    document.getElementById("summaryTitle").textContent = `${label(state.selected.start)}–${label(state.selected.end)}`;
    bar.classList.add("show");
  } else {
    bar.classList.remove("show");
  }
}

async function creaPrenotazioneOperatore(tipo) {
  if (!state.selected || !state.duration) return;
  const errorEl = document.getElementById("picker-error");
  errorEl.innerHTML = "";

  let motivo = null;
  if (tipo === "BLOCK") {
    motivo = prompt("Motivo del blocco (es. manutenzione campo, evento privato):", "Manutenzione campo");
    if (motivo === null) return;
  } else if (!confirm(`Confermare la prenotazione esente per ${label(state.selected.start)}–${label(state.selected.end)}?`)) {
    return;
  }

  try {
    const fn = firebase.functions().httpsCallable("creaPrenotazioneOperatore");
    await fn({
      courtId: COURT_ID,
      date: state.data,
      startTime: label(state.selected.start),
      endTime: label(state.selected.end),
      durationMinutes: state.duration,
      tipo,
      motivo
    });
    state.selected = null;
    state.duration = null;
    document.querySelectorAll("#durationSeg button").forEach(b => b.setAttribute("aria-pressed", "false"));
    await caricaGiorno();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  }
}

// ---------- Ricerca per codice ----------

async function cercaCodice() {
  const input = document.getElementById("ricerca-codice");
  const errorEl = document.getElementById("ricerca-error");
  const risultato = document.getElementById("ricerca-risultato");
  errorEl.innerHTML = "";
  risultato.innerHTML = "";

  const code = input.value.trim().toUpperCase();
  if (!code) return;

  try {
    const idx = await db.collection("bookingCodes").doc(code).get();
    if (!idx.exists) {
      showError(errorEl, "Nessuna prenotazione trovata con questo codice.");
      return;
    }
    const { bookingId, token } = idx.data();
    const [ticketSnap, bookingSnap] = await Promise.all([
      db.collection("bookingTickets").doc(token).get(),
      db.collection("bookings").doc(bookingId).get()
    ]);
    if (!ticketSnap.exists) {
      showError(errorEl, "Biglietto non trovato.");
      return;
    }
    const t = { token, ...ticketSnap.data(), status: bookingSnap.exists ? bookingSnap.data().status : "CONFIRMED" };
    risultato.innerHTML = rigaHtml(t);
    wireAnnullaCredito(risultato);
  } catch (err) {
    showError(errorEl, "Errore nella ricerca: " + err.message);
  }
}

// ---------- Stampa lista giornaliera ----------
//
// Terzo livello di verifica al campo (dopo QR e codice): una lista
// leggibile anche offline se internet/Firebase/il computer non
// funzionano — va stampata prima di quel momento, non durante.
async function stampaListaGiorno() {
  const [ticketsSnap, bookingsSnap] = await Promise.all([
    db.collection("bookingTickets").where("date", "==", state.data).where("courtId", "==", COURT_ID).get(),
    db.collection("bookings").where("date", "==", state.data).where("courtId", "==", COURT_ID).get()
  ]);
  const statoPerBookingId = {};
  bookingsSnap.docs.forEach(d => { statoPerBookingId[d.id] = d.data().status; });

  const righe = ticketsSnap.docs
    .map(d => d.data())
    .map(t => ({ ...t, status: statoPerBookingId[t.bookingId] || "CONFIRMED" }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const corpo = righe.map(t =>
    `<tr><td>${t.startTime}-${t.endTime}</td><td>${escapeHtml(t.bookingCode)}</td><td>${STATO_LABEL[t.status] || t.status}</td><td>${formatTimestamp(t.createdAt)}</td></tr>`
  ).join("");

  document.getElementById("print-area").innerHTML = `
    <h1>Campo ${COURT_ID} — ${formatDataBreve(state.data)}</h1>
    <p>Lista generata il ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <thead><tr><th>Orario</th><th>Codice</th><th>Stato</th><th>Prenotato il</th></tr></thead>
      <tbody>${corpo || "<tr><td colspan=4>Nessuna prenotazione</td></tr>"}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "prenotazioni:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("operatore-content").classList.add("hidden");
    return;
  }

  state.data = toISO(new Date());
  buildDayStrip();

  document.getElementById("ricerca-btn").addEventListener("click", cercaCodice);
  document.getElementById("ricerca-codice").addEventListener("keydown", e => { if (e.key === "Enter") cercaCodice(); });
  document.getElementById("stampa-lista-btn").addEventListener("click", stampaListaGiorno);

  document.querySelectorAll("#durationSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      const dur = parseInt(btn.dataset.dur, 10);
      state.duration = (state.duration === dur) ? null : dur;
      state.selected = null;
      document.querySelectorAll("#durationSeg button").forEach(b =>
        b.setAttribute("aria-pressed", String(parseInt(b.dataset.dur, 10) === state.duration))
      );
      renderPicker();
    });
  });
  document.getElementById("blocca-btn").addEventListener("click", () => creaPrenotazioneOperatore("BLOCK"));
  document.getElementById("esente-btn").addEventListener("click", () => creaPrenotazioneOperatore("STAFF_EXEMPT"));

  await caricaGiorno();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
