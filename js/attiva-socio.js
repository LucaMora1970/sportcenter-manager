// ============================================================
// attiva-socio.js — attivazione di un dispositivo come "riconosciuto"
// per un socio/junior/studente/azienda partner, senza account
// tradizionale: consuma un token (arrivato via email o via QR mostrato
// dallo staff, stesso formato), ottiene una sessione Firebase Auth
// stabile per quella persona (signInWithCustomToken) e la collega a
// questo dispositivo (sociDevices/{uid}, vedi collegaSocioAlDispositivo).
//
// Senza token in URL: mostra il form per richiedere un nuovo link via
// email (richiediAttivazioneEmail) — usato sia per il primo accesso sia
// se un link precedente è scaduto.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login staff).
// ============================================================

function mostraStato(id) {
  ["stato-attivazione", "stato-errore", "stato-ok", "richiedi-email-box"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

async function attivaConToken(token) {
  mostraStato("stato-attivazione");
  try {
    const attiva = cloudFunctions().httpsCallable("attivaSocioDaToken");
    const { data } = await attiva({ token });

    await firebase.auth().signInWithCustomToken(data.customToken);

    const collega = cloudFunctions().httpsCallable("collegaSocioAlDispositivo");
    await collega({ socioId: data.socioId });

    mostraStato("stato-ok");
  } catch (err) {
    document.getElementById("errore-testo").textContent = err.message || "Il link è scaduto oppure è già stato usato.";
    mostraStato("stato-errore");
  }
}

async function onRichiediEmail(e) {
  e.preventDefault();
  const btn = document.getElementById("richiedi-email-btn");
  const errorEl = document.getElementById("richiedi-email-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const email = document.getElementById("richiedi-email-input").value.trim();
  try {
    const fn = cloudFunctions().httpsCallable("richiediAttivazioneEmail");
    await fn({ email });
    document.getElementById("richiedi-email-form").classList.add("hidden");
    document.getElementById("richiedi-email-inviato").classList.remove("hidden");
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const token = new URLSearchParams(location.search).get("t");
  if (token) {
    await attivaConToken(token);
  } else {
    mostraStato("richiedi-email-box");
    document.getElementById("richiedi-email-form").addEventListener("submit", onRichiediEmail);
  }
})();
