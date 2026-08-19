// ============================================================
// prenota-campo.js — prenotazione pubblica tennis/squash, senza login
// obbligatorio. A differenza del padel (griglia continua, un solo
// campo) qui: più campi raggruppati per disciplina/posizione (letti da
// "campi", mai hardcoded — aggiungere un campo in Configurazione basta
// a renderlo prenotabile qui), slot fissi (niente anti-buco, vedi
// functions/index.js), e un prezzo che dipende da chi gioca — per
// questo la vista principale è un elenco di orari liberi ("Opzione C",
// scelta esplicitamente) invece di un tabellone a griglia.
//
// Riconoscimento del dispositivo: se firebase.auth().currentUser esiste
// (sessione ottenuta via attiva-socio.html) si legge sociDevices/{uid}
// per sapere la/le categorie di chi prenota da qui: tariffa e priorità
// di anticipo vengono comunque sempre ricalcolate/riverificate lato
// server in creaPrenotazioneCampo, questo qui è solo per mostrare un
// prezzo indicativo e permettere di scegliere il profilo giusto.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login staff, ma un riconoscimento via Firebase Auth diverso).
// ============================================================

// SLOT_TENNIS non va ridichiarato qui: è già una const globale di
// js/utils.js (caricato prima su questa pagina) — ridichiararla con lo
// stesso nome come "const" causerebbe un SyntaxError che blocca l'intero
// script (script normali, non moduli: condividono lo stesso scope).

function addMinuti(orario, minuti) {
  const [h, m] = orario.split(":").map(Number);
  const tot = h * 60 + m + minuti;
  return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
}

function generaOrariSquash() {
  const out = [];
  for (let m = 8 * 60 + 15; m <= 21 * 60 + 45; m += 45) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}
const ORARI_INIZIO_SQUASH = generaOrariSquash();

// dataIso opzionale: se passato, toglie gli slot che finirebbero dopo la
// chiusura del giorno (sabato/domenica/festivi il centro chiude alle
// 20:30, non solo per il padel — vedi padelChiusuraGiorno più sotto,
// stessa soglia riusata qui invece di duplicarla una terza volta).
function slotFissiDisciplina(disciplina, dataIso) {
  let slots;
  if (disciplina === "tennis") slots = SLOT_TENNIS.map(([inizio, fine]) => ({ inizio, fine }));
  else if (disciplina === "squash") slots = ORARI_INIZIO_SQUASH.map(inizio => ({ inizio, fine: addMinuti(inizio, 45) }));
  else return [];
  if (dataIso) {
    const close = padelChiusuraGiorno(dataIso);
    slots = slots.filter(s => orarioToMin(s.fine) <= close);
  }
  return slots;
}

// ---------- Padel: griglia continua con anti-buco (duplicata da
// js/prenota-padel.js/functions/index.js — unico campo "1", non modellato
// in "campi") — a differenza di tennis/squash qui gli slot non sono fissi:
// vanno calcolati per la durata scelta (60'/90'), stesso identico
// algoritmo del tabellone padel dedicato.
const PADEL_OPEN = 8 * 60;
const PADEL_CLOSE = 23 * 60;
const PADEL_BOUNDARY = 17 * 60;
const PADEL_SLOT_FISSO_PRANZO = 12 * 60 + 15;
const PADEL_SLOT_FISSO_SERALE = 17 * 60 + 30;

