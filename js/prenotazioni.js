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
const DISCIPLINA = "Padel"; // i campi sono numerati per disciplina, va sempre indicata
const NR_GIORNI_STRIP = 14;
const GIORNI_BREVI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

// Stessa logica anti-buco di js/prenota-padel.js e functions/index.js —
// duplicata anche qui (terza copia): se cambia va cambiata ovunque.
const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const BOUNDARY = 17 * 60;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const SLOT_FISSO_SERALE = 17 * 60 + 30; // 17:30, solo lun-ven, solo 90'
const PX_PER_MIN = 1.1;
const EDGE_PAD = 10;

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
function eOggi(dataIso) {
  return dataIso === oraLocaleZurigo().dataIso;
}

// Duplicato da js/prenota-padel.js e functions/index.js.
const PENDING_SCADUTO_MINUTI = 15;
function pendingScaduto(booking) {
  if (booking.status !== "PENDING_PAYMENT") return false;
  if (!booking.createdAt || typeof booking.createdAt.toMillis !== "function") return false;
  return (Date.now() - booking.createdAt.toMillis()) > PENDING_SCADUTO_MINUTI * 60000;
}

// Un giorno festivo (IMPOSTAZIONI.festivi, js/utils.js) accorcia l'orario
// come sabato/domenica, fino a IMPOSTAZIONI.chiusuraWeekend (configurabile
// da Configurazione → Impostazioni generali, default "20:30") — stesso
// criterio del server.
function chiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  const chiusuraWeekend = orarioToMin(IMPOSTAZIONI.chiusuraWeekend || "20:30");
  return (giorno === 0 || giorno === 6 || (IMPOSTAZIONI.festivi || []).includes(dataIso)) ? chiusuraWeekend : CLOSE;
}
function feriale(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !(IMPOSTAZIONI.festivi || []).includes(dataIso);
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
function slotsInInterval(a, b, duration, feriale, oggi) {
  const starts = [];
  if (duration === 90) {
    for (let t = a; t < BOUNDARY && t + 90 <= b; t += 30) {
      const remain = b - (t + 90);
      if ((remain === 0 || remain >= 60) && gapPrimaOk(t, a)) starts.push(t);
    }
    // Oggi la catena dei 90' dopo le 17:00 usa un passo più fine (15'
    // invece di 90') così non nasconde disponibilità reale nelle
    // prossime ore — vedi js/prenota-padel.js per i dettagli.
    const primoChain = Math.max(a, BOUNDARY);
    if (gapPrimaOk(primoChain, a)) {
      const passo = oggi ? 15 : 90;
      for (let t = primoChain; t + 90 <= b; t += passo) starts.push(t);
    }
    if (SLOT_FISSO_PRANZO >= a && SLOT_FISSO_PRANZO + 90 <= b && gapPrimaOk(SLOT_FISSO_PRANZO, a)) {
      const remain = b - (SLOT_FISSO_PRANZO + 90);
      if (remain === 0 || remain >= 60) starts.push(SLOT_FISSO_PRANZO);
    }
    // 17:30 dal lunedì al venerdì: fascia serale fissa aggiuntiva, come
    // il pranzo. Non nel weekend/festivi.
    if (feriale && SLOT_FISSO_SERALE >= a && SLOT_FISSO_SERALE + 90 <= b && gapPrimaOk(SLOT_FISSO_SERALE, a)) {
      const remain = b - (SLOT_FISSO_SERALE + 90);
      if (remain === 0 || remain >= 60) starts.push(SLOT_FISSO_SERALE);
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
function validStarts(bookings, duration, close, feriale, oggi) {
  const free = freeIntervals(bookings, close);
  let starts = [];
  free.forEach(([a, b]) => { starts = starts.concat(slotsInInterval(a, b, duration, feriale, oggi)); });
  return [...new Set(starts)].sort((x, y) => x - y);
}

const STATO_LABEL = {
  PENDING_PAYMENT: "In pagamento",
  PENDING_CONFIRMATION: "In conferma (community)",
  CONFIRMED: "Confermata",
  COMPLETED: "Completata",
  CANCELLED: "Annullata",
  CREDITED: "Convertita in credito"
};
const STATO_STILE = {
  CONFIRMED: "border-color:#7f9e4a;color:#c1e08f;",
  COMPLETED: "border-color:#7f9e4a;color:#c1e08f;",
  PENDING_PAYMENT: "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);",
  PENDING_CONFIRMATION: "border-color:#d4b83a;color:#e0c85a;",
  CANCELLED: "border-color:var(--danger);color:var(--danger);",
  CREDITED: "border-color:#4a7f9e;color:#8fc1e0;"
};

let state = { data: null, duration: null, selected: null, bookingsMinuti: [] };

// Giorni di chiusura totale (collection "chiusurePadel", gestiti più
// sotto in questa stessa pagina) — diverso da IMPOSTAZIONI.festivi +
// chiusuraGiorno, che si limita ad accorciare l'orario: qui il campo non
// è prenotabile da nessuno, nemmeno per blocchi/prenotazioni esenti.
let CHIUSURE_PADEL = new Set();
async function caricaChiusurePadel() {
  const snap = await db.collection("chiusurePadel").get();
  CHIUSURE_PADEL = new Set(snap.docs.map(d => d.id));
}

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
      <button type="button" class="day-btn${CHIUSURE_PADEL.has(iso) ? " chiuso" : ""}" role="tab" data-data="${iso}" aria-pressed="${iso === state.data}">
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

    // Motivo (solo blocchi) e chi ha creato la prenotazione sono in una
    // collection separata, non pubblica (vedi firestore.rules) — serve
    // per entrambi i tipi: mostra "prenotato da" e, per chi ha solo
    // prenotazioni:proprie, decide se può eliminarla (solo le proprie).
    const idOperatore = righe.filter(t => t.type === "BLOCK" || t.type === "STAFF_EXEMPT").map(t => t.bookingId);
    if (idOperatore.length > 0) {
      const dettagli = await Promise.all(idOperatore.map(id => db.collection("blockDetails").doc(id).get()));
      const dettaglioPerBookingId = {};
      dettagli.forEach(doc => { if (doc.exists) dettaglioPerBookingId[doc.id] = doc.data(); });
      righe = righe.map(t => (t.type === "BLOCK" || t.type === "STAFF_EXEMPT")
        ? { ...t, ...dettaglioPerBookingId[t.bookingId] }
        : t);
    }

    renderGiorno(list, righe);

    // Per il selettore orario sotto (blocco/esente): stessi impegni del
    // giorno, in minuti, usati dall'anti-buco.
    state.bookingsMinuti = bookingsSnap.docs
      .map(d => d.data())
      .filter(b => (b.status === "PENDING_PAYMENT" && !pendingScaduto(b)) || b.status === "PENDING_CONFIRMATION" || b.status === "CONFIRMED" || b.status === "COMPLETED")
      .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime), createdAt: b.createdAt }));
    state.selected = null;
    renderPicker();
  } catch (err) {
    showError(errorEl, "Errore nel caricamento: " + err.message);
    list.innerHTML = "";
  }
}

