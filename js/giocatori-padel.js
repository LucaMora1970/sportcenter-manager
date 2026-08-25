// ============================================================
// giocatori-padel.js — hub pubblico della Community Padel: registrazione
// giocatore (socio o esterno), classifica, proposta di sessioni con
// quorum e blocco provvisorio del campo, risposta agli inviti ricevuti
// via link (?invito=token) e verifica email (?verifica=token).
//
// Identità: un socio riusa la propria sessione "dispositivo riconosciuto"
// (sociDevices, vedi abbonamento.js) — se firebase.auth() ha un utente ma
// giocatoriPadel/{uid} non esiste, è per forza un socio non ancora
// registrato come giocatore Padel (un esterno ottiene l'identità solo
// alla registrazione, creata insieme al documento giocatoriPadel, vedi
// registraGiocatorePadel lato server). Nessun account tradizionale.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login staff).
// ============================================================

let currentUid = null;
let currentGiocatore = null; // giocatoriPadel/{uid} se già registrato
let classificaCache = [];

const STATO_SESSIONE_LABEL = { aperta: "In attesa di conferme", confermata: "Confermata", scaduta: "Scaduta", annullata: "Annullata" };

// ---------- Calcolo slot liberi (stessa identica logica anti-buco di
// js/prenota-padel.js, duplicata anche lì e lato server in
// functions/index.js — se cambia va cambiata ovunque) — qui serve per
// proporre in "Proponi una sessione" solo orari realmente disponibili e
// con tariffa configurata, invece di un orario libero che poi il server
// rifiuterebbe. minutiToOrario()/IMPOSTAZIONI/loadImpostazioni() sono già
// in js/utils.js, riusati direttamente. ----------

const COURT_ID = "1";
const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const BOUNDARY = 17 * 60;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const SLOT_FISSO_SERALE = 17 * 60 + 30;

