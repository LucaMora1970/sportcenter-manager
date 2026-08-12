// ============================================================
// iscrizione-corso.js — modulo PUBBLICO (nessun login) per l'interesse/
// iscrizione a un corso. Chi lo compila non è autenticato: la sicurezza
// è data dalle firestore.rules (vedi match /iscrizioniCorsi), non da
// permessi lato client. Non chiede il numero AVS (tolto su richiesta) e
// non raccoglie ancora i dati aggiuntivi né il pagamento richiesti in
// caso di conferma — quelli arrivano con un link dedicato in una fase
// successiva, dopo la valutazione dello staff.
// Richiede firebase-config.js e utils.js già caricati (NON auth.js: qui
// non c'è login).
// ============================================================

let corsiApertiCache = [];
let corsoSelezionato = null;
let staffProfile = null;

// La pagina resta pubblica (nessun requireAuth/redirect), ma se chi la
// apre è già loggato nell'app (es. maestro arrivato dal pulsante "Iscrivi
// un allievo" in Corsi) rileviamo la sessione per marcare l'iscrizione
// come inserita dallo staff invece che dalla famiglia.
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

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function etaDa(dataNascitaStr) {
  if (!dataNascitaStr) return null;
  const nascita = new Date(dataNascitaStr + "T00:00:00");
  const oggi = new Date();
  let eta = oggi.getFullYear() - nascita.getFullYear();
  const m = oggi.getMonth() - nascita.getMonth();
  if (m < 0 || (m === 0 && oggi.getDate() < nascita.getDate())) eta--;
  return eta;
}

// Il contatto del genitore è obbligatorio solo per i minorenni (fino a 17
// anni) — qui si calcola dal vivo appena si inserisce la data di nascita
// e si mostra/nasconde il suggerimento e l'obbligatorietà dei campi.
function syncGenitoreObbligatorio() {
  const eta = etaDa(document.getElementById("isc-datanascita").value);
  const minorenne = eta != null && eta < 18;

  document.getElementById("isc-genitore-hint").classList.toggle("hidden", !minorenne);
  document.getElementById("isc-nomegenitore").required = minorenne;
  document.getElementById("isc-telgenitore").required = minorenne;
}

async function loadCorsiAperti() {
  const list = document.getElementById("corsi-aperti-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  await loadDiscipline();

  const snap = await db.collection("corsi").where("approvato", "==", true).get();
  const oggi = todayISO();
  corsiApertiCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.attivo !== false && (!c.terminIscrizione || c.terminIscrizione >= oggi))
    .sort((a, b) => (a.ordine ?? Infinity) - (b.ordine ?? Infinity) || a.dal.localeCompare(b.dal));

  renderCorsiAperti();

  // Link diretto (?corso=ID, generato dallo staff in Corsi): se il corso è
  // tra quelli aperti alle iscrizioni si passa dritti al form, altrimenti
  // (non più approvato/aperto) resta il solito elenco.
  const corsoId = new URLSearchParams(location.search).get("corso");
  const corsoDaLink = corsoId ? corsiApertiCache.find(c => c.id === corsoId) : null;
  if (corsoDaLink) selezionaCorso(corsoDaLink);
}

