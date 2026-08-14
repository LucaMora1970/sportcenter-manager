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

const SLOT_TENNIS = [
  ["08:15", "09:15"], ["09:15", "10:15"], ["10:15", "11:15"], ["11:15", "12:15"], ["12:15", "13:15"],
  ["13:30", "14:30"], ["14:30", "15:30"], ["15:30", "16:30"], ["16:30", "17:30"],
  ["17:30", "18:30"], ["18:30", "19:30"], ["19:30", "20:30"], ["20:30", "21:30"], ["21:30", "22:30"]
];

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

function slotFissiDisciplina(disciplina) {
  if (disciplina === "tennis") return SLOT_TENNIS.map(([inizio, fine]) => ({ inizio, fine }));
  if (disciplina === "squash") return ORARI_INIZIO_SQUASH.map(inizio => ({ inizio, fine: addMinuti(inizio, 45) }));
  return [];
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
let CHIUSURE_CENTRO = []; // [{id, discipline}]
let TARIFFE_CAMPI = [];
let FORFAIT_CAMPI = [];
let IMPOSTAZIONI_PC = { settimaneVisibili: 4 };
let PROFILI = []; // sociDevices.profili
let profiloScelto = null; // socioId scelto, o null = esterno/primo profilo

const state = { gruppoKey: null, data: null, bookingsPerCourt: {}, apertoPerCourtSlot: null };
let bookingsUnsub = null;

function disciplinaLabel(d) { return { tennis: "Tennis", squash: "Squash" }[d] || d; }
function posizioneLabel(p) { return { interno: "Interno", esterno: "Esterno" }[p] || p; }

function categoriaCorrente() {
  if (!profiloScelto) return "esterno";
  const p = PROFILI.find(x => x.socioId === profiloScelto);
  return p ? p.categoria : "esterno";
}

function quotaCategoriaClient(disciplina, posizione, categoria, dataIso) {
  const forfaitAttivo = FORFAIT_CAMPI.some(f =>
    f.disciplina === disciplina && f.posizione === posizione
    && dataIso >= f.periodoInizio && dataIso <= f.periodoFine
    && (f.categorie || []).includes(categoria)
  );
  if (forfaitAttivo) return 0;

  const giorno = new Date(dataIso + "T00:00:00").getDay();
  const tipoGiorno = giorno === 0 ? "domenica_festivo" : "feriale";
  const candidati = TARIFFE_CAMPI
    .filter(t => t.disciplina === disciplina && t.posizione === posizione && t.categoria === categoria)
    .filter(t => !t.tipoGiorno || t.tipoGiorno === tipoGiorno)
    .sort((a, b) => (b.tipoGiorno ? 1 : 0) - (a.tipoGiorno ? 1 : 0));
  return candidati.length > 0 ? candidati[0].prezzo : null;
}

// ---------- Gruppi/campi ----------

function costruisciGruppi() {
  const map = new Map();
  CAMPI.forEach(c => {
    const key = `${c.disciplina}__${c.posizione || "_"}`;
    if (!map.has(key)) {
      map.set(key, {
        key, disciplina: c.disciplina, posizione: c.posizione,
        label: `${disciplinaLabel(c.disciplina)}${c.posizione ? " " + posizioneLabel(c.posizione) : ""}`,
        campi: []
      });
    }
    map.get(key).campi.push(c);
  });
  GRUPPI = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function renderGruppoPills() {
  const el = document.getElementById("gruppo-pills");
  el.innerHTML = GRUPPI.map(g => `
    <button type="button" data-key="${g.key}" aria-pressed="${g.key === state.gruppoKey}">${escapeHtml(g.label)}</button>
  `).join("");
  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => selezionaGruppo(btn.dataset.key));
  });
}

function selezionaGruppo(key) {
  state.gruppoKey = key;
  document.querySelectorAll("#gruppo-pills button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.key === key)));
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
    const chiuso = CHIUSURE_CENTRO.some(c => c.id === iso && (!(c.discipline || []).length || c.discipline.includes(gruppoAttivo()?.disciplina)));
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
  const fissi = slotFissiDisciplina(gruppo.disciplina);
  const ora = oraLocaleZurigo();
  const oggi = state.data === ora.dataIso;
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

function render() {
  const el = document.getElementById("slot-list");
  const gruppo = gruppoAttivo();
  if (!gruppo) { el.innerHTML = ""; return; }

  const chiuso = CHIUSURE_CENTRO.some(c => c.id === state.data && (!(c.discipline || []).length || c.discipline.includes(gruppo.disciplina)));
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
    const prezzo = quotaCategoriaClient(gruppo.disciplina, gruppo.posizione, categoria, state.data);
    const prezzoLabel = prezzo == null ? "—" : (prezzo === 0 ? "Incluso" : `da CHF ${prezzo.toFixed(2)}`);
    return `
      <div class="slot-row">
        <div class="si">
          <span class="st">${s.inizio}–${s.fine}</span>
          <span class="sc">Campo ${escapeHtml(s.campo.numero)}</span>
        </div>
        <span class="sp">${prezzoLabel}${gruppo.disciplina === "tennis" ? " · a testa" : ""}</span>
        <button type="button" class="btn btn-ghost apri-prenota-btn" style="width:auto;padding:8px 14px;font-size:0.76rem;" data-idx="${i}">Prenota</button>
      </div>
      <div class="prenota-panel-slot hidden" data-idx="${i}"></div>
    `;
  }).join("");

  el.querySelectorAll(".apri-prenota-btn").forEach((btn, i) => {
    btn.addEventListener("click", () => apriPannelloPrenota(liberi[i], i));
  });
}

