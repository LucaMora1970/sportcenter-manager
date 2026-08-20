// ============================================================
// iscrizione-socio.js — modulo pubblico di iscrizione socio (nessun
// login). Crea solo una richiesta in attesa (richiediIscrizioneSocio):
// la categoria si deduce dall'età, lo staff verifica ed approva da
// Configurazione, incassando la quota fuori dall'app (contanti).
//
// L'età qui è calcolata per anno solare (anno corrente - anno di
// nascita), stessa convenzione usata lato server (etaAnnoSociale in
// functions/index.js) — diversa apposta da etaDa() di corsi.js/
// iscrizione-corso.js, che è invece l'età precisa al giorno. Il calcolo
// qui è solo un'anteprima: la categoria vera si ricalcola sempre
// server-side alla conferma.
//
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login — ma se chi apre la pagina è già loggato nell'app, la
// sessione viene comunque rilevata per il banner staff sotto).
// ============================================================

let categorieSocioCache = [];
let staffProfile = null;

// La pagina resta pubblica (nessun requireAuth/redirect), ma se chi la
// apre è già loggato nell'app (es. segretaria arrivata dal pulsante
// "Registra un socio" nella pagina Soci) rileviamo la sessione per
// mostrare un banner — il tag "inserita da staff" lo decide comunque
// sempre e solo richiediIscrizioneSocio lato server, verificando
// request.auth: un flag mandato dal client non farebbe fede. Stesso
// pattern di js/iscrizione-corso.js.
auth.onAuthStateChanged(async (user) => {
  if (!user) { staffProfile = null; syncStaffBanner(); return; }
  try {
    const userSnap = await db.collection("users").doc(user.uid).get();
    staffProfile = userSnap.exists ? { uid: user.uid, nome: userSnap.data().nome || user.email } : null;
  } catch {
    staffProfile = null;
  }
  syncStaffBanner();
});

function syncStaffBanner() {
  const banner = document.getElementById("staff-banner");
  if (!banner) return;
  banner.classList.toggle("hidden", !staffProfile);
  if (staffProfile) banner.textContent = `Stai compilando come membro dello staff (${staffProfile.nome}) — l'iscrizione verrà segnata come inserita da te.`;
}

function etaAnnoSociale(dataNascitaIso) {
  if (!dataNascitaIso) return null;
  const anno = parseInt(dataNascitaIso.slice(0, 4), 10);
  if (!anno) return null;
  return new Date().getFullYear() - anno;
}

function categoriaEtaCache(id) {
  return categorieSocioCache.find(c => c.id === id) || null;
}

// Categoria automatica dall'età (esclude famiglia/studenti, mai dedotte
// da sole — vedi commento server-side in richiediIscrizioneSocio).
function categoriaAutomaticaDaEta(eta) {
  return categorieSocioCache.find(c =>
    c.id !== "famiglia" && c.id !== "studenti"
    && (c.etaMin == null || eta >= c.etaMin)
    && (c.etaMax == null || eta <= c.etaMax)
  ) || null;
}

function aggiornaAnteprima() {
  const eta = etaAnnoSociale(document.getElementById("is-datanascita").value);
  const previewEl = document.getElementById("categoria-preview");
  const studenteRow = document.getElementById("cb-studente-row");
  const famigliaEl = document.getElementById("is-famiglia");
  const studenteEl = document.getElementById("is-studente");

  const studentiCat = categoriaEtaCache("studenti");
  const inFasciaStudenti = eta != null && studentiCat
    && (studentiCat.etaMin == null || eta >= studentiCat.etaMin)
    && (studentiCat.etaMax == null || eta <= studentiCat.etaMax);
  studenteRow.classList.toggle("hidden", !inFasciaStudenti);
  if (!inFasciaStudenti) studenteEl.checked = false;

  let categoria = null;
  if (famigliaEl.checked) {
    categoria = categoriaEtaCache("famiglia");
  } else if (studenteEl.checked) {
    categoria = studentiCat;
  } else if (eta != null) {
    categoria = categoriaAutomaticaDaEta(eta);
  }

  if (!categoria) {
    previewEl.classList.add("hidden");
    return;
  }
  document.getElementById("cp-nome").textContent = `Categoria: ${categoria.nome}`;
  document.getElementById("cp-quota").textContent = categoria.costoForfait != null
    ? `Quota annuale: CHF ${Number(categoria.costoForfait).toFixed(2)}` : "Quota da confermare col circolo";
  previewEl.classList.remove("hidden");
}

async function onSubmitIscrizione(e) {
  e.preventDefault();
  const btn = document.getElementById("iscrizione-save-btn");
  const errorEl = document.getElementById("iscrizione-form-error");
  errorEl.textContent = "";

  if (!document.getElementById("is-privacy").checked) {
    showError(errorEl, "Devi accettare l'informativa privacy per proseguire.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Invio in corso…";

  const payload = {
    nome: document.getElementById("is-nome").value.trim(),
    cognome: document.getElementById("is-cognome").value.trim(),
    email: document.getElementById("is-email").value.trim(),
    telefono: document.getElementById("is-telefono").value.trim() || null,
    dataNascita: document.getElementById("is-datanascita").value,
    via: document.getElementById("is-via").value.trim(),
    cap: document.getElementById("is-cap").value.trim(),
    localita: document.getElementById("is-localita").value.trim(),
    consensoPrivacy: true,
    richiedeFamiglia: document.getElementById("is-famiglia").checked,
    richiedeStudente: document.getElementById("is-studente").checked
  };

  try {
    const fn = cloudFunctions().httpsCallable("richiediIscrizioneSocio");
    const { data } = await fn(payload);
    if (data.pagamentoNecessario) {
      // Categoria chiara: si passa subito al pagamento online, come per
      // una prenotazione — nessuno step intermedio da mostrare qui, la
      // pagina di pagamento fa già da conferma.
      window.location.href = data.paymentPageUrl;
      return;
    }
    document.getElementById("step-form").classList.add("hidden");
    document.getElementById("step-fatto").classList.remove("hidden");
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Invia richiesta";
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const snap = await db.collection("categorieSocio").where("attivo", "==", true).get();
  categorieSocioCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("is-datanascita").addEventListener("change", aggiornaAnteprima);
  // Famiglia e Studenti si escludono a vicenda: selezionarne una
  // deseleziona l'altra prima di ricalcolare l'anteprima.
  document.getElementById("is-famiglia").addEventListener("change", () => {
    if (document.getElementById("is-famiglia").checked) document.getElementById("is-studente").checked = false;
    aggiornaAnteprima();
  });
  document.getElementById("is-studente").addEventListener("change", () => {
    if (document.getElementById("is-studente").checked) document.getElementById("is-famiglia").checked = false;
    aggiornaAnteprima();
  });

  document.getElementById("iscrizione-form").addEventListener("submit", onSubmitIscrizione);
})();
