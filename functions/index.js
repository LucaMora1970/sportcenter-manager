// ============================================================
// Cloud Functions — pagamento prenotazioni padel via PostFinance
// Checkout (SDK "postfinancecheckout", verificato contro i tipi reali
// spediti nel pacchetto npm: vedi TransactionsService, TransactionCreate,
// TransactionState).
//
// Perché serve un backend: il client non può mai gestire la chiave
// segreta PostFinance (Application Key) né scriversi da solo "pagato" su
// Firestore — sarebbe falsificabile da chiunque. Qui la scrittura usa
// l'Admin SDK (bypassa le firestore.rules) proprio perché è un contesto
// server fidato, a differenza del browser.
//
// Credenziali (mai nel codice, impostate da chi ha accesso al merchant
// PostFinance Checkout):
//   firebase functions:secrets:set POSTFINANCE_SPACE_ID
//   firebase functions:secrets:set POSTFINANCE_USER_ID
//   firebase functions:secrets:set POSTFINANCE_APP_KEY
//
// creaPrenotazionePubblica / collection "bookings"+"bookingTickets"+
// "bookingCodes"+"payments"+"credits"+"creditTransactions": booking
// pubblico senza login, con biglietto/QR/codice e sistema di credito.
//
// (Il vecchio flusso interno pre-apertura pubblica, creaPagamentoPrenotazione
// su "prenotazioniPadel", è stato rimosso: non più collegato a nessuna
// pagina, senza il controllo anti-sovrapposizione delle funzioni attuali —
// vedi git log se serve recuperarlo.)
// ============================================================

const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const {
  Configuration, HttpBearerAuth, TransactionsService, TokensService, LineItemType, TransactionState,
  TransactionEnvironmentSelectionStrategy
} = require("postfinancecheckout");

// FASE DI TEST: forza ogni transazione in ambiente di test/anteprima
// PostFinance anche se lo spazio configurato è quello reale (nessun
// addebito vero) — non serve un secondo spazio sandbox separato. Va
// rimosso (o passato a "USE_CONFIGURATION") solo quando si è pronti a
// incassare pagamenti veri.
const FORZA_AMBIENTE_TEST = true;

initializeApp();
const db = getFirestore();

const POSTFINANCE_SPACE_ID = defineSecret("POSTFINANCE_SPACE_ID");
const POSTFINANCE_USER_ID = defineSecret("POSTFINANCE_USER_ID");
const POSTFINANCE_APP_KEY = defineSecret("POSTFINANCE_APP_KEY");

// Invio email reale (attivazione soci) tramite l'host email già associato
// a sport-os.ch — deciso al posto dell'invio automatico di Firebase
// (sendSignInLinkToEmail) perché, come già annotato più sotto per
// generaLinkResetPassword, quell'invio finisce spesso in spam/filtrato.
// Credenziali impostate con:
//   firebase functions:secrets:set SMTP_HOST
//   firebase functions:secrets:set SMTP_PORT
//   firebase functions:secrets:set SMTP_USER
//   firebase functions:secrets:set SMTP_PASS
//   firebase functions:secrets:set MAIL_FROM
const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_PORT = defineSecret("SMTP_PORT");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const MAIL_FROM = defineSecret("MAIL_FROM");
const MAIL_SECRETS = [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM];

function mailTransporter() {
  const port = parseInt(SMTP_PORT.value(), 10);
  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465, // 465 = TLS implicito fin dall'inizio (SMTPS)
    requireTLS: port !== 465, // 587 = STARTTLS, ma imposta esplicitamente: mai inviare in chiaro se il server non riesce a fare l'upgrade
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
  });
}

async function inviaEmail({ to, subject, html }) {
  const transporter = mailTransporter();
  await transporter.sendMail({ from: MAIL_FROM.value(), to, subject, html });
}

// URL base dell'app (dominio personalizzato via GitHub Pages), per i
// redirect di successo/fallimento del pagamento e i link di reset password.
const APP_URL = "https://sport-os.ch/";

const BOUNDARY = 17 * 60; // 17:00 — stessa soglia diurno/serale di prenotazioni.js

function transactionsService() {
  const config = new Configuration();
  config.httpBearerAuth = new HttpBearerAuth(
    parseInt(POSTFINANCE_USER_ID.value(), 10),
    POSTFINANCE_APP_KEY.value()
  );
  return new TransactionsService(config);
}

// Tokenizzazione carta (corsi a soglia minima): stessa configurazione di
// transactionsService(), servizio diverso dell'SDK.
function tokensService() {
  const config = new Configuration();
  config.httpBearerAuth = new HttpBearerAuth(
    parseInt(POSTFINANCE_USER_ID.value(), 10),
    POSTFINANCE_APP_KEY.value()
  );
  return new TokensService(config);
}

// ---------- Anti-buco (duplicato da js/prenotazioni.js) ----------
// Lo slot scelto va sempre riverificato lato server, mai fidarsi di
// quello arrivato dal client. Se l'algoritmo cambia in js/prenotazioni.js
// va aggiornato anche qui.
const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const CLOSE_WEEKEND = 20 * 60 + 30;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const SLOT_FISSO_SERALE = 17 * 60 + 30; // 17:30, solo lun-ven, solo 90'

// Una prenotazione resta "PENDING_PAYMENT" tra la creazione e l'esito del
// pagamento — se il webhook non arriva mai (pagamento abbandonato,
// problemi di configurazione) resterebbe bloccata per sempre senza
// questo limite. Duplicato in js/prenota-padel.js e js/prenotazioni.js.
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

function chiusuraGiorno(dataIso, festivi) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return (giorno === 0 || giorno === 6 || (festivi || []).includes(dataIso)) ? CLOSE_WEEKEND : CLOSE;
}

function feriale(dataIso, festivi) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !(festivi || []).includes(dataIso);
}

// Giorni di chiusura totale (collection "chiusurePadel", doc ID = data
// ISO) — diverso da impostazioni/generale.festivi + chiusuraGiorno, che si
// limita ad accorciare l'orario: qui il campo non è prenotabile da
// nessuno, nemmeno per blocchi/prenotazioni esenti. Va sempre riverificato
// lato server, mai fidarsi del solo filtro client.
async function giornoChiuso(dataIso) {
  const doc = await db.collection("chiusurePadel").doc(dataIso).get();
  return doc.exists;
}

// Data/ora corrente in fuso orario svizzero — Cloud Functions gira in
// UTC di default, e "date"/"startTime" sono sempre orario locale del
// campo, quindi un confronto con un new Date() nudo sarebbe sfalsato di
// qualche ora. Duplicato in js/prenota-padel.js e js/prenotazioni.js.
function oraLocaleZurigo() {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { dataIso: `${parti.year}-${parti.month}-${parti.day}`, minuti: parseInt(parti.hour, 10) * 60 + parseInt(parti.minute, 10) };
}

// Rifiuta uno slot di oggi già iniziato/passato — mai fidarsi del client,
// stesso principio già applicato a prezzo e slot.
function eOrmaiPassato(dataIso, startMin) {
  const ora = oraLocaleZurigo();
  return dataIso === ora.dataIso && startMin <= ora.minuti;
}

