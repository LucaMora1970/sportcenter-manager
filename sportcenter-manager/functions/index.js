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
// ============================================================

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

// ---------- 1. Crea la prenotazione + la transazione di pagamento ----------
//
// Chiamata dal client (utente loggato) al posto della scrittura diretta
// su Firestore usata finora. Occupa subito lo slot con
// pagamento:"in_attesa" (evita doppie prenotazioni mentre l'utente è
// sulla pagina di pagamento) e restituisce l'URL della pagina di
// pagamento PostFinance a cui reindirizzare. Se l'utente è esente
// (maestro), conferma subito senza creare nessuna transazione.
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

// ---------- 2. Webhook: conferma reale del pagamento ----------
//
// Da configurare nel Portale PostFinance Checkout: Spazio → Webhook →
// Nuovo ascoltatore webhook → entità "Transaction" → URL di questa
// funzione (visibile dopo il primo deploy). Il corpo della notifica
// contiene solo l'id della transazione (campo "entityId") — non ci si
// fida mai del payload in sé, si rilegge sempre lo stato reale via API.
exports.webhookPostFinance = onRequest(
  { secrets: [POSTFINANCE_SPACE_ID, POSTFINANCE_USER_ID, POSTFINANCE_APP_KEY] },
  async (req, res) => {
    try {
      const transactionId = req.body?.entityId;
      if (!transactionId) { res.status(400).send("missing entityId"); return; }

      const spaceId = parseInt(POSTFINANCE_SPACE_ID.value(), 10);
      const service = transactionsService();
      const transaction = await service.getPaymentTransactionsId({ id: transactionId, space: spaceId });

      const prenotazioneId = transaction.metaData?.prenotazioneId || transaction.merchantReference;
      if (!prenotazioneId) { res.status(200).send("ok (nessun riferimento prenotazione)"); return; }

      const ref = db.collection("prenotazioniPadel").doc(prenotazioneId);

      if (transaction.state === TransactionState.Fulfill || transaction.state === TransactionState.Completed) {
        await ref.update({ pagamento: "pagato" });
      } else if (
        transaction.state === TransactionState.Failed
        || transaction.state === TransactionState.Decline
        || transaction.state === TransactionState.Voided
      ) {
        // Pagamento non riuscito: libera lo slot invece di lasciarlo
        // occupato da una prenotazione mai pagata.
        await ref.delete();
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("webhookPostFinance error:", err);
      res.status(500).send("error");
    }
  }
);
