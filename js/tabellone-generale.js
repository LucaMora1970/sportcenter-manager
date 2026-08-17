// ============================================================
// tabellone-generale.js — vista pubblica "tutti i campi, tutta la
// giornata" (tennis, squash, padel insieme), pensata sia per il monitor
// in reception sia per il desktop della direzione.
//
// Due modalità, stessa pagina, nessun login obbligatorio:
// - chiunque (anche senza login): legge solo "bookings" (già pubblica,
//   mai nomi) → mostra "Occupato".
// - chi è loggato con prenotazioni:gestisci o prenotazioni:proprie: legge
//   in più bookingDettagli/blockDetails (già riservate a quel permesso
//   nelle firestore.rules, nessuna regola nuova) → mostra anche i nomi.
//
// L'ordine delle discipline segue il campo "Ordine" già configurabile in
// Configurazione → Discipline (stesso DISCIPLINE di utils.js, già
// ordinato) — nessuna impostazione nuova da costruire per quello.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è redirect a login, il controllo permessi è opzionale e locale).
// ============================================================

const GIORNO_INIZIO = 8 * 60;   // 08:00 — cornice fissa della vista, non l'orario di chiusura reale del giorno
const GIORNO_FINE = 23 * 60;    // 23:00
const PENDING_SCADUTO_MINUTI = 15;

let CAMPI = []; // [{ id, numero, disciplina, posizione }] — tennis/squash da "campi" + un campo sintetico per il padel
let CHIUSURE_CENTRO = [];
let CHIUSURE_PADEL = new Set();
let permessoNomi = false;

let state = { data: toISO(new Date()) };

function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addGiorni(dataIso, n) {
  const d = new Date(dataIso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function label(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}
function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}
function pendingScaduto(booking) {
  if (booking.status !== "PENDING_PAYMENT") return false;
  if (!booking.createdAt || typeof booking.createdAt.toMillis !== "function") return false;
  return (Date.now() - booking.createdAt.toMillis()) > PENDING_SCADUTO_MINUTI * 60000;
}

const GIORNI_LUNGHI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
function formatGiornoEsteso(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  return `${GIORNI_LUNGHI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`;
}

// ---------- Caricamento campi ----------

// Il campo "Numero" in Configurazione è testo libero (es. "4 Leda Polli",
// il circolo ci mette anche il nome di uno sponsor/dedica) — non un
// intero pulito. Separa la parte numerica iniziale (per ordinare ed
// etichettare "Campo N") dal resto (mostrato come dedica sulla riga
// sotto, vedi render()).
function parseNumeroCampo(numero) {
  const testo = String(numero || "").trim();
  const match = testo.match(/^(\d+)\s*(.*)$/);
  return match ? { numero: match[1], dedica: match[2].trim() || null } : { numero: testo, dedica: null };
}
function numeroOrdinabile(numero) {
  const match = String(numero || "").match(/^\d+/);
  return match ? parseInt(match[0], 10) : Infinity; // non numerici in fondo, non spariscono
}

async function loadCampi() {
  const snap = await db.collection("campi").where("attivo", "==", true).get();
  const tutti = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const tennisSquash = tutti.filter(c => c.disciplina === "tennis" || c.disciplina === "squash");

  // Il padel non ha mai un vero doc "campi" (courtId fisso "1") — se
  // l'admin ne ha comunque creato uno per dargli un nome reale, si usa
  // solo per l'etichetta, mai per l'identità del campo (stesso principio
  // di padelCampoNumero lato server e PADEL_NUMERO in prenota-campo.js).
  const padelReale = tutti.find(c => c.disciplina === "padel");
  const padel = { id: "1", numero: (padelReale && padelReale.numero) || "1", disciplina: "padel", posizione: null };

  CAMPI = [...tennisSquash, padel].sort((a, b) => numeroOrdinabile(a.numero) - numeroOrdinabile(b.numero));
}

async function loadChiusure(dataIso) {
  const [centroSnap, padelSnap] = await Promise.all([
    db.collection("chiusureCentro").doc(dataIso).get(),
    db.collection("chiusurePadel").doc(dataIso).get()
  ]);
  CHIUSURE_CENTRO = centroSnap.exists ? [{ id: dataIso, ...centroSnap.data() }] : [];
  CHIUSURE_PADEL = new Set(padelSnap.exists ? [dataIso] : []);
}

function campoChiuso(campo, dataIso) {
  if (campo.disciplina === "padel" && CHIUSURE_PADEL.has(dataIso)) return true;
  return CHIUSURE_CENTRO.some(c => c.id === dataIso && (!(c.discipline || []).length || c.discipline.includes(campo.disciplina)));
}

// ---------- Permesso "direzione" (nomi) ----------
// Stesso permesso già usato dal pannello operatore padel per leggere
// bookingDettagli/blockDetails (vedi firestore.rules) — nessun controllo
// nuovo, solo replicato qui lato client per decidere cosa MOSTRARE (la
// vera protezione resta sempre la regola Firestore sulla lettura).
async function calcolaPermessoNomi(uid) {
  if (!uid) return false;
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists || userSnap.data().attivo === false) return false;
    const ruoloId = userSnap.data().ruoloId;
    if (!ruoloId) return false;
    const roleSnap = await db.collection("roles").doc(ruoloId).get();
    if (!roleSnap.exists) return false;
    const permessi = roleSnap.data().permessi || [];
    return permessi.includes("*") || permessi.includes("prenotazioni:gestisci") || permessi.includes("prenotazioni:proprie");
  } catch {
    return false;
  }
}