function eOggi(dataIso) {
  return dataIso === oraLocaleZurigo().dataIso;
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
    // Oggi la catena dei 90' dopo le 17:00 usa un passo più fine (15'
    // invece di 90') così non nasconde disponibilità reale nelle
    // prossime ore (es. sono le 20:07, il prossimo scatto fisso sarebbe
    // le 21:30 ma il campo è comunque libero anche prima) — chi chiama
    // filtra comunque gli orari già passati con eOrmaiPassato.
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

// ---------- Tennis/Squash: slot fissi, niente anti-buco ----------
//
// A differenza del padel (griglia continua, durate miste, ancore fisse —
// vedi sopra), tennis e squash hanno slot già discreti e a durata fissa:
// basta verificare che il candidato non si sovrapponga a una prenotazione
// esistente. Duplicato da js/utils.js (SLOT_TENNIS/ORARI_INIZIO_AUTO.squash)
// per lo stesso motivo di tariffa/slot padel: mai fidarsi del client.
const SLOT_TENNIS = [
  ["08:15", "09:15"], ["09:15", "10:15"], ["10:15", "11:15"], ["11:15", "12:15"], ["12:15", "13:15"],
  ["13:30", "14:30"], ["14:30", "15:30"], ["15:30", "16:30"], ["16:30", "17:30"],
  ["17:30", "18:30"], ["18:30", "19:30"], ["19:30", "20:30"], ["20:30", "21:30"], ["21:30", "22:30"]
];

function minutiToOrario(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function generaOrari(inizioMin, fineMin, stepMin) {
  const out = [];
  for (let m = inizioMin; m <= fineMin; m += stepMin) out.push(minutiToOrario(m));
  return out;
}

function addMinuti(orario, minuti) {
  const [h, m] = orario.split(":").map(Number);
  return minutiToOrario(h * 60 + m + minuti);
}

const ORARI_INIZIO_SQUASH = generaOrari(8 * 60 + 15, 21 * 60 + 45, 45); // 08:15–21:45 ogni 45'

// Elenco {inizio, fine} degli slot fissi prenotabili per la disciplina, o
// [] se la disciplina non usa questo modello (es. padel, che resta sulla
// griglia continua sopra).
function slotFissiDisciplina(disciplina) {
  if (disciplina === "tennis") return SLOT_TENNIS.map(([inizio, fine]) => ({ inizio, fine }));
  if (disciplina === "squash") return ORARI_INIZIO_SQUASH.map(inizio => ({ inizio, fine: addMinuti(inizio, 45) }));
  return [];
}

function sovrapposto(aInizio, aFine, bInizio, bFine) {
  return orarioToMin(aInizio) < orarioToMin(bFine) && orarioToMin(aFine) > orarioToMin(bInizio);
}

// ---------- Codici e token ----------

// Token privato: lungo e casuale, destinato al link/QR del biglietto.
// Conoscerlo è di per sé l'autorizzazione a leggere quel biglietto (vedi
// firestore.rules — "allow get: if true" su bookingTickets/{token}).
function generaToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// Codice breve leggibile per l'uomo (verifica manuale al campo se il QR
// non funziona) — niente 0/O/1/I per evitare ambiguità alla lettura.
const CODICE_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generaCodiceCasuale() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODICE_ALFABETO[crypto.randomInt(CODICE_ALFABETO.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

async function generaCodicePrenotazioneUnivoco() {
  for (let tentativo = 0; tentativo < 10; tentativo++) {
    const code = generaCodiceCasuale();
    const doc = await db.collection("bookingCodes").doc(code).get();
    if (!doc.exists) return code;
  }
  throw new Error("Impossibile generare un codice prenotazione univoco.");
}

function generaCodiceCredito() {
  return `CR-${generaCodiceCasuale()}`;
}

// ---------- 1b. Flusso pubblico (senza login) ----------

// Un solo campo padel per ora — "unico campo" già mostrato nel
// pannello operatore. Il courtId è comunque un campo esplicito sui
// documenti per non dover rifare uno schema quando ne arriverà un
// secondo.
const COURT_ID = "1";

// Il courtId del padel ("1") non corrisponde a nessun id reale in
// "campi" (quell'id è solo interno, mai un doc Firestore) — se l'admin
// ha comunque creato lì una voce per il padel (per dargli un nome vero,
// es. "Indoor 1"), va usata solo per l'etichetta mostrata a chi prenota,
// mai per l'identità della prenotazione. "1" resta il fallback se nessuna
// voce è stata creata.
async function padelCampoNumero() {
  const snap = await db.collection("campi").where("disciplina", "==", "padel").limit(1).get();
  return snap.empty ? COURT_ID : (snap.docs[0].data().numero || COURT_ID);
}

// Scrive tutto ciò che rende "reale" una prenotazione confermata:
// biglietto privato, indice codice→prenotazione, mirror del pagamento, e
// se c'è un credito coinvolto lo scala e lo registra. Chiamata sia dal
// caso "credito copre tutto" (creaPrenotazionePubblica, sincrono) sia dal
// webhook (dopo la conferma PostFinance).
// disciplina/campoLabel sono facoltativi (assenti = null): il flusso
// padel esistente non li passa e biglietto.js ricade sul suo default
// "Padel"/"Campo {courtId}" — per tennis/squash (dove courtId è l'id
// interno del doc "campi", non il numero mostrato) servono per mostrare
// un'etichetta leggibile sul biglietto.
async function confermaPrenotazionePubblica({ bookingId, courtId, date, startTime, endTime, prezzo, token, paymentId, creditCode, creditoScalato, disciplina, campoLabel }) {
  const bookingCode = await generaCodicePrenotazioneUnivoco();

  // L'id transazione di PostFinance è un numero (Transaction.id: number
  // nell'SDK) — .doc() di Firestore richiede sempre una stringa, senza
  // questa conversione la scrittura lancia un errore e l'intero webhook
  // fallisce silenziosamente (biglietto mai creato).
  const paymentIdStr = paymentId != null ? String(paymentId) : null;

  const batch = db.batch();
  batch.update(db.collection("bookings").doc(bookingId), { status: "CONFIRMED" });
  batch.set(db.collection("bookingTickets").doc(token), {
    bookingId, bookingCode, courtId, date, startTime, endTime,
    price: prezzo, currency: "CHF", paymentId: paymentIdStr,
    disciplina: disciplina || null,
    campoLabel: campoLabel || null,
    createdAt: FieldValue.serverTimestamp()
  });
  batch.set(db.collection("bookingCodes").doc(bookingCode), { bookingId, token });
  if (paymentIdStr) {
    batch.set(db.collection("payments").doc(paymentIdStr), {
      bookingId, amount: prezzo - (creditoScalato || 0), currency: "CHF",
      status: "PAID", createdAt: FieldValue.serverTimestamp()
    });
  }
  await batch.commit();

  if (creditCode && creditoScalato > 0) {
    const creditoRef = db.collection("credits").doc(creditCode);
    const creditoSnap = await creditoRef.get();
    if (creditoSnap.exists) {
      const nuovoResiduo = Math.max(0, creditoSnap.data().remainingAmount - creditoScalato);
      await creditoRef.update({
        remainingAmount: nuovoResiduo,
        status: nuovoResiduo === 0 ? "USED" : "PARTIALLY_USED"
      });
      await db.collection("creditTransactions").add({
        creditId: creditCode, bookingId, type: "REDEEM", amount: creditoScalato,
        createdAt: FieldValue.serverTimestamp()
      });
    }
  }

  return bookingCode;
}

// Invocabile da chiunque, senza login: il cliente sceglie campo/data/
// ora/durata (senza registrazione), lo slot e il prezzo vengono
// ricalcolati qui — mai fidarsi di quelli mandati dal client. Se un
// credito copre l'intero importo si conferma subito, senza passare da
// PostFinance; altrimenti si crea la transazione per la differenza (o
// per l'intero prezzo se non c'è credito) e si restituisce l'URL di
// pagamento.
exports.creaPrenotazionePubblica = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const {
      courtId, date, startTime, endTime, durationMinutes, creditCode, profiloId,
      giocatore2Nome, giocatore2SocioId, giocatore3Nome, giocatore3SocioId, giocatore4Nome, giocatore4SocioId
    } = request.data || {};
    if (!date || !startTime || !endTime || !durationMinutes) {
      throw new HttpsError("invalid-argument", "Dati prenotazione incompleti.");
    }
    if (await giornoChiuso(date)) {
      throw new HttpsError("failed-precondition", "Il campo è chiuso in questa data.");
    }

    const court = courtId || COURT_ID;
    const startMin = orarioToMin(startTime);
    // Giorni festivi (impostazioni/generale.festivi): contano come domenica
    // ai fini della tariffa e accorciano l'orario di chiusura come sabato/
    // domenica — un solo fetch, riusato per entrambi qui sotto.
    const generaleSnap = await db.collection("impostazioni").doc("generale").get();
    const festivi = generaleSnap.exists ? (generaleSnap.data().festivi || []) : [];
    const close = chiusuraGiorno(date, festivi);

    // Pulizia best-effort delle "PENDING_PAYMENT" scadute (pagamento mai
    // concluso, es. abbandonato o webhook mai arrivato) — fuori dalla
    // transazione qui sotto: è solo pulizia, non deve rallentarla né
    // farla fallire per un errore di cancellazione.
    const preSnap = await db.collection("bookings")
      .where("date", "==", date)
      .where("courtId", "==", court)
      .get();
    const scadute = preSnap.docs.filter(d => pendingScaduto(d.data()));
    if (scadute.length > 0) await Promise.all(scadute.map(d => d.ref.delete()));

    if (eOrmaiPassato(date, startMin)) {
      throw new HttpsError("failed-precondition", "Questo slot non è più disponibile — scegline un altro.");
    }

    // Prezzo: come per creaPrenotazioneCampo (tennis/squash), somma delle
    // quote dirette per categoria di ciascun giocatore — niente più tariffa
    // fissa + sconto percentuale. Ogni nominativo si riverifica qui contro
    // "soci", mai fidandosi delle categorie dichiarate dal client. Stessa
    // funzione di risoluzione categoria del prenotante già usata da
    // creaPrenotazioneCampo (definita più sotto in questo file, hoisted).
    const prenotante = await risolviCategoriaPrenotante(request.auth, profiloId);

    const altriGiocatoriInput = [
      { nome: giocatore2Nome, socioId: giocatore2SocioId },
      { nome: giocatore3Nome, socioId: giocatore3SocioId },
      { nome: giocatore4Nome, socioId: giocatore4SocioId }
    ].filter(g => g.nome || g.socioId);

    // I nominativi dei compagni servono solo per il tabellone/record (chi
    // gioca), non per il prezzo: la tariffa padel è per l'intero campo, non
    // per giocatore — un solo calcolo qui sotto, in base alla categoria di
    // chi prenota, indipendente da quanti (e chi) giocano con lui.
    const altriGiocatoriRisolti = [];
    for (const g of altriGiocatoriInput) {
      let nomeRisolto = g.nome || null;
      if (g.socioId) {
        const gSnap = await db.collection("soci").doc(g.socioId).get();
        if (gSnap.exists && gSnap.data().attivo !== false) {
          nomeRisolto = `${gSnap.data().nome} ${gSnap.data().cognome}`;
        }
      }
      altriGiocatoriRisolti.push({ nome: nomeRisolto });
    }

    let quotaPrenotante = await quotaCategoria({
      disciplina: "padel", posizione: null, categoria: prenotante.categoria,
      dataIso: date, startTime, durataMinuti: durationMinutes, festivi
    });
    if (quotaPrenotante == null) {
      throw new HttpsError("failed-precondition", "Tariffa non configurata per questo slot/categoria.");
    }
    let categoriaPrenotante = prenotante.categoria;
    ({ categoria: categoriaPrenotante, prezzo: quotaPrenotante } = await applicaTettoAzienda({
      categoria: categoriaPrenotante, socioId: prenotante.socioId || null, prezzo: quotaPrenotante,
      disciplina: "padel", posizione: null, dataIso: date, startTime, durataMinuti: durationMinutes, festivi
    }));
    const prezzo = quotaPrenotante;
    const prezzoDettaglio = [{ ruolo: "campo", categoria: categoriaPrenotante, importo: quotaPrenotante, socioId: prenotante.socioId || null }];

    let creditoDaScalare = 0;
    if (creditCode) {
      const creditoSnap = await db.collection("credits").doc(creditCode).get();
      if (!creditoSnap.exists || creditoSnap.data().status === "USED"
        || creditoSnap.data().status === "EXPIRED" || creditoSnap.data().status === "CANCELLED") {
        throw new HttpsError("failed-precondition", "Codice credito non valido o già utilizzato.");
      }
      creditoDaScalare = Math.min(creditoSnap.data().remainingAmount, prezzo);
    }
    const daPagare = Math.max(0, prezzo - creditoDaScalare);
    const token = generaToken();

    // Verifica e prenotazione dentro un'unica transazione Firestore: se
    // due richieste concorrenti leggono lo stesso slot libero, solo la
    // prima scrittura va a buon fine — Firestore invalida e riprova
    // automaticamente l'altra, che rilegge lo slot ormai occupato e si
    // ferma qui sotto. Mai due prenotazioni sovrapposte pagate entrambe
    // davvero (la lettura+scrittura separate di prima erano una finestra
    // di corsa reale, per quanto piccola).
    const bookingRef = db.collection("bookings").doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(
        db.collection("bookings").where("date", "==", date).where("courtId", "==", court)
      );
      const existingBookings = snap.docs
        .filter(d => !pendingScaduto(d.data()))
        .map(d => d.data())
        .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
        .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));

      if (!validStarts(existingBookings, durationMinutes, close, feriale(date, festivi), eOggi(date)).includes(startMin)) {
        throw new HttpsError("failed-precondition", "Questo slot non è più disponibile — scegline un altro.");
      }

      tx.set(bookingRef, {
        courtId: court, date, startTime, endTime,
        status: "PENDING_PAYMENT",
        type: "CUSTOMER",
        authUid: prenotante.authUid || null,
        createdAt: FieldValue.serverTimestamp()
      });
      // Nomi/sconto separati da "bookings" (pubblica) per lo stesso motivo
      // già spiegato per creaPrenotazioneCampo: mai esporre nominativi a
      // chi legge il tabellone senza essere un dispositivo riconosciuto.
      if (prenotante.nome || altriGiocatoriRisolti.length > 0) {
        tx.set(db.collection("bookingDettagli").doc(bookingRef.id), {
          prenotanteNome: prenotante.nome || null,
          altriGiocatori: altriGiocatoriRisolti.map(g => g.nome).filter(Boolean),
          prezzoDettaglio
        });
      }
    });

    if (daPagare === 0) {
      await confermaPrenotazionePubblica({
        bookingId: bookingRef.id, courtId: court, date, startTime, endTime, prezzo, token,
        paymentId: null, creditCode: creditCode || null, creditoScalato: creditoDaScalare,
        disciplina: "padel", campoLabel: `Campo ${await padelCampoNumero()}`
      });
      return { pagamentoNecessario: false, token };
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: bookingRef.id,
          successUrl: `${APP_URL}biglietto.html?t=${token}`,
          failedUrl: `${APP_URL}prenota-padel.html?pagamento=fallito`,
          lineItems: [{
            uniqueId: bookingRef.id,
            name: `Campo padel ${date} ${startTime}–${endTime}`,
            quantity: 1,
            amountIncludingTax: daPagare,
            type: LineItemType.Product
          }],
          metaData: {
            bookingId: bookingRef.id,
            token,
            prezzoTotale: String(prezzo),
            creditCode: creditCode || "",
            creditoScalato: String(creditoDaScalare)
          },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      return { pagamentoNecessario: true, token, paymentPageUrl };
    } catch (err) {
      await bookingRef.delete();
      console.error("creaPrenotazionePubblica: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// ---------- 1c. Flusso operatore: blocco slot / prenotazione esente ----------
//
// Due casi, entrambi senza pagamento, entrambi riservati a chi è
// loggato — a differenza del flusso pubblico, qui l'identità di chi
// chiama conta:
// - "BLOCK": blocca uno slot (manutenzione, evento, torneo), richiede
//   prenotazioni:gestisci oppure prenotazioni:proprie (es. maestri, che
//   possono bloccare per tornei ma non toccare le prenotazioni altrui).
// - "STAFF_EXEMPT": un maestro prenota per sé senza pagare, richiede sia
//   uno dei due permessi sopra sia soggettoQuotaCampo sul proprio utente
//   (stesso flag già usato per la quota campo del diario).
// In entrambi i casi lo slot occupa comunque "bookings" come una
// prenotazione vera, per restare coerente con il tabellone pubblico e
// l'algoritmo anti-buco (che non deve conoscere la differenza). Chi ha
// creato la prenotazione viene sempre registrato in "blockDetails" (non
// solo per i blocchi): serve a eliminaPrenotazioneOperatore per
// verificare che chi ha solo prenotazioni:proprie tocchi solo le sue.
exports.creaPrenotazioneOperatore = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

  const { courtId, date, startTime, endTime, durationMinutes, tipo, motivo } = request.data || {};
  if (!date || !startTime || !endTime || !durationMinutes || !tipo) {
    throw new HttpsError("invalid-argument", "Dati prenotazione incompleti.");
  }
  if (tipo !== "BLOCK" && tipo !== "STAFF_EXEMPT") {
    throw new HttpsError("invalid-argument", "Tipo non valido.");
  }

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  const isAdmin = permessi.includes("*");
  const puoOperare = isAdmin || permessi.includes("prenotazioni:gestisci") || permessi.includes("prenotazioni:proprie");

  if (!puoOperare) {
    throw new HttpsError("permission-denied", "Permesso mancante per prenotazioni padel.");
  }
  if (tipo === "BLOCK") {
    if (!motivo || !motivo.trim()) {
      throw new HttpsError("invalid-argument", "Indica un motivo per il blocco.");
    }
  } else if (!userData.soggettoQuotaCampo) {
    throw new HttpsError("permission-denied", "Questa prenotazione esente è riservata ai maestri.");
  }

  if (await giornoChiuso(date)) {
    throw new HttpsError("failed-precondition", "Il campo è chiuso in questa data.");
  }

  const court = courtId || COURT_ID;
  const startMin = orarioToMin(startTime);
  const generaleSnap = await db.collection("impostazioni").doc("generale").get();
  const festivi = generaleSnap.exists ? (generaleSnap.data().festivi || []) : [];
  const close = chiusuraGiorno(date, festivi);

  // Pulizia best-effort delle scadute — fuori dalla transazione qui
  // sotto, è solo pulizia.
  const preSnap = await db.collection("bookings")
    .where("date", "==", date)
    .where("courtId", "==", court)
    .get();
  const scadute = preSnap.docs.filter(d => pendingScaduto(d.data()));
  if (scadute.length > 0) await Promise.all(scadute.map(d => d.ref.delete()));

  if (eOrmaiPassato(date, startMin)) {
    throw new HttpsError("failed-precondition", "Questo slot non è più disponibile.");
  }

  // Prezzo puramente teorico/di conteggio interno (mai incassato — il
  // maestro è esente). "esterno" perché la vecchia tariffa fissa era
  // uguale per tutti, mai scontata in questo flusso: è l'equivalente più
  // fedele nel nuovo sistema a categorie di "Tariffe campi".
  let prezzo = 0;
  if (tipo === "STAFF_EXEMPT") {
    prezzo = await quotaCategoria({
      disciplina: "padel", posizione: null, categoria: "esterno",
      dataIso: date, startTime, durataMinuti: durationMinutes, festivi
    }) || 0;
  }

  const token = generaToken();

  // Stessa protezione anti-doppia-prenotazione di creaPrenotazionePubblica
  // (vedi commento lì): verifica e scrittura nella stessa transazione,
  // così due richieste concorrenti sullo stesso slot non possono passare
  // entrambe.
  const bookingRef = db.collection("bookings").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(
      db.collection("bookings").where("date", "==", date).where("courtId", "==", court)
    );
    const existingBookings = snap.docs
      .filter(d => !pendingScaduto(d.data()))
      .map(d => d.data())
      .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
      .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));

    if (!validStarts(existingBookings, durationMinutes, close, feriale(date, festivi), eOggi(date)).includes(startMin)) {
      throw new HttpsError("failed-precondition", "Questo slot non è più disponibile.");
    }

    tx.set(bookingRef, {
      courtId: court, date, startTime, endTime,
      status: "PENDING_PAYMENT",
      type: tipo,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  const bookingCode = await confermaPrenotazionePubblica({
    bookingId: bookingRef.id, courtId: court, date, startTime, endTime, prezzo, token,
    paymentId: null, creditCode: null, creditoScalato: 0
  });

  await db.collection("blockDetails").doc(bookingRef.id).set({
    motivo: tipo === "BLOCK" ? motivo.trim() : null,
    createdByUid: request.auth.uid,
    createdByNome: userData.nome || "—",
    createdAt: FieldValue.serverTimestamp()
  });

  return { bookingId: bookingRef.id, token, bookingCode };
});

