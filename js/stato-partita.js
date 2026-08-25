// ============================================================
// stato-partita.js — pagina pubblica di sola consultazione per una
// proposta di sessione Community Padel: chi ha aderito, chi manca, e
// quanto deve pagare ciascuno (per la propria categoria reale, come la
// ripartizione già esistente per le prenotazioni dirette). Nessun login:
// conoscere l'id della sessione (nel link ?s=) è di per sé
// l'autorizzazione, stesso principio già usato per bookingTickets/
// attivazioniSoci (vedi la Cloud Function statoSessionePadel e
// firestore.rules).
//
// Live: un listener Firestore sul documento sessioniPadel (pubblico in
// lettura) fa ripartire il calcolo quota via Cloud Function ad ogni
// cambiamento — il calcolo va per forza lato server perché richiede di
// leggere "soci" (mai accessibile dal client).
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js).
// ============================================================

const STATO_SESSIONE_LABEL = { aperta: "In attesa di conferme", confermata: "Confermata", scaduta: "Scaduta", annullata: "Annullata" };

function mostraStato(id) {
  ["stato-caricamento", "stato-errore", "stato-content"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function formatoQuota(q) {
  return q != null ? `CHF ${Number(q).toFixed(2)}` : "—";
}

async function aggiornaStato(sessioneId) {
  try {
    const fn = cloudFunctions().httpsCallable("statoSessionePadel");
    const { data } = await fn({ sessioneId });

    document.getElementById("stato-riepilogo").innerHTML = `
      <div class="entry-tipo">${escapeHtml(data.date)} · ${escapeHtml(data.startTime)}–${escapeHtml(data.endTime)}</div>
      <div class="entry-meta">Stato: ${escapeHtml(STATO_SESSIONE_LABEL[data.stato] || data.stato)}</div>
      <div class="entry-meta">Organizzatore: ${escapeHtml(data.organizzatore.pseudonimo)} — quota ${formatoQuota(data.organizzatore.quota)}</div>
      <div class="entry-meta" style="margin-top:6px;font-family:'Space Mono',monospace;">Totale finora: ${formatoQuota(data.quotaTotale)}</div>
    `;

    document.getElementById("stato-confermati").innerHTML = data.confermati.length > 0
      ? data.confermati.map(c => `
          <div class="gp-classifica-row">
            <span>✓ ${escapeHtml(c.pseudonimo)}</span>
            <span class="livello">${formatoQuota(c.quota)}</span>
          </div>
        `).join("")
      : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessuno ancora, oltre all'organizzatore.</p>`;

    document.getElementById("stato-in-attesa").innerHTML = data.inAttesa.length > 0
      ? data.inAttesa.map(c => `<div class="gp-classifica-row"><span>… ${escapeHtml(c.pseudonimo)}</span></div>`).join("")
      : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessuno in attesa.</p>`;

    mostraStato("stato-content");
  } catch (err) {
    document.getElementById("stato-errore-testo").textContent = err.message || "Il link non è valido.";
    mostraStato("stato-errore");
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const sessioneId = new URLSearchParams(location.search).get("s");
  if (!sessioneId) {
    document.getElementById("stato-errore-testo").textContent = "Link incompleto.";
    mostraStato("stato-errore");
    return;
  }

  // onSnapshot chiama il callback anche subito con lo stato attuale, non
  // serve un primo aggiornaStato() separato prima di attaccare il listener.
  db.collection("sessioniPadel").doc(sessioneId).onSnapshot(
    () => aggiornaStato(sessioneId),
    () => aggiornaStato(sessioneId) // errore di lettura: lascia che sia la Cloud Function a spiegare perché
  );
})();