// Un giorno festivo (IMPOSTAZIONI.festivi, js/utils.js) accorcia l'orario
// come sabato/domenica, fino a IMPOSTAZIONI.chiusuraWeekend (configurabile
// da Configurazione → Impostazioni generali, default "20:30") — stesso
// criterio delle altre pagine di prenotazione. Vale anche per tennis/
// squash, che riusano questa stessa funzione (vedi slotFissiDisciplina
// sopra), non solo per il padel nonostante il nome.
function padelChiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  const chiusuraWeekend = orarioToMin(IMPOSTAZIONI.chiusuraWeekend || "20:30");
  return (giorno === 0 || giorno === 6 || (IMPOSTAZIONI.festivi || []).includes(dataIso)) ? chiusuraWeekend : PADEL_CLOSE;
}
function padelFeriale(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !(IMPOSTAZIONI.festivi || []).includes(dataIso);
}
function padelFreeIntervals(bookings, close) {
  const sorted = [...bookings].sort((a, b) => a.start - b.start);
  const free = [];
  let cursor = PADEL_OPEN;
  sorted.forEach(b => {
    if (b.start > cursor) free.push([cursor, b.start]);
    cursor = Math.max(cursor, b.end);
  });
  if (cursor < close) free.push([cursor, close]);
  return free;
}
function padelGapPrimaOk(t, a) {
  const gap = t - a;
  return gap === 0 || gap >= 60;
}
function padelSlotsInInterval(a, b, duration, feriale, oggi) {
  const starts = [];
  if (duration === 90) {
    for (let t = a; t < PADEL_BOUNDARY && t + 90 <= b; t += 30) {
      const remain = b - (t + 90);
      if ((remain === 0 || remain >= 60) && padelGapPrimaOk(t, a)) starts.push(t);
    }
    // La griglia a passi di 30' sopra parte da `a` e avanza a scatti: se la
    // distanza fino al prossimo impegno non è multipla di 30' salta esatta-
    // mente i due punti più utili — quello che tocca l'impegno (buco 0') e
    // quello che lascia il buco minimo consentito (60') — anche se validi
    // per la stessa regola. Cercati qui esplicitamente, in aggiunta.
    [b - 90, b - 90 - 60].forEach(t => {
      if (t >= a && t < PADEL_BOUNDARY && !starts.includes(t) && padelGapPrimaOk(t, a)) {
        const remain = b - (t + 90);
        if (remain === 0 || remain >= 60) starts.push(t);
      }
    });
    const primoChain = Math.max(a, PADEL_BOUNDARY);
    if (padelGapPrimaOk(primoChain, a)) {
      const passo = oggi ? 15 : 90;
      for (let t = primoChain; t + 90 <= b; t += passo) starts.push(t);
    }
    if (PADEL_SLOT_FISSO_PRANZO >= a && PADEL_SLOT_FISSO_PRANZO + 90 <= b && padelGapPrimaOk(PADEL_SLOT_FISSO_PRANZO, a)) {
      const remain = b - (PADEL_SLOT_FISSO_PRANZO + 90);
      if (remain === 0 || remain >= 60) starts.push(PADEL_SLOT_FISSO_PRANZO);
    }
    if (feriale && PADEL_SLOT_FISSO_SERALE >= a && PADEL_SLOT_FISSO_SERALE + 90 <= b && padelGapPrimaOk(PADEL_SLOT_FISSO_SERALE, a)) {
      const remain = b - (PADEL_SLOT_FISSO_SERALE + 90);
      if (remain === 0 || remain >= 60) starts.push(PADEL_SLOT_FISSO_SERALE);
    }
  } else {
    const limit = Math.min(b, PADEL_BOUNDARY + 30);
    for (let t = a; t + 60 <= limit; t += 30) {
      const remain = limit - (t + 60);
      if ((remain === 0 || remain >= 60) && padelGapPrimaOk(t, a)) starts.push(t);
    }
    // Stesso problema di "punto utile saltato dalla griglia" spiegato sopra
    // per i 90', qui per i 60'.
    [limit - 60, limit - 60 - 60].forEach(t => {
      if (t >= a && !starts.includes(t) && padelGapPrimaOk(t, a)) {
        const remain = limit - (t + 60);
        if (remain === 0 || remain >= 60) starts.push(t);
      }
    });
    // Se la finestra libera è più stretta di 90', un 90' non ci sarebbe
    // mai potuto stare comunque — un margine sprecato da un lato non toglie
    // nessuna vera opportunità in quel caso, quindi qui (solo qui) si
    // ignora la regola del buco minimo pur di non lasciare vuota tutta la
    // finestra: meglio un'ora piena occupata con uno scarto ai bordi che
    // niente.
    if (limit - a < 90) {
      [a, limit - 60].forEach(t => {
        if (t >= a && t + 60 <= limit && !starts.includes(t)) starts.push(t);
      });
    }
    if (PADEL_SLOT_FISSO_PRANZO >= a && PADEL_SLOT_FISSO_PRANZO + 60 <= limit && padelGapPrimaOk(PADEL_SLOT_FISSO_PRANZO, a)) {
      const remain = limit - (PADEL_SLOT_FISSO_PRANZO + 60);
      if (remain === 0 || remain >= 60) starts.push(PADEL_SLOT_FISSO_PRANZO);
    }
  }
  return starts;
}
function padelValidStarts(bookings, duration, close, feriale, oggi) {
  const free = padelFreeIntervals(bookings, close);
  let starts = [];
  free.forEach(([a, b]) => { starts = starts.concat(padelSlotsInInterval(a, b, duration, feriale, oggi)); });
  return [...new Set(starts)].sort((x, y) => x - y);
}
function minutiToOrario(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}
function sovrapposto(aInizio, aFine, bInizio, bFine) {
  return orarioToMin(aInizio) < orarioToMin(bFine) && orarioToMin(aFine) > orarioToMin(bInizio);
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
  return (Date.now() - booking.createdAt.toMillis()) > 15 * 60000;
}

const GIORNI_BREVI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }

// ---------- Stato ----------