// ---------- 1d. Flusso operatore: elimina blocco / prenotazione esente ----------
//
// Mai per prenotazioni "CUSTOMER" (pagate da un cliente): quelle passano
// solo da annullaEConvertiInCredito, così il cliente resta sempre
// protetto da una cancellazione senza rimborso/credito. Chi ha
// prenotazioni:gestisci (o è admin) può eliminare qualunque blocco o
// prenotazione esente; chi ha solo prenotazioni:proprie (es. un maestro)
// solo quelli creati da sé stesso — verificato via blockDetails, scritto
// da creaPrenotazioneOperatore per ogni prenotazione di questo tipo.
exports.eliminaPrenotazioneOperatore = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

  const { bookingId } = request.data || {};
  if (!bookingId) throw new HttpsError("invalid-argument", "ID prenotazione mancante.");

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  const isAdmin = permessi.includes("*");
  const puoTutto = isAdmin || permessi.includes("prenotazioni:gestisci");
  const puoProprie = puoTutto || permessi.includes("prenotazioni:proprie");

  if (!puoProprie) {
    throw new HttpsError("permission-denied", "Permesso mancante per prenotazioni padel.");
  }

  const bookingRef = db.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Prenotazione non trovata.");
  const booking = bookingSnap.data();

  if (booking.type !== "BLOCK" && booking.type !== "STAFF_EXEMPT") {
    throw new HttpsError(
      "failed-precondition",
      "Solo blocchi o prenotazioni esenti possono essere eliminati da qui — per una prenotazione cliente usa \"Annulla e converti in credito\"."
    );
  }

  if (!puoTutto) {
    const detailsSnap = await db.collection("blockDetails").doc(bookingId).get();
    const createdByUid = detailsSnap.exists ? detailsSnap.data().createdByUid : null;
    if (createdByUid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Puoi eliminare solo le tue prenotazioni.");
    }
  }

  const ticketsSnap = await db.collection("bookingTickets").where("bookingId", "==", bookingId).get();

  const batch = db.batch();
  batch.delete(bookingRef);
  batch.delete(db.collection("blockDetails").doc(bookingId));
  ticketsSnap.docs.forEach(d => {
    batch.delete(d.ref);
    batch.delete(db.collection("bookingCodes").doc(d.data().bookingCode));
  });
  await batch.commit();

  return { ok: true };
});

// ---------- 2. Webhook: conferma reale del pagamento ----------
//
// Da configurare nel Portale PostFinance Checkout: Spazio → Webhook →
// Nuovo ascoltatore webhook → entità "Transaction" → URL di questa
// funzione (visibile dopo il primo deploy). Il corpo della notifica
// contiene solo l'id della transazione (campo "entityId") — non ci si
// fida mai del payload in sé, si rilegge sempre lo stato reale via API.
// Gestisce entrambi i flussi (interno e pubblico), distinguendoli dal
// contenuto di metaData sulla transazione stessa.
exports.webhookPostFinance = onRequest(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY, ...MAIL_SECRETS] },
  async (req, res) => {
    try {
      const transactionId = req.body?.entityId;
      if (!transactionId) { res.status(400).send("missing entityId"); return; }

      const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
      const service = transactionsService();
      const transaction = await service.getPaymentTransactionsId({ id: transactionId, space: spaceId });

      const successo = transaction.state === TransactionState.Fulfill || transaction.state === TransactionState.Completed;
      const fallito = transaction.state === TransactionState.Failed
        || transaction.state === TransactionState.Decline
        || transaction.state === TransactionState.Voided;
      if (!successo && !fallito) { res.status(200).send("ok (stato intermedio)"); return; }

      const meta = transaction.metaData || {};

      if (meta.tipoTransazione === "pagamento_diario" && meta.token) {
        // Pagamento online di una lezione (richiesto da un maestro
        // abilitato, vedi richiediPagamentoDiario) — a differenza dei
        // buoni regalo qui il documento "paymentRequests" esiste già in
        // stato PENDING dalla creazione, va solo aggiornato con l'esito.
        const stato = successo ? "PAID" : "FAILED";
        await db.collection("paymentRequests").doc(meta.token).update({
          stato,
          paymentId: String(transaction.id),
          esitoAt: FieldValue.serverTimestamp()
        });

        if (meta.entryId) {
          const campiDiario = successo
            ? { pagamentoOnlineStato: "PAID", pagamentoOnlinePagatoAt: FieldValue.serverTimestamp() }
            : { pagamentoOnlineStato: "FAILED" };
          await db.collection("diario").doc(meta.entryId).update(campiDiario);
        }
      } else if (meta.tipoTransazione === "rinnovo_socio" && meta.token) {
        // Rinnovo tesseramento/forfait: stesso pattern di pagamento_diario
        // (il documento paymentRequests esiste già in PENDING dalla
        // creazione). Sul successo rinnova di un anno da oggi — un
        // rinnovo anticipato o posticipato non estende oltre l'anno.
        const stato = successo ? "PAID" : "FAILED";
        await db.collection("paymentRequests").doc(meta.token).update({
          stato, paymentId: String(transaction.id), esitoAt: FieldValue.serverTimestamp()
        });
        if (successo && meta.socioId) {
          const oggi = oraLocaleZurigo().dataIso;
          const scadenzaDate = new Date(oggi);
          scadenzaDate.setFullYear(scadenzaDate.getFullYear() + 1);
          const scadenzaIso = scadenzaDate.toISOString().slice(0, 10);
          await db.collection("soci").doc(meta.socioId).update({
            scadenza: scadenzaDate,
            forfaitPagato: { inizio: oggi, fine: scadenzaIso }
          });
        }
      } else if (meta.tipoTransazione === "tokenizzazione_corso" && meta.iscrizioneId) {
        // Salvataggio carta a costo zero (corsi a soglia minima): sul
        // successo il token è pronto per un addebito differito; sul
        // fallimento l'iscritto pagherà comunque più avanti via link,
        // come chiunque non abbia salvato la carta — nessun blocco.
        const nuovoStato = successo ? "ATTIVO" : "FALLITO";
        await db.collection("iscrizioniCorsi").doc(meta.iscrizioneId).update({ tokenStato: nuovoStato });
        if (meta.verificaToken) {
          await db.collection("tokenizzazioniCorsi").doc(meta.verificaToken).update({ stato: nuovoStato });
        }
      } else if (meta.tipoTransazione === "pagamento_corso" && meta.iscrizioneId) {
        if (successo) {
          await db.collection("iscrizioniCorsi").doc(meta.iscrizioneId).update({ pagamentoStato: "PAGATO" });
        } else if (meta.viaToken === "true") {
          // Addebito automatico sulla carta salvata fallito (rifiutata,
          // scaduta, 3-D Secure...): fallback automatico, come deciso —
          // si genera un link di pagamento normale e si manda via email,
          // invece di lasciare l'iscritto bloccato in attesa.
          try {
            const iscrizioneSnap = await db.collection("iscrizioniCorsi").doc(meta.iscrizioneId).get();
            const iscrizione = iscrizioneSnap.data();
            const importo = parseFloat(meta.importo || "0");
            const paymentPageUrl = await creaLinkPagamentoCorso({
              iscrizioneId: meta.iscrizioneId, corsoNome: iscrizione.corsoNome, importo, email: iscrizione.email
            });
            await iscrizioneSnap.ref.update({
              pagamentoStato: "FALLITO_LINK_INVIATO", pagamentoLink: paymentPageUrl, pagamentoImporto: importo
            });
            if (iscrizione.email) {
              await inviaEmail({
                to: iscrizione.email,
                subject: `Pagamento corso — ${iscrizione.corsoNome || ""}`,
                html: `<p>Il corso "${iscrizione.corsoNome || ""}" è confermato, ma non siamo riusciti ad addebitare la carta salvata.</p>`
                  + `<p>Completa il pagamento da qui: <a href="${paymentPageUrl}">${paymentPageUrl}</a></p>`
              });
            }
          } catch (err) {
            console.error("webhookPostFinance: fallback pagamento_corso fallito:", err);
          }
        }
      } else if (meta.tipoTransazione === "tokenizzazione_azienda" && meta.aziendaId) {
        // Salvataggio carta a costo zero (azienda convenzionata): sul
        // successo il token è pronto per un addebito, deciso di volta in
        // volta dal referente — nessun addebito automatico da qui.
        await db.collection("aziende").doc(meta.aziendaId).update({
          tokenStato: successo ? "ATTIVO" : "FALLITO"
        });
      } else if (meta.tipoTransazione === "addebito_azienda" && meta.aziendaId) {
        // Corregge lo stato ottimistico "IN_CORSO" impostato da
        // addebitaAzienda con l'esito reale — stesso schema del fallback
        // di pagamento_corso, ma qui non c'è un link di ripiego automatico:
        // il referente vede l'esito nel proprio portale e può riprovare.
        await db.collection("aziende").doc(meta.aziendaId).update({
          "ultimoAddebito.stato": successo ? "PAGATO" : "FALLITO"
        });
      } else if (meta.tipoTransazione === "voucher" && meta.token) {
        // Buono regalo acquistato dalla pagina pubblica — nessun documento
        // esiste prima del successo (a differenza delle prenotazioni non
        // c'è nemmeno un "bookings" da liberare in caso di fallimento).
        if (successo) {
          const code = generaCodiceCredito();
          const importo = parseFloat(meta.importo || "0");
          await db.collection("credits").doc(code).set({
            originalBookingId: null,
            initialAmount: importo,
            remainingAmount: importo,
            status: "ACTIVE",
            origine: "voucher_acquistato",
            paymentId: String(transaction.id),
            createdAt: FieldValue.serverTimestamp()
          });
          await db.collection("voucherTickets").doc(meta.token).set({
            creditCode: code, importo, origine: "voucher_acquistato",
            createdAt: FieldValue.serverTimestamp()
          });
          await db.collection("creditTransactions").add({
            creditId: code, bookingId: null, type: "ISSUE", amount: importo,
            createdAt: FieldValue.serverTimestamp()
          });
        }
      } else if (meta.bookingId && meta.token) {
        // Flusso pubblico (padel, o tennis/squash via creaPrenotazioneCampo
        // — stesso schema "bookings"/"bookingTickets", distinti solo dal
        // fatto che per tennis/squash courtId punta a un doc "campi").
        if (successo) {
          const bookingSnap = await db.collection("bookings").doc(meta.bookingId).get();
          if (bookingSnap.exists && bookingSnap.data().status === "PENDING_PAYMENT") {
            const courtId = bookingSnap.data().courtId;
            const campoSnap = await db.collection("campi").doc(courtId).get();
            // Nessun doc "campi" per questo courtId = flusso padel (unico
            // caso in cui creaPrenotazionePubblica viene usata oggi), non
            // un errore.
            const disciplina = campoSnap.exists ? campoSnap.data().disciplina : "padel";
            const campoLabel = campoSnap.exists
              ? `Campo ${campoSnap.data().numero}${campoSnap.data().posizione ? ` (${campoSnap.data().posizione})` : ""}`
              : `Campo ${await padelCampoNumero()}`;
            await confermaPrenotazionePubblica({
              bookingId: meta.bookingId,
              courtId,
              date: bookingSnap.data().date,
              startTime: bookingSnap.data().startTime,
              endTime: bookingSnap.data().endTime,
              prezzo: parseFloat(meta.prezzoTotale || "0"),
              token: meta.token,
              paymentId: transaction.id,
              creditCode: meta.creditCode || null,
              creditoScalato: parseFloat(meta.creditoScalato || "0"),
              disciplina, campoLabel
            });
          }
        } else {
          await db.collection("bookings").doc(meta.bookingId).delete();
        }
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("webhookPostFinance error:", err);
      res.status(500).send("error");
    }
  }
);

