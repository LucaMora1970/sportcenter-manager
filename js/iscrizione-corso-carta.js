// ============================================================
// iscrizione-corso-carta.js — pagina pubblica di ritorno dopo il
// salvataggio facoltativo della carta per un corso a soglia minima.
// Legge tokenizzazioniCorsi/{token}: conoscere il token (dal redirect di
// PostFinance) è di per sé l'autorizzazione a leggerlo — stesso pattern
// di paymentRequests/bookingTickets. Il webhook aggiorna lo stato in
// modo indipendente dal redirect del browser, per questo qui si prova a
// leggere con qualche tentativo/attesa invece di arrendersi subito.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

const TENTATIVI_MAX = 6;
const ATTESA_TRA_TENTATIVI_MS = 2500;
const HOMEPAGE_FALLBACK = "https://www.tennisclubmendrisio.ch";

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function caricaEsito(token) {
  for (let tentativo = 0; tentativo < TENTATIVI_MAX; tentativo++) {
    try {
      const doc = await db.collection("tokenizzazioniCorsi").doc(token).get();
      if (doc.exists) {
        const data = doc.data();
        if (data.stato === "ATTIVO" || data.stato === "FALLITO") return data.stato;
      }
    } catch (err) {
      console.warn("caricaEsito: tentativo fallito:", err.message);
    }
    if (tentativo < TENTATIVI_MAX - 1) await attendi(ATTESA_TRA_TENTATIVI_MS);
  }
  return null;
}

function mostraStato(id) {
  ["stato-caricamento", "stato-non-trovato", "stato-attivo", "stato-fallito"].forEach(altroId => {
    document.getElementById(altroId).classList.toggle("hidden", altroId !== id);
  });
  document.getElementById("chiudi-btn").classList.toggle("hidden", id === "stato-caricamento");
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const token = new URLSearchParams(location.search).get("t");
  if (!token) {
    mostraStato("stato-non-trovato");
  } else {
    const esito = await caricaEsito(token);
    if (esito === "ATTIVO") mostraStato("stato-attivo");
    else if (esito === "FALLITO") mostraStato("stato-fallito");
    else mostraStato("stato-non-trovato");
  }

  document.getElementById("chiudi-btn").addEventListener("click", () => {
    window.close();
    const homepage = DATI_CENTRO.homepage
      ? (DATI_CENTRO.homepage.startsWith("http") ? DATI_CENTRO.homepage : `https://${DATI_CENTRO.homepage}`)
      : HOMEPAGE_FALLBACK;
    location.href = homepage;
  });
})();