let CAMPI = []; // [{id, numero, disciplina, posizione}]
let GRUPPI = []; // [{key, disciplina, posizione, label, campi:[...]}]
// Il padel non ha un vero courtId in "campi" (fisso "1", mai un doc
// Firestore) — se l'admin ha comunque creato lì una voce per dargli un
// nome reale (es. "Indoor 1"), va usata solo per l'etichetta, mai per
// l'identità della prenotazione. "1" resta il fallback.
let PADEL_NUMERO = "1";
let CHIUSURE_CENTRO = []; // [{id, discipline}]
let CHIUSURE_PADEL = new Set(); // date ISO, solo per il padel (chiusurePadel)
let TARIFFE_CAMPI = [];
let FORFAIT_CAMPI = [];
let IMPOSTAZIONI_PC = { settimaneVisibili: 4 };
let PROFILI = []; // sociDevices.profili
let profiloScelto = null; // socioId scelto, o null = esterno/primo profilo

const state = { gruppoKey: null, data: null, bookingsPerCourt: {}, apertoPerCourtSlot: null, durataPadel: 90, tennisPosizione: "interno" };
let bookingsUnsub = null;

function disciplinaLabel(d) { return { tennis: "Tennis", squash: "Squash", padel: "Padel" }[d] || d; }
function posizioneLabel(p) { return { interno: "Interno", esterno: "Esterno" }[p] || p; }

// Un dispositivo loggato con un account staff (documento "users") paga
// come "maestro" — stessa precedenza di risolviCategoriaPrenotante in
// functions/index.js, controllata PRIMA dei profili sociDevices: così
// l'anteprima prezzo mostra la stessa categoria che verrà davvero
// addebitata, invece di mostrare sempre "esterno" per chi è staff.
let sessioneStaff = false;

function categoriaCorrente() {
  if (sessioneStaff) return "maestro";
  if (!profiloScelto) return "esterno";
  const p = PROFILI.find(x => x.socioId === profiloScelto);
  return p ? p.categoria : "esterno";
}

// GIORNI_SETTIMANA/GIORNO_JS_DAY vengono da js/utils.js (già caricato) —
// qui serve la direzione inversa (da Date a codice "lun".."dom").
// Un giorno festivo (IMPOSTAZIONI.festivi, js/utils.js) conta come
// domenica ai fini della tariffa — stesso criterio del server.
function giornoSettimanaCodice(dataIso) {
  if ((IMPOSTAZIONI.festivi || []).includes(dataIso)) return "dom";
  const jsDay = new Date(dataIso + "T00:00:00").getDay();
  return Object.keys(GIORNO_JS_DAY).find(id => GIORNO_JS_DAY[id] === jsDay);
}

function quotaCategoriaClient(disciplina, posizione, categoria, dataIso, startTime, durataMinuti) {
  // Stessa normalizzazione del server (functions/index.js, quotaCategoria):
  // undefined e null devono contare come lo stesso "nessuna posizione".
  posizione = posizione ?? null;
  const forfaitAttivo = FORFAIT_CAMPI.some(f =>
    f.disciplina === disciplina && f.posizione === posizione
    && dataIso >= f.periodoInizio && dataIso <= f.periodoFine
    && (f.categorie || []).includes(categoria)
  );
  if (forfaitAttivo) return 0;

  const giorno = giornoSettimanaCodice(dataIso);
  const startMin = orarioToMin(startTime);
  const candidati = TARIFFE_CAMPI
    .filter(t => t.disciplina === disciplina && t.posizione === posizione && t.categoria === categoria)
    .filter(t => t.oraInizio != null && t.oraFine != null)
    .filter(t => !(t.giorniSettimana || []).length || t.giorniSettimana.includes(giorno))
    .filter(t => startMin >= orarioToMin(t.oraInizio) && startMin < orarioToMin(t.oraFine))
    .filter(t => t.durataMinuti == null || t.durataMinuti === durataMinuti)
    .sort((a, b) => {
      const specDurataA = a.durataMinuti != null ? 1 : 0;
      const specDurataB = b.durataMinuti != null ? 1 : 0;
      if (specDurataA !== specDurataB) return specDurataB - specDurataA;
      const durataA = orarioToMin(a.oraFine) - orarioToMin(a.oraInizio);
      const durataB = orarioToMin(b.oraFine) - orarioToMin(b.oraInizio);
      if (durataA !== durataB) return durataA - durataB;
      const giorniA = (a.giorniSettimana || []).length || 7;
      const giorniB = (b.giorniSettimana || []).length || 7;
      return giorniA - giorniB;
    });
  return candidati.length > 0 ? candidati[0].prezzo : null;
}

// ---------- Gruppi/campi ----------

// Ordine fisso delle schede (non alfabetico, deciso esplicitamente):
// Tennis Interno, Tennis Esterno, Padel, Squash.
function rangoGruppo(g) {
  if (g.disciplina === "tennis" && g.posizione === "interno") return 0;
  if (g.disciplina === "tennis" && g.posizione === "esterno") return 1;
  if (g.disciplina === "padel") return 2;
  if (g.disciplina === "squash") return 3;
  return 99;
}

