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
// Due generazioni di flusso convivono qui:
// - creaPagamentoPrenotazione / collection "prenotazioniPadel": booking
//   interno da parte di utenti loggati (team), precedente all'apertura
//   pubblica. Lasciato per compatibilità, non più usato dalle pagine
//   nuove ma ancora valido se qualche transazione fosse in corso al
//   momento del passaggio.
// - creaPrenotazionePubblica / collection "bookings"+"bookingTickets"+
//   "bookingCodes"+"payments"+"credits"+"creditTransactions": booking
//   pubblico senza login, con biglietto/QR/codice e sistema di credito.
// ============================================================

const crypto = require("crypto");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  Configuration, HttpBearerAuth, TransactionsService, LineItemType, TransactionState,
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

// URL base dell'app su GitHub Pages, per i redirect di successo/fallimento.
const APP_URL = "https://lucamora1970.github.io/sportcenter-manager/sportcenter-manager/";

const BOUNDARY = 17 * 60; // 17:00 — stessa soglia diurno/serale di prenotazioni.js

function transactionsService() {
  const config = new Configuration();
  config.httpBearerAuth = new HttpBearerAuth(
    parseInt(POSTFINANCE_USER_ID.value(), 10),
    POSTFINANCE_APP_KEY.value()
  );
  return new TransactionsService(config);
}

// Stessa logica di js/prenotazioni.js (fasciaTariffa), duplicata qui
// perché il prezzo va SEMPRE ricalcolato lato server: fidarsi di un
// prezzo mandato dal client sarebbe falsificabile.
function fasciaTariffa(oraInizio, durataMinuti) {
  const [h, m] = oraInizio.split(":").map(Number);
  const inizioMin = h * 60 + m;
  return durataMinuti === 60 ? "diurno60" : (inizioMin < BOUNDARY ? "diurno90" : "serale90");
}

// ---------- Anti-buco (duplicato da js/prenotazioni.js) ----------
// Stesso motivo di fasciaTariffa: lo slot scelto va sempre riverificato
// lato server, mai fidarsi di quello arrivato dal client. Se l'algoritmo
// cambia in js/prenotazioni.js va aggiornato anche qui.
const OPEN = 8 * 60;
const CLOSE = 23 * 60;
const CLOSE_WEEKEND = 20 * 60 + 30;
const SLOT_FISSO_PRANZO = 12 * 60 + 15;
const SLOT_FISSO_SERALE = 17 * 60 + 30; // 17:30, solo lun-ven, solo 90'
const FESTIVI = [];

function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}

function chiusuraGiorno(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return (giorno === 0 || giorno === 6 || FESTIVI.includes(dataIso)) ? CLOSE_WEEKEND : CLOSE;
}