// ---------- 3. Annulla e converti in credito (pannello operatore) ----------
//
// Solo per chi gestisce le prenotazioni: trasforma una prenotazione
// confermata in un credito spendibile su una prenotazione futura, invece
// di un rimborso diretto. L'importo pagato si recupera da "payments"
// (Admin SDK, bypassa le regole — non serve un riferimento pubblico).
exports.annullaEConvertiInCredito = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  const autorizzato = permessi.includes("prenotazioni:gestisci") || permessi.includes("*");
  if (!autorizzato) throw new HttpsError("permission-denied", "Permesso mancante.");

  const { bookingId } = request.data || {};
  if (!bookingId) throw new HttpsError("invalid-argument", "bookingId mancante.");

  const bookingRef = db.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Prenotazione non trovata.");
  const stato = bookingSnap.data().status;
  if (stato !== "CONFIRMED" && stato !== "COMPLETED") {
    throw new HttpsError("failed-precondition", `Impossibile convertire in credito una prenotazione in stato ${stato}.`);
  }

  const paymentsSnap = await db.collection("payments").where("bookingId", "==", bookingId).get();
  const importoPagato = paymentsSnap.docs.reduce((somma, d) => somma + (d.data().amount || 0), 0);
  if (importoPagato <= 0) {
    throw new HttpsError("failed-precondition", "Nessun pagamento trovato per questa prenotazione (es. era esente).");
  }

  const creditCode = generaCodiceCredito();
  await bookingRef.update({ status: "CREDITED" });
  await db.collection("credits").doc(creditCode).set({
    originalBookingId: bookingId,
    initialAmount: importoPagato,
    remainingAmount: importoPagato,
    status: "ACTIVE",
    createdAt: FieldValue.serverTimestamp()
  });
  await db.collection("creditTransactions").add({
    creditId: creditCode, bookingId, type: "ISSUE", amount: importoPagato,
    createdAt: FieldValue.serverTimestamp()
  });

  return { creditCode, importo: importoPagato };
});

// ---------- 4. Buoni regalo ----------
//
// Un buono regalo è, sotto il cofano, esattamente un "credito" (stessa
// collection "credits" già usata per le prenotazioni annullate) — cambia
// solo come nasce: qui non da una prenotazione annullata ma da un
// acquisto vero (questa funzione) o da un'emissione omaggio dello staff
// (emettiBuonoOmaggio più sotto). Il campo "origine" li distingue per il
// resoconto. Come le prenotazioni pubbliche, il documento "ricevuta"
// pubblico (voucherTickets, ID = token lungo e casuale) viene creato solo
// dal webhook a pagamento riuscito — prima non esiste nulla da indovinare
// o enumerare.
const IMPORTO_BUONO_MIN = 10;
const IMPORTO_BUONO_MAX = 500;

exports.acquistaBuonoRegalo = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const { importo } = request.data || {};
    if (typeof importo !== "number" || !isFinite(importo) || importo < IMPORTO_BUONO_MIN || importo > IMPORTO_BUONO_MAX) {
      throw new HttpsError("invalid-argument", `Inserisci un importo tra CHF ${IMPORTO_BUONO_MIN} e CHF ${IMPORTO_BUONO_MAX}.`);
    }

    const token = generaToken();
    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: token,
          successUrl: `${APP_URL}buono-regalo-conferma.html?t=${token}`,
          failedUrl: `${APP_URL}buono-regalo.html?pagamento=fallito`,
          lineItems: [{
            uniqueId: token,
            name: `Buono regalo padel CHF ${importo.toFixed(2)}`,
            quantity: 1,
            amountIncludingTax: importo,
            type: LineItemType.Product
          }],
          metaData: { tipoTransazione: "voucher", token, importo: String(importo) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      return { token, paymentPageUrl };
    } catch (err) {
      console.error("acquistaBuonoRegalo: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// Emissione da parte dello staff (es. omaggio/promozione), nessun
// pagamento — stesso identico effetto finale di un buono acquistato
// (un "credits" ACTIVE), così si spende esattamente allo stesso modo in
// fase di prenotazione. Riservata a chi gestisce le prenotazioni.
exports.emettiBuonoOmaggio = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  const autorizzato = permessi.includes("prenotazioni:gestisci") || permessi.includes("*");
  if (!autorizzato) throw new HttpsError("permission-denied", "Permesso mancante.");

  const { importo, nota } = request.data || {};
  if (typeof importo !== "number" || !isFinite(importo) || importo <= 0) {
    throw new HttpsError("invalid-argument", "Importo non valido.");
  }

  const code = generaCodiceCredito();
  const token = generaToken();

  await db.collection("credits").doc(code).set({
    originalBookingId: null,
    initialAmount: importo,
    remainingAmount: importo,
    status: "ACTIVE",
    origine: "voucher_omaggio",
    createdByUid: request.auth.uid,
    createdByNome: userData.nome || "—",
    nota: nota || null,
    createdAt: FieldValue.serverTimestamp()
  });
  await db.collection("voucherTickets").doc(token).set({
    creditCode: code, importo, origine: "voucher_omaggio",
    createdAt: FieldValue.serverTimestamp()
  });
  await db.collection("creditTransactions").add({
    creditId: code, bookingId: null, type: "ISSUE", amount: importo,
    createdAt: FieldValue.serverTimestamp()
  });

  return { code, token };
});

