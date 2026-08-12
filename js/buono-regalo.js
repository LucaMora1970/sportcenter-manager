// ============================================================
// buono-regalo.js — acquisto pubblico di un buono regalo padel, senza
// login. Chiama la Cloud Function acquistaBuonoRegalo (nessun controllo
// request.auth: chiunque può comprare un buono), che crea la transazione
// PostFinance e restituisce l'URL di pagamento — stesso schema di
// prenota-padel.js, senza però bisogno di data/slot.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

const IMPORTO_MIN = 10;
const IMPORTO_MAX = 500;

let importoSelezionato = null;

function syncSummaryBar() {
  const bar = document.getElementById("summaryBar");
  const titleEl = document.getElementById("summaryTitle");
  if (importoSelezionato != null) {
    titleEl.textContent = `CHF ${importoSelezionato.toFixed(2)}`;
    bar.classList.add("show");
  } else {
    bar.classList.remove("show");
  }
}

function selezionaPreset(importo) {
  importoSelezionato = importo;
  document.getElementById("importo-libero").value = "";
  document.querySelectorAll("#importoSeg button").forEach(b =>
    b.setAttribute("aria-pressed", String(parseInt(b.dataset.importo, 10) === importo))
  );
  syncSummaryBar();
}

function onImportoLibero(e) {
  const val = parseFloat(e.target.value);
  document.querySelectorAll("#importoSeg button").forEach(b => b.setAttribute("aria-pressed", "false"));
  importoSelezionato = (e.target.value && !isNaN(val)) ? val : null;
  syncSummaryBar();
}

async function acquistaBuono() {
  const btn = document.getElementById("summaryCta");
  const errorEl = document.getElementById("buono-error");
  errorEl.innerHTML = "";

  if (importoSelezionato == null || importoSelezionato < IMPORTO_MIN || importoSelezionato > IMPORTO_MAX) {
    showError(errorEl, `Inserisci un importo tra CHF ${IMPORTO_MIN} e CHF ${IMPORTO_MAX}.`);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Attendere…";

  try {
    const fn = firebase.functions().httpsCallable("acquistaBuonoRegalo");
    const result = await fn({ importo: importoSelezionato });
    window.location.href = result.data.paymentPageUrl;
  } catch (err) {
    showError(errorEl, "Errore nell'acquisto: " + (err.message || err));
    btn.disabled = false;
    btn.textContent = "Paga e ricevi il buono";
  }
}

// ---------- Init ----------

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const esitoPagamento = new URLSearchParams(location.search).get("pagamento");
  if (esitoPagamento === "fallito") {
    alert("Pagamento non riuscito o annullato: riprova pure.");
    history.replaceState(null, "", location.pathname);
  }

  document.querySelectorAll("#importoSeg button").forEach(btn => {
    btn.addEventListener("click", () => selezionaPreset(parseInt(btn.dataset.importo, 10)));
  });
  document.getElementById("importo-libero").addEventListener("input", onImportoLibero);
  document.getElementById("summaryCta").addEventListener("click", acquistaBuono);
})();