// Chi ha solo prenotazioni:proprie (es. maestri) può eliminare solo
// blocchi/prenotazioni esenti creati da sé stesso, mai le prenotazioni
// online dei clienti — quelle restano riservate a prenotazioni:gestisci
// tramite "Annulla e converti in credito".
function puoEliminarePrenotazione(t) {
  if (t.type !== "BLOCK" && t.type !== "STAFF_EXEMPT") return false;
  if (hasPermission(currentProfile, "prenotazioni:gestisci")) return true;
  return hasPermission(currentProfile, "prenotazioni:proprie") && t.createdByUid === currentProfile.uid;
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
        <div class="entry-meta">${DISCIPLINA} · Campo ${escapeHtml(t.courtId || COURT_ID)}</div>
        <div class="entry-meta">Codice: ${escapeHtml(t.bookingCode)} · CHF ${(t.price || 0).toFixed(2)}</div>
        ${t.type === "BLOCK" && t.motivo ? `<div class="entry-meta">Motivo: ${escapeHtml(t.motivo)}</div>` : ""}
        ${(t.type === "BLOCK" || t.type === "STAFF_EXEMPT") && t.createdByNome ? `<div class="entry-meta">Prenotato da: ${escapeHtml(t.createdByNome)}</div>` : ""}
        <div class="entry-meta">Prenotato il ${formatTimestamp(t.createdAt)}</div>
      </div>
      ${(t.type === "CUSTOMER" && (t.status === "CONFIRMED" || t.status === "COMPLETED") && hasPermission(currentProfile, "prenotazioni:gestisci"))
        ? `<button type="button" class="btn btn-danger annulla-credito-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-booking-id="${t.bookingId}">Annulla e converti in credito</button>`
        : ""}
      ${puoEliminarePrenotazione(t) ? `<button type="button" class="btn btn-danger elimina-prenotazione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-booking-id="${t.bookingId}">Elimina</button>` : ""}
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
  wireEliminaPrenotazione(list);
}