function feriale(dataIso) {
  const giorno = new Date(dataIso + "T00:00:00").getDay();
  return giorno >= 1 && giorno <= 5 && !FESTIVI.includes(dataIso);
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

// ---------- 1a. Flusso interno (team, dietro login) — invariato ----------

exports.creaPagamentoPrenotazione = onCall(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Devi essere loggato.");

    const { data, oraInizio, oraFine, durataMinuti } = request.data || {};
    if (!data || !oraInizio || !oraFine || !durataMinuti) {
      throw new HttpsError("invalid-argument", "Dati prenotazione incompleti.");
    }

    const userSnap = await db.collection("users").doc(request.auth.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const userNome = userData.nome || request.auth.token.email || "Socio";
    const esente = !!userData.soggettoQuotaCampo;

    const tariffeSnap = await db.collection("impostazioni").doc("tariffePadel").get();
    const tariffe = tariffeSnap.exists ? tariffeSnap.data() : {};
    const fascia = fasciaTariffa(oraInizio, durataMinuti);
    const prezzoTeorico = tariffe[fascia];
    if (prezzoTeorico == null) {
      throw new HttpsError("failed-precondition", "Tariffa non configurata per questo slot — vai in Configurazione.");
    }

    const prenotazioneRef = await db.collection("prenotazioniPadel").add({
      data, oraInizio, oraFine, durataMinuti,
      userId: request.auth.uid,
      userNome,
      bloccato: false,
      motivoBlocco: null,
      fasciaTariffa: fascia,
      prezzoTeorico,
      esente,
      prezzo: esente ? 0 : prezzoTeorico,
      pagamento: esente ? "esente" : "in_attesa",
      createdAt: FieldValue.serverTimestamp()
    });

    if (esente) {
      return { esente: true, prenotazioneId: prenotazioneRef.id };
    }

    const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
    const service = transactionsService();

    let transaction;
    try {
      transaction = await service.postPaymentTransactions({
        space: spaceId,
        transactionCreate: {
          currency: "CHF",
          merchantReference: prenotazioneRef.id,
          customerEmailAddress: request.auth.token.email || undefined,
          successUrl: `${APP_URL}prenotazioni.html?pagamento=ok`,
          failedUrl: `${APP_URL}prenotazioni.html?pagamento=fallito`,
          lineItems: [{
            uniqueId: prenotazioneRef.id,
            name: `Campo padel ${data} ${oraInizio}–${oraFine}`,
            quantity: 1,
            amountIncludingTax: prezzoTeorico,
            type: LineItemType.Product
          }],
          metaData: { prenotazioneId: prenotazioneRef.id },
          environmentSelectionStrategy: FORZA_AMBIENTE_TEST
            ? TransactionEnvironmentSelectionStrategy.ForceTestEnvironment
            : TransactionEnvironmentSelectionStrategy.UseConfiguration
        }
      });

      const paymentPageUrl = await service.getPaymentTransactionsIdPaymentPageUrl({
        id: transaction.id,
        space: spaceId
      });

      await prenotazioneRef.update({ transazioneId: transaction.id });

      return { esente: false, prenotazioneId: prenotazioneRef.id, paymentPageUrl };
    } catch (err) {
      // La transazione PostFinance non si è creata: libera subito lo
      // slot invece di lasciarlo occupato da una prenotazione orfana.
      await prenotazioneRef.delete();
      console.error("creaPagamentoPrenotazione: errore PostFinance:", err);
      throw new HttpsError("internal", "Errore nella creazione del pagamento. Riprova.");
    }
  }
);

// ---------- 1b. Flusso pubblico (senza login) ----------

// Un solo campo padel per ora — "unico campo" già mostrato nel
// pannello operatore. Il courtId è comunque un campo esplicito sui
// documenti per non dover rifare uno schema quando ne arriverà un
// secondo.
const COURT_ID = "1";

// Scrive tutto ciò che rende "reale" una prenotazione confermata:
// biglietto privato, indice codice→prenotazione, mirror del pagamento, e
// se c'è un credito coinvolto lo scala e lo registra. Chiamata sia dal
// caso "credito copre tutto" (creaPrenotazionePubblica, sincrono) sia dal
// webhook (dopo la conferma PostFinance).
async function confermaPrenotazionePubblica({ bookingId, courtId, date, startTime, endTime, prezzo, token, paymentId, creditCode, creditoScalato }) {
  const bookingCode = await generaCodicePrenotazioneUnivoco();

  const batch = db.batch();
  batch.update(db.collection("bookings").doc(bookingId), { status: "CONFIRMED" });
  batch.set(db.collection("bookingTickets").doc(token), {
    bookingId, bookingCode, courtId, date, startTime, endTime,
    price: prezzo, currency: "CHF", paymentId: paymentId || null,
    createdAt: FieldValue.serverTimestamp()
  });
  batch.set(db.collection("bookingCodes").doc(bookingCode), { bookingId, token });
  if (paymentId) {
    batch.set(db.collection("payments").doc(paymentId), {
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
    const { courtId, date, startTime, endTime, durationMinutes, creditCode } = request.data || {};
    if (!date || !startTime || !endTime || !durationMinutes) {
      throw new HttpsError("invalid-argument", "Dati prenotazione incompleti.");
    }
    const court = courtId || COURT_ID;
    const startMin = orarioToMin(startTime);
    const close = chiusuraGiorno(date);

    const existingSnap = await db.collection("bookings")
      .where("date", "==", date)
      .where("courtId", "==", court)
      .get();
    const existingBookings = existingSnap.docs
      .map(d => d.data())
      .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
      .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));

    if (eOrmaiPassato(date, startMin) || !validStarts(existingBookings, durationMinutes, close, feriale(date), eOggi(date)).includes(startMin)) {
      throw new HttpsError("failed-precondition", "Questo slot non è più disponibile — scegline un altro.");
    }

    const tariffeSnap = await db.collection("impostazioni").doc("tariffePadel").get();
    const tariffe = tariffeSnap.exists ? tariffeSnap.data() : {};
    const fascia = fasciaTariffa(startTime, durationMinutes);
    const prezzo = tariffe[fascia];
    if (prezzo == null) {
      throw new HttpsError("failed-precondition", "Tariffa non configurata per questo slot.");
    }

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

    const bookingRef = await db.collection("bookings").add({
      courtId: court, date, startTime, endTime,
      status: "PENDING_PAYMENT",
      type: "CUSTOMER",
      createdAt: FieldValue.serverTimestamp()
    });

    if (daPagare === 0) {
      await confermaPrenotazionePubblica({
        bookingId: bookingRef.id, courtId: court, date, startTime, endTime, prezzo, token,
        paymentId: null, creditCode: creditCode || null, creditoScalato: creditoDaScalare
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
// - "BLOCK": il responsabile blocca uno slot (manutenzione, evento),
//   richiede il permesso prenotazioni:gestisci.
// - "STAFF_EXEMPT": un maestro prenota per sé senza pagare, richiede
//   soggettoQuotaCampo sul proprio utente (stesso flag già usato per la
//   quota campo del diario).
// In entrambi i casi lo slot occupa comunque "bookings" come una
// prenotazione vera, per restare coerente con il tabellone pubblico e
// l'algoritmo anti-buco (che non deve conoscere la differenza).
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

  if (tipo === "BLOCK") {
    if (!isAdmin && !permessi.includes("prenotazioni:gestisci")) {
      throw new HttpsError("permission-denied", "Permesso mancante per bloccare uno slot.");
    }
    if (!motivo || !motivo.trim()) {
      throw new HttpsError("invalid-argument", "Indica un motivo per il blocco.");
    }
  } else if (!userData.soggettoQuotaCampo) {
    throw new HttpsError("permission-denied", "Questa prenotazione esente è riservata ai maestri.");
  }

  const court = courtId || COURT_ID;
  const startMin = orarioToMin(startTime);
  const close = chiusuraGiorno(date);

  const existingSnap = await db.collection("bookings")
    .where("date", "==", date)
    .where("courtId", "==", court)
    .get();
  const existingBookings = existingSnap.docs
    .map(d => d.data())
    .filter(b => b.status === "PENDING_PAYMENT" || b.status === "CONFIRMED" || b.status === "COMPLETED")
    .map(b => ({ start: orarioToMin(b.startTime), end: orarioToMin(b.endTime) }));

  if (eOrmaiPassato(date, startMin) || !validStarts(existingBookings, durationMinutes, close, feriale(date), eOggi(date)).includes(startMin)) {
    throw new HttpsError("failed-precondition", "Questo slot non è più disponibile.");
  }

  let prezzo = 0;
  if (tipo === "STAFF_EXEMPT") {
    const tariffeSnap = await db.collection("impostazioni").doc("tariffePadel").get();
    const tariffe = tariffeSnap.exists ? tariffeSnap.data() : {};
    prezzo = tariffe[fasciaTariffa(startTime, durationMinutes)] || 0;
  }

  const token = generaToken();
  const bookingRef = await db.collection("bookings").add({
    courtId: court, date, startTime, endTime,
    status: "PENDING_PAYMENT",
    type: tipo,
    createdAt: FieldValue.serverTimestamp()
  });

  const bookingCode = await confermaPrenotazionePubblica({
    bookingId: bookingRef.id, courtId: court, date, startTime, endTime, prezzo, token,
    paymentId: null, creditCode: null, creditoScalato: 0
  });

  if (tipo === "BLOCK") {
    await db.collection("blockDetails").doc(bookingRef.id).set({
      motivo: motivo.trim(),
      createdByUid: request.auth.uid,
      createdByNome: userData.nome || "—",
      createdAt: FieldValue.serverTimestamp()
    });
  }

  return { bookingId: bookingRef.id, token, bookingCode };
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
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
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

      if (meta.bookingId && meta.token) {
        // Flusso pubblico.
        if (successo) {
          const bookingSnap = await db.collection("bookings").doc(meta.bookingId).get();
          if (bookingSnap.exists && bookingSnap.data().status === "PENDING_PAYMENT") {
            await confermaPrenotazionePubblica({
              bookingId: meta.bookingId,
              courtId: bookingSnap.data().courtId,
              date: bookingSnap.data().date,
              startTime: bookingSnap.data().startTime,
              endTime: bookingSnap.data().endTime,
              prezzo: parseFloat(meta.prezzoTotale || "0"),
              token: meta.token,
              paymentId: transaction.id,
              creditCode: meta.creditCode || null,
              creditoScalato: parseFloat(meta.creditoScalato || "0")
            });
          }
        } else {
          await db.collection("bookings").doc(meta.bookingId).delete();
        }
      } else if (meta.prenotazioneId) {
        // Flusso interno (team, dietro login) — invariato.
        const ref = db.collection("prenotazioniPadel").doc(meta.prenotazioneId);
        if (successo) {
          await ref.update({ pagamento: "pagato" });
        } else {
          await ref.delete();
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