// ---------- Pagamento online di una lezione (Diario) ----------
//
// Un maestro abilitato (flag puoRichiederePagamento sul proprio utente,
// impostato da Team) genera un link di pagamento PostFinance per una SUA
// voce diario, da inoltrare al cliente. A differenza dei buoni regalo,
// qui il documento "paymentRequests" e i campi sulla voce diario si
// scrivono SUBITO in stato PENDING (non solo al successo): serve per
// mostrare "richiesta in corso" nell'interfaccia prima ancora che il
// cliente paghi, e per evitare di generare due link paralleli per la
// stessa lezione.
exports.richiediPagamentoDiario = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

    const userSnap = await db.collection("users").doc(request.auth.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    let permessi = [];
    if (userData.ruoloId) {
      const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
      if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
    }
    const isAdminUser = permessi.includes("*");
    if (!isAdminUser && !userData.puoRichiederePagamento) {
      throw new HttpsError("permission-denied", "Non sei abilitato a richiedere pagamenti online.");
    }

    const { entryId, importo } = request.data || {};
    if (!entryId) throw new HttpsError("invalid-argument", "ID voce diario mancante.");
    if (typeof importo !== "number" || !isFinite(importo) || importo <= 0) {
      throw new HttpsError("invalid-argument", "Importo non valido.");
    }

    const entryRef = db.collection("diario").doc(entryId);
    const entrySnap = await entryRef.get();
    if (!entrySnap.exists) throw new HttpsError("not-found", "Voce diario non trovata.");
    const entry = entrySnap.data();
    if (!isAdminUser && entry.userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Puoi richiedere il pagamento solo delle tue lezioni.");
    }

    const descrizione = `${entry.tipoAttivitaNome || "Lezione"} — ${entry.data || ""}`;
    const token = generaToken();
    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();

    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: token,
          successUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
          failedUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
          lineItems: [{
            uniqueId: token,
            name: descrizione,
            quantity: 1,
            amountIncludingTax: importo,
            type: LineItemType.Product
          }],
          metaData: { tipoTransazione: "pagamento_diario", token, entryId, importo: String(importo) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      await db.collection("paymentRequests").doc(token).set({
        tipo: "diario_lezione",
        riferimentoId: entryId,
        importo,
        descrizione,
        data: entry.data || null,
        oraInizio: entry.oraInizio || null,
        oraFine: entry.oraFine || null,
        stato: "PENDING",
        createdByUid: request.auth.uid,
        createdByNome: userData.nome || "—",
        createdAt: FieldValue.serverTimestamp()
      });

      await entryRef.update({
        pagamentoOnlineStato: "PENDING",
        pagamentoOnlineToken: token,
        pagamentoOnlineImporto: importo,
        pagamentoOnlineLink: paymentPageUrl,
        pagamentoOnlineDescrizione: descrizione,
        pagamentoOnlineRichiestoDaUid: request.auth.uid,
        pagamentoOnlineRichiestoDaNome: userData.nome || "—",
        pagamentoOnlineRichiestoAt: FieldValue.serverTimestamp()
      });

      return { token, paymentPageUrl };
    } catch (err) {
      console.error("richiediPagamentoDiario: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// ---------- 4. Prenotazione campi tennis/squash: riconoscimento soci ----------
//
// Categorie: socio, junior (della scuola), studente, azienda (partner),
// esterno (nessuna categoria, tariffa piena), maestro (staff, vedi
// risolviCategoriaPrenotante). Nessun account tradizionale: un dispositivo
// diventa "riconosciuto" consumando un token (via email o QR staff, stesso
// schema), che genera una sessione Firebase Auth stabile per quella
// persona (stesso uid ad ogni riattivazione, anche su un altro
// dispositivo) — vedi attivaSocioDaToken/collegaSocioAlDispositivo.

async function permessiUtente(uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : null;
  let permessi = [];
  if (userData && userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  return { userData, permessi, isAdmin: permessi.includes("*") };
}

// Import/aggiornamento massivo dell'anagrafica soci (a inizio stagione,
// incollando l'export del gestionale attuale) — upsert per email. Righe
// senza i campi minimi vengono scartate e contate, non bloccano le altre.
exports.importaSoci = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("config:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }

  const { righe } = request.data || {};
  if (!Array.isArray(righe) || righe.length === 0) {
    throw new HttpsError("invalid-argument", "Nessuna riga da importare.");
  }

  // Le categorie sono configurabili (collection "categorieSocio", vedi
  // Configurazione) invece di un elenco fisso — "azienda" resta l'unico
  // valore speciale non di tesseramento accettato qui ("esterno"/"maestro"
  // non hanno senso per un socio importato).
  const categorieSnap = await db.collection("categorieSocio").where("attivo", "==", true).get();
  const CATEGORIE_VALIDE = [...categorieSnap.docs.map(d => d.id), "azienda"];
  let importate = 0;
  let scartate = 0;
  for (const riga of righe) {
    const email = (riga.email || "").trim().toLowerCase();
    if (!email || !riga.nome || !riga.cognome || !CATEGORIE_VALIDE.includes(riga.categoria)) {
      scartate++;
      continue;
    }
    const dati = {
      nome: riga.nome, cognome: riga.cognome, email,
      telefono: riga.telefono || null,
      categoria: riga.categoria,
      aziendaNome: riga.aziendaNome || null,
      tessera: riga.tessera || null,
      scadenza: riga.scadenza ? new Date(riga.scadenza) : null,
      attivo: true
    };
    const esistente = await db.collection("soci").where("email", "==", email).limit(1).get();
    if (!esistente.empty) {
      await esistente.docs[0].ref.set(dati, { merge: true });
    } else {
      await db.collection("soci").add({ ...dati, authUid: null, forfaitPagato: null, createdAt: FieldValue.serverTimestamp() });
    }
    importate++;
  }
  return { importate, scartate };
});

// Il client invia l'email inserita dal socio; la risposta è sempre
// {ok:true} indipendentemente dal risultato reale della ricerca — non deve
// essere possibile usare questo endpoint per scoprire se un indirizzo
// appartiene o no a un socio del circolo.
exports.richiediAttivazioneEmail = onCall({ secrets: MAIL_SECRETS }, async (request) => {
  const email = (request.data?.email || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Email mancante.");

  const snap = await db.collection("soci").where("email", "==", email).where("attivo", "==", true).limit(1).get();
  if (!snap.empty) {
    const socioId = snap.docs[0].id;
    const token = generaToken();
    await db.collection("attivazioniSoci").doc(token).set({
      socioId, metodo: "email", usato: false, createdByUid: null, createdAt: FieldValue.serverTimestamp()
    });
    const link = `${APP_URL}attiva-socio.html?t=${token}`;
    try {
      await inviaEmail({
        to: email,
        subject: "Il tuo accesso a Sport-OS",
        html: `<p>Tocca il link qui sotto per attivare questo dispositivo e prenotare i campi con la tua tariffa socio:</p>`
          + `<p><a href="${link}">${link}</a></p><p>Il link è valido una sola volta.</p>`
      });
    } catch (err) {
      console.error("richiediAttivazioneEmail: invio email fallito:", err);
    }
  }
  return { ok: true };
});

// Ricerca soci per il pannello operatore (per generare il QR di
// attivazione) — dietro permesso, mai esposta al pubblico.
exports.cercaSociStaff = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("prenotazioni:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }
  const testo = (request.data?.testo || "").trim().toLowerCase();
  if (testo.length < 2) return { risultati: [] };

  const snap = await db.collection("soci").where("attivo", "==", true).limit(500).get();
  const risultati = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => `${s.nome} ${s.cognome} ${s.tessera || ""}`.toLowerCase().includes(testo))
    .slice(0, 20)
    .map(s => ({ id: s.id, nome: s.nome, cognome: s.cognome, categoria: s.categoria, tessera: s.tessera || null }));
  return { risultati };
});

// Pannello operatore: genera il token da cui disegnare il QR di
// attivazione (qrcodejs, già in uso per i biglietti) per chi non ha email
// in anagrafica, o è Studente/Azienda partner/Junior verificato di persona.
exports.generaTokenAttivazione = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("prenotazioni:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }
  const { socioId } = request.data || {};
  if (!socioId) throw new HttpsError("invalid-argument", "socioId mancante.");
  const socioSnap = await db.collection("soci").doc(socioId).get();
  if (!socioSnap.exists) throw new HttpsError("not-found", "Socio non trovato.");

  const token = generaToken();
  await db.collection("attivazioniSoci").doc(token).set({
    socioId, metodo: "qr", usato: false, createdByUid: request.auth.uid, createdAt: FieldValue.serverTimestamp()
  });
  return { token };
});

// Consuma un token (email o QR, stesso formato) e crea/riusa una sessione
// Firebase Auth stabile per quel socio — stesso uid ogni volta che si
// riattiva, anche su un dispositivo diverso, così l'identità resta
// coerente ovunque (limite prenotazioni, priorità di anticipo).
exports.attivaSocioDaToken = onCall(async (request) => {
  const { token } = request.data || {};
  if (!token) throw new HttpsError("invalid-argument", "Token mancante.");

  const tokenRef = db.collection("attivazioniSoci").doc(token);
  const tokenSnap = await tokenRef.get();
  if (!tokenSnap.exists || tokenSnap.data().usato) {
    throw new HttpsError("failed-precondition", "Link o codice non valido o già usato.");
  }
  const { socioId } = tokenSnap.data();
  const socioRef = db.collection("soci").doc(socioId);
  const socioSnap = await socioRef.get();
  if (!socioSnap.exists || socioSnap.data().attivo === false) {
    throw new HttpsError("not-found", "Profilo non trovato.");
  }

  let uid = socioSnap.data().authUid;
  if (!uid) {
    uid = `socio_${socioId}`;
    try {
      await getAuth().createUser({ uid });
    } catch (err) {
      if (err.code !== "auth/uid-already-exists") throw err;
    }
    await socioRef.update({ authUid: uid });
  }

  await tokenRef.update({ usato: true, usatoAt: FieldValue.serverTimestamp() });
  const customToken = await getAuth().createCustomToken(uid);
  return { customToken, socioId };
});

// Dopo signInWithCustomToken il dispositivo ha una sessione Firebase Auth
// ma non è ancora "agganciato" a nessun profilo: aggiunge il profilo a
// sociDevices/{uid}, supportando più profili sullo stesso dispositivo (un
// tablet di famiglia condiviso) — ogni familiare la richiama dopo il
// proprio giro email/QR.
exports.collegaSocioAlDispositivo = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { socioId } = request.data || {};
  if (!socioId) throw new HttpsError("invalid-argument", "socioId mancante.");

  const socioSnap = await db.collection("soci").doc(socioId).get();
  if (!socioSnap.exists || socioSnap.data().authUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Profilo non valido per questo dispositivo.");
  }
  const socio = socioSnap.data();

  const deviceRef = db.collection("sociDevices").doc(request.auth.uid);
  const deviceSnap = await deviceRef.get();
  const profili = deviceSnap.exists ? (deviceSnap.data().profili || []) : [];
  if (!profili.some(p => p.socioId === socioId)) {
    profili.push({ socioId, nome: `${socio.nome} ${socio.cognome}`, categoria: socio.categoria });
  }
  await deviceRef.set({ profili, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { profili };
});

// ---------- Aziende convenzionate: portale referente ----------
//
// Ogni azienda convenzionata è anche una categoria di prezzo a sé (righe in
// "tariffeCampi" con categoria == aziendaId, gestite in Configurazione) —
// qui c'è solo la gestione dei dipendenti e il consumo mensile, mai il
// prezzo (quello passa comunque da quotaCategoria come ogni altra
// categoria). Ambito sempre preso da users/{uid}.aziendaId lato server,
// mai da un parametro del client.

async function verificaReferenteAzienda(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { userData, permessi, isAdmin } = await permessiUtente(auth.uid);
  if (!isAdmin && !permessi.includes("azienda:propria")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }
  const aziendaId = userData && userData.aziendaId;
  if (!aziendaId) throw new HttpsError("failed-precondition", "Nessuna azienda associata al tuo account.");
  return aziendaId;
}

// Consumo mensile (mese corrente, fuso Zurigo) per i dipendenti di
// un'azienda: somma degli importi con categoria == aziendaId in
// prezzoDettaglio di bookingDettagli confermati, attribuiti tramite il
// socioId salvato su ciascuna voce — mai per nome (due persone possono
// chiamarsi uguale) né per la sola categoria (serve sapere DI CHI è la
// spesa, non solo che è un dipendente di quell'azienda). Query per
// intervallo di date senza filtro "status" lato Firestore (evita di dover
// creare un indice composito) — il filtro sullo stato si fa in JS.
async function consumoMensileAzienda(aziendaId, socioIds) {
  const oggi = oraLocaleZurigo().dataIso;
  const inizioMese = oggi.slice(0, 7) + "-01";
  const bookingsSnap = await db.collection("bookings")
    .where("date", ">=", inizioMese)
    .where("date", "<=", oggi)
    .get();
  const idsConfermati = bookingsSnap.docs
    .filter(d => ["CONFIRMED", "COMPLETED"].includes(d.data().status))
    .map(d => d.id);
  const dettagliSnaps = await Promise.all(idsConfermati.map(id => db.collection("bookingDettagli").doc(id).get()));

  const perSocioId = {};
  socioIds.forEach(id => { perSocioId[id] = 0; });
  let totaleAzienda = 0;
  dettagliSnaps.forEach(snap => {
    if (!snap.exists) return;
    (snap.data().prezzoDettaglio || []).forEach(voce => {
      if (voce.categoria !== aziendaId || !voce.socioId) return;
      totaleAzienda += voce.importo || 0;
      perSocioId[voce.socioId] = (perSocioId[voce.socioId] || 0) + (voce.importo || 0);
    });
  });
  return { perSocioId, totaleAzienda };
}

// Se una categoria corrisponde a un'azienda convenzionata attiva (id di
// "aziende"), verifica il tetto di spesa mensile (personale e aziendale)
// PRIMA di accettare quel prezzo: se lo supererebbe, ricalcola l'intera
// quota di quel giocatore con categoria "esterno" invece — nessuna
// prenotazione bloccata, solo tariffa piena per quella parte, come da
// richiesta. Chiamata sia da creaPrenotazionePubblica (padel) che da
// creaPrenotazioneCampo (tennis/squash), una volta per giocatore — due
// compagni possono appartenere ad aziende diverse, ognuno verificato per
// conto proprio. Ritorna {categoria, prezzo} invariati se non è
// un'azienda, se non ha nessun tetto configurato, o se rientra nei tetti.
async function applicaTettoAzienda({ categoria, socioId, prezzo, disciplina, posizione, dataIso, startTime, durataMinuti, festivi }) {
  if (!socioId) return { categoria, prezzo };
  const aziendaSnap = await db.collection("aziende").doc(categoria).get();
  if (!aziendaSnap.exists || aziendaSnap.data().attivo === false) return { categoria, prezzo };
  const azienda = aziendaSnap.data();
  if (azienda.tettoMensileAzienda == null && azienda.tettoDefaultPerUtente == null) return { categoria, prezzo };

  const socioSnap = await db.collection("soci").doc(socioId).get();
  const tettoSocio = (socioSnap.exists ? socioSnap.data().tettoPersonalizzato : null) ?? azienda.tettoDefaultPerUtente;

  const { perSocioId, totaleAzienda } = await consumoMensileAzienda(categoria, [socioId]);
  const consumoSocio = perSocioId[socioId] || 0;

  const superaTettoSocio = tettoSocio != null && (consumoSocio + prezzo) > tettoSocio;
  const superaTettoAzienda = azienda.tettoMensileAzienda != null && (totaleAzienda + prezzo) > azienda.tettoMensileAzienda;
  if (!superaTettoSocio && !superaTettoAzienda) return { categoria, prezzo };

  const prezzoEsterno = await quotaCategoria({ disciplina, posizione, categoria: "esterno", dataIso, startTime, durataMinuti, festivi });
  return { categoria: "esterno", prezzo: prezzoEsterno != null ? prezzoEsterno : prezzo };
}

// Unico punto che collega un'azienda a un account referente (o la
// scollega, uid nullo) — azione di chi gestisce (config:gestisci /
// users:gestisci), non del referente stesso. referenteNome/Email su
// "aziende" restano una copia denormalizzata, aggiornata solo qui, per
// non dover risolvere lo user ad ogni visualizzazione della lista.
exports.collegaReferenteAzienda = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("config:gestisci") && !permessi.includes("users:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }

  const { aziendaId, uid } = request.data || {};
  if (!aziendaId) throw new HttpsError("invalid-argument", "aziendaId mancante.");

  const aziendaRef = db.collection("aziende").doc(aziendaId);
  const aziendaSnap = await aziendaRef.get();
  if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");

  // Scollega l'eventuale referente precedente se diverso dal nuovo — mai
  // due utenti collegati alla stessa azienda, nessun accesso orfano.
  const vecchioUid = aziendaSnap.data().referenteUid;
  if (vecchioUid && vecchioUid !== uid) {
    await db.collection("users").doc(vecchioUid).update({ aziendaId: null }).catch(() => {});
  }

  if (!uid) {
    await aziendaRef.update({ referenteUid: null, referenteNome: null, referenteEmail: null });
    return { ok: true };
  }

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) throw new HttpsError("not-found", "Utente non trovato.");
  const userData = userSnap.data();

  // Verifica che il ruolo scelto conceda davvero azienda:propria — mai
  // collegare per sbaglio un membro dello staff qualunque.
  let permessiRuolo = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessiRuolo = roleSnap.data().permessi || [];
  }
  if (!permessiRuolo.includes("azienda:propria") && !permessiRuolo.includes("*")) {
    throw new HttpsError("failed-precondition", "Il ruolo di questo utente non ha il permesso \"Referente aziendale\".");
  }

  await userSnap.ref.update({ aziendaId });
  await aziendaRef.update({
    referenteUid: uid,
    referenteNome: userData.nome || null,
    referenteEmail: userData.email || null
  });
  return { ok: true };
});

// Invio reale (SMTP, non più mailto: aperto sul dispositivo di chi
// gestisce le aziende) dell'email di benvenuto al referente — richiesto
// esplicitamente al posto del pattern "solo link, spedisce una persona"
// usato per il reset password dello staff, perché qui il destinatario è
// esterno e non va bene affidarsi al client di posta di chi è in
// Configurazione in quel momento.
exports.inviaInvitoAzienda = onCall({ secrets: MAIL_SECRETS }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("config:gestisci") && !permessi.includes("users:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante.");
  }

  const { aziendaId } = request.data || {};
  if (!aziendaId) throw new HttpsError("invalid-argument", "aziendaId mancante.");

  const aziendaSnap = await db.collection("aziende").doc(aziendaId).get();
  if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");
  const azienda = aziendaSnap.data();
  if (!azienda.referenteUid) {
    throw new HttpsError("failed-precondition", `Collega prima un referente all'azienda "${azienda.nome}".`);
  }

  const userSnap = await db.collection("users").doc(azienda.referenteUid).get();
  if (!userSnap.exists) throw new HttpsError("not-found", "Account del referente non trovato.");
  const user = userSnap.data();
  if (!user.email) throw new HttpsError("failed-precondition", "L'account del referente non ha un'email registrata.");

  const centroSnap = await db.collection("impostazioni").doc("centro").get();
  const nomeCentro = (centroSnap.exists && centroSnap.data().nome) || "Tennis Club Mendrisio";

  const link = await getAuth().generatePasswordResetLink(user.email, { url: `${APP_URL}index.html` });
  const portaleUrl = `${APP_URL}azienda.html`;

  await inviaEmail({
    to: user.email,
    subject: `Benvenuto in Sport-OS come Partner — ${nomeCentro}`,
    html: `<p>Ciao ${user.nome || ""},</p>`
      + `<p><strong>${azienda.nome}</strong> è ora un'azienda convenzionata con ${nomeCentro}! Da qui i tuoi dipendenti potranno prenotare i campi alla tariffa concordata.</p>`
      + `<p>Accedi al tuo portale aziendale per gestire i dipendenti e vedere i consumi:<br><a href="${portaleUrl}">${portaleUrl}</a></p>`
      + `<p>Per impostare la tua password, tocca questo link:<br><a href="${link}">${link}</a></p>`
      + `<p>Email di accesso: ${user.email}</p>`
  });

  return { ok: true, email: user.email };
});

exports.listaSociAzienda = onCall(async (request) => {
  const aziendaId = await verificaReferenteAzienda(request.auth);

  const aziendaSnap = await db.collection("aziende").doc(aziendaId).get();
  if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");
  const azienda = aziendaSnap.data();

  const sociSnap = await db.collection("soci").where("aziendaId", "==", aziendaId).get();
  const soci = sociSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const { perSocioId, totaleAzienda } = await consumoMensileAzienda(aziendaId, soci.map(s => s.id));

  return {
    azienda: {
      nome: azienda.nome,
      tettoMensileAzienda: azienda.tettoMensileAzienda ?? null,
      tettoDefaultPerUtente: azienda.tettoDefaultPerUtente ?? null,
      tokenStato: azienda.tokenStato ?? null,
      ultimoAddebito: azienda.ultimoAddebito ?? null
    },
    consumoTotaleAzienda: totaleAzienda,
    dipendenti: soci.map(s => ({
      id: s.id, nome: s.nome, cognome: s.cognome, attivo: s.attivo !== false,
      tettoPersonalizzato: s.tettoPersonalizzato ?? null,
      consumoMese: perSocioId[s.id] || 0
    }))
  };
});

