// ============================================================
// pagamento-conferma.js — pagina pubblica di conferma pagamento (senza
// login), raggiunta come successUrl/failedUrl da richiediPagamentoDiario.
// Legge paymentRequests/{token}: conoscere il token è di per sé
// l'autorizzazione a leggerlo (vedi firestore.rules, "allow get: if
// true" — stesso pattern di bookingTickets/voucherTickets).
//
// Il webhook aggiorna lo stato in modo indipendente dal redirect del
// browser: per questo qui si prova a leggere con qualche tentativo/
// attesa invece di arrendersi al primo stato ancora "PENDING".
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

const TENTATIVI_MAX = 6;
const ATTESA_TRA_TENTATIVI_MS = 2500;

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function caricaEsitoPagamento(token) {
  for (let tentativo = 0; tentativo < TENTATIVI_MAX; tentativo++) {
    try {
      const doc = await db.collection("paymentRequests").doc(token).get();
      if (doc.exists) {
        const data = doc.data();
        if (data.stato === "PAID" || data.stato === "FAILED") return data;
      }
    } catch (err) {
      console.warn("caricaEsitoPagamento: tentativo fallito:", err.message);
    }
    if (tentativo < TENTATIVI_MAX - 1) await attendi(ATTESA_TRA_TENTATIVI_MS);
  }
  return null;
}

function mostraStato(id) {
  ["stato-caricamento", "stato-non-trovato", "stato-fallito", "pagamento-content"].forEach(altroId => {
    document.getElementById(altroId).classList.toggle("hidden", altroId !== id);
  });
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const token = new URLSearchParams(location.search).get("t");
  if (!token) {
    mostraStato("stato-non-trovato");
    return;
  }

  const data = await caricaEsitoPagamento(token);
  if (!data) {
    // Nessun esito definitivo dopo tutti i tentativi: il documento
    // esiste ancora in PENDING (webhook non ancora arrivato, o il
    // cliente ha semplicemente chiuso la pagina di pagamento senza
    // completare) — non è un "non trovato", ma non c'è ancora nulla di
    // confermato da mostrare.
    mostraStato("stato-non-trovato");
    return;
  }

  if (data.stato === "FAILED") {
    mostraStato("stato-fallito");
    return;
  }

  document.getElementById("p-importo").textContent = `CHF ${(data.importo || 0).toFixed(2)}`;
  document.getElementById("p-descrizione").textContent = data.descrizione || "";
  mostraStato("pagamento-content");
})();