function costruisciGruppi() {
  const map = new Map();
  CAMPI.forEach(c => {
    // I campi squash non hanno mai avuto un campo "posizione" in Firestore
    // (assente, non solo vuoto) — letto così darebbe `undefined`, diverso
    // dal `null` esplicito salvato nelle tariffe: normalizzato qui, unica
    // fonte di verità per il resto della pagina (gruppo.posizione).
    const posizione = c.posizione ?? null;
    const key = `${c.disciplina}__${posizione || "_"}`;
    if (!map.has(key)) {
      map.set(key, {
        key, disciplina: c.disciplina, posizione,
        label: `${disciplinaLabel(c.disciplina)}${posizione ? " " + posizioneLabel(posizione) : ""}`,
        campi: []
      });
    }
    map.get(key).campi.push(c);
  });
  GRUPPI = [...map.values()];
  // Il padel ha oggi un solo campo, non modellato nella collection "campi"
  // (courtId fisso "1", come in prenota-padel.js/functions/index.js) —
  // voce sintetica per includerlo nello stesso ingresso unico.
  GRUPPI.push({ key: "padel__", disciplina: "padel", posizione: null, label: "Padel", campi: [{ id: "1", numero: PADEL_NUMERO, disciplina: "padel" }] });
  GRUPPI.sort((a, b) => rangoGruppo(a) - rangoGruppo(b));
}

// Una scheda per disciplina, non per gruppo: Tennis Interno/Esterno
// restano due GRUPPI distinti internamente (li usano slotsLiberi,
// quotaCategoriaClient, ecc.), ma in cima si mostra un solo bottone
// "Tennis" — quale dei due è attivo lo sceglie il selettore
// Interno/Esterno sotto (renderPosizioneTennis). GRUPPI è già ordinato da
// rangoGruppo (tennis-interno, tennis-esterno, padel, squash): prendendo
// la prima occorrenza per disciplina si ottiene Tennis, Padel, Squash
// senza bisogno di un ordinamento separato.
function disciplineUniche() {
  const viste = new Set();
  const tabs = [];
  GRUPPI.forEach(g => {
    if (viste.has(g.disciplina)) return;
    viste.add(g.disciplina);
    tabs.push(g.disciplina);
  });
  return tabs;
}

function renderGruppoPills() {
  const el = document.getElementById("gruppo-pills");
  const disciplinaAttiva = gruppoAttivo()?.disciplina;
  el.innerHTML = disciplineUniche().map(d => `
    <button type="button" data-disciplina="${d}" aria-pressed="${d === disciplinaAttiva}">${escapeHtml(disciplinaLabel(d))}</button>
  `).join("");
  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => selezionaDisciplina(btn.dataset.disciplina));
  });
}

function selezionaDisciplina(disciplina) {
  const key = disciplina === "tennis"
    ? `tennis__${state.tennisPosizione}`
    : (GRUPPI.find(g => g.disciplina === disciplina) || {}).key;
  if (!key) return;
  selezionaGruppo(key);
}

function selezionaGruppo(key) {
  state.gruppoKey = key;
  const disciplinaAttiva = gruppoAttivo()?.disciplina;
  document.querySelectorAll("#gruppo-pills button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.disciplina === disciplinaAttiva)));
  ascoltaPrenotazioniGiorno();
}

// ---------- Day strip ----------

function buildDayStrip() {
  const el = document.getElementById("dayStrip");
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);
  const nrGiorni = Math.max(7, (IMPOSTAZIONI_PC.settimaneVisibili || 4) * 7);

  const giorni = [];
  for (let i = 0; i < nrGiorni; i++) {
    const d = new Date(oggi);
    d.setDate(oggi.getDate() + i);
    giorni.push(d);
  }

  el.innerHTML = giorni.map(d => {
    const iso = toISO(d);
    const disc = gruppoAttivo()?.disciplina;
    const chiuso = CHIUSURE_CENTRO.some(c => c.id === iso && (!(c.discipline || []).length || c.discipline.includes(disc)))
      || (disc === "padel" && CHIUSURE_PADEL.has(iso));
    return `
      <button type="button" class="day-btn${chiuso ? " chiuso" : ""}" role="tab" data-data="${iso}" aria-pressed="${iso === state.data}">
        <span class="d">${GIORNI_BREVI[d.getDay()]}</span>
        <span class="n">${d.getDate()}</span>
      </button>
    `;
  }).join("");

  el.querySelectorAll(".day-btn").forEach(btn => {
    btn.addEventListener("click", () => selezionaGiorno(btn.dataset.data));
  });
}

function gruppoAttivo() {
  return GRUPPI.find(g => g.key === state.gruppoKey) || null;
}

