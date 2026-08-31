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
  await loadFotoDiscipline();

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

// Foto disciplina configurata in Configurazione → Foto discipline (stesso
// FOTO_DISCIPLINE usato da tcm.html e da Corsi lato staff) — per Tennis si
// preferisce la foto Interno con ripiego su Esterno se mancante.
function fotoDisciplinaIscrizione(disciplinaId) {
  if (disciplinaId === "tennis") return FOTO_DISCIPLINE.tennisInterno || FOTO_DISCIPLINE.tennisEsterno || "";
  return FOTO_DISCIPLINE[disciplinaId] || "";
}

let filtroDisciplinaIscrizione = "tutti";

function corsoApertoCardHtml(c) {
  return `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${c.disciplina}">${escapeHtml(disciplinaLabel(c.disciplina))}</span>
        <div class="entry-tipo">${escapeHtml(c.nome)}</div>
        <div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · ${c.forfettario ? "Forfait" : (c.nrSessioni || "—") + " sessioni"} · CHF ${(c.prezzoRichiesto || 0).toFixed(2)}</div>
        ${c.terminIscrizione ? `<div class="entry-meta">Iscrizioni entro il ${formatDataBreve(c.terminIscrizione)}</div>` : ""}
      </div>
      <button type="button" class="btn btn-primary seleziona-corso-btn" style="width:auto;padding:10px 16px;font-size:0.75rem;" data-id="${c.id}">Iscriviti</button>
    </div>
  `;
}