// Crea il dipendente come "soci" doc (categoria = aziendaId, così il
// motore prezzi lo tratta come qualunque altra categoria) e genera subito
// un token di attivazione — stesso schema di generaTokenAttivazione più
// sotto, il referente lo mostra come QR/link al dipendente per collegare
// il suo dispositivo (attiva-socio.html, invariato).
exports.aggiungiDipendenteAzienda = onCall(async (request) => {
  const aziendaId = await verificaReferenteAzienda(request.auth);
  const { nome, cognome, email } = request.data || {};
  if (!nome || !cognome) throw new HttpsError("invalid-argument", "Nome e cognome obbligatori.");

  const socioRef = await db.collection("soci").add({
    nome, cognome, email: (email || "").trim().toLowerCase() || null,
    categoria: aziendaId, aziendaId, telefono: null, tessera: null,
    scadenza: null, attivo: true, authUid: null, forfaitPagato: null,
    createdAt: FieldValue.serverTimestamp()
  });

  const token = generaToken();
  await db.collection("attivazioniSoci").doc(token).set({
    socioId: socioRef.id, metodo: "qr", createdByUid: request.auth.uid,
    usato: false, createdAt: FieldValue.serverTimestamp()
  });

  return { socioId: socioRef.id, token };
});

async function verificaDipendenteProprio(aziendaId, socioId) {
  const socioSnap = await db.collection("soci").doc(socioId).get();
  if (!socioSnap.exists || socioSnap.data().aziendaId !== aziendaId) {
    throw new HttpsError("permission-denied", "Questo dipendente non appartiene alla tua azienda.");
  }
  return socioSnap;
}

exports.disattivaDipendenteAzienda = onCall(async (request) => {
  const aziendaId = await verificaReferenteAzienda(request.auth);
  const { socioId, attivo } = request.data || {};
  if (!socioId) throw new HttpsError("invalid-argument", "socioId mancante.");
  await verificaDipendenteProprio(aziendaId, socioId);
  await db.collection("soci").doc(socioId).update({ attivo: attivo !== false });
  return { ok: true };
});

exports.impostaTettoDipendenteAzienda = onCall(async (request) => {
  const aziendaId = await verificaReferenteAzienda(request.auth);
  const { socioId, tetto } = request.data || {};
  if (!socioId) throw new HttpsError("invalid-argument", "socioId mancante.");
  await verificaDipendenteProprio(aziendaId, socioId);
  const tettoPersonalizzato = tetto !== "" && tetto != null ? Number(tetto) : null;
  await db.collection("soci").doc(socioId).update({ tettoPersonalizzato });
  return { ok: true };
});

// Report per il referente: chi ha prenotato, quante volte e quanto ha
// speso alla tariffa azienda nell'intervallo scelto — base per il
// conteggio periodico. Stessa identificazione per socioId di
// consumoMensileAzienda (mai per nome). I nomi si leggono da "soci" (non
// da bookingDettagli, che per il tennis salva il nome solo del prenotante
// principale, non di un eventuale secondo giocatore dipendente).
// Calcolo condiviso tra reportAzienda (sola lettura, per lo staff/il
// referente) e addebitaAzienda (fonte di verità per l'importo caricato —
// mai un numero arrivato dal client). Stessa identificazione per socioId
// di consumoMensileAzienda, solo su un intervallo di date libero invece
// che sul mese corrente.
async function consumoPeriodoAzienda(aziendaId, dal, al) {
  const bookingsSnap = await db.collection("bookings")
    .where("date", ">=", dal)
    .where("date", "<=", al)
    .get();
  const idsConfermati = bookingsSnap.docs
    .filter(d => ["CONFIRMED", "COMPLETED"].includes(d.data().status))
    .map(d => d.id);
  const dettagliSnaps = await Promise.all(idsConfermati.map(id => db.collection("bookingDettagli").doc(id).get()));

  const perSocio = {}; // socioId -> {totale, prenotazioni}
  let totale = 0;
  dettagliSnaps.forEach(snap => {
    if (!snap.exists) return;
    (snap.data().prezzoDettaglio || []).forEach(voce => {
      if (voce.categoria !== aziendaId || !voce.socioId) return;
      totale += voce.importo || 0;
      if (!perSocio[voce.socioId]) perSocio[voce.socioId] = { totale: 0, prenotazioni: 0 };
      perSocio[voce.socioId].totale += voce.importo || 0;
      perSocio[voce.socioId].prenotazioni += 1;
    });
  });

  return { totale, perSocio };
}

exports.reportAzienda = onCall(async (request) => {
  const aziendaId = await verificaReferenteAzienda(request.auth);
  const { dal, al } = request.data || {};
  if (!dal || !al) throw new HttpsError("invalid-argument", "Intervallo di date mancante.");

  const { totale, perSocio } = await consumoPeriodoAzienda(aziendaId, dal, al);

  const socioIds = Object.keys(perSocio);
  const sociSnaps = await Promise.all(socioIds.map(id => db.collection("soci").doc(id).get()));
  const righe = socioIds.map((id, i) => {
    const s = sociSnaps[i].exists ? sociSnaps[i].data() : null;
    return {
      nome: s ? `${s.nome} ${s.cognome}` : "(dipendente rimosso)",
      totale: perSocio[id].totale,
      prenotazioni: perSocio[id].prenotazioni
    };
  }).sort((a, b) => b.totale - a.totale);

  return { totale, righe };
});

// Salvataggio carta aziendale, stesso schema di avviaTokenizzazioneCorso
// ma per un'azienda invece di un'iscrizione, e con chi chiama già
// autenticato (referente della propria azienda) invece che anonimo:
// niente pagina di ritorno pubblica dedicata né collection ponte, il
// ritorno è azienda.html stessa (query string), che rilegge lo stato da
// listaSociAzienda con la stessa sessione già autorizzata.
exports.avviaTokenizzazioneAzienda = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const aziendaId = await verificaReferenteAzienda(request.auth);
    const aziendaSnap = await db.collection("aziende").doc(aziendaId).get();
    if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");
    const azienda = aziendaSnap.data();

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const tService = tokensService();

    try {
      const token = await tService.postPaymentTokens({
        space: spaceId,
        tokenCreate: {
          externalId: aziendaId,
          customerEmailAddress: azienda.referenteEmail || undefined,
          enabledForOneClickPayment: true
        }
      });

      const transaction = await tService.postPaymentTokensIdCreateTransactionForTokenUpdate({
        id: token.id,
        space: spaceId
      });

      // "version" obbligatorio per il patch (controllo di concorrenza
      // ottimistica di PostFinance) — vedi avviaTokenizzazioneCorso.
      await transactionsService().patchPaymentTransactionsId({
        id: transaction.id,
        space: spaceId,
        transactionPending: {
          version: transaction.version,
          successUrl: `${APP_URL}azienda.html?tokenizzazione=esito`,
          failedUrl: `${APP_URL}azienda.html?tokenizzazione=esito`,
          metaData: { tipoTransazione: "tokenizzazione_azienda", aziendaId }
        }
      });

      const paymentPageUrl = await transactionsService().getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      await aziendaSnap.ref.update({ tokenId: token.id, tokenStato: "PENDING" });

      return { paymentPageUrl };
    } catch (err) {
      console.error("avviaTokenizzazioneAzienda: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nel salvataggio della carta. Riprova.");
    }
  }
);

exports.eliminaTokenAzienda = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const aziendaId = await verificaReferenteAzienda(request.auth);
    const aziendaRef = db.collection("aziende").doc(aziendaId);
    const aziendaSnap = await aziendaRef.get();
    if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");
    const azienda = aziendaSnap.data();

    if (azienda.tokenStato !== "ATTIVO") return { eliminato: false };

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    try {
      await tokensService().deletePaymentTokensId({ id: azienda.tokenId, space: spaceId });
    } catch (err) {
      console.error("eliminaTokenAzienda: errore PostFinance:", err);
    }
    await aziendaRef.update({ tokenStato: "ELIMINATO" });
    return { eliminato: true };
  }
);

// Addebito di quanto dovuto per un periodo, innescato sempre dal
// referente (mai schedulato) dopo aver generato il report — mai un
// addebito automatico. L'importo si ricalcola qui con la stessa logica
// di reportAzienda, mai fidandosi di un numero passato dal client.
exports.addebitaAzienda = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const aziendaId = await verificaReferenteAzienda(request.auth);
    const { dal, al } = request.data || {};
    if (!dal || !al) throw new HttpsError("invalid-argument", "Intervallo di date mancante.");

    const aziendaRef = db.collection("aziende").doc(aziendaId);
    const aziendaSnap = await aziendaRef.get();
    if (!aziendaSnap.exists) throw new HttpsError("not-found", "Azienda non trovata.");
    const azienda = aziendaSnap.data();
    if (azienda.tokenStato !== "ATTIVO") {
      throw new HttpsError("failed-precondition", "Nessuna carta salvata per questa azienda.");
    }

    const { totale } = await consumoPeriodoAzienda(aziendaId, dal, al);
    if (totale <= 0) {
      return { addebitato: false, motivo: "Nessun importo da addebitare per questo periodo." };
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    const riferimento = `${aziendaId}-${dal}-${al}`;
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: riferimento,
          token: azienda.tokenId,
          lineItems: [{
            uniqueId: riferimento,
            name: `${azienda.nome} — utilizzo campi ${dal} → ${al}`,
            quantity: 1,
            amountIncludingTax: totale,
            type: LineItemType.Product
          }],
          metaData: { tipoTransazione: "addebito_azienda", aziendaId, dal, al, importo: String(totale) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      await service.postPaymentTransactionsIdProcessWithToken({ id: transaction.id, space: spaceId });
      await aziendaRef.update({ ultimoAddebito: { dal, al, importo: totale, stato: "IN_CORSO", data: FieldValue.serverTimestamp() } });
      return { addebitato: true, importo: totale };
    } catch (err) {
      console.error("addebitaAzienda: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nell'addebito. Riprova.");
    }
  }
);

// Ricerca del secondo giocatore/compagni (tennis/padel), pubblica come
// cercaSociStaff (pannello operatore) ma più prudente nell'esposizione dato
// che qui non serve login: soglia più alta (3 caratteri), pochi risultati
// (8), e niente categoria nell'elenco — solo nome, per limitare quanto un
// visitatore non riconosciuto può "sfogliare" cercando lettere comuni. La
// categoria del giocatore selezionato si riverifica comunque sempre lato
// server al momento della prenotazione (mai fidarsi del client).
exports.cercaGiocatore = onCall(async (request) => {
  const testo = (request.data?.nome || "").trim().toLowerCase();
  if (testo.length < 3) return { risultati: [] };

  const snap = await db.collection("soci").where("attivo", "==", true).limit(500).get();
  const risultati = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => `${s.nome} ${s.cognome}`.toLowerCase().includes(testo))
    .slice(0, 8)
    .map(s => ({ socioId: s.id, nome: s.nome, cognome: s.cognome }));
  return { risultati };
});

// Vista "Chi c'è in campo": nomi (o pseudonimo, se impostato) visibili
// solo a un dispositivo già riconosciuto (request.auth != null) — un
// visitatore non riconosciuto continua a vedere solo "Occupato" come sul
// tabellone pubblico. Legge "bookingDettagli" (mai pubblico) via Admin
// SDK, mai la collection "soci".
exports.dettagliGiocatori = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Dispositivo non riconosciuto.");
  const { bookingIds } = request.data || {};
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return { dettagli: {} };

  const dettagli = {};
  await Promise.all(bookingIds.slice(0, 50).map(async (id) => {
    const snap = await db.collection("bookingDettagli").doc(id).get();
    if (!snap.exists) return;
    const d = snap.data();
    // Forme diverse a seconda della disciplina: tennis ha un solo secondo
    // giocatore (giocatore2Nome), il padel fino a 3 (altriGiocatori) —
    // qui si uniformano in un solo elenco "altri".
    const altri = d.altriGiocatori && d.altriGiocatori.length > 0
      ? d.altriGiocatori
      : (d.giocatore2Nome ? [d.giocatore2Nome] : []);
    dettagli[id] = { nome1: d.prenotanteNome || null, altri };
  }));
  return { dettagli };
});

// Giorno della settimana come codice "lun".."dom" (stesso vocabolario di
// GIORNI_SETTIMANA/GIORNO_JS_DAY già usato per i corsi, js/utils.js) — qui
// serve la direzione inversa (da Date a codice), non condivisibile col
// client (runtime separati), duplicata per lo stesso motivo di sempre.
const GIORNO_JS_DAY_INV = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
// Un giorno festivo (elenco in impostazioni/generale.festivi, caricato dal
// chiamante) conta come domenica ai fini della tariffa, a prescindere dal
// giorno reale della settimana in cui cade.
function giornoSettimanaCodice(dataIso, festivi) {
  if ((festivi || []).includes(dataIso)) return "dom";
  return GIORNO_JS_DAY_INV[new Date(dataIso + "T00:00:00").getDay()];
}