function selezionaGiorno(dataIso) {
  state.data = dataIso;
  state.apertoPerCourtSlot = null;
  document.querySelectorAll(".day-btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.data === dataIso)));
  ascoltaPrenotazioniGiorno();
}

// ---------- Dati Firestore ----------

function ascoltaPrenotazioniGiorno() {
  if (bookingsUnsub) bookingsUnsub();
  const gruppo = gruppoAttivo();
  if (!gruppo || !state.data) return;

  const courtIds = gruppo.campi.map(c => c.id);
  bookingsUnsub = db.collection("bookings")
    .where("date", "==", state.data)
    .where("courtId", "in", courtIds)
    .onSnapshot(
      (snap) => {
        state.bookingsPerCourt = {};
        snap.docs.map(d => d.data())
          .filter(b => (b.status === "PENDING_PAYMENT" && !pendingScaduto(b)) || b.status === "CONFIRMED" || b.status === "COMPLETED")
          .forEach(b => {
            (state.bookingsPerCourt[b.courtId] = state.bookingsPerCourt[b.courtId] || []).push(b);
          });
        render();
      },
      (err) => showError(document.getElementById("prenota-error"), "Errore nel caricamento: " + err.message)
    );
}

// ---------- Render elenco (Opzione C) ----------

function slotsLiberi(gruppo) {
  const ora = oraLocaleZurigo();
  const oggi = state.data === ora.dataIso;

  if (gruppo.disciplina === "padel") {
    const campo = gruppo.campi[0];
    const bookings = (state.bookingsPerCourt[campo.id] || [])
      .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));
    const close = padelChiusuraGiorno(state.data);
    const starts = padelValidStarts(bookings, state.durataPadel, close, padelFeriale(state.data), oggi)
      .filter(s => !(oggi && s <= ora.minuti));
    return starts.map(s => ({ campo, inizio: minutiToOrario(s), fine: minutiToOrario(s + state.durataPadel) }));
  }

  const fissi = slotFissiDisciplina(gruppo.disciplina, state.data);
  const risultati = [];
  gruppo.campi.forEach(campo => {
    const occupati = state.bookingsPerCourt[campo.id] || [];
    fissi.forEach(slot => {
      if (oggi && orarioToMin(slot.inizio) <= ora.minuti) return;
      const occ = occupati.some(b => sovrapposto(slot.inizio, slot.fine, b.startTime, b.endTime));
      if (!occ) risultati.push({ campo, ...slot });
    });
  });
  return risultati.sort((a, b) => a.inizio.localeCompare(b.inizio) || a.campo.numero.localeCompare(b.campo.numero));
}

function renderDurataPadel() {
  return `
    <div class="picker-label" style="margin-bottom:8px;">Scegli la durata</div>
    <div class="gruppo-pills" id="durata-padel-pills" style="margin-bottom:10px;">
      <button type="button" data-dur="60" aria-pressed="${state.durataPadel === 60}">60'</button>
      <button type="button" data-dur="90" aria-pressed="${state.durataPadel === 90}">90'</button>
    </div>
  `;
}

function renderPosizioneTennis() {
  return `
    <div class="gruppo-pills" id="posizione-tennis-pills" style="margin-bottom:10px;">
      <button type="button" data-pos="interno" aria-pressed="${state.tennisPosizione === "interno"}">Interno</button>
      <button type="button" data-pos="esterno" aria-pressed="${state.tennisPosizione === "esterno"}">Esterno</button>
    </div>
  `;
}

function wirePosizioneTennis() {
  document.querySelectorAll("#posizione-tennis-pills button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.tennisPosizione = btn.dataset.pos;
      selezionaGruppo(`tennis__${state.tennisPosizione}`);
    });
  });
}