function wireAnnullaCredito(container) {
  container.querySelectorAll(".annulla-credito-btn").forEach(btn => {
    btn.addEventListener("click", () => annullaEConverti(btn.dataset.bookingId, btn));
  });
}

function wireEliminaPrenotazione(container) {
  container.querySelectorAll(".elimina-prenotazione-btn").forEach(btn => {
    btn.addEventListener("click", () => eliminaPrenotazione(btn.dataset.bookingId, btn));
  });
}

async function annullaEConverti(bookingId, btn) {
  if (!confirm("Annullare questa prenotazione e convertirla in credito per il cliente?")) return;
  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("annullaEConvertiInCredito");
    const result = await fn({ bookingId });
    alert(`Credito creato: ${result.data.creditCode} — CHF ${result.data.importo.toFixed(2)}\n\nComunicalo al cliente per una prenotazione futura.`);
    await caricaGiorno();
  } catch (err) {
    alert("Errore: " + err.message);
    btn.disabled = false;
  }
}

async function eliminaPrenotazione(bookingId, btn) {
  if (!confirm("Eliminare questa prenotazione? Lo slot torna libero. L'operazione non è reversibile.")) return;
  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("eliminaPrenotazioneOperatore");
    await fn({ bookingId });
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

  if (CHIUSURE_PADEL.has(state.data)) {
    timelineEl.style.height = "";
    timelineEl.innerHTML = `<div class="empty-state"><div class="display">Campo chiuso</div><p>Nessuno slot prenotabile in questa data.</p></div>`;
    document.getElementById("summaryBar").classList.remove("show");
    return;
  }

  const close = chiusuraGiorno(state.data);
  timelineEl.style.height = (px(close) + EDGE_PAD) + "px";

  let html = hourGridHtml(close);
  html += state.bookingsMinuti.map(b => `
    <div class="busy" style="top:${px(b.start)}px;height:${px(b.end) - px(b.start)}px">
      <span class="name">Occupato</span>
      <span class="time">${label(b.start)}–${label(b.end)}</span>
      ${b.createdAt ? `<span class="timestamp">Prenotato il ${formatTimestamp(b.createdAt)}</span>` : ""}
    </div>
  `).join("");

  if (state.duration) {
    const starts = escludiOrariPassati(validStarts(state.bookingsMinuti, state.duration, close, feriale(state.data), eOggi(state.data)), state.data);
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

  // Disabilita entrambi i pulsanti (non solo quello cliccato): un doppio
  // click, o un click sull'altro pulsante mentre la prima richiesta è
  // ancora in corso, non deve poter partire una seconda richiesta sullo
  // stesso slot — stessa cautela già presa in prenota-padel.js, anche
  // se qui il backend (transazione Firestore) blocca comunque il
  // doppione: è solo per evitare un errore inutile in interfaccia.
  const blockaBtn = document.getElementById("blocca-btn");
  const esenteBtn = document.getElementById("esente-btn");
  blockaBtn.disabled = true;
  esenteBtn.disabled = true;
  mostraCaricamento(tipo === "BLOCK" ? "Blocco dello slot in corso…" : "Creazione della prenotazione in corso…");

  try {
    const fn = cloudFunctions().httpsCallable("creaPrenotazioneOperatore");
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
  } finally {
    nascondiCaricamento();
    blockaBtn.disabled = false;
    esenteBtn.disabled = false;
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
    const t = {
      token, ...ticketSnap.data(),
      status: bookingSnap.exists ? bookingSnap.data().status : "CONFIRMED",
      type: bookingSnap.exists ? bookingSnap.data().type : "CUSTOMER"
    };
    if (t.type === "BLOCK" || t.type === "STAFF_EXEMPT") {
      const dettaglioSnap = await db.collection("blockDetails").doc(t.bookingId).get();
      if (dettaglioSnap.exists) Object.assign(t, dettaglioSnap.data());
    }
    risultato.innerHTML = rigaHtml(t);
    wireAnnullaCredito(risultato);
    wireEliminaPrenotazione(risultato);
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
    ${intestazioneStampaHtml()}
    <h1>${DISCIPLINA} — Campo ${COURT_ID} — ${formatDataBreve(state.data)}</h1>
    <p>Lista generata il ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <thead><tr><th>Orario</th><th>Codice</th><th>Stato</th><th>Prenotato il</th></tr></thead>
      <tbody>${corpo || "<tr><td colspan=4>Nessuna prenotazione</td></tr>"}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Giorni di chiusura ----------

function renderChiusure(chiusure) {
  const el = document.getElementById("chiusure-list");

  if (chiusure.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna chiusura configurata</div></div>`;
    return;
  }

  el.innerHTML = chiusure.map(c => `
    <div class="entry-card" data-data="${c.id}">
      <div class="entry-main">
        <div class="entry-tipo">${formatDataBreve(c.id)}</div>
        ${c.motivo ? `<div class="entry-meta">${escapeHtml(c.motivo)}</div>` : ""}
      </div>
      <button type="button" class="btn btn-danger elimina-chiusura-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-data="${c.id}">Elimina</button>
    </div>
  `).join("");

  el.querySelectorAll(".elimina-chiusura-btn").forEach(btn => {
    btn.addEventListener("click", () => eliminaChiusura(btn.dataset.data, btn));
  });
}

async function caricaChiusureList() {
  const el = document.getElementById("chiusure-list");
  el.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  const snap = await db.collection("chiusurePadel").orderBy(firebase.firestore.FieldPath.documentId()).get();
  const chiusure = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderChiusure(chiusure);
}

async function onAggiungiChiusura() {
  const dataIso = document.getElementById("nuova-chiusura-data").value;
  const motivo = document.getElementById("nuova-chiusura-motivo").value.trim();
  const errorEl = document.getElementById("chiusure-error");
  errorEl.textContent = "";

  if (!dataIso) {
    showError(errorEl, "Scegli una data.");
    return;
  }

  const btn = document.getElementById("aggiungi-chiusura-btn");
  btn.disabled = true;
  try {
    await db.collection("chiusurePadel").doc(dataIso).set({
      motivo: motivo || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    document.getElementById("nuova-chiusura-data").value = "";
    document.getElementById("nuova-chiusura-motivo").value = "";
    await caricaChiusurePadel();
    await caricaChiusureList();
    buildDayStrip();
    if (state.data === dataIso) renderPicker();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function eliminaChiusura(dataIso, btn) {
  if (!confirm(`Riaprire il campo per il ${formatDataBreve(dataIso)}?`)) return;
  btn.disabled = true;
  try {
    await db.collection("chiusurePadel").doc(dataIso).delete();
    await caricaChiusurePadel();
    await caricaChiusureList();
    buildDayStrip();
    if (state.data === dataIso) renderPicker();
  } catch (err) {
    showError(document.getElementById("chiusure-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

// ---------- Attivazione soci (QR, tennis/squash) ----------
//
// Per chi non ha email in anagrafica, o Studente/Azienda partner/Junior
// verificato di persona: lo staff cerca il socio (cercaSociStaff, mai
// esposta al pubblico) e genera un token di attivazione (generaTokenAttivazione)
// da mostrare come QR — lo stesso schema del biglietto padel (qrcodejs,
// già caricato in questa pagina).

let attivazioneCercaTimeout = null;

function wireAttivazioneSoci() {
  document.getElementById("attivazione-cerca-input").addEventListener("input", (e) => {
    clearTimeout(attivazioneCercaTimeout);
    document.getElementById("attivazione-qr-box").classList.add("hidden");
    const testo = e.target.value.trim();
    if (testo.length < 2) {
      document.getElementById("attivazione-risultati").innerHTML = "";
      return;
    }
    attivazioneCercaTimeout = setTimeout(() => cercaSociAttivazione(testo), 400);
  });
}

async function cercaSociAttivazione(testo) {
  const risultatiEl = document.getElementById("attivazione-risultati");
  const errorEl = document.getElementById("attivazione-error");
  errorEl.textContent = "";
  risultatiEl.innerHTML = `<div class="empty-state"><div class="display">Ricerca…</div></div>`;
  try {
    const fn = cloudFunctions().httpsCallable("cercaSociStaff");
    const { data } = await fn({ testo });
    if (data.risultati.length === 0) {
      risultatiEl.innerHTML = `<div class="empty-state"><div class="display">Nessun risultato</div></div>`;
      return;
    }
    risultatiEl.innerHTML = data.risultati.map(s => `
      <div class="entry-card" data-id="${s.id}">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(s.nome)} ${escapeHtml(s.cognome)}</div>
          <div class="entry-meta">${escapeHtml(s.categoria)}${s.tessera ? " · " + escapeHtml(s.tessera) : ""}</div>
        </div>
        <button type="button" class="btn btn-ghost genera-qr-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;"
          data-id="${s.id}" data-nome="${escapeHtml(s.nome)} ${escapeHtml(s.cognome)}">Genera QR</button>
      </div>
    `).join("");
    risultatiEl.querySelectorAll(".genera-qr-btn").forEach(btn => {
      btn.addEventListener("click", () => generaQrAttivazione(btn.dataset.id, btn.dataset.nome));
    });
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    risultatiEl.innerHTML = "";
  }
}

async function generaQrAttivazione(socioId, nome) {
  const errorEl = document.getElementById("attivazione-error");
  errorEl.textContent = "";
  try {
    const fn = cloudFunctions().httpsCallable("generaTokenAttivazione");
    const { data } = await fn({ socioId });
    const url = `${basePageUrl()}attiva-socio.html?t=${data.token}`;
    const container = document.getElementById("attivazione-qr-container");
    container.innerHTML = "";
    new QRCode(container, {
      text: url, width: 200, height: 200,
      colorDark: "#0d1f30", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M
    });
    document.getElementById("attivazione-qr-nome").textContent = `${nome} — fai scansionare questo QR con il telefono del socio`;
    document.getElementById("attivazione-qr-box").classList.remove("hidden");
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  }
}

// ---------- Buoni regalo (emissione omaggio) ----------
//
// Stesso identico effetto di un buono acquistato dai clienti sulla
// pagina pubblica (crea un "credits" ACTIVE) — qui senza pagamento,
// per omaggi/promozioni. La Cloud Function crea anche il voucherTickets
// così il codice si può mostrare/stampare con la stessa pagina pubblica
// usata per i buoni acquistati.
async function onEmettiBuonoOmaggio() {
  const importoRaw = document.getElementById("nuovo-buono-importo").value;
  const nota = document.getElementById("nuovo-buono-nota").value.trim();
  const errorEl = document.getElementById("buono-omaggio-error");
  const risultatoEl = document.getElementById("buono-omaggio-risultato");
  errorEl.textContent = "";
  risultatoEl.innerHTML = "";

  const importo = parseFloat(importoRaw);
  if (!importoRaw || isNaN(importo) || importo <= 0) {
    showError(errorEl, "Inserisci un importo valido.");
    return;
  }

  const btn = document.getElementById("emetti-buono-btn");
  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("emettiBuonoOmaggio");
    const result = await fn({ importo, nota: nota || null });
    const link = `${basePageUrl()}buono-regalo-conferma.html?t=${result.data.token}`;
    risultatoEl.innerHTML = `
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">Buono emesso: ${escapeHtml(result.data.code)}</div>
          <div class="entry-meta">CHF ${importo.toFixed(2)} — <a href="${link}" target="_blank">apri pagina del buono</a></div>
        </div>
      </div>
    `;
    document.getElementById("nuovo-buono-importo").value = "";
    document.getElementById("nuovo-buono-nota").value = "";
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Resoconto per periodo (vendita campi + quota campo maestri) ----------
//
// Due numeri utili per la segreteria: quanto si è incassato dai clienti
// (per durata, es. per capire se conviene privilegiare slot da 60' o
// 90') e quanto devono i maestri per le lezioni prenotate "esenti"
// (nessun pagamento del cliente, ma il campo va comunque riaddebitato
// al maestro in base alle Quote campo configurate — stessa logica di
// quotaCampoPerEntry in js/resoconto.js, qui applicata alle
// prenotazioni del tabellone invece che alle voci diario).

let ultimoResocontoPeriodo = null;

function currentMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [toISO(first), toISO(last)];
}
function last7DaysRange() {
  const oggi = new Date();
  const settimanaFa = new Date();
  settimanaFa.setDate(oggi.getDate() - 6);
  return [toISO(settimanaFa), toISO(oggi)];
}

function fasciaOrariaFor(oraInizio) {
  return oraInizio < "17:00" ? "prima_17" : "dopo_17";
}

// Diverso da feriale() più sopra (che esclude sabato E domenica, per gli
// orari di chiusura campo): qui la quota campo distingue solo la
// domenica, come richiesto — il sabato resta prezzo feriale.
function domenicaOFestivo(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno === 0 || (IMPOSTAZIONI.festivi || []).includes(dataIso);
}

function quotaCampoPerPrenotazione(booking, quoteCampoList) {
  const durata = orarioToMin(booking.endTime) - orarioToMin(booking.startTime);
  const fascia = fasciaOrariaFor(booking.startTime);
  const tipoGiorno = domenicaOFestivo(booking.date) ? "domenica_festivo" : "feriale";
  const candidates = quoteCampoList
    .filter(q => q.disciplina === "padel")
    .filter(q => !q.periodoInizio || booking.date >= q.periodoInizio)
    .filter(q => !q.periodoFine || booking.date <= q.periodoFine)
    .filter(q => !q.tipoGiorno || q.tipoGiorno === tipoGiorno)
    .filter(q => q.fasciaOraria === fascia && q.durataMinuti === durata)
    .sort((a, b) => {
      const aGiorno = a.tipoGiorno ? 1 : 0;
      const bGiorno = b.tipoGiorno ? 1 : 0;
      if (aGiorno !== bGiorno) return bGiorno - aGiorno;
      return (b.periodoInizio || "").localeCompare(a.periodoInizio || "");
    });
  return candidates.length > 0 ? candidates[0].importo : null;
}

function renderVenditaPerDurata(perDurata, totaleVendite) {
  const el = document.getElementById("vendita-per-durata-table");
  const durate = Object.keys(perDurata).map(Number).sort((a, b) => a - b);

  if (durate.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna vendita nel periodo</div></div>`;
    return;
  }

  el.innerHTML = `
    <table class="app-table">
      <thead><tr><th>Durata</th><th>Prenotazioni</th><th>Incasso</th></tr></thead>
      <tbody>
        ${durate.map(d => `
          <tr>
            <td>${d}'</td>
            <td>${perDurata[d].count}</td>
            <td>CHF ${perDurata[d].totale.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>Totale</strong></td>
          <td><strong>${durate.reduce((s, d) => s + perDurata[d].count, 0)}</strong></td>
          <td><strong>CHF ${totaleVendite.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

const ORIGINE_BUONO_LABEL = { voucher_acquistato: "Acquistati", voucher_omaggio: "Omaggio" };

function renderBuoniEmessi(perOrigineBuoni) {
  const el = document.getElementById("buoni-emessi-table");
  const origini = Object.keys(perOrigineBuoni);

  if (origini.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessun buono emesso nel periodo</div></div>`;
    return;
  }

  const totCount = origini.reduce((s, o) => s + perOrigineBuoni[o].count, 0);
  const totImporto = origini.reduce((s, o) => s + perOrigineBuoni[o].totale, 0);

  el.innerHTML = `
    <table class="app-table">
      <thead><tr><th>Origine</th><th>Numero</th><th>Totale</th></tr></thead>
      <tbody>
        ${origini.map(o => `
          <tr>
            <td>${ORIGINE_BUONO_LABEL[o] || o}</td>
            <td>${perOrigineBuoni[o].count}</td>
            <td>CHF ${perOrigineBuoni[o].totale.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>Totale</strong></td>
          <td><strong>${totCount}</strong></td>
          <td><strong>CHF ${totImporto.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

async function calcolaResocontoPeriodo(e) {
  e.preventDefault();
  const dal = document.getElementById("resoconto-dal").value;
  const al = document.getElementById("resoconto-al").value;
  const btn = document.getElementById("calcola-resoconto-btn");
  const errorEl = document.getElementById("resoconto-periodo-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Calcolo…";

  try {
    const [ticketsSnap, bookingsSnap, quoteCampoSnap, creditsSnap] = await Promise.all([
      db.collection("bookingTickets").where("courtId", "==", COURT_ID).where("date", ">=", dal).where("date", "<=", al).get(),
      db.collection("bookings").where("courtId", "==", COURT_ID).where("date", ">=", dal).where("date", "<=", al).get(),
      db.collection("quoteCampo").get(),
      db.collection("credits")
        .where("createdAt", ">=", new Date(dal + "T00:00:00"))
        .where("createdAt", "<=", new Date(al + "T23:59:59"))
        .get()
    ]);

    const infoPerBookingId = {};
    bookingsSnap.docs.forEach(d => { infoPerBookingId[d.id] = d.data(); });

    // Solo le prenotazioni davvero concluse: esclude PENDING_PAYMENT (mai
    // pagate/scadute) e CREDITED (rimborsate in credito — se il credito
    // viene riusato genera una nuova vendita, contarla anche qui sarebbe
    // un doppio conteggio).
    const righe = ticketsSnap.docs
      .map(d => d.data())
      .map(t => ({
        ...t,
        status: (infoPerBookingId[t.bookingId] || {}).status || "CONFIRMED",
        type: (infoPerBookingId[t.bookingId] || {}).type || "CUSTOMER"
      }))
      .filter(t => t.status === "CONFIRMED" || t.status === "COMPLETED");

    // Come nel Resoconto: una quota disattivata in Configurazione non si
    // applica più. Le due pagine devono concordare, altrimenti la stessa
    // quota campo risulterebbe dovuta in una e non nell'altra.
    const quoteCampoList = quoteCampoSnap.docs
      .map(d => d.data())
      .filter(q => q.attivo !== false);

    const perDurata = {};
    let totaleVendite = 0;
    let totaleQuotaCampo = 0;
    let numEsentiSenzaQuota = 0;

    righe.forEach(t => {
      const durata = orarioToMin(t.endTime) - orarioToMin(t.startTime);
      if (t.type === "CUSTOMER") {
        if (!perDurata[durata]) perDurata[durata] = { count: 0, totale: 0 };
        perDurata[durata].count++;
        perDurata[durata].totale += (t.price || 0);
        totaleVendite += (t.price || 0);
      } else if (t.type === "STAFF_EXEMPT") {
        const quota = quotaCampoPerPrenotazione(t, quoteCampoList);
        if (quota != null) {
          totaleQuotaCampo += quota;
        } else {
          numEsentiSenzaQuota++;
        }
      }
    });

    // Buoni regalo emessi nel periodo (acquistati o omaggio) — i più
    // vecchi crediti da annullamento non hanno "origine" e restano
    // esclusi, non sono buoni regalo.
    const perOrigineBuoni = {};
    creditsSnap.docs
      .map(d => d.data())
      .filter(c => c.origine === "voucher_acquistato" || c.origine === "voucher_omaggio")
      .forEach(c => {
        if (!perOrigineBuoni[c.origine]) perOrigineBuoni[c.origine] = { count: 0, totale: 0 };
        perOrigineBuoni[c.origine].count++;
        perOrigineBuoni[c.origine].totale += (c.initialAmount || 0);
      });

    ultimoResocontoPeriodo = { dal, al, perDurata, totaleVendite, totaleQuotaCampo, perOrigineBuoni };

    renderVenditaPerDurata(perDurata, totaleVendite);
    document.getElementById("totale-quotacampo-maestri").textContent = `CHF ${totaleQuotaCampo.toFixed(2)}`;
    document.getElementById("quotacampo-maestri-warning").textContent = numEsentiSenzaQuota > 0
      ? `${numEsentiSenzaQuota} prenotazioni esenti senza una Quota campo configurata per quella durata/fascia (escluse dal totale).`
      : "";
    renderBuoniEmessi(perOrigineBuoni);
    document.getElementById("resoconto-periodo-risultato").classList.remove("hidden");
  } catch (err) {
    showError(errorEl, "Errore nel calcolo: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcola";
  }
}

function stampaResocontoPeriodo() {
  if (!ultimoResocontoPeriodo) return;
  const { dal, al, perDurata, totaleVendite, totaleQuotaCampo, perOrigineBuoni } = ultimoResocontoPeriodo;
  const durate = Object.keys(perDurata).map(Number).sort((a, b) => a - b);

  const righe = durate.map(d => `
    <tr><td>${d}'</td><td>${perDurata[d].count}</td><td>${perDurata[d].totale.toFixed(2)}</td></tr>
  `).join("");

  const origini = Object.keys(perOrigineBuoni || {});
  const righeBuoni = origini.map(o => `
    <tr><td>${ORIGINE_BUONO_LABEL[o] || o}</td><td>${perOrigineBuoni[o].count}</td><td>${perOrigineBuoni[o].totale.toFixed(2)}</td></tr>
  `).join("");

  document.getElementById("print-area").innerHTML = `
    ${intestazioneStampaHtml()}
    <h1>Resoconto ${DISCIPLINA} — Campo ${COURT_ID}</h1>
    <p>Periodo: ${formatDataBreve(dal)} – ${formatDataBreve(al)}</p>
    <table>
      <thead><tr><th>Durata</th><th>Prenotazioni</th><th>Incasso (CHF)</th></tr></thead>
      <tbody>${righe || "<tr><td colspan=3>Nessuna vendita</td></tr>"}</tbody>
      <tfoot><tr><th>Totale</th><th>${durate.reduce((s, d) => s + perDurata[d].count, 0)}</th><th>${totaleVendite.toFixed(2)}</th></tr></tfoot>
    </table>
    <p><strong>Quota campo dovuta dai maestri:</strong> CHF ${totaleQuotaCampo.toFixed(2)}</p>
    <h1>Buoni regalo emessi</h1>
    <table>
      <thead><tr><th>Origine</th><th>Numero</th><th>Totale (CHF)</th></tr></thead>
      <tbody>${righeBuoni || "<tr><td colspan=3>Nessun buono emesso</td></tr>"}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  const puoGestire = hasPermission(profile, "prenotazioni:gestisci");
  const puoProprie = puoGestire || hasPermission(profile, "prenotazioni:proprie");

  if (!puoProprie) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("operatore-content").classList.add("hidden");
    return;
  }

  if (!puoGestire) {
    // Maestri (solo prenotazioni:proprie): niente ricerca per codice,
    // lista stampabile, giorni di chiusura o resoconto — solo il
    // tabellone del giorno e il blocco/prenotazione esente per sé stessi.
    document.querySelectorAll(".solo-gestisci").forEach(el => el.classList.add("hidden"));
  }

  await loadDatiCentro();
  await loadImpostazioni();
  await caricaChiusurePadel();

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

  if (puoGestire) {
    document.getElementById("aggiungi-chiusura-btn").addEventListener("click", onAggiungiChiusura);
    await caricaChiusureList();

    wireAttivazioneSoci();

    document.getElementById("emetti-buono-btn").addEventListener("click", onEmettiBuonoOmaggio);

    const [meseDal, meseAl] = currentMonthRange();
    document.getElementById("resoconto-dal").value = meseDal;
    document.getElementById("resoconto-al").value = meseAl;
    document.getElementById("resoconto-periodo-form").addEventListener("submit", calcolaResocontoPeriodo);
    document.getElementById("preset-7giorni-resoconto").addEventListener("click", () => {
      const [d, a] = last7DaysRange();
      document.getElementById("resoconto-dal").value = d;
      document.getElementById("resoconto-al").value = a;
      calcolaResocontoPeriodo(new Event("submit"));
    });
    document.getElementById("preset-mese-resoconto").addEventListener("click", () => {
      const [d, a] = currentMonthRange();
      document.getElementById("resoconto-dal").value = d;
      document.getElementById("resoconto-al").value = a;
      calcolaResocontoPeriodo(new Event("submit"));
    });
    document.getElementById("stampa-resoconto-periodo-btn").addEventListener("click", stampaResocontoPeriodo);
  }

  await caricaGiorno();

  // Stesso motivo di prenota-campo.js/prenota-padel.js: senza un refresh
  // periodico, chi lascia la pagina aperta vede ancora selezionabile nel
  // picker un orario ormai passato. Solo renderPicker() (ricalcolo
  // locale con i dati già in state.bookingsMinuti, nessuna nuova lettura
  // Firestore) — non ricarichiamo l'intera lista del giorno ogni minuto,
  // quella resta aggiornata al cambio giorno/azione come già oggi.
  setInterval(renderPicker, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderPicker();
  });
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