// Calcola la quota di una categoria per un campo/data/orario/durata: prima
// il forfait stagionale (0 se dentro il periodo e categoria inclusa), poi
// la tariffa a fascia — l'amministratore definisce liberamente in
// Configurazione quante fasce vuole (dalle-alle-prezzo), ciascuna
// applicabile a giorni della settimana specifici o a tutti, e
// facoltativamente a una durata specifica (necessario per il padel, che a
// differenza di tennis/squash ha durata scelta dal cliente). Se più fasce
// si sovrappongono per errore di configurazione, vince quella più
// specifica (durata fissata, poi banda oraria più stretta, poi meno
// giorni selezionati).
async function quotaCategoria({ disciplina, posizione, categoria, dataIso, startTime, durataMinuti, festivi }) {
  // Firestore rifiuta "undefined" come valore di query — e un campo
  // "posizione" può arrivare undefined da un documento "campi" che non
  // l'ha mai avuta (es. squash), diverso dal null esplicito salvato nelle
  // tariffe. Normalizzato qui una volta per tutte, così ogni chiamante
  // può passare undefined o null indifferentemente.
  posizione = posizione ?? null;
  const forfaitSnap = await db.collection("forfaitCampi")
    .where("disciplina", "==", disciplina)
    .where("posizione", "==", posizione)
    .get();
  const forfaitAttivo = forfaitSnap.docs.some(d => {
    const f = d.data();
    return dataIso >= f.periodoInizio && dataIso <= f.periodoFine && (f.categorie || []).includes(categoria);
  });
  if (forfaitAttivo) return 0;

  const giorno = giornoSettimanaCodice(dataIso, festivi);
  const startMin = orarioToMin(startTime);
  const tariffeSnap = await db.collection("tariffeCampi")
    .where("disciplina", "==", disciplina)
    .where("posizione", "==", posizione)
    .where("categoria", "==", categoria)
    .get();
  const candidates = tariffeSnap.docs.map(d => d.data())
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
  return candidates.length > 0 ? candidates[0].prezzo : null;
}

// Chi prenota: un maestro/responsabile loggato (ha un documento "users",
// controllo con priorità perché lo staff non ha mai un profilo in "soci")
// paga come "maestro" ed è esente se soggettoQuotaCampo (come lo
// STAFF_EXEMPT del padel); un dispositivo riconosciuto legge il profilo
// scelto da sociDevices (profiloId, per il caso famiglia); altrimenti
// esterno anonimo.
async function risolviCategoriaPrenotante(auth, profiloId) {
  if (!auth) return { categoria: "esterno", nome: null, authUid: null, isStaff: false };

  const userSnap = await db.collection("users").doc(auth.uid).get();
  if (userSnap.exists) {
    const u = userSnap.data();
    return {
      categoria: "maestro", nome: u.nome || null, authUid: auth.uid,
      isStaff: true, soggettoQuotaCampo: !!u.soggettoQuotaCampo
    };
  }

  const deviceSnap = await db.collection("sociDevices").doc(auth.uid).get();
  if (deviceSnap.exists) {
    const profili = deviceSnap.data().profili || [];
    const scelto = profiloId ? profili.find(p => p.socioId === profiloId) : profili[0];
    if (scelto) return { categoria: scelto.categoria, nome: scelto.nome, authUid: auth.uid, isStaff: false, socioId: scelto.socioId };
  }

  return { categoria: "esterno", nome: null, authUid: auth.uid, isStaff: false };
}

// Prenotazione tennis/squash: invocabile da chiunque (esterno anonimo),
// da un dispositivo riconosciuto (tariffa/priorità/limite di categoria) o
// da un maestro loggato. Non modifica creaPrenotazionePubblica (padel),
// che resta la funzione dedicata a quel flusso già in produzione.
exports.creaPrenotazioneCampo = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const { courtId, date, startTime, giocatore2Nome, giocatore2SocioId, profiloId } = request.data || {};
    if (!courtId || !date || !startTime) {
      throw new HttpsError("invalid-argument", "Dati prenotazione incompleti.");
    }

    const campoSnap = await db.collection("campi").doc(courtId).get();
    if (!campoSnap.exists || campoSnap.data().attivo === false) {
      throw new HttpsError("not-found", "Campo non disponibile.");
    }
    const { disciplina, numero } = campoSnap.data();
    // I campi squash non hanno mai avuto un campo "posizione" in Firestore
    // (assente, non semplicemente vuoto) — letto così darebbe `undefined`,
    // diverso da `null` per una query Firestore (che anzi rifiuta undefined
    // come valore) e diverso dal `null` esplicito salvato nelle tariffe.
    // Normalizzato a null qui, unica fonte di verità per il resto della
    // funzione.
    const posizione = campoSnap.data().posizione ?? null;
    const campoLabel = `Campo ${numero}${posizione ? ` (${posizione})` : ""}`;
    if (disciplina !== "tennis" && disciplina !== "squash") {
      throw new HttpsError("invalid-argument", "Disciplina non gestita da questa funzione.");
    }

    const slot = slotFissiDisciplina(disciplina).find(s => s.inizio === startTime);
    if (!slot) throw new HttpsError("invalid-argument", "Orario non valido per questa disciplina.");
    const endTime = slot.fine;

    const chiusuraSnap = await db.collection("chiusureCentro").doc(date).get();
    if (chiusuraSnap.exists) {
      const discipline = chiusuraSnap.data().discipline || [];
      if (discipline.length === 0 || discipline.includes(disciplina)) {
        throw new HttpsError("failed-precondition", "Il centro è chiuso in questa data.");
      }
    }

    if (eOrmaiPassato(date, orarioToMin(startTime))) {
      throw new HttpsError("failed-precondition", "Questo slot non è più disponibile — scegline un altro.");
    }

    const prenotante = await risolviCategoriaPrenotante(request.auth, profiloId);

    // Finestra di anticipo: quanti giorni prima ciascuna categoria può
    // prenotare — priorità ai soci, come richiesto. 7 giorni se non
    // configurato.
    const impostazioniSnap = await db.collection("impostazioni").doc("prenotazioniCampi").get();
    const impostazioni = impostazioniSnap.exists ? impostazioniSnap.data() : {};
    const anticipoMax = (impostazioni.giorniAnticipoPrenotazione || {})[prenotante.categoria] ?? 7;
    const oggiIso = oraLocaleZurigo().dataIso;
    const giorniAvanti = Math.round((new Date(date) - new Date(oggiIso)) / 86400000);
    if (giorniAvanti > anticipoMax) {
      throw new HttpsError("failed-precondition", "Questa data non è ancora aperta alle prenotazioni per la tua categoria.");
    }

    // Limite prenotazioni attive: solo per chi è riconosciuto (un esterno
    // anonimo non ha un'identità stabile su cui contarlo).
    if (prenotante.authUid && !prenotante.isStaff && impostazioni.maxPrenotazioniAttivePerUtente != null) {
      const attiveSnap = await db.collection("bookings")
        .where("authUid", "==", prenotante.authUid)
        .where("date", ">=", oggiIso)
        .get();
      const attive = attiveSnap.docs.filter(d => {
        const b = d.data();
        return !pendingScaduto(b) && (b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED");
      });
      if (attive.length >= impostazioni.maxPrenotazioniAttivePerUtente) {
        throw new HttpsError("failed-precondition", "Hai raggiunto il numero massimo di prenotazioni attive.");
      }
    }

    // Pulizia best-effort delle "PENDING_PAYMENT" scadute.
    const preSnap = await db.collection("bookings").where("date", "==", date).where("courtId", "==", courtId).get();
    const scadute = preSnap.docs.filter(d => pendingScaduto(d.data()));
    if (scadute.length > 0) await Promise.all(scadute.map(d => d.ref.delete()));

    // Prezzo: sempre ricalcolato lato server. Per il tennis si gioca in
    // due — mai fidarsi del nome libero del secondo giocatore, si
    // riverifica sempre giocatore2SocioId contro "soci" (se non risolto,
    // resta "esterno").
    let giocatore2Categoria = "esterno";
    let giocatore2NomeRisolto = giocatore2Nome || null;
    let giocatore2SocioIdVerificato = null;
    if (disciplina === "tennis" && giocatore2SocioId) {
      const g2Snap = await db.collection("soci").doc(giocatore2SocioId).get();
      if (g2Snap.exists && g2Snap.data().attivo !== false) {
        giocatore2Categoria = g2Snap.data().categoria;
        giocatore2NomeRisolto = `${g2Snap.data().nome} ${g2Snap.data().cognome}`;
        giocatore2SocioIdVerificato = giocatore2SocioId;
      }
    }

    const generaleSnap = await db.collection("impostazioni").doc("generale").get();
    const festivi = generaleSnap.exists ? (generaleSnap.data().festivi || []) : [];
    // Durata reale dello slot (fissa per disciplina, nota da slotFissiDisciplina
    // qui sopra): va sempre passata a quotaCategoria, anche se molte righe
    // tariffa non specificano una durata (in tal caso il match è comunque
    // libero) — altrimenti le righe che la specificano (es. 60' per il
    // tennis) non troverebbero mai corrispondenza.
    const durataMinuti = orarioToMin(endTime) - orarioToMin(startTime);

    let quota1 = await quotaCategoria({ disciplina, posizione, categoria: prenotante.categoria, dataIso: date, startTime, durataMinuti, festivi });
    if (quota1 == null) throw new HttpsError("failed-precondition", "Tariffa non configurata per questo campo/categoria.");
    let categoria1 = prenotante.categoria;
    ({ categoria: categoria1, prezzo: quota1 } = await applicaTettoAzienda({
      categoria: categoria1, socioId: prenotante.socioId || null, prezzo: quota1,
      disciplina, posizione, dataIso: date, startTime, durataMinuti, festivi
    }));
    let prezzo = quota1;
    const prezzoDettaglio = [{ ruolo: "prenotante", categoria: categoria1, importo: quota1, socioId: prenotante.socioId || null }];

    if (disciplina === "tennis") {
      let quota2 = await quotaCategoria({ disciplina, posizione, categoria: giocatore2Categoria, dataIso: date, startTime, durataMinuti, festivi });
      if (quota2 == null) throw new HttpsError("failed-precondition", "Tariffa non configurata per il secondo giocatore.");
      let categoria2 = giocatore2Categoria;
      ({ categoria: categoria2, prezzo: quota2 } = await applicaTettoAzienda({
        categoria: categoria2, socioId: giocatore2SocioIdVerificato, prezzo: quota2,
        disciplina, posizione, dataIso: date, startTime, durataMinuti, festivi
      }));
      prezzo += quota2;
      prezzoDettaglio.push({ ruolo: "secondo giocatore", categoria: categoria2, importo: quota2, socioId: giocatore2SocioIdVerificato });
    }

    // Un maestro soggetto a quota campo (come per il padel STAFF_EXEMPT)
    // non paga qui la propria quota: è già fatturata nella lezione via
    // richiediPagamentoDiario, non due volte.
    if (prenotante.isStaff && prenotante.soggettoQuotaCampo) {
      prezzo -= quota1;
      prezzoDettaglio[0].importo = 0;
    }

    const token = generaToken();
    const bookingRef = db.collection("bookings").doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection("bookings").where("date", "==", date).where("courtId", "==", courtId));
      const occupato = snap.docs
        .filter(d => !pendingScaduto(d.data()))
        .map(d => d.data())
        .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
        .some(b => sovrapposto(startTime, endTime, b.startTime, b.endTime));
      if (occupato) throw new HttpsError("failed-precondition", "Questo slot non è più disponibile — scegline un altro.");

      // "bookings" è leggibile da chiunque (allow get,list: if true — serve
      // al calcolo pubblico degli slot liberi): niente nomi qui, mai, o
      // sarebbero interrogabili da chiunque via SDK client, bypassando
      // completamente il controllo "solo dispositivi riconosciuti" di
      // dettagliGiocatori. Nome/dettaglio prezzo vanno in "bookingDettagli",
      // collection separata e non pubblica (vedi firestore.rules).
      tx.set(bookingRef, {
        courtId, date, startTime, endTime, status: "PENDING_PAYMENT", type: "CUSTOMER",
        authUid: prenotante.authUid || null,
        createdAt: FieldValue.serverTimestamp()
      });
      tx.set(db.collection("bookingDettagli").doc(bookingRef.id), {
        prenotanteNome: prenotante.nome || null,
        giocatore2Nome: disciplina === "tennis" ? giocatore2NomeRisolto : null,
        giocatore2SocioId: disciplina === "tennis" && giocatore2Categoria !== "esterno" ? giocatore2SocioId : null,
        prezzoDettaglio
      });
    });

    if (prezzo <= 0) {
      await confermaPrenotazionePubblica({
        bookingId: bookingRef.id, courtId, date, startTime, endTime, prezzo: 0, token,
        paymentId: null, creditCode: null, creditoScalato: 0, disciplina, campoLabel
      });
      return { pagamentoNecessario: false, token };
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: bookingRef.id,
          successUrl: `${APP_URL}biglietto.html?t=${token}`,
          failedUrl: `${APP_URL}prenota-campo.html?pagamento=fallito`,
          lineItems: [{
            uniqueId: bookingRef.id,
            name: `Campo ${disciplina} ${date} ${startTime}–${endTime}`,
            quantity: 1,
            amountIncludingTax: prezzo,
            type: LineItemType.Product
          }],
          metaData: { bookingId: bookingRef.id, token, prezzoTotale: String(prezzo) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });
      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({ id: transaction.id, space: spaceId });
      return { pagamentoNecessario: true, token, paymentPageUrl };
    } catch (err) {
      await bookingRef.delete();
      console.error("creaPrenotazioneCampo: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// ---------- Rinnovo tesseramento/forfait (pagamento online) ----------
exports.richiediRinnovoAbbonamento = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
    const { socioId, importo, descrizione } = request.data || {};
    if (!socioId || typeof importo !== "number" || !isFinite(importo) || importo <= 0) {
      throw new HttpsError("invalid-argument", "Dati di rinnovo incompleti.");
    }
    const socioSnap = await db.collection("soci").doc(socioId).get();
    if (!socioSnap.exists || socioSnap.data().authUid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Puoi rinnovare solo il tuo abbonamento.");
    }

    const token = generaToken();
    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: token,
          successUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
          failedUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
          lineItems: [{
            uniqueId: token,
            name: descrizione || "Rinnovo tesseramento",
            quantity: 1,
            amountIncludingTax: importo,
            type: LineItemType.Product
          }],
          metaData: { tipoTransazione: "rinnovo_socio", token, socioId, importo: String(importo) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });
      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({ id: transaction.id, space: spaceId });

      await db.collection("paymentRequests").doc(token).set({
        tipo: "rinnovo_socio", riferimentoId: socioId, importo,
        descrizione: descrizione || "Rinnovo tesseramento",
        stato: "PENDING", createdByUid: request.auth.uid, createdByNome: null,
        createdAt: FieldValue.serverTimestamp()
      });

      return { token, paymentPageUrl };
    } catch (err) {
      console.error("richiediRinnovoAbbonamento: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// ---------- Tokenizzazione carta per corsi a soglia minima ----------
//
// Meccanismo generico "salva carta ora, addebita più avanti" — pensato
// per essere riusabile anche da altri casi futuri di addebito differito,
// non solo dai corsi. Due passaggi separati nell'SDK PostFinance:
// - un Token (nessun importo) verificato tramite una transazione dedicata
//   che il cliente completa sulla pagina di checkout ospitata, come le
//   transazioni normali;
// - quando si conosce l'importo, una transazione normale che referenzia
//   il token invece dei dati carta, finalizzata senza che il cliente sia
//   presente (postPaymentTransactionsIdProcessWithToken).
// Come sempre in questo file: l'esito autorevole arriva dal webhook, mai
// dalla sola risposta sincrona di una chiamata PostFinance.

exports.avviaTokenizzazioneCorso = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    const { iscrizioneId } = request.data || {};
    if (!iscrizioneId) throw new HttpsError("invalid-argument", "iscrizioneId mancante.");

    const iscrizioneRef = db.collection("iscrizioniCorsi").doc(iscrizioneId);
    const iscrizioneSnap = await iscrizioneRef.get();
    if (!iscrizioneSnap.exists) throw new HttpsError("not-found", "Iscrizione non trovata.");
    const iscrizione = iscrizioneSnap.data();
    if (iscrizione.stato !== "in_attesa") {
      throw new HttpsError("failed-precondition", "Questa iscrizione non è più in attesa.");
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const tService = tokensService();
    const verificaToken = generaToken();

    try {
      const token = await tService.postPaymentTokens({
        space: spaceId,
        tokenCreate: {
          externalId: iscrizioneId,
          customerEmailAddress: iscrizione.email,
          enabledForOneClickPayment: true
        }
      });

      const transaction = await tService.postPaymentTokensIdCreateTransactionForTokenUpdate({
        id: token.id,
        space: spaceId
      });

      // La transazione di verifica non nasce con successUrl/failedUrl
      // configurabili in un colpo solo (a differenza di una TransactionCreate
      // normale): vanno impostate con un patch sulla transazione pending
      // appena creata, prima di generarne la pagina di pagamento. Stessa
      // occasione per mettere il metaData (non impostabile alla creazione,
      // che qui non passa da una TransactionCreate) — è quello che il
      // webhook userà per riconoscere questo tipo di transazione.
      // "version" è obbligatorio (controllo di concorrenza ottimistica di
      // PostFinance: senza, il patch fallisce con "No version was provided")
      // — quello della transazione appena creata, già disponibile qui.
      await transactionsService().patchPaymentTransactionsId({
        id: transaction.id,
        space: spaceId,
        transactionPending: {
          version: transaction.version,
          successUrl: `${APP_URL}iscrizione-corso-carta.html?t=${verificaToken}`,
          failedUrl: `${APP_URL}iscrizione-corso-carta.html?t=${verificaToken}`,
          metaData: { tipoTransazione: "tokenizzazione_corso", iscrizioneId, verificaToken }
        }
      });

      const paymentPageUrl = await transactionsService().getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      await iscrizioneRef.update({
        tokenId: token.id,
        tokenStato: "PENDING",
        tokenVerificaToken: verificaToken
      });
      // Documento pubblico separato (vedi firestore.rules): la pagina di
      // ritorno senza login legge questo, mai "iscrizioniCorsi" (dati
      // sensibili, mai leggibile dal pubblico).
      await db.collection("tokenizzazioniCorsi").doc(verificaToken).set({
        iscrizioneId, stato: "PENDING", createdAt: FieldValue.serverTimestamp()
      });

      return { paymentPageUrl };
    } catch (err) {
      console.error("avviaTokenizzazioneCorso: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nel salvataggio della carta. Riprova.");
    }
  }
);

// Addebita l'iscritto sulla carta salvata quando lo staff conferma la sua
// iscrizione (segno che il corso ha raggiunto la soglia minima). Se non
// c'è un token attivo non fa nulla: l'iscritto resta "da pagare", da
// gestire come oggi (manualmente, fuori da questo meccanismo).
exports.addebitaIscrizioneCorso = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
    const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
    if (!isAdmin && !permessi.includes("iscrizioni:gestisci")) {
      throw new HttpsError("permission-denied", "Permesso mancante.");
    }

    const { iscrizioneId } = request.data || {};
    if (!iscrizioneId) throw new HttpsError("invalid-argument", "iscrizioneId mancante.");

    const iscrizioneRef = db.collection("iscrizioniCorsi").doc(iscrizioneId);
    const iscrizioneSnap = await iscrizioneRef.get();
    if (!iscrizioneSnap.exists) throw new HttpsError("not-found", "Iscrizione non trovata.");
    const iscrizione = iscrizioneSnap.data();

    if (iscrizione.tokenStato !== "ATTIVO") {
      return { addebitato: false, motivo: "Nessuna carta salvata per questa iscrizione." };
    }

    const corsoSnap = await db.collection("corsi").doc(iscrizione.corsoId).get();
    const corso = corsoSnap.exists ? corsoSnap.data() : {};
    const importo = corso.prezzoRichiesto;
    if (!importo || importo <= 0) {
      return { addebitato: false, motivo: "Prezzo del corso non configurato." };
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();
    try {
      const transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: iscrizioneId,
          token: iscrizione.tokenId,
          lineItems: [{
            uniqueId: iscrizioneId,
            name: `Corso ${iscrizione.corsoNome || ""}`,
            quantity: 1,
            amountIncludingTax: importo,
            type: LineItemType.Product
          }],
          metaData: { tipoTransazione: "pagamento_corso", iscrizioneId, viaToken: "true", importo: String(importo) },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      await service.postPaymentTransactionsIdProcessWithToken({ id: transaction.id, space: spaceId });
      await iscrizioneRef.update({ pagamentoStato: "IN_CORSO", pagamentoImporto: importo });
      return { addebitato: true };
    } catch (err) {
      console.error("addebitaIscrizioneCorso: errore PostFinance:", err);
      // Non blocca la conferma già avvenuta: l'iscrizione resta "da
      // pagare", gestibile manualmente o con un nuovo tentativo.
      return { addebitato: false, motivo: "Errore nell'addebito. Riprova o invia un link di pagamento." };
    }
  }
);