function render() {
  const el = document.getElementById("slot-list");
  const subToggleEl = document.getElementById("subToggleContainer");
  const gruppo = gruppoAttivo();
  if (!gruppo) { el.innerHTML = ""; subToggleEl.innerHTML = ""; return; }

  // Il sotto-selettore (durata padel / interno-esterno tennis) vive fuori
  // da #slot-list, dentro lo stesso blocco sticky del day-strip — così
  // resta sempre visibile mentre si scorrono gli orari, invece di sparire
  // insieme al resto della lista.
  subToggleEl.innerHTML = gruppo.disciplina === "padel" ? renderDurataPadel()
    : gruppo.disciplina === "tennis" ? renderPosizioneTennis() : "";
  wireDurataPadel();
  wirePosizioneTennis();

  const chiuso = CHIUSURE_CENTRO.some(c => c.id === state.data && (!(c.discipline || []).length || c.discipline.includes(gruppo.disciplina)))
    || (gruppo.disciplina === "padel" && CHIUSURE_PADEL.has(state.data));
  if (chiuso) {
    el.innerHTML = `<div class="empty-state"><div class="display">Centro chiuso</div><p>Non prenotabile in questa data.</p></div>`;
    return;
  }

  const liberi = slotsLiberi(gruppo);
  if (liberi.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessun orario libero</div><p>Prova un altro giorno.</p></div>`;
    return;
  }

  const categoria = categoriaCorrente();
  el.innerHTML = liberi.map((s, i) => {
    const durataMinuti = gruppo.disciplina === "padel" ? state.durataPadel : orarioToMin(s.fine) - orarioToMin(s.inizio);
    const prezzo = quotaCategoriaClient(gruppo.disciplina, gruppo.posizione, categoria, state.data, s.inizio, durataMinuti);
    const prezzoLabel = prezzo == null ? "—" : `CHF ${prezzo.toFixed(2)}`;
    return `
      <div class="slot-row">
        <div class="si">
          <span class="st">${s.inizio}</span>
          <span class="sc">${escapeHtml(disciplinaLabel(gruppo.disciplina))} · Campo ${escapeHtml(s.campo.numero)}</span>
        </div>
        <span class="sp">${prezzoLabel}</span>
        <button type="button" class="btn btn-ghost apri-prenota-btn" style="width:auto;padding:8px 14px;font-size:0.76rem;" data-idx="${i}">Prenota</button>
      </div>
      <div class="prenota-panel-slot hidden" data-idx="${i}"></div>
    `;
  }).join("");

  el.querySelectorAll(".apri-prenota-btn").forEach((btn, i) => {
    btn.addEventListener("click", () => apriPannelloPrenota(liberi[i], i));
  });
}

function wireDurataPadel() {
  document.querySelectorAll("#durata-padel-pills button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.durataPadel = parseInt(btn.dataset.dur, 10);
      render();
    });
  });
}

// ---------- Pannello di conferma prenotazione ----------
//
// Numero di campi "altro giocatore" mostrati, per disciplina: 1 per il
// tennis (la tariffa configurata è per l'intero slot, divisa a metà tra i
// due giocatori — ognuno la propria metà, secondo la propria categoria:
// stessa categoria per entrambi = tariffa intera invariata, categorie
// miste = media delle due), 3 per il padel (fino a 4 nominativi, solo per
// il tabellone — il prezzo è per il campo, non cambia in base a chi/quanti
// giocano), nessuno per lo squash.
function numeroCampiGiocatore(disciplina) {
  if (disciplina === "tennis") return 1;
  if (disciplina === "padel") return 3;
  return 0;
}

let giocatoriRisolti = []; // [{socioId, nomeVisualizzato} | null, ...]
let ricercaGiocatoreTimeout = null;

function apriPannelloPrenota(slot, idx) {
  document.querySelectorAll(".prenota-panel-slot").forEach(p => { p.innerHTML = ""; p.classList.add("hidden"); });
  const panel = document.querySelector(`.prenota-panel-slot[data-idx="${idx}"]`);

  const nCampi = numeroCampiGiocatore(slot.campo.disciplina);
  giocatoriRisolti = new Array(nCampi).fill(null);

  const etichetta = slot.campo.disciplina === "tennis" ? "Nome del secondo giocatore" : "Nome giocatore";
  const introPadel = nCampi > 0 && slot.campo.disciplina === "padel"
    ? `<p style="color:var(--chalk-grey);font-size:0.78rem;margin:0 0 10px;">Chi gioca con te? (facoltativo — il prezzo è per il campo, non cambia in base al numero di giocatori).</p>` : "";
  const introTennis = slot.campo.disciplina === "tennis"
    ? `<p style="color:var(--chalk-grey);font-size:0.78rem;margin:0 0 10px;">Il prezzo mostrato è indicativo: se il secondo giocatore ha una categoria diversa dalla tua, la tariffa finale si adegua di conseguenza.</p>` : "";

  panel.innerHTML = `
    <div class="prenota-panel">
      <div style="display:flex;justify-content:flex-end;margin-bottom:4px;">
        <button type="button" class="btn btn-ghost chiudi-prenota-btn" style="width:auto;padding:4px 10px;font-size:0.9rem;line-height:1;" aria-label="Chiudi">✕</button>
      </div>
      ${introPadel}
      ${introTennis}
      ${Array.from({ length: nCampi }).map((_, n) => `
        <div class="field" id="g-campo-${idx}-${n}">
          <label for="g-nome-${idx}-${n}">${etichetta}${nCampi > 1 ? " " + (n + 2) : ""}</label>
          <input type="text" id="g-nome-${idx}-${n}" placeholder="es. Mario Rossi" autocomplete="off">
          <div id="g-esito-${idx}-${n}"></div>
        </div>
        <div class="entry-card hidden" id="g-selezionato-${idx}-${n}" style="margin-bottom:14px;">
          <div class="entry-main">
            <div class="entry-tipo" id="g-selezionato-nome-${idx}-${n}"></div>
          </div>
          <button type="button" class="btn btn-ghost cambia-giocatore-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-n="${n}">Cambia</button>
        </div>
      `).join("")}
      <div class="error-msg" id="conferma-error-${idx}"></div>
      <button type="button" class="btn btn-primary conferma-prenota-btn" data-idx="${idx}" style="margin-top:10px;">Conferma prenotazione</button>
    </div>
  `;
  panel.classList.remove("hidden");

  panel.querySelector(".chiudi-prenota-btn").addEventListener("click", () => {
    panel.innerHTML = "";
    panel.classList.add("hidden");
  });

  const selezionaGiocatore = (n, socioId, nome) => {
    giocatoriRisolti[n] = { socioId, nomeVisualizzato: nome };
    document.getElementById(`g-campo-${idx}-${n}`).classList.add("hidden");
    document.getElementById(`g-selezionato-nome-${idx}-${n}`).textContent = nome;
    document.getElementById(`g-selezionato-${idx}-${n}`).classList.remove("hidden");
  };

  for (let n = 0; n < nCampi; n++) {
    const input = document.getElementById(`g-nome-${idx}-${n}`);
    const esitoEl = document.getElementById(`g-esito-${idx}-${n}`);

    input.addEventListener("input", () => {
      clearTimeout(ricercaGiocatoreTimeout);
      giocatoriRisolti[n] = null;
      const nome = input.value.trim();
      if (nome.length < 3) { esitoEl.innerHTML = ""; return; }
      esitoEl.innerHTML = `<p class="g2-esito">Ricerca…</p>`;
      ricercaGiocatoreTimeout = setTimeout(async () => {
        try {
          const fn = cloudFunctions().httpsCallable("cercaGiocatore");
          const { data } = await fn({ nome });
          if (data.risultati.length === 0) {
            esitoEl.innerHTML = `<p class="g2-esito no">Non trovato tra i soci — verrà considerato esterno.</p>`;
            return;
          }
          esitoEl.innerHTML = data.risultati.map(s => `
            <div class="entry-card" style="margin-bottom:6px;">
              <div class="entry-main">
                <div class="entry-tipo">${escapeHtml(s.nome)} ${escapeHtml(s.cognome)}</div>
              </div>
              <button type="button" class="btn btn-ghost seleziona-giocatore-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;"
                data-socio-id="${s.socioId}" data-nome="${escapeHtml(s.nome)} ${escapeHtml(s.cognome)}">Seleziona</button>
            </div>
          `).join("");
          esitoEl.querySelectorAll(".seleziona-giocatore-btn").forEach(btn => {
            btn.addEventListener("click", () => selezionaGiocatore(n, btn.dataset.socioId, btn.dataset.nome));
          });
        } catch { /* ricerca facoltativa, non blocca la prenotazione */ }
      }, 500);
    });

    document.querySelector(`#g-selezionato-${idx}-${n} .cambia-giocatore-btn`).addEventListener("click", () => {
      giocatoriRisolti[n] = null;
      document.getElementById(`g-campo-${idx}-${n}`).classList.remove("hidden");
      document.getElementById(`g-selezionato-${idx}-${n}`).classList.add("hidden");
      input.value = "";
      esitoEl.innerHTML = "";
      input.focus();
    });
  }

  panel.querySelector(".conferma-prenota-btn").addEventListener("click", () => confermaPrenota(slot, idx));
}