// ---------- Pannello di conferma prenotazione ----------

let giocatore2Risolto = null; // {socioId, nomeVisualizzato, categoria} o null
let ricercaGiocatoreTimeout = null;

function apriPannelloPrenota(slot, idx) {
  document.querySelectorAll(".prenota-panel-slot").forEach(p => { p.innerHTML = ""; p.classList.add("hidden"); });
  const panel = document.querySelector(`.prenota-panel-slot[data-idx="${idx}"]`);
  giocatore2Risolto = null;

  const isTennis = slot.campo.disciplina === "tennis";
  panel.innerHTML = `
    <div class="prenota-panel">
      ${isTennis ? `
        <div class="field">
          <label for="g2-nome-${idx}">Nome del secondo giocatore</label>
          <input type="text" id="g2-nome-${idx}" placeholder="es. Mario Rossi">
        </div>
        <div class="g2-esito" id="g2-esito-${idx}"></div>
      ` : ""}
      <div class="error-msg" id="conferma-error-${idx}"></div>
      <button type="button" class="btn btn-primary conferma-prenota-btn" data-idx="${idx}" style="margin-top:10px;">Conferma prenotazione</button>
    </div>
  `;
  panel.classList.remove("hidden");

  if (isTennis) {
    const input = document.getElementById(`g2-nome-${idx}`);
    input.addEventListener("input", () => {
      clearTimeout(ricercaGiocatoreTimeout);
      const esitoEl = document.getElementById(`g2-esito-${idx}`);
      const nome = input.value.trim();
      giocatore2Risolto = null;
      if (nome.length < 2) { esitoEl.textContent = ""; return; }
      esitoEl.textContent = "Ricerca…";
      esitoEl.className = "g2-esito";
      ricercaGiocatoreTimeout = setTimeout(async () => {
        try {
          const fn = firebase.functions().httpsCallable("cercaGiocatore");
          const { data } = await fn({ nome });
          if (data.trovato) {
            giocatore2Risolto = data;
            esitoEl.textContent = `Riconosciuto: ${data.nomeVisualizzato} (${data.categoria})`;
            esitoEl.className = "g2-esito ok";
          } else {
            esitoEl.textContent = "Non trovato tra i soci — verrà considerato esterno.";
            esitoEl.className = "g2-esito no";
          }
        } catch { /* ricerca facoltativa, non blocca la prenotazione */ }
      }, 500);
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

  const isTennis = slot.campo.disciplina === "tennis";
  const g2NomeInput = isTennis ? document.getElementById(`g2-nome-${idx}`).value.trim() : null;

  try {
    const fn = firebase.functions().httpsCallable("creaPrenotazioneCampo");
    const result = await fn({
      courtId: slot.campo.id,
      date: state.data,
      startTime: slot.inizio,
      giocatore2Nome: isTennis ? (giocatore2Risolto ? giocatore2Risolto.nomeVisualizzato : g2NomeInput) : null,
      giocatore2SocioId: isTennis && giocatore2Risolto ? giocatore2Risolto.socioId : null,
      profiloId: profiloScelto
    });

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
    boxTesto.textContent = "Prenoti come esterno.";
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
    boxTesto.textContent = "Prenoti come esterno.";
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
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const esitoPagamento = new URLSearchParams(location.search).get("pagamento");
  if (esitoPagamento === "fallito") {
    alert("Pagamento non riuscito o annullato: lo slot è stato liberato, riprova pure.");
    history.replaceState(null, "", location.pathname);
  }

  const [campiSnap, chiusureSnap, tariffeSnap, forfaitSnap, impostazioniSnap] = await Promise.all([
    db.collection("campi").where("attivo", "==", true).get(),
    db.collection("chiusureCentro").get(),
    db.collection("tariffeCampi").get(),
    db.collection("forfaitCampi").get(),
    db.collection("impostazioni").doc("prenotazioniCampi").get()
  ]);

  CAMPI = campiSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.disciplina === "tennis" || c.disciplina === "squash");
  CHIUSURE_CENTRO = chiusureSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  TARIFFE_CAMPI = tariffeSnap.docs.map(d => d.data());
  FORFAIT_CAMPI = forfaitSnap.docs.map(d => d.data());
  if (impostazioniSnap.exists) IMPOSTAZIONI_PC = { ...IMPOSTAZIONI_PC, ...impostazioniSnap.data() };

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
})();
