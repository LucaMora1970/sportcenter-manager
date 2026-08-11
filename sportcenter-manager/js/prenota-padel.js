// ============================================================
// prenota-padel.js — prenotazione pubblica del campo padel, senza
// login. Legge la collection pubblica "bookings" (solo campi non
// sensibili: courtId/date/startTime/endTime/status/createdAt — niente
// nomi, contatti o codici, per non esporli a chi legge il tabellone).
// La creazione vera passa sempre dalla Cloud Function
// creaPrenotazionePubblica, che ricalcola slot e prezzo lato server e,
// se serve, crea la transazione PostFinance.
//
// Stessa identica logica anti-buco di js/prenotazioni.js (duplicata
// anche lato server in functions/index.js) — se cambia qui va cambiata
// in entrambi gli altri due posti.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

const COURT_ID = "1";

const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const CLOSE_WEEKEND = 20 * 60 + 30;
const BOUNDARY = 17 * 60;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const SLOT_FISSO_SERALE = 17 * 60 + 30; // 17:30, solo lun-ven, solo 90'
const PX_PER_MIN = 1.1;
const EDGE_PAD = 10;
const GIORNI_BREVI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
const NR_GIORNI_STRIP = 14;
const FESTIVI = [];

// Data/ora corrente in fuso orario svizzero, indipendentemente da come è
// impostato l'orologio/fuso del dispositivo di chi prenota (un cliente
// che naviga dall'estero non deve vedere gli orari del campo sfalsati) —
// serve per escludere gli slot di oggi già passati. Duplicato in
// js/prenotazioni.js e functions/index.js: se cambia va cambiato ovunque.
function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}

// Sugli slot di oggi, esclude quelli già iniziati/passati.
function escludiOrariPassati(starts, dataIso) {
  const ora = oraLocaleZurigo();
  if (dataIso !== ora.dataIso) return starts;
  return starts.filter(s => s > ora.minuti);
}

function eOggi(dataIso) {
  return dataIso === oraLocaleZurigo().dataIso;
}

// Una prenotazione "in pagamento" scaduta (pagamento mai concluso: pagina
// abbandonata, o problemi col webhook) non deve bloccare lo slot per
// sempre — la cancellazione fisica avviene lato server (Cloud Function),
// qui si tratta solo come "libera" a scopo di visualizzazione/calcolo.
// Duplicato in js/prenotazioni.js e functions/index.js.
const PENDING_SCADUTO_MINUTI = 15;
function pendingScaduto(booking) {
  if (booking.status !== "PENDING_PAYMENT") return false;
  if (!booking.createdAt || typeof booking.createdAt.toMillis !== "function") return false;
  return (Date.now() - booking.createdAt.toMillis()) > PENDING_SCADUTO_MINUTI * 60000;
}

// Timestamp dell'acquisto mostrato sullo slot "Occupato" — elemento di
// verifica in più (confrontabile col biglietto), non una credenziale.
function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "";
  const d = ts.toDate();
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} alle ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function chiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return (giorno === 0 || giorno === 6 || FESTIVI.includes(dataIso)) ? CLOSE_WEEKEND : CLOSE;
}

// Lunedì-venerdì, festivi esclusi (stesso elenco usato per la chiusura ridotta).
function feriale(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !FESTIVI.includes(dataIso);
}

let TARIFFE_PADEL = { diurno60: null, diurno90: null, serale90: null };
async function loadTariffePadel() {
  try {
    const doc = await db.collection("impostazioni").doc("tariffePadel").get();
    if (doc.exists) TARIFFE_PADEL = { ...TARIFFE_PADEL, ...doc.data() };
  } catch (err) {
    console.warn("loadTariffePadel: lettura fallita:", err.message);
  }
}

function fasciaTariffa(startMin, duration) {
  return duration === 60 ? "diurno60" : (startMin < BOUNDARY ? "diurno90" : "serale90");
}
function prezzoSlot(startMin, duration) {
  return TARIFFE_PADEL[fasciaTariffa(startMin, duration)];
}

let state = { data: null, duration: null, selected: null, bookings: [] };
let bookingsUnsub = null;

function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function px(min) { return (min - OPEN) * PX_PER_MIN + EDGE_PAD; }
function label(min) { return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); }
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}

// ---------- Logica anti-buchi (identica a js/prenotazioni.js) ----------

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
    // Dopo le 17:00 la catena avanza a blocchi da 90' (nessun buco fisso
    // residuo). Oggi però quel passo largo può nascondere disponibilità
    // reale nelle prossime ore (es. sono le 20:07, il prossimo scatto
    // fisso è le 21:30 ma tra 20:07 e 21:30 il campo è comunque libero) —
    // per il giorno corrente si usa quindi un passo più fine (15'),
    // lasciando che chi chiama filtri comunque gli orari già passati.
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
    // il pranzo — offerta anche se non cade sulla catena dei 90' da
    // BOUNDARY, stessa regola anti-buco. Non nel weekend/festivi.
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
    btn.addEventListener("click", () => selezionaGiorno(btn.dataset.data));
  });
}