function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}
function eOggi(dataIso) {
  return dataIso === oraLocaleZurigo().dataIso;
}
function escludiOrariPassati(starts, dataIso) {
  const ora = oraLocaleZurigo();
  if (dataIso !== ora.dataIso) return starts;
  return starts.filter(s => s > ora.minuti);
}
const PENDING_SCADUTO_MINUTI = 15;
function pendingScaduto(booking) {
  if (booking.status !== "PENDING_PAYMENT") return false;
  if (!booking.createdAt || typeof booking.createdAt.toMillis !== "function") return false;
  return (Date.now() - booking.createdAt.toMillis()) > PENDING_SCADUTO_MINUTI * 60000;
}
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}
function chiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  const chiusuraWeekend = orarioToMin(IMPOSTAZIONI.chiusuraWeekend || "20:30");
  return (giorno === 0 || giorno === 6 || (IMPOSTAZIONI.festivi || []).includes(dataIso)) ? chiusuraWeekend : CLOSE;
}
function feriale(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !(IMPOSTAZIONI.festivi || []).includes(dataIso);
}
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
    [b - 90, b - 90 - 60].forEach(t => {
      if (t >= a && t < BOUNDARY && !starts.includes(t) && gapPrimaOk(t, a)) {
        const remain = b - (t + 90);
        if (remain === 0 || remain >= 60) starts.push(t);
      }
    });
    const primoChain = Math.max(a, BOUNDARY);
    if (gapPrimaOk(primoChain, a)) {
      const passo = oggi ? 15 : 90;
      for (let t = primoChain; t + 90 <= b; t += passo) starts.push(t);
    }
    if (SLOT_FISSO_PRANZO >= a && SLOT_FISSO_PRANZO + 90 <= b && gapPrimaOk(SLOT_FISSO_PRANZO, a)) {
      const remain = b - (SLOT_FISSO_PRANZO + 90);
      if (remain === 0 || remain >= 60) starts.push(SLOT_FISSO_PRANZO);
    }
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
    [limit - 60, limit - 60 - 60].forEach(t => {
      if (t >= a && !starts.includes(t) && gapPrimaOk(t, a)) {
        const remain = limit - (t + 60);
        if (remain === 0 || remain >= 60) starts.push(t);
      }
    });
    if (limit - a < 90) {
      [a, limit - 60].forEach(t => {
        if (t >= a && t + 60 <= limit && !starts.includes(t)) starts.push(t);
      });
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

let CHIUSURE_PADEL = new Set();
async function caricaChiusurePadel() {
  const snap = await db.collection("chiusurePadel").get();
  CHIUSURE_PADEL = new Set(snap.docs.map(d => d.id));
}

// Prezzo mostrato accanto a ogni orario nel menu "Ora inizio" — stesso
// motore "Tariffe campi" e stessa semplificazione di prenota-padel.js:
// categoria sempre "esterno", perché è solo un'anteprima orientativa (il
// prezzo reale lo ricalcola sempre il server in proponiSessionePadel, e
// comunque i giocatori se lo dividono fuori app) — niente da guadagnare
// replicando qui la risoluzione socio/esterno solo per questa stima.
let TARIFFE_CAMPI = [];
let FORFAIT_CAMPI = [];
async function loadTariffeCampi() {
  try {
    const [tariffeSnap, forfaitSnap] = await Promise.all([
      db.collection("tariffeCampi").get(),
      db.collection("forfaitCampi").get()
    ]);
    TARIFFE_CAMPI = tariffeSnap.docs.map(d => d.data());
    FORFAIT_CAMPI = forfaitSnap.docs.map(d => d.data());
  } catch (err) {
    console.warn("loadTariffeCampi: lettura fallita:", err.message);
  }
}
function giornoSettimanaCodice(dataIso) {
  if ((IMPOSTAZIONI.festivi || []).includes(dataIso)) return "dom";
  const jsDay = new Date(dataIso + "T00:00:00").getDay();
  return Object.keys(GIORNO_JS_DAY).find(id => GIORNO_JS_DAY[id] === jsDay);
}
function prezzoSlotStimato(dataIso, startTime, durataMinuti) {
  const disciplina = "padel", posizione = null, categoria = "esterno";
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

async function slotDisponibiliPadel(dataIso, durationMinutes) {
  if (CHIUSURE_PADEL.has(dataIso)) return [];
  const close = chiusuraGiorno(dataIso);
  const snap = await db.collection("bookings").where("date", "==", dataIso).where("courtId", "==", COURT_ID).get();
  const bookings = snap.docs
    .map(d => d.data())
    .filter(b => !pendingScaduto(b))
    .filter(b => b.status === "PENDING_PAYMENT" || b.status === "PENDING_CONFIRMATION" || b.status === "CONFIRMED" || b.status === "COMPLETED")
    .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));
  const starts = validStarts(bookings, durationMinutes, close, feriale(dataIso), eOggi(dataIso));
  return escludiOrariPassati(starts, dataIso);
}

async function aggiornaSlotOra() {
  const select = document.getElementById("pr-ora");
  const dataIso = document.getElementById("pr-data").value;
  const durata = parseInt(document.getElementById("pr-durata").value, 10);
  if (!dataIso) {
    select.innerHTML = `<option value="">Scegli prima data e durata…</option>`;
    return;
  }
  select.innerHTML = `<option value="">Caricamento orari…</option>`;
  select.disabled = true;
  try {
    const starts = await slotDisponibiliPadel(dataIso, durata);
    select.innerHTML = starts.length > 0
      ? `<option value="">Scegli un orario…</option>` + starts.map(s => {
          const orario = minutiToOrario(s);
          const prezzo = prezzoSlotStimato(dataIso, orario, durata);
          const prezzoTxt = prezzo != null ? ` — CHF ${prezzo.toFixed(2)} lo slot` : "";
          return `<option value="${orario}">${orario}${prezzoTxt}</option>`;
        }).join("")
      : `<option value="">Nessuno slot libero in questa data</option>`;
  } catch (err) {
    select.innerHTML = `<option value="">Errore nel caricamento orari</option>`;
    console.error("aggiornaSlotOra:", err);
  } finally {
    select.disabled = false;
  }
}

