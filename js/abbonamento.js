// ============================================================
// abbonamento.js — "La mia area" del socio: abbonamento fisso (con
// cancellazione di una singola settimana), le proprie prenotazioni
// (tennis/squash/padel, sola lettura) e il credito residuo da eventuali
// annullamenti. Nessun login staff: si basa sullo stesso riconoscimento
// dispositivo già usato da tcm.html (sessione Firebase Auth
// ottenuta via attiva-socio.html) — se il dispositivo non è riconosciuto,
// non c'è nulla da mostrare qui.
//
// Nessun rimborso automatico alla cancellazione: se dovuto, lo valuta
// la segreteria a parte (vedi annullaSettimanaAbbonamento lato server).
//
// Le prenotazioni sono per dispositivo (bookings.authUid), non per
// profilo/socioId come l'abbonamento — su un device condiviso da più
// familiari si vedono tutte insieme, vedi commento server-side su
// leMiePrenotazioniECredito.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login staff).
// ============================================================

let CAMPI_LABEL = {}; // courtId -> "Campo N (posizione)"

const GIORNI_LUNGHI_ABB = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
function formatDataEstesa(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  return `${GIORNI_LUNGHI_ABB[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

async function caricaCampiLabel() {
  try {
    const snap = await db.collection("campi").get();
    snap.docs.forEach(d => {
      const c = d.data();
      CAMPI_LABEL[d.id] = `Campo ${c.numero}${c.posizione ? ` (${c.posizione})` : ""}`;
    });
  } catch { /* etichetta di ripiego più sotto se manca */ }
}

function mostraStato(id) {
  ["stato-caricamento", "stato-non-riconosciuto", "area-content"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function abbonamentoCardHtml(abb) {
  const campoLabel = CAMPI_LABEL[abb.courtId] || "Campo";
  const settimaneHtml = abb.settimane.map(s => {
    if (s.status !== "CONFIRMED") {
      return `<div class="settimana-row"><span class="data stato-cancellata">${formatDataEstesa(s.date)}</span><span class="stato-cancellata">Annullata</span></div>`;
    }
    return `
      <div class="settimana-row">
        <span class="data">${formatDataEstesa(s.date)}, ${s.startTime}–${s.endTime}</span>
        <button type="button" class="cancella-settimana-btn" data-booking-id="${s.bookingId}">Cancella</button>
      </div>
    `;
  }).join("");

  return `
    <div class="abb-card">
      <div class="titolo">${escapeHtml(campoLabel)} — ${escapeHtml(GIORNO_LABEL_DISPLAY[abb.giornoSettimana] || abb.giornoSettimana)} ${escapeHtml(abb.orarioInizio)}–${escapeHtml(abb.orarioFine)}</div>
      <div class="meta">${abb.compagnoNome ? "Con " + escapeHtml(abb.compagnoNome) : "Nessun compagno indicato"}</div>
      ${settimaneHtml || `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessuna settimana futura in programma.</p>`}
    </div>
  `;
}

const GIORNO_LABEL_DISPLAY = { lun: "Lunedì", mar: "Martedì", mer: "Mercoledì", gio: "Giovedì", ven: "Venerdì", sab: "Sabato", dom: "Domenica" };

async function caricaAbbonamenti() {
  try {
    const fn = cloudFunctions().httpsCallable("ilMioAbbonamento");
    const { data } = await fn();
    if (data.abbonamenti.length === 0) return; // resta il messaggio "nessun abbonamento" già nell'HTML
    document.getElementById("abbonamenti-container").innerHTML = data.abbonamenti.map(abbonamentoCardHtml).join("");
    document.querySelectorAll(".cancella-settimana-btn").forEach(btn => {
      btn.addEventListener("click", () => onCancellaSettimana(btn));
    });
  } catch (err) {
    document.getElementById("abbonamento-error").textContent = "Errore: " + err.message;
  }
}

const STATO_PRENOTAZIONE_LABEL = { CONFIRMED: "Confermata", CREDITED: "Annullata (credito)", CANCELLED: "Annullata", COMPLETED: "Giocata" };

function prenotazioneRowHtml(p) {
  const campoLabel = CAMPI_LABEL[p.courtId] || "Campo";
  const annullata = p.status === "CANCELLED" || p.status === "CREDITED";
  return `
    <div class="prenotazione-row">
      <div>
        <div class="data${annullata ? " stato-annullata" : ""}">${formatDataEstesa(p.date)}, ${p.startTime}–${p.endTime}</div>
        <div class="disciplina">${escapeHtml(campoLabel)} · ${STATO_PRENOTAZIONE_LABEL[p.status] || p.status}</div>
      </div>
      <div class="prezzo${annullata ? " stato-annullata" : ""}">CHF ${(p.prezzo || 0).toFixed(2)}</div>
    </div>
  `;
}

// Prenotazioni e credito residuo: stessa chiamata, un solo giro di rete —
// vedi leMiePrenotazioniECredito lato server per il perché sono per
// dispositivo (authUid) e non per profilo come l'abbonamento qui sopra.
async function caricaPrenotazioniECredito() {
  try {
    const fn = cloudFunctions().httpsCallable("leMiePrenotazioniECredito");
    const { data } = await fn();

    if (data.prenotazioni.length > 0) {
      document.getElementById("prenotazioni-container").innerHTML = data.prenotazioni.map(prenotazioneRowHtml).join("");
    }

    if (data.credito.length > 0) {
      const righe = data.credito.map(c => `CHF ${(c.remainingAmount || 0).toFixed(2)} — codice <strong>${escapeHtml(c.id)}</strong>`).join("<br>");
      document.getElementById("credito-lista").innerHTML =
        righe + `<br>Comunica il codice in segreteria per usarlo su una prossima prenotazione.`;
      document.getElementById("credito-box").classList.remove("hidden");
    }
  } catch (err) {
    document.getElementById("abbonamento-error").textContent = "Errore: " + err.message;
  }
}

async function onCancellaSettimana(btn) {
  if (!confirm("Cancellare questa settimana? Lo slot torna libero. L'eventuale rimborso va concordato con la segreteria, qui non è automatico.")) return;
  btn.disabled = true;
  btn.textContent = "Cancellazione…";
  const errorEl = document.getElementById("abbonamento-error");
  errorEl.textContent = "";
  try {
    const fn = cloudFunctions().httpsCallable("annullaSettimanaAbbonamento");
    await fn({ bookingId: btn.dataset.bookingId });
    await caricaAbbonamenti();
  } catch (err) {
    errorEl.textContent = "Errore: " + err.message;
    btn.disabled = false;
    btn.textContent = "Cancella";
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
  await caricaCampiLabel();

  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
      mostraStato("stato-non-riconosciuto");
      return;
    }
    mostraStato("area-content");
    await Promise.all([caricaAbbonamenti(), caricaPrenotazioniECredito()]);
  });
})();