function renderCorsiAperti() {
  const list = document.getElementById("corsi-aperti-list");

  if (corsiApertiCache.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun corso aperto alle iscrizioni al momento</div></div>`;
    return;
  }

  list.innerHTML = corsiApertiCache.map(c => `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${c.disciplina}">${escapeHtml(disciplinaLabel(c.disciplina))}</span>
        <div class="entry-tipo">${escapeHtml(c.nome)}</div>
        <div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · ${c.nrSessioni || "—"} sessioni · CHF ${(c.prezzoRichiesto || 0).toFixed(2)}</div>
        ${c.terminIscrizione ? `<div class="entry-meta">Iscrizioni entro il ${formatDataBreve(c.terminIscrizione)}</div>` : ""}
      </div>
      <button type="button" class="btn btn-primary seleziona-corso-btn" style="width:auto;padding:10px 16px;font-size:0.75rem;" data-id="${c.id}">Iscriviti</button>
    </div>
  `).join("");

  list.querySelectorAll(".seleziona-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => selezionaCorso(corsiApertiCache.find(c => c.id === btn.dataset.id)));
  });
}

function selezionaCorso(corso) {
  corsoSelezionato = corso;

  document.getElementById("corso-scelto-nome").textContent = corso.nome;
  document.getElementById("corso-scelto-descrizione").textContent = corso.descrizione || "";

  const disponibilitaEl = document.getElementById("isc-disponibilita-list");
  const giorniConOrari = GIORNI_SETTIMANA.filter(g => (corso.giorniOrari || {})[g.id]?.length > 0);
  disponibilitaEl.innerHTML = giorniConOrari.map(g => `
    <div class="giorno-orari-block">
      <div class="row-label" style="margin:14px 0 6px;">${g.label}</div>
      <div class="checkbox-list">
        ${corso.giorniOrari[g.id].map(o => `
          <div class="checkbox-row">
            <input type="checkbox" class="isc-disponibilita-cb" data-giorno="${g.id}" value="${o}" id="isc-disp-${g.id}-${o}">
            <label for="isc-disp-${g.id}-${o}">${o}</label>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");

  document.getElementById("step-scelta").classList.add("hidden");
  document.getElementById("step-form").classList.remove("hidden");
  document.getElementById("iscrizione-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function tornaAllaScelta() {
  corsoSelezionato = null;
  document.getElementById("iscrizione-form").reset();
  syncGenitoreObbligatorio();
  document.getElementById("step-form").classList.add("hidden");
  document.getElementById("step-scelta").classList.remove("hidden");
}

async function onSubmitIscrizione(e) {
  e.preventDefault();
  if (!corsoSelezionato) return;

  const btn = document.getElementById("iscrizione-save-btn");
  const errorEl = document.getElementById("iscrizione-form-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Invio…";

  try {
    const disponibilita = {};
    document.querySelectorAll(".isc-disponibilita-cb:checked").forEach(cb => {
      const g = cb.dataset.giorno;
      if (!disponibilita[g]) disponibilita[g] = [];
      disponibilita[g].push(cb.value);
    });

    const nrOreRaw = document.getElementById("isc-nrore").value;

    await db.collection("iscrizioniCorsi").add({
      corsoId: corsoSelezionato.id,
      corsoNome: corsoSelezionato.nome,
      nome: document.getElementById("isc-nome").value.trim(),
      cognome: document.getElementById("isc-cognome").value.trim(),
      dataNascita: document.getElementById("isc-datanascita").value,
      eta: etaDa(document.getElementById("isc-datanascita").value),
      nazionalita: document.getElementById("isc-nazionalita").value.trim(),
      via: document.getElementById("isc-via").value.trim(),
      cap: document.getElementById("isc-cap").value.trim(),
      localita: document.getElementById("isc-localita").value.trim(),
      email: document.getElementById("isc-email").value.trim(),
      nomeGenitore: document.getElementById("isc-nomegenitore").value.trim(),
      telefonoGenitore: document.getElementById("isc-telgenitore").value.trim(),
      scuolaFrequentata: document.getElementById("isc-scuola").value.trim(),
      altriSportPraticati: document.getElementById("isc-altrisport").value.trim(),
      nrOreDesiderate: nrOreRaw !== "" ? parseFloat(nrOreRaw) : null,
      disponibilita,
      stato: "in_attesa",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...(staffProfile ? { inseritaDaStaff: true, inseritaDaUid: staffProfile.uid, inseritaDaNome: staffProfile.nome } : {})
    });

    document.getElementById("step-form").classList.add("hidden");
    document.getElementById("step-fatto").classList.remove("hidden");
    document.getElementById("step-fatto").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(errorEl, "Errore nell'invio: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Invia iscrizione";
  }
}

document.getElementById("cambia-corso-btn").addEventListener("click", tornaAllaScelta);
document.getElementById("iscrizione-form").addEventListener("submit", onSubmitIscrizione);
document.getElementById("isc-datanascita").addEventListener("change", syncGenitoreObbligatorio);

(async function () {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;
})();

loadCorsiAperti();