async function confermaPrenota(slot, idx) {
  const btn = document.querySelector(`.conferma-prenota-btn[data-idx="${idx}"]`);
  const errorEl = document.getElementById(`conferma-error-${idx}`);
  errorEl.textContent = "";
  btn.disabled = true;
  mostraCaricamento("Prenotazione in corso — non chiudere questa pagina…");

  const nCampi = numeroCampiGiocatore(slot.campo.disciplina);
  const nomiInput = Array.from({ length: nCampi }, (_, n) => document.getElementById(`g-nome-${idx}-${n}`).value.trim());
  const nomeRisolto = n => giocatoriRisolti[n] ? giocatoriRisolti[n].nomeVisualizzato : (nomiInput[n] || null);
  const socioIdRisolto = n => giocatoriRisolti[n] ? giocatoriRisolti[n].socioId : null;

  try {
    let fn, payload;
    if (slot.campo.disciplina === "padel") {
      fn = cloudFunctions().httpsCallable("creaPrenotazionePubblica");
      payload = {
        courtId: slot.campo.id,
        date: state.data,
        startTime: slot.inizio,
        endTime: slot.fine,
        durationMinutes: state.durataPadel,
        profiloId: profiloScelto,
        giocatore2Nome: nCampi > 0 ? nomeRisolto(0) : null, giocatore2SocioId: nCampi > 0 ? socioIdRisolto(0) : null,
        giocatore3Nome: nCampi > 1 ? nomeRisolto(1) : null, giocatore3SocioId: nCampi > 1 ? socioIdRisolto(1) : null,
        giocatore4Nome: nCampi > 2 ? nomeRisolto(2) : null, giocatore4SocioId: nCampi > 2 ? socioIdRisolto(2) : null
      };
    } else {
      fn = cloudFunctions().httpsCallable("creaPrenotazioneCampo");
      payload = {
        courtId: slot.campo.id,
        date: state.data,
        startTime: slot.inizio,
        giocatore2Nome: nCampi > 0 ? nomeRisolto(0) : null,
        giocatore2SocioId: nCampi > 0 ? socioIdRisolto(0) : null,
        profiloId: profiloScelto
      };
    }
    const result = await fn(payload);

    if (result.data.pagamentoNecessario) {
      window.location.href = result.data.paymentPageUrl;
    } else {
      window.location.href = `biglietto.html?t=${result.data.token}`;
    }
  } catch (err) {
    nascondiCaricamento();
    showError(errorEl, "Errore: " + (err.message || err));
    btn.disabled = false;
  }
}