function renderCorsiAperti() {
  const list = document.getElementById("corsi-aperti-list");
  const pillsEl = document.getElementById("corsi-aperti-filtro-pills");

  if (corsiApertiCache.length === 0) {
    pillsEl.classList.add("hidden");
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun corso aperto alle iscrizioni al momento</div></div>`;
    return;
  }

  // Sezioni per disciplina, nell'ordine di DISCIPLINE, solo quelle che
  // hanno almeno un corso aperto (stesso raggruppamento di Corsi staff).
  const sezioni = DISCIPLINE.filter(d => corsiApertiCache.some(c => c.disciplina === d.id));

  // Ripiego se la lettura di "discipline" è fallita (pagina pubblica senza
  // regole pubblicate): elenco piatto, senza pill né banner, ma i corsi
  // restano comunque visibili.
  if (sezioni.length === 0) {
    pillsEl.classList.add("hidden");
    list.innerHTML = corsiApertiCache.map(corsoApertoCardHtml).join("");
    list.querySelectorAll(".seleziona-corso-btn").forEach(btn => {
      btn.addEventListener("click", () => selezionaCorso(corsiApertiCache.find(c => c.id === btn.dataset.id)));
    });
    return;
  }

  const isTrasversale = (filtroId) => sezioni.some(d => d.id === filtroId && d.trasversale);

  pillsEl.classList.toggle("hidden", sezioni.length <= 1);
  pillsEl.innerHTML = [{ id: "tutti", label: "Tutti" }, ...sezioni.map(d => ({ id: d.id, label: d.label }))]
    .map(d => `<button type="button" data-filtro="${d.id}" aria-pressed="${d.id === filtroDisciplinaIscrizione}">${escapeHtml(d.label)}</button>`)
    .join("");
  pillsEl.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      filtroDisciplinaIscrizione = btn.dataset.filtro;
      renderCorsiAperti();
    });
  });

  list.innerHTML = sezioni.map(d => {
    const corsiSezione = corsiApertiCache.filter(c => c.disciplina === d.id);
    if (corsiSezione.length === 0) return "";
    const visibile = filtroDisciplinaIscrizione === "tutti" || filtroDisciplinaIscrizione === d.id
      || (d.trasversale && !isTrasversale(filtroDisciplinaIscrizione));
    const foto = fotoDisciplinaIscrizione(d.id);
    const headerHtml = foto
      ? `<div class="corsi-sezione-header con-foto" style="background-image:url('${foto}')"><h3>${escapeHtml(d.label)}</h3></div>`
      : `<div class="corsi-sezione-header"><h3>${escapeHtml(d.label)}</h3></div>`;
    const cardsHtml = corsiSezione.map(corsoApertoCardHtml).join("");
    return `<div class="corsi-sezione${visibile ? "" : " hidden"}" data-disciplina="${d.id}">${headerHtml}${cardsHtml}</div>`;
  }).join("");

  list.querySelectorAll(".seleziona-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => selezionaCorso(corsiApertiCache.find(c => c.id === btn.dataset.id)));
  });
}

function selezionaCorso(corso) {
  corsoSelezionato = corso;

  document.getElementById("corso-scelto-nome").textContent = corso.nome;
  document.getElementById("corso-scelto-descrizione").textContent = corso.descrizione || "";

  // Corso forfettario: nessun giorno/orario/ore da scegliere, l'iscrizione
  // è secca (nome, dati anagrafici, condizioni, eventuale carta).
  document.getElementById("isc-field-nrore").classList.toggle("hidden", corso.forfettario === true);
  document.getElementById("isc-field-disponibilita").classList.toggle("hidden", corso.forfettario === true);

  // Condizioni generali: mostrate (e da accettare) su qualunque corso che
  // ne abbia — prima non comparivano da nessuna parte lato pubblico.
  const condBox = document.getElementById("isc-condizioni-box");
  const hasCondizioni = !!(corso.condizioniGenerali && corso.condizioniGenerali.trim());
  condBox.classList.toggle("hidden", !hasCondizioni);
  document.getElementById("isc-condizioni-testo").textContent = corso.condizioniGenerali || "";
  document.getElementById("isc-accetto-condizioni").checked = false;

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

  const hasCondizioni = !!(corsoSelezionato.condizioniGenerali && corsoSelezionato.condizioniGenerali.trim());
  if (hasCondizioni && !document.getElementById("isc-accetto-condizioni").checked) {
    showError(errorEl, "Devi accettare le condizioni generali per procedere.");
    btn.disabled = false;
    btn.textContent = "Invia iscrizione";
    return;
  }

  try {
    const forfettario = corsoSelezionato.forfettario === true;

    const disponibilita = {};
    if (!forfettario) {
      document.querySelectorAll(".isc-disponibilita-cb:checked").forEach(cb => {
        const g = cb.dataset.giorno;
        if (!disponibilita[g]) disponibilita[g] = [];
        disponibilita[g].push(cb.value);
      });
    }

    const nrOreRaw = forfettario ? "" : document.getElementById("isc-nrore").value;

    const iscrizioneRef = await db.collection("iscrizioniCorsi").add({
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
      ...(hasCondizioni ? {
        condizioniAccettate: true,
        condizioniTestoAccettato: corsoSelezionato.condizioniGenerali
      } : {}),
      ...(staffProfile ? { inseritaDaStaff: true, inseritaDaUid: staffProfile.uid, inseritaDaNome: staffProfile.nome } : {})
    });

    document.getElementById("step-form").classList.add("hidden");
    document.getElementById("step-fatto").classList.remove("hidden");
    document.getElementById("step-fatto").scrollIntoView({ behavior: "smooth", block: "start" });

    // Il salvataggio carta ha senso quando non si conosce ancora se/quando
    // il pagamento andrà a buon fine al momento dell'iscrizione: corsi con
    // una soglia minima di iscritti (il corso potrebbe non partire) e corsi
    // forfettari (l'iscrizione resta "in attesa" finché lo staff non la
    // conferma). tokenizzazioneAttiva permette allo staff di disattivarlo
    // comunque per corsi specifici (Corsi, checkbox "Offri il salvataggio
    // carta"); assente sui corsi creati prima di questa opzione, che
    // restano quindi invariati (!== false).
    if ((corsoSelezionato.minIscrittiConferma || corsoSelezionato.forfettario) && corsoSelezionato.tokenizzazioneAttiva !== false) {
      document.getElementById("step-carta").classList.remove("hidden");
      document.getElementById("salva-carta-btn").addEventListener("click", () => avviaSalvataggioCarta(iscrizioneRef.id));
    }
  } catch (err) {
    showError(errorEl, "Errore nell'invio: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Invia iscrizione";
  }
}

// Salvataggio carta facoltativo (a costo zero): reindirizza alla pagina
// di checkout ospitata di PostFinance, di ritorno su
// iscrizione-corso-carta.html — nessun addebito qui, solo verifica carta.
async function avviaSalvataggioCarta(iscrizioneId) {
  const btn = document.getElementById("salva-carta-btn");
  const errorEl = document.getElementById("salva-carta-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Attendere…";
  mostraCaricamento("Preparazione del salvataggio carta…");

  try {
    const fn = cloudFunctions().httpsCallable("avviaTokenizzazioneCorso");
    const result = await fn({ iscrizioneId });
    window.location.href = result.data.paymentPageUrl;
  } catch (err) {
    nascondiCaricamento();
    showError(errorEl, "Errore: " + (err.message || err));
    btn.disabled = false;
    btn.textContent = "Salva carta ora (facoltativo)";
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