// ---------- Prenotazioni del giorno ----------

async function loadPrenotazioniGiorno(dataIso) {
  const bookingsSnap = await db.collection("bookings").where("date", "==", dataIso).get();
  const bookings = bookingsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => !pendingScaduto(b))
    .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED");

  if (!permessoNomi || bookings.length === 0) return bookings;

  const idCustomer = bookings.filter(b => b.type === "CUSTOMER" || !b.type).map(b => b.id);
  const idOperatore = bookings.filter(b => b.type === "BLOCK" || b.type === "STAFF_EXEMPT").map(b => b.id);

  const [dettagli, blocchi] = await Promise.all([
    Promise.all(idCustomer.map(id => db.collection("bookingDettagli").doc(id).get())),
    Promise.all(idOperatore.map(id => db.collection("blockDetails").doc(id).get()))
  ]);
  const dettagliPerId = {};
  dettagli.forEach(doc => { if (doc.exists) dettagliPerId[doc.id] = doc.data(); });
  const blocchiPerId = {};
  blocchi.forEach(doc => { if (doc.exists) blocchiPerId[doc.id] = doc.data(); });

  return bookings.map(b => ({
    ...b,
    dettagli: dettagliPerId[b.id] || null,
    blocco: blocchiPerId[b.id] || null
  }));
}

function etichettaOccupato(b) {
  if (!permessoNomi) return { testo: "Occupato", classe: "" };
  if (b.type === "BLOCK") {
    return { testo: "Bloccato" + (b.blocco && b.blocco.motivo ? ` — ${b.blocco.motivo}` : ""), classe: "tipo-block" };
  }
  if (b.type === "STAFF_EXEMPT") {
    return { testo: "Esente" + (b.blocco && b.blocco.createdByNome ? ` — ${b.blocco.createdByNome}` : ""), classe: "tipo-exempt" };
  }
  const d = b.dettagli;
  if (!d) return { testo: "Occupato", classe: "" };
  const nomi = [d.prenotanteNome, d.giocatore2Nome].filter(Boolean).join(" / ");
  return { testo: nomi || "Occupato", classe: "" };
}

// ---------- Segmenti liberi/occupati per un campo ----------