function selezionaGiorno(dataIso) {
  state.data = dataIso;
  state.selected = null;
  document.querySelectorAll(".day-btn").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.data === dataIso));
  });
  ascoltaPrenotazioniGiorno();
}

// ---------- Dati Firestore ----------

function ascoltaPrenotazioniGiorno() {
  if (bookingsUnsub) bookingsUnsub();

  bookingsUnsub = db.collection("bookings")
    .where("date", "==", state.data)
    .where("courtId", "==", COURT_ID)
    .onSnapshot(
      (snap) => {
        state.bookings = snap.docs
          .map(d => d.data())
          .filter(b => (b.status === "PENDING_PAYMENT" && !pendingScaduto(b)) || b.status === "CONFIRMED" || b.status === "COMPLETED")
          .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime), createdAt: b.createdAt }));
        render();
      },
      (err) => {
        showError(document.getElementById("tabellone-error"), "Errore nel caricamento: " + err.message);
      }
    );
}

async function prenotaSlot() {
  if (!state.selected || !state.duration) return;

  const btn = document.getElementById("summaryCta");
  const errorEl = document.getElementById("tabellone-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Attendere…";

  const creditCode = document.getElementById("credito-input").value.trim() || null;

  try {
    const creaPrenotazione = firebase.functions().httpsCallable("creaPrenotazionePubblica");
    const result = await creaPrenotazione({
      courtId: COURT_ID,
      date: state.data,
      startTime: label(state.selected.start),
      endTime: label(state.selected.end),
      durationMinutes: state.duration,
      creditCode
    });

    if (result.data.pagamentoNecessario) {
      window.location.href = result.data.paymentPageUrl;
    } else {
      window.location.href = `biglietto.html?t=${result.data.token}`;
    }
  } catch (err) {
    showError(errorEl, "Errore nella prenotazione: " + (err.message || err));
    btn.disabled = false;
    btn.textContent = "Paga e prenota";
  }
}

// ---------- Render griglia ----------

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

function render() {
  const timelineEl = document.getElementById("timeline");
  const close = chiusuraGiorno(state.data);
  const totalPx = px(close) + EDGE_PAD;
  timelineEl.style.height = totalPx + "px";

  let html = hourGridHtml(close);

  html += state.bookings.map(b => `
    <div class="busy" style="top:${px(b.start)}px;height:${px(b.end) - px(b.start)}px">
      <span class="name">Occupato</span>
      <span class="time">${label(b.start)}–${label(b.end)}</span>
      ${b.createdAt ? `<span class="timestamp">Prenotato il ${formatTimestamp(b.createdAt)}</span>` : ""}
    </div>
  `).join("");

  if (state.duration) {
    const starts = escludiOrariPassati(validStarts(state.bookings, state.duration, close, feriale(state.data), eOggi(state.data)), state.data);
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
      render();
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
  });

  const bar = document.getElementById("summaryBar");
  const priceEl = document.getElementById("summaryPrice");
  if (state.selected) {
    document.getElementById("summaryTitle").textContent = `${label(state.selected.start)}–${label(state.selected.end)}`;
    bar.classList.add("show");
    const prezzo = prezzoSlot(state.selected.start, state.duration);
    priceEl.textContent = prezzo != null ? `CHF ${prezzo.toFixed(2)}` : "Tariffa non configurata";
  } else {
    bar.classList.remove("show");
  }
}

// ---------- Init ----------

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const esitoPagamento = new URLSearchParams(location.search).get("pagamento");
  if (esitoPagamento === "fallito") {
    alert("Pagamento non riuscito o annullato: lo slot è stato liberato, riprova pure.");
    history.replaceState(null, "", location.pathname);
  }

  await loadTariffePadel();

  state.data = toISO(new Date());
  buildDayStrip();

  // 90' selezionata di default: è la durata più richiesta, così la
  // griglia mostra subito qualcosa senza dover prima scegliere.
  state.duration = 90;
  document.querySelectorAll("#durationSeg button").forEach(b =>
    b.setAttribute("aria-pressed", String(parseInt(b.dataset.dur, 10) === state.duration))
  );

  document.querySelectorAll("#durationSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      const dur = parseInt(btn.dataset.dur, 10);
      state.duration = (state.duration === dur) ? null : dur;
      state.selected = null;
      document.querySelectorAll("#durationSeg button").forEach(b =>
        b.setAttribute("aria-pressed", String(parseInt(b.dataset.dur, 10) === state.duration))
      );
      render();
    });
  });

  document.getElementById("summaryCta").addEventListener("click", prenotaSlot);

  ascoltaPrenotazioniGiorno();
})();