function mostraStato(id) {
  ["stato-caricamento", "stato-verifica-email", "stato-invito", "stato-registrazione", "area-content"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function invitoTokenCorrente() {
  return new URLSearchParams(location.search).get("invito");
}

// ---------- Verifica email (?verifica=token) ----------

async function gestisciVerificaEmail(token) {
  mostraStato("stato-verifica-email");
  try {
    const fn = cloudFunctions().httpsCallable("verificaEmailGiocatorePadel");
    await fn({ token });
    document.getElementById("verifica-email-titolo").textContent = "Email confermata";
    document.getElementById("verifica-email-testo").textContent = "Il tuo profilo giocatore Padel resta attivo. Puoi chiudere questa pagina.";
  } catch (err) {
    document.getElementById("verifica-email-titolo").textContent = "Link non valido";
    document.getElementById("verifica-email-testo").textContent = err.message || "Il link è scaduto oppure è già stato usato.";
  }
}

// ---------- Registrazione ----------

async function socioIdDelDispositivo(uid) {
  try {
    const doc = await db.collection("sociDevices").doc(uid).get();
    const profili = doc.exists ? (doc.data().profili || []) : [];
    return profili[0] ? profili[0].socioId : null;
  } catch {
    return null;
  }
}

async function ricaricaGiocatore() {
  if (!currentUid) { currentGiocatore = null; return; }
  const doc = await db.collection("giocatoriPadel").doc(currentUid).get();
  currentGiocatore = doc.exists ? doc.data() : null;
}

async function onSubmitRegistrazione(e) {
  e.preventDefault();
  const btn = document.getElementById("registrazione-btn");
  const errorEl = document.getElementById("registrazione-error");
  errorEl.textContent = "";

  if (!document.getElementById("reg-consenso").checked) {
    showError(errorEl, "Devi accettare il trattamento dei dati per registrarti.");
    return;
  }

  btn.disabled = true;
  try {
    const payload = {
      nome: document.getElementById("reg-nome").value.trim(),
      cognome: document.getElementById("reg-cognome").value.trim(),
      pseudonimo: document.getElementById("reg-pseudonimo").value.trim(),
      telefono: document.getElementById("reg-telefono").value.trim() || null,
      email: document.getElementById("reg-email").value.trim(),
      playtomicLivello: document.getElementById("reg-playtomic").value !== "" ? parseFloat(document.getElementById("reg-playtomic").value) : null,
      consenso: true
    };
    if (currentUid) payload.socioId = await socioIdDelDispositivo(currentUid);

    const fn = cloudFunctions().httpsCallable("registraGiocatorePadel");
    const { data } = await fn(payload);

    if (data.customToken) {
      await firebase.auth().signInWithCustomToken(data.customToken);
      // onAuthStateChanged si occupa del resto (currentUid/currentGiocatore
      // e della schermata successiva, invito compreso).
    } else {
      currentUid = currentUid || (firebase.auth().currentUser || {}).uid;
      await ricaricaGiocatore();
      const invito = invitoTokenCorrente();
      if (invito) await gestisciInvito(invito);
      else await mostraAreaContent();
    }
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
  }
}

// ---------- Invito a una sessione (?invito=token) ----------

// Risolve gli id giocatore in pseudonimo (mai nome vero, coerente col
// resto dell'app) — usato per mostrare "chi gioca" sia all'organizzatore
// sia a chi risponde a un invito, non solo il conteggio delle conferme.
async function risolviNomiGiocatori(ids) {
  const unici = [...new Set(ids)].filter(Boolean);
  const docs = await Promise.all(unici.map(id => db.collection("giocatoriPadel").doc(id).get().catch(() => null)));
  const mappa = {};
  docs.forEach(d => { if (d && d.exists) mappa[d.id] = d.data().pseudonimo || "Giocatore"; });
  return mappa;
}

function rosterHtml(sessione, nomi) {
  const orgNome = nomi[sessione.organizerId] || "Organizzatore";
  const STATO_ICONA = { si: "✓", no: "✗", in_attesa: "…" };
  const STATO_TESTO = { si: "conferma", no: "non viene", in_attesa: "in attesa" };
  const righeInvitati = (sessione.invitati || []).map(i => {
    const nome = i.giocatoreId ? (nomi[i.giocatoreId] || "Giocatore") : (i.ospiteNome || "Ospite");
    return `
    <div class="gp-invito-riga">
      <span>${STATO_ICONA[i.stato] || "…"} ${escapeHtml(nome)}${!i.giocatoreId ? " <span style=\"color:var(--chalk-grey);\">(ospite)</span>" : ""}</span>
      <span style="color:var(--chalk-grey);font-size:0.76rem;">${STATO_TESTO[i.stato] || "in attesa"}</span>
    </div>
  `;
  }).join("");
  return `
    <div style="margin-top:14px;">
      <div class="entry-meta" style="margin-bottom:6px;">Chi gioca</div>
      <div class="gp-invito-riga"><span>★ ${escapeHtml(orgNome)}</span><span style="color:var(--chalk-grey);font-size:0.76rem;">organizzatore</span></div>
      ${righeInvitati}
    </div>
  `;
}

async function gestisciInvito(token) {
  mostraStato("stato-invito");
  const card = document.getElementById("invito-card");
  card.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Caricamento…</p>`;

  let invito, sessione;
  try {
    const doc = await db.collection("sessioniPadelInviti").doc(token).get();
    if (!doc.exists) throw new Error("Invito non trovato.");
    invito = doc.data();
    const sDoc = await db.collection("sessioniPadel").doc(invito.sessioneId).get();
    if (!sDoc.exists) throw new Error("Proposta non trovata.");
    sessione = sDoc.data();
  } catch (err) {
    card.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    return;
  }

  const nomi = await risolviNomiGiocatori([sessione.organizerId, ...(sessione.invitati || []).map(i => i.giocatoreId)]);
  const orgNome = nomi[sessione.organizerId] || "Un giocatore";

  if (sessione.stato !== "aperta") {
    card.innerHTML = `
      <p>Questa proposta non è più aperta (${escapeHtml(STATO_SESSIONE_LABEL[sessione.stato] || sessione.stato)}).</p>
      ${rosterHtml(sessione, nomi)}
    `;
    return;
  }

  if (currentUid && currentGiocatore) {
    card.innerHTML = `
      <p><strong>${escapeHtml(orgNome)}</strong> ti invita a giocare il ${escapeHtml(sessione.date)} alle ${escapeHtml(sessione.startTime)}–${escapeHtml(sessione.endTime)}.</p>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button type="button" class="btn btn-primary" id="invito-si-btn">Sì, ci sto</button>
        <button type="button" class="btn btn-ghost" id="invito-no-btn">Non posso</button>
      </div>
      <div class="error-msg" id="invito-error"></div>
      ${rosterHtml(sessione, nomi)}
    `;
    document.getElementById("invito-si-btn").addEventListener("click", () => rispondiInvito(token, "si"));
    document.getElementById("invito-no-btn").addEventListener("click", () => rispondiInvito(token, "no"));
    return;
  }

  // Non registrato/riconosciuto: se l'invito non è mirato a un giocatore
  // specifico (link aperto o email non ancora reclamata), offri anche la
  // risposta rapida come ospite — pseudonimo/nome, categoria "esterno",
  // nessun account creato. Resta comunque possibile riconoscere il
  // dispositivo o registrarsi per un ingresso stabile in Community Padel.
  const puoRisponendereComeOspite = !invito.giocatoreId;
  card.innerHTML = `
    <p><strong>${escapeHtml(orgNome)}</strong> ti invita a giocare il ${escapeHtml(sessione.date)} alle ${escapeHtml(sessione.startTime)}–${escapeHtml(sessione.endTime)}.</p>
    ${puoRisponendereComeOspite ? `
      <div class="field" style="margin-top:14px;">
        <label for="ospite-nome">Il tuo pseudonimo o nome — rispondi al volo, senza registrarti</label>
        <input type="text" id="ospite-nome" maxlength="40">
      </div>
      <div style="display:flex;gap:10px;margin-top:10px;">
        <button type="button" class="btn btn-primary" id="invito-ospite-si-btn">Sì, ci sto</button>
        <button type="button" class="btn btn-ghost" id="invito-ospite-no-btn">Non posso</button>
      </div>
      <div class="error-msg" id="invito-error"></div>
      <p style="color:var(--chalk-grey);font-size:0.78rem;margin-top:10px;">Oppure, se preferisci un ingresso stabile in Community Padel:</p>
    ` : `<div class="error-msg" style="margin-top:14px;"></div>`}
    <p style="margin-top:10px;"><a href="attiva-socio.html" class="btn btn-ghost" style="display:inline-block;width:auto;">Sono socio — attiva dispositivo</a></p>
    <p style="margin-top:10px;color:var(--chalk-grey);font-size:0.84rem;">Non sei socio? Registrati qui sotto come giocatore esterno — il link ti riporterà automaticamente su questo invito.</p>
    ${rosterHtml(sessione, nomi)}
  `;
  if (puoRisponendereComeOspite) {
    document.getElementById("invito-ospite-si-btn").addEventListener("click", () => rispondiComeOspite(token, "si"));
    document.getElementById("invito-ospite-no-btn").addEventListener("click", () => rispondiComeOspite(token, "no"));
  }
  document.getElementById("stato-registrazione").classList.remove("hidden");
}

// Identificativo leggero per una risposta da ospite (nessun account):
// resta nel browser e serve solo a non poter rispondere due volte alla
// stessa proposta, mai per riconoscere la persona altrove nell'app.
function dispositivoTokenOspite() {
  let t;
  try { t = localStorage.getItem("sportos-ospite-token"); } catch { t = null; }
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try { localStorage.setItem("sportos-ospite-token", t); } catch { /* storage non disponibile: token solo per questa risposta */ }
  }
  return t;
}

async function rispondiComeOspite(token, risposta) {
  const errorEl = document.getElementById("invito-error");
  const ospiteNome = document.getElementById("ospite-nome").value.trim();
  if (!ospiteNome) {
    showError(errorEl, "Inserisci uno pseudonimo o nome.");
    return;
  }
  try {
    const fn = cloudFunctions().httpsCallable("rispondiInvitoSessionePadel");
    const { data } = await fn({ token, risposta, ospiteNome, dispositivoToken: dispositivoTokenOspite() });

    const invitoDoc = await db.collection("sessioniPadelInviti").doc(token).get();
    const sessioneDoc = await db.collection("sessioniPadel").doc(invitoDoc.data().sessioneId).get();
    const sessione = sessioneDoc.data();
    const nomi = await risolviNomiGiocatori([sessione.organizerId, ...(sessione.invitati || []).map(i => i.giocatoreId)]);

    document.getElementById("invito-card").innerHTML = `
      <p>${risposta === "si" ? "Presenza confermata!" : "Hai segnalato di non poter partecipare."}${data.confermata ? " La partita ha raggiunto il numero di giocatori richiesto ed è ora confermata." : ""}</p>
      ${rosterHtml(sessione, nomi)}
    `;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  }
}

async function rispondiInvito(token, risposta) {
  const errorEl = document.getElementById("invito-error");
  try {
    const fn = cloudFunctions().httpsCallable("rispondiInvitoSessionePadel");
    const { data } = await fn({ token, risposta });

    const invitoDoc = await db.collection("sessioniPadelInviti").doc(token).get();
    const sessioneDoc = await db.collection("sessioniPadel").doc(invitoDoc.data().sessioneId).get();
    const sessione = sessioneDoc.data();
    const nomi = await risolviNomiGiocatori([sessione.organizerId, ...(sessione.invitati || []).map(i => i.giocatoreId)]);

    document.getElementById("invito-card").innerHTML = `
      <p>${risposta === "si" ? "Presenza confermata!" : "Hai segnalato di non poter partecipare."}${data.confermata ? " La partita ha raggiunto il numero di giocatori richiesto ed è ora confermata." : ""}</p>
      ${rosterHtml(sessione, nomi)}
    `;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  }
}

// ---------- Classifica ----------

async function caricaClassifica() {
  const el = document.getElementById("classifica-list");
  try {
    const snap = await db.collection("giocatoriPadel").where("attivo", "==", true).orderBy("livelloEffettivo", "desc").get();
    classificaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    el.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Errore nel caricamento: ${escapeHtml(err.message)}</p>`;
    return;
  }
  el.innerHTML = classificaCache.length > 0
    ? classificaCache.map(g => `
        <div class="gp-classifica-row">
          <span>${escapeHtml(g.pseudonimo || "Giocatore")}</span>
          <span class="livello">${g.livelloEffettivo != null ? g.livelloEffettivo.toFixed(2) : "—"}</span>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessun giocatore registrato ancora.</p>`;
  renderInvitatiCheckbox();
}

function renderInvitatiCheckbox() {
  const el = document.getElementById("proponi-invitati-list");
  const altri = classificaCache.filter(g => g.id !== currentUid);
  el.innerHTML = altri.length > 0
    ? altri.map(g => `
        <div class="checkbox-row">
          <input type="checkbox" class="pr-invitato-cb" value="${g.id}" id="pr-inv-${g.id}">
          <label for="pr-inv-${g.id}">${escapeHtml(g.pseudonimo || "Giocatore")} (${g.livelloEffettivo != null ? g.livelloEffettivo.toFixed(2) : "—"})</label>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessun altro giocatore registrato ancora — invita via email qui sotto.</p>`;
}

// ---------- Proponi una sessione ----------

async function onSubmitProponi(e) {
  e.preventDefault();
  const btn = document.getElementById("proponi-btn");
  const errorEl = document.getElementById("proponi-error");
  errorEl.textContent = "";
  btn.disabled = true;
  mostraCaricamento("Lancio della proposta in corso…");

  try {
    const invitatiIds = Array.from(document.querySelectorAll(".pr-invitato-cb:checked")).map(cb => cb.value);

    const fn = cloudFunctions().httpsCallable("proponiSessionePadel");
    const { data } = await fn({
      date: document.getElementById("pr-data").value,
      startTime: document.getElementById("pr-ora").value,
      durationMinutes: parseInt(document.getElementById("pr-durata").value, 10),
      targetHeadcount: parseInt(document.getElementById("pr-headcount").value, 10),
      invitatiIds
    });

    // Dritti sulla pagina di stato appena lanciata: è lì che ora si vede
    // subito chi ha aderito e si trova, solo per l'organizzatore (vedi
    // ?org=1 in stato-partita.js), la sezione per condividere il link.
    location.href = `${data.statoLink}&org=1`;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
    nascondiCaricamento();
  }
}

// ---------- Le mie proposte ----------

async function caricaMieProposte() {
  const el = document.getElementById("mie-proposte-list");
  if (!currentUid) return;
  try {
    const snap = await db.collection("sessioniPadel").where("organizerId", "==", currentUid).get();
    const proposte = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

    const tuttiGliId = proposte.flatMap(s => [s.organizerId, ...(s.invitati || []).map(i => i.giocatoreId)]);
    const nomi = await risolviNomiGiocatori(tuttiGliId);

    el.innerHTML = proposte.length > 0
      ? proposte.map(s => {
          const confermeSi = (s.invitati || []).filter(i => i.stato === "si").length;
          return `
            <div class="gp-classifica-row" style="align-items:flex-start;">
              <div>
                <div>${escapeHtml(s.date)} ${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)} — ${escapeHtml(STATO_SESSIONE_LABEL[s.stato] || s.stato)} (${confermeSi}/${(s.targetHeadcount || 0) - 1} conferme)</div>
                ${rosterHtml(s, nomi)}
              </div>
              ${s.stato === "aperta" ? `<button type="button" class="btn btn-danger annulla-proposta-btn" data-id="${s.id}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Annulla</button>` : ""}
            </div>
          `;
        }).join("")
      : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessuna proposta lanciata ancora.</p>`;
    el.querySelectorAll(".annulla-proposta-btn").forEach(b => b.addEventListener("click", () => annullaProposta(b.dataset.id)));
  } catch (err) {
    el.innerHTML = `<p style="color:var(--chalk-grey);font-size:0.84rem;">Errore nel caricamento: ${escapeHtml(err.message)}</p>`;
  }
}

async function annullaProposta(sessioneId) {
  if (!confirm("Annullare questa proposta? Il campo si libera subito.")) return;
  try {
    const fn = cloudFunctions().httpsCallable("annullaPropostaSessionePadel");
    await fn({ sessioneId });
    await caricaMieProposte();
  } catch (err) {
    alert("Errore: " + err.message);
  }
}

// ---------- Tab ----------

function attivaTab(tab) {
  document.querySelectorAll(".gp-tab-btn").forEach(b => b.dataset.active = String(b.dataset.tab === tab));
  document.querySelectorAll(".gp-tab-panel").forEach(p => p.classList.toggle("hidden", p.id !== "tab-" + tab));
  // La classifica (e quindi anche "Invita dalla classifica") va ricaricata
  // ad ogni apertura di queste due schede, non solo al primo ingresso in
  // pagina — altrimenti un giocatore che si registra nel frattempo non
  // compare finché non si ricarica tutta la pagina.
  if (tab === "mie") caricaMieProposte();
  if (tab === "classifica" || tab === "proponi") caricaClassifica();
}

// ---------- Init ----------

async function mostraAreaContent() {
  mostraStato("area-content");
  const oggi = new Date();
  const domani = new Date(oggi);
  domani.setDate(oggi.getDate() + 1);
  document.getElementById("pr-data").min = oggi.toISOString().slice(0, 10);
  if (!document.getElementById("pr-data").value) {
    document.getElementById("pr-data").value = domani.toISOString().slice(0, 10);
  }
  await caricaClassifica();
  await aggiornaSlotOra();
  attivaTab("classifica");
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
  await loadImpostazioni();
  await caricaChiusurePadel();
  await loadTariffeCampi();

  document.getElementById("registrazione-form").addEventListener("submit", onSubmitRegistrazione);
  document.getElementById("proponi-form").addEventListener("submit", onSubmitProponi);
  document.getElementById("pr-data").addEventListener("change", aggiornaSlotOra);
  document.getElementById("pr-durata").addEventListener("change", aggiornaSlotOra);
  document.querySelectorAll(".gp-tab-btn").forEach(b => b.addEventListener("click", () => attivaTab(b.dataset.tab)));

  const params = new URLSearchParams(location.search);
  const verificaToken = params.get("verifica");
  if (verificaToken) {
    await gestisciVerificaEmail(verificaToken);
    return;
  }

  firebase.auth().onAuthStateChanged(async (user) => {
    currentUid = user ? user.uid : null;
    await ricaricaGiocatore();

    const invito = invitoTokenCorrente();
    if (invito) {
      await gestisciInvito(invito);
      return;
    }

    if (!currentGiocatore) {
      mostraStato("stato-registrazione");
      return;
    }
    await mostraAreaContent();
  });
})();