function segmentiCampo(campo, bookingsGiorno) {
  const occupati = bookingsGiorno
    .filter(b => b.courtId === campo.id)
    .map(b => ({
      start: Math.max(GIORNO_INIZIO, orarioToMin(b.startTime)),
      end: Math.min(GIORNO_FINE, orarioToMin(b.endTime)),
      etichetta: etichettaOccupato(b)
    }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const out = [];
  let cursore = GIORNO_INIZIO;
  occupati.forEach(s => {
    if (s.start > cursore) out.push({ tipo: "free", durata: s.start - cursore });
    out.push({ tipo: "occ", durata: s.end - s.start, ...s.etichetta });
    cursore = Math.max(cursore, s.end);
  });
  if (cursore < GIORNO_FINE) out.push({ tipo: "free", durata: GIORNO_FINE - cursore });
  return out;
}

// ---------- Render ----------

function perDisciplina() {
  const gruppi = {};
  CAMPI.forEach(c => { (gruppi[c.disciplina] = gruppi[c.disciplina] || []).push(c); });
  // DISCIPLINE è già ordinata per "ordine" (vedi loadDiscipline in utils.js)
  // e configurabile in Configurazione → Discipline: nessun ordinamento
  // proprio qui, si segue quello.
  return DISCIPLINE
    .map(d => d.id)
    .filter(id => gruppi[id])
    .map(id => ({ disciplina: id, campi: gruppi[id] }));
}

async function render() {
  document.getElementById("giorno-data").textContent = formatGiornoEsteso(state.data);
  document.getElementById("giorno-oggi").classList.toggle("hidden", state.data === toISO(new Date()));

  const modoEl = document.getElementById("modo-indicatore");
  modoEl.classList.toggle("direzione", permessoNomi);
  document.getElementById("modo-testo").textContent = permessoNomi
    ? "Vista direzione — nomi visibili"
    : "Vista pubblica — solo stato occupato";

  await loadChiusure(state.data);
  const bookingsGiorno = await loadPrenotazioniGiorno(state.data);

  const board = document.getElementById("board");
  board.innerHTML = "";
  const gruppi = perDisciplina();

  if (gruppi.length === 0) {
    board.innerHTML = `<div class="empty-state"><div class="display">Nessun campo configurato</div></div>`;
  }

  gruppi.forEach(({ disciplina, campi }) => {
    const group = document.createElement("div");
    group.className = "disc-group";
    group.innerHTML = `<div class="disc-label">${escapeHtml(disciplinaLabel(disciplina))}</div>`;
    campi.forEach(campo => {
      const row = document.createElement("div");
      row.className = "court-row";
      const { numero, dedica } = parseNumeroCampo(campo.numero);
      const nomeCampo = `Campo ${numero}${campo.posizione ? ` (${campo.posizione})` : ""}`;
      let timelineHtml;
      if (campoChiuso(campo, state.data)) {
        timelineHtml = `<div class="tg-timeline"><div class="tg-seg chiuso">Chiuso</div></div>`;
      } else {
        const segs = segmentiCampo(campo, bookingsGiorno).map(s => {
          if (s.tipo === "free") return `<div class="tg-seg free" style="flex-grow:${s.durata}"></div>`;
          return `<div class="tg-seg occ ${s.classe}" style="flex-grow:${s.durata}" title="${escapeHtml(s.testo)}"><span>${escapeHtml(s.testo)}</span></div>`;
        }).join("");
        timelineHtml = `<div class="tg-timeline">${segs}</div>`;
      }
      const dedicaHtml = dedica ? `<span class="dedica">${escapeHtml(dedica)}</span>` : "";
      row.innerHTML = `<div class="court-name"><span>${escapeHtml(nomeCampo)}</span>${dedicaHtml}</div>${timelineHtml}`;
      group.appendChild(row);
    });
    board.appendChild(group);
  });

  // Linea "ora": solo se il giorno mostrato è oggi, altrimenti non avrebbe senso.
  const boardWrap = document.getElementById("board-wrap");
  boardWrap.querySelectorAll(".now-line").forEach(el => el.remove());
  const ora = oraLocaleZurigo();
  if (state.data === ora.dataIso && ora.minuti >= GIORNO_INIZIO && ora.minuti <= GIORNO_FINE) {
    boardWrap.style.setProperty("--now-pct", ((ora.minuti - GIORNO_INIZIO) / (GIORNO_FINE - GIORNO_INIZIO)).toFixed(4));
    const nowLine = document.createElement("div");
    nowLine.className = "now-line";
    boardWrap.appendChild(nowLine);
  }

  document.getElementById("stato-caricamento").classList.add("hidden");
  boardWrap.classList.remove("hidden");
}

function renderHourTicks() {
  const el = document.getElementById("hour-ticks");
  el.innerHTML = "";
  for (let h = 8; h <= 22; h++) el.innerHTML += `<span>${pad2(h)}:00</span>`;
}

// ---------- Init ----------

(async function init() {
  await Promise.all([loadDatiCentro(), loadDiscipline()]);
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
  renderHourTicks();

  document.getElementById("giorno-prev").addEventListener("click", () => { state.data = addGiorni(state.data, -1); render(); });
  document.getElementById("giorno-next").addEventListener("click", () => { state.data = addGiorni(state.data, 1); render(); });
  document.getElementById("giorno-oggi").addEventListener("click", () => { state.data = toISO(new Date()); render(); });

  await loadCampi();

  // Non si aspetta firebase.auth() per il primo giro: chi non è loggato
  // (il caso più comune, il monitor in reception) vede subito qualcosa
  // invece di fissare "Caricamento…" per il tempo di inizializzazione
  // dell'SDK auth — quando lo stato auth è pronto, si ri-renderizza da
  // capo aggiungendo i nomi se il permesso c'è.
  render();
  firebase.auth().onAuthStateChanged(async (user) => {
    permessoNomi = await calcolaPermessoNomi(user ? user.uid : null);
    render();
  });

  // Aggiornamento periodico, stesso motivo già applicato alle pagine di
  // prenotazione: senza, chi lascia il monitor acceso vede la linea "ora"
  // e lo stato "in pagamento scaduto" restare fermi.
  setInterval(render, 60000);
})();