// ---------- Riconoscimento socio ----------

async function caricaProfiliDispositivo() {
  const user = firebase.auth().currentUser;
  const box = document.getElementById("socio-box");
  const boxTesto = document.getElementById("socio-box-testo");
  const selectBox = document.getElementById("profilo-select-box");

  if (!user) {
    boxTesto.textContent = "Stai prenotando come utente esterno";
    sessioneStaff = false;
    PROFILI = [];
    profiloScelto = null;
    selectBox.classList.add("hidden");
    return;
  }

  try {
    const userSnap = await db.collection("users").doc(user.uid).get();
    sessioneStaff = userSnap.exists;
  } catch {
    sessioneStaff = false;
  }
  if (sessioneStaff) {
    boxTesto.textContent = "Stai prenotando come membro dello staff (categoria Maestro)";
    PROFILI = [];
    profiloScelto = null;
    selectBox.classList.add("hidden");
    return;
  }

  try {
    const doc = await db.collection("sociDevices").doc(user.uid).get();
    PROFILI = doc.exists ? (doc.data().profili || []) : [];
  } catch {
    PROFILI = [];
  }

  if (PROFILI.length === 0) {
    boxTesto.textContent = "Stai prenotando come utente esterno";
    profiloScelto = null;
    selectBox.classList.add("hidden");
    return;
  }

  profiloScelto = PROFILI[0].socioId;
  box.classList.add("hidden");

  if (PROFILI.length > 1) {
    selectBox.classList.remove("hidden");
    const select = document.getElementById("profilo-select");
    select.innerHTML = PROFILI.map(p => `<option value="${p.socioId}">${escapeHtml(p.nome)} (${escapeHtml(p.categoria)})</option>`).join("");
    select.value = profiloScelto;
    select.onchange = () => { profiloScelto = select.value; render(); };
  } else {
    selectBox.classList.add("hidden");
  }
}

// ---------- Init ----------

(async function init() {
  await loadDatiCentro();
  await loadImpostazioni();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const esitoPagamento = new URLSearchParams(location.search).get("pagamento");
  if (esitoPagamento === "fallito") {
    history.replaceState(null, "", location.pathname);
  }

  const [campiSnap, chiusureSnap, tariffeSnap, forfaitSnap, impostazioniSnap, chiusurePadelSnap] = await Promise.all([
    db.collection("campi").where("attivo", "==", true).get(),
    db.collection("chiusureCentro").get(),
    db.collection("tariffeCampi").get(),
    db.collection("forfaitCampi").get(),
    db.collection("impostazioni").doc("prenotazioniCampi").get(),
    db.collection("chiusurePadel").get()
  ]);

  const campiTutti = campiSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CAMPI = campiTutti.filter(c => c.disciplina === "tennis" || c.disciplina === "squash");
  const padelCampoReale = campiTutti.find(c => c.disciplina === "padel");
  if (padelCampoReale && padelCampoReale.numero) PADEL_NUMERO = padelCampoReale.numero;
  CHIUSURE_CENTRO = chiusureSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  TARIFFE_CAMPI = tariffeSnap.docs.map(d => d.data());
  FORFAIT_CAMPI = forfaitSnap.docs.map(d => d.data());
  if (impostazioniSnap.exists) IMPOSTAZIONI_PC = { ...IMPOSTAZIONI_PC, ...impostazioniSnap.data() };
  CHIUSURE_PADEL = new Set(chiusurePadelSnap.docs.map(d => d.id));

  costruisciGruppi();
  renderGruppoPills();

  if (GRUPPI.length === 0) {
    document.getElementById("slot-list").innerHTML = `<div class="empty-state"><div class="display">Nessun campo configurato</div></div>`;
    return;
  }

  state.gruppoKey = GRUPPI[0].key;
  document.querySelector("#gruppo-pills button")?.setAttribute("aria-pressed", "true");
  state.data = toISO(new Date());
  buildDayStrip();

  firebase.auth().onAuthStateChanged(async () => {
    await caricaProfiliDispositivo();
    render();
  });

  ascoltaPrenotazioniGiorno();

  // Senza questo, chi lascia la pagina aperta continua a vedere come
  // "libero" un orario ormai passato finché non arriva un evento
  // Firestore (nuova prenotazione) o tocca qualcosa — render() ricalcola
  // anche l'orario corrente (vedi slotsLiberi), quindi basta richiamarla.
  // Salta il refresh se un pannello di prenotazione è aperto, per non
  // cancellare a qualcuno un nome appena digitato.
  const refreshSePossibile = () => {
    if (!document.querySelector(".prenota-panel-slot:not(.hidden)")) render();
  };
  setInterval(refreshSePossibile, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshSePossibile();
  });
})();