// Genera una transazione Checkout normale (redirect, come richiediPagamentoDiario)
// per l'importo indicato — usata sia come fallback automatico dal webhook
// (addebito su token fallito) sia riutilizzabile in futuro per un invio
// manuale. Ritorna il link, non lo invia: l'invio è responsabilità di chi
// chiama (qui, il webhook stesso via inviaEmail).
async function creaLinkPagamentoCorso({ iscrizioneId, corsoNome, importo, email }) {
  const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
  const service = transactionsService();
  const token = generaToken();

  const transaction = await service.postPaymentTransactions({
    space: spaceId,
    transactionCreate: {
      currency: "CHF",
      merchantReference: `${iscrizioneId}-link`,
      successUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
      failedUrl: `${APP_URL}pagamento-conferma.html?t=${token}`,
      customerEmailAddress: email || undefined,
      lineItems: [{
        uniqueId: iscrizioneId,
        name: `Corso ${corsoNome || ""}`,
        quantity: 1,
        amountIncludingTax: importo,
        type: LineItemType.Product
      }],
      metaData: { tipoTransazione: "pagamento_corso", iscrizioneId, importo: String(importo) },
      environmentSelectionStrategy: FORZA_AMBIENTE_TEST
        ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
        : TransactionEnvironmentSelectionStrategy.UseConfiguration
    }
  });
  const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({ id: transaction.id, space: spaceId });

  await db.collection("paymentRequests").doc(token).set({
    tipo: "corso", riferimentoId: iscrizioneId, importo,
    descrizione: `Corso ${corsoNome || ""}`,
    stato: "PENDING", createdByUid: null, createdByNome: null,
    createdAt: FieldValue.serverTimestamp()
  });

  return paymentPageUrl;
}

// Elimina esplicitamente il token salvato (non lo lascia semplicemente
// inutilizzato) quando un'iscrizione con carta salvata viene rifiutata —
// es. corso che non raggiunge la soglia minima e non parte.
exports.eliminaTokenIscrizione = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
    const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
    if (!isAdmin && !permessi.includes("iscrizioni:gestisci")) {
      throw new HttpsError("permission-denied", "Permesso mancante.");
    }

    const { iscrizioneId } = request.data || {};
    if (!iscrizioneId) throw new HttpsError("invalid-argument", "iscrizioneId mancante.");

    const iscrizioneRef = db.collection("iscrizioniCorsi").doc(iscrizioneId);
    const iscrizioneSnap = await iscrizioneRef.get();
    if (!iscrizioneSnap.exists) throw new HttpsError("not-found", "Iscrizione non trovata.");
    const iscrizione = iscrizioneSnap.data();

    if (iscrizione.tokenStato !== "ATTIVO") return { eliminato: false };

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    try {
      await tokensService().deletePaymentTokensId({ id: iscrizione.tokenId, space: spaceId });
    } catch (err) {
      console.error("eliminaTokenIscrizione: errore PostFinance:", err);
    }
    await iscrizioneRef.update({ tokenStato: "ELIMINATO" });
    return { eliminato: true };
  }
);

// ---------- Link di reset password (senza invio email di Firebase) ----------
//
// auth.sendPasswordResetEmail() del client SDK genera E spedisce l'email
// tramite l'infrastruttura di Firebase — spesso finita in spam o filtrata
// da alcuni provider (es. iCloud), senza modo di intervenire sul testo o
// sul mittente. generatePasswordResetLink() dell'Admin SDK genera invece
// SOLO il link, senza spedire nulla: il testo lo compone e lo invia chi
// gestisce gli utenti dal proprio client di posta reale (stesso pattern
// già usato per le credenziali di un nuovo collaboratore), migliorando la
// recapitabilità perché il mittente è una persona vera, non un dominio
// condiviso.
exports.generaLinkResetPassword = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  let permessi = [];
  if (userData.ruoloId) {
    const roleSnap = await db.collection("roles").doc(userData.ruoloId).get();
    if (roleSnap.exists) permessi = roleSnap.data().permessi || [];
  }
  const isAdmin = permessi.includes("*");
  if (!isAdmin && !permessi.includes("users:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante per gestire gli utenti.");
  }

  const { email } = request.data || {};
  if (!email) throw new HttpsError("invalid-argument", "Email mancante.");

  try {
    const link = await getAuth().generatePasswordResetLink(email, { url: `${APP_URL}index.html` });
    return { link };
  } catch (err) {
    throw new HttpsError("failed-precondition", "Impossibile generare il link: " + err.message);
  }
});

// Elimina davvero un utente (documento Firestore + account Auth) — serve
// l'Admin SDK perché il client non può cancellare l'account di un altro
// utente. Pensata soprattutto per ripulire utenze di test rotte (es.
// create fuori dal form standard, con campi mancanti) senza lasciare
// account Auth orfani che poi bloccano la ricreazione con la stessa email.
exports.eliminaUtente = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");
  if (request.auth.uid === request.data?.uid) {
    throw new HttpsError("failed-precondition", "Non puoi eliminare te stesso.");
  }

  const { permessi, isAdmin } = await permessiUtente(request.auth.uid);
  if (!isAdmin && !permessi.includes("users:gestisci")) {
    throw new HttpsError("permission-denied", "Permesso mancante per gestire gli utenti.");
  }

  const { uid } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid mancante.");

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) throw new HttpsError("not-found", "Utente non trovato.");

  // Nessun'azienda deve restare con un referente puntato a un utente che
  // non esiste più — stesso scollegamento fatto da collegaReferenteAzienda
  // quando si cambia referente.
  const aziendeSnap = await db.collection("aziende").where("referenteUid", "==", uid).get();
  await Promise.all(aziendeSnap.docs.map(d => d.ref.update({ referenteUid: null, referenteNome: null, referenteEmail: null })));

  await db.collection("users").doc(uid).delete();
  try {
    await getAuth().deleteUser(uid);
  } catch (err) {
    // L'account Auth potrebbe non esistere più (es. già ripulito a mano) —
    // il documento Firestore è comunque sparito, non è un fallimento reale.
    if (err.code !== "auth/user-not-found") throw err;
  }

  return { ok: true };
});
