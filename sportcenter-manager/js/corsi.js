// ============================================================
// corsi.js — fase 1: creazione e gestione interna dei corsi (dietro
// login). Un corso è una "proposta": chi lo crea sceglie un sottoinsieme
// di giorni/orari/campi tra quelli realmente disponibili per la
// disciplina (stessi orari usati in Diario, stessi campi configurati).
// Il calendario reale delle sessioni si genera più avanti, quando dagli
// iscritti risulta quale combinazione attivare — non qui.
// Vedi anche iscrizione-corso.html/js: il modulo pubblico di iscrizione
// (nessun login) e la vista di revisione delle iscrizioni qui sotto.
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsiCache = [];
let campiCache = [];
let iscrizioniConfermateCache = [];
let editingCorsoId = null;

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function oreTotaliCorso(nrSessioni, durataMinuti) {
  return (nrSessioni || 0) * (durataMinuti || 0) / 60;
}

function calcolaCostoPerPartecipante(form) {
  const ore = oreTotaliCorso(form.nrSessioni, form.durataSessioneMinuti);
  const costoTotale = ore * (form.costoIstruttoreOra || 0) + ore * (form.costoCampoOrganizzazioneOra || 0) + (form.costoMateriale || 0);
  const minIscritti = form.minIscrittiConferma || 0;
  return minIscritti > 0 ? costoTotale / minIscritti : null;
}

// ---------- Caricamento campi ----------

async function loadCampi() {
  const snap = await db.collection("campi").where("attivo", "==", true).get();
  campiCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------- Checkbox giorni/orari/campi dipendenti dalla disciplina ----------

// Un blocco di orari per ciascun giorno della settimana: la disponibilità
// non è uguale ogni giorno, quindi l'orario si sceglie giorno per giorno
// invece che come unico elenco condiviso. Un giorno senza orari selezionati
// semplicemente non fa parte della proposta (niente checkbox separata
// "giorno attivo").
function syncOrariCampiDisciplina() {
  const disciplina = document.getElementById("corso-disciplina").value;

  const giorniOrariEl = document.getElementById("corso-giorni-orari");
  const orari = orariInizioPerDisciplina(disciplina);
  giorniOrariEl.innerHTML = orari.length > 0
    ? GIORNI_SETTIMANA.map(g => `
        <div class="giorno-orari-block">
          <div class="row-label" style="margin:14px 0 6px;">${g.label}</div>
          <div class="checkbox-list">
            ${orari.map(o => `
              <div class="checkbox-row">
                <input type="checkbox" class="corso-orario-cb" data-giorno="${g.id}" value="${o}" id="corso-orario-${g.id}-${o}">
                <label for="corso-orario-${g.id}-${o}">${o}</label>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessun orario prenotabile configurato per questa disciplina.</p>`;

  const campiEl = document.getElementById("corso-campi-list");
  const campiPerDisciplina = campiCache
    .filter(c => c.disciplina === disciplina)
    .sort((a, b) => (a.numero || "").localeCompare(b.numero || "", undefined, { numeric: true }));
  campiEl.innerHTML = campiPerDisciplina.length > 0
    ? campiPerDisciplina.map(c => `
        <div class="checkbox-row">
          <input type="checkbox" class="corso-campo-cb" value="${c.numero}" id="corso-campo-${c.numero}">
          <label for="corso-campo-${c.numero}">Campo ${escapeHtml(c.numero)} (${c.posizione === "interno" ? "coperto" : "scoperto"})</label>
        </div>
      `).join("")
    : `<p style="color:var(--chalk-grey);font-size:0.82rem;">Nessun campo configurato per questa disciplina.</p>`;
}

// ---------- Lettura form ----------

function leggiFormCorso() {
  const giorniOrari = {};
  GIORNI_SETTIMANA.forEach(g => {
    const orari = Array.from(document.querySelectorAll(`.corso-orario-cb[data-giorno="${g.id}"]:checked`)).map(cb => cb.value);
    if (orari.length > 0) giorniOrari[g.id] = orari;
  });

  const campiNumeri = Array.from(document.querySelectorAll(".corso-campo-cb:checked")).map(cb => cb.value);

  const livelloIstruttori = [];
  if (document.getElementById("corso-liv-maestro").checked) livelloIstruttori.push("maestro");
  if (document.getElementById("corso-liv-monitore").checked) livelloIstruttori.push("monitore");
  if (document.getElementById("corso-liv-preparatore").checked) livelloIstruttori.push("preparatore-atletico");

  const num = (id) => {
    const raw = document.getElementById(id).value;
    return raw !== "" ? parseFloat(raw) : null;
  };

  return {
    nome: document.getElementById("corso-nome").value.trim(),
    descrizione: document.getElementById("corso-descrizione").value.trim(),
    disciplina: document.getElementById("corso-disciplina").value,
    dal: document.getElementById("corso-dal").value,
    al: document.getElementById("corso-al").value || null,
    nrSessioni: num("corso-nrsessioni"),
    durataSessioneMinuti: num("corso-durata"),
    giorniOrari,
    campiNumeri,
    etaMin: num("corso-eta-min"),
    etaMax: num("corso-eta-max"),
    maxIscrittiPerSessione: num("corso-max-iscritti"),
    minIscrittiConferma: num("corso-min-iscritti"),
    terminIscrizione: document.getElementById("corso-termine-iscrizione").value || null,
    condizioniGenerali: document.getElementById("corso-condizioni").value.trim(),
    livelloIstruttori,
    costoIstruttoreOra: num("corso-costo-istruttore"),
    costoCampoOrganizzazioneOra: num("corso-costo-campo"),
    costoMateriale: num("corso-costo-materiale"),
    prezzoRichiesto: num("corso-prezzo-richiesto")
  };
}

// ---------- Costo per partecipante, aggiornato dal vivo ----------

function aggiornaCostoCalcolato() {
  const form = leggiFormCorso();
  const costoEl = document.getElementById("corso-costo-calcolato");
  const costo = calcolaCostoPerPartecipante(form);
  costoEl.textContent = costo != null
    ? `CHF ${costo.toFixed(2)} (÷ ${form.minIscrittiConferma} iscritti)`
    : "CHF —";
}

// ---------- Elenco corsi ----------

async function loadCorsi() {
  const list = document.getElementById("corsi-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("corsi").orderBy("dal", "desc").get();
  corsiCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderCorsi();
}

function renderCorsi() {
  const list = document.getElementById("corsi-list");

  if (corsiCache.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun corso creato</div></div>`;
    return;
  }

  const puoGestire = hasPermission(currentProfile, "corsi:gestisci");
  const puoApprovare = hasPermission(currentProfile, "corsi:approva");
  const puoVedereIscrizioni = hasPermission(currentProfile, "iscrizioni:gestisci");

  list.innerHTML = corsiCache.map(c => {
    const giorniOrariLabel = Object.entries(c.giorniOrari || {})
      .map(([g, orari]) => `${(GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g} ${orari.join("/")}`)
      .join(" · ") || "—";
    const campiLabel = (c.campiNumeri || []).map(n => "Campo " + n).join(", ") || "—";
    return `
    <div class="dipendente-block" data-id="${c.id}">
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${c.approvato ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"}">${c.approvato ? "Approvato" : "Bozza"}</span>
          <span class="badge ${c.disciplina}">${escapeHtml(disciplinaLabel(c.disciplina))}</span>
          <div class="entry-tipo">${escapeHtml(c.nome)}</div>
          <div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · ${c.nrSessioni || "—"} sessioni da ${c.durataSessioneMinuti || "—"}' · campi: ${campiLabel}</div>
          <div class="entry-meta">Proposta: ${giorniOrariLabel}</div>
          <div class="entry-meta">Creato da ${escapeHtml(c.creatoDaNome || "—")}${c.approvato ? " · approvato da " + escapeHtml(c.approvatoDaNome || "—") : ""}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${puoGestire ? `<button class="btn btn-ghost edit-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Modifica</button>` : ""}
          ${puoApprovare && !c.approvato ? `<button class="btn btn-primary approva-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Approva</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost iscrizioni-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Iscrizioni</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost panoramica-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Panoramica</button>` : ""}
          ${puoGestire ? `<button class="btn btn-danger delete-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Elimina</button>` : ""}
        </div>
      </div>
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="iscrizioni-${c.id}"></div>` : ""}
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="panoramica-${c.id}"></div>` : ""}
    </div>
  `;
  }).join("");

  list.querySelectorAll(".edit-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => startEditCorso(corsiCache.find(c => c.id === btn.dataset.id)));
  });

  list.querySelectorAll(".approva-corso-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await db.collection("corsi").doc(btn.dataset.id).update({
          approvato: true,
          approvatoDaUid: currentProfile.uid,
          approvatoDaNome: currentProfile.nome
        });
        await loadCorsi();
      } catch (err) {
        showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll(".delete-corso-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare definitivamente questo corso? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("corsi").doc(btn.dataset.id).delete();
        await loadCorsi();
      } catch (err) {
        showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll(".iscrizioni-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleIscrizioniCorso(btn.dataset.id));
  });

  list.querySelectorAll(".panoramica-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => togglePanoramicaCorso(btn.dataset.id));
  });
}

// ---------- Iscrizioni ricevute (permesso iscrizioni:gestisci) ----------

function etaDa(dataNascitaStr) {
  if (!dataNascitaStr) return null;
  const nascita = new Date(dataNascitaStr + "T00:00:00");
  const oggi = new Date();
  let eta = oggi.getFullYear() - nascita.getFullYear();
  const m = oggi.getMonth() - nascita.getMonth();
  if (m < 0 || (m === 0 && oggi.getDate() < nascita.getDate())) eta--;
  return eta;
}

async function toggleIscrizioniCorso(corsoId) {
  const container = document.getElementById(`iscrizioni-${corsoId}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  container.classList.remove("hidden");
  await ricaricaIscrizioniCorso(corsoId);
}

async function ricaricaIscrizioniCorso(corsoId) {
  const container = document.getElementById(`iscrizioni-${corsoId}`);
  if (!container) return;
  const corso = corsiCache.find(c => c.id === corsoId);
  const snap = await db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get();
  renderIscrizioniCorso(container, corso, snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

// Tutte le combinazioni giorno/orario proposte dal corso, in un unico
// elenco piatto — usato per il selettore di assegnazione alla conferma.
function combinazioniCorso(corso) {
  const combinazioni = [];
  GIORNI_SETTIMANA.forEach(g => {
    (corso.giorniOrari?.[g.id] || []).forEach(o => {
      combinazioni.push({ giorno: g.id, giornoLabel: g.label, orario: o });
    });
  });
  return combinazioni;
}

// Panoramica: ribalta la vista da "per iscritto" a "per slot" — per ogni
// combinazione giorno/orario proposta, chi l'ha flaggata come disponibile
// (in attesa) e chi c'è già confermato. Serve a decidere in un colpo
// d'occhio quali slot hanno abbastanza persone per formare un gruppo.
async function togglePanoramicaCorso(corsoId) {
  const container = document.getElementById(`panoramica-${corsoId}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  container.classList.remove("hidden");

  const corso = corsiCache.find(c => c.id === corsoId);
  const snap = await db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get();
  const iscrizioni = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderPanoramicaCorso(container, corso, iscrizioni);
}

function renderPanoramicaCorso(container, corso, iscrizioni) {
  const combinazioni = combinazioniCorso(corso);
  let html = "";
  let giornoCorrente = null;

  combinazioni.forEach(c => {
    const candidati = iscrizioni.filter(i => i.stato === "in_attesa" && (i.disponibilita?.[c.giorno] || []).includes(c.orario));
    const confermati = iscrizioni.filter(i => i.stato === "confermata" && i.giornoAssegnato === c.giorno && i.orarioAssegnato === c.orario);
    if (candidati.length === 0 && confermati.length === 0) return;

    if (c.giorno !== giornoCorrente) {
      giornoCorrente = c.giorno;
      html += `<div class="row-label" style="margin:14px 0 6px;">${c.giornoLabel}</div>`;
    }

    const totale = candidati.length + confermati.length;
    const bastante = corso.minIscrittiConferma && totale >= corso.minIscrittiConferma;

    html += `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${bastante ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"}">${totale} ${totale === 1 ? "persona" : "persone"}${corso.minIscrittiConferma ? " / min " + corso.minIscrittiConferma : ""}</span>
          <div class="entry-tipo">${c.orario}</div>
          ${confermati.length > 0 ? `<div class="entry-meta">Confermati: ${confermati.map(i => escapeHtml(i.nome) + " " + escapeHtml(i.cognome)).join(", ")}</div>` : ""}
          ${candidati.length > 0 ? `<div class="entry-meta">In attesa: ${candidati.map(i => escapeHtml(i.nome) + " " + escapeHtml(i.cognome)).join(", ")}</div>` : ""}
        </div>
      </div>
    `;
  });

  container.innerHTML = html || `<div class="empty-state"><div class="display">Nessuna disponibilità ricevuta ancora</div></div>`;
}

// Se la Panoramica di questo corso è aperta, la ricarica — così conferme e
// rifiuti fatti dalla vista Iscrizioni si riflettono subito nei conteggi.
async function ricaricaPanoramicaSeAperta(corsoId) {
  const container = document.getElementById(`panoramica-${corsoId}`);
  if (!container || container.classList.contains("hidden")) return;
  const corso = corsiCache.find(c => c.id === corsoId);
  const snap = await db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get();
  renderPanoramicaCorso(container, corso, snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

function renderIscrizioniCorso(container, corso, iscrizioni) {
  if (iscrizioni.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="display">Nessuna iscrizione ricevuta</div></div>`;
    return;
  }

  const statoLabel = { in_attesa: "In attesa", confermata: "Confermata", annullata: "Annullata" };
  const statoStyle = {
    in_attesa: "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);",
    confermata: "border-color:#7f9e4a;color:#c1e08f;",
    annullata: "border-color:var(--danger);color:var(--danger);"
  };
  const combinazioni = combinazioniCorso(corso);

  container.innerHTML = iscrizioni.map(i => {
    const disponibilitaLabel = Object.entries(i.disponibilita || {})
      .map(([g, orari]) => `${(GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g} ${orari.join("/")}`)
      .join(" · ") || "—";
    const eta = etaDa(i.dataNascita);
    const disponibileSet = new Set(Object.entries(i.disponibilita || {}).flatMap(([g, orari]) => orari.map(o => `${g}|${o}`)));

    const selectSlot = i.stato === "in_attesa" ? `
      <select class="assegna-slot-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;">
        ${combinazioni.map(c => `<option value="${c.giorno}|${c.orario}">${c.giornoLabel} ${c.orario}${disponibileSet.has(`${c.giorno}|${c.orario}`) ? " ✓" : ""}</option>`).join("")}
      </select>
    ` : "";

    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${statoStyle[i.stato] || statoStyle.in_attesa}">${statoLabel[i.stato] || i.stato}</span>
          <div class="entry-tipo">${escapeHtml(i.nome)} ${escapeHtml(i.cognome)}${eta != null ? " · " + eta + " anni" : ""}</div>
          <div class="entry-meta">${escapeHtml(i.email)}${i.nrOreDesiderate ? " · " + i.nrOreDesiderate + "h/sett." : ""}${i.scuolaFrequentata ? " · " + escapeHtml(i.scuolaFrequentata) : ""}</div>
          ${i.nomeGenitore || i.telefonoGenitore ? `<div class="entry-meta">Genitore: ${escapeHtml(i.nomeGenitore || "—")}${i.telefonoGenitore ? " · " + escapeHtml(i.telefonoGenitore) : ""}</div>` : ""}
          <div class="entry-meta">Disponibilità: ${disponibilitaLabel}</div>
          ${i.stato === "confermata" && i.giornoAssegnato ? `<div class="entry-meta">Assegnato: ${(GIORNI_SETTIMANA.find(x => x.id === i.giornoAssegnato) || {}).label || i.giornoAssegnato} ${i.orarioAssegnato}</div>` : ""}
          ${i.stato === "annullata" && i.motivoRifiuto ? `<div class="entry-meta">Motivo: ${escapeHtml(i.motivoRifiuto)}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${selectSlot}
          ${i.stato === "in_attesa" ? `<button class="btn btn-primary conferma-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}">Conferma in questo slot</button>` : ""}
          ${i.stato === "in_attesa" ? `<button class="btn btn-danger annulla-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}">Rifiuta</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".conferma-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const select = container.querySelector(`.assegna-slot-select[data-id="${btn.dataset.id}"]`);
      const [giorno, orario] = select.value.split("|");
      confermaIscrizione(btn.dataset.id, btn.dataset.corso, giorno, orario);
    });
  });
  container.querySelectorAll(".annulla-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => rifiutaIscrizione(btn.dataset.id, btn.dataset.corso));
  });
}

// Conferma l'iscritto nello slot scelto nel select — può essere diverso da
// quanto aveva flaggato come disponibile (spostamento previo suo accordo,
// concordato fuori dall'app: qui si registra solo l'esito).
async function confermaIscrizione(iscrizioneId, corsoId, giorno, orario) {
  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      stato: "confermata",
      giornoAssegnato: giorno,
      orarioAssegnato: orario,
      motivoRifiuto: null,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Chiede un motivo (es. "numero insufficiente di iscritti nella fascia
// richiesta") così lo staff ha una nota pronta per avvisare l'interessato.
async function rifiutaIscrizione(iscrizioneId, corsoId) {
  const motivo = prompt("Motivo del rifiuto (es. numero insufficiente di iscritti nella fascia richiesta) — verrà usato per avvisare l'interessato:", "Numero insufficiente di iscritti nella fascia richiesta");
  if (motivo === null) return;

  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      stato: "annullata",
      motivoRifiuto: motivo,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// ---------- Riepilogo giornaliero/settimanale (gruppi confermati) ----------

async function loadIscrizioniConfermate() {
  const snap = await db.collection("iscrizioniCorsi").where("stato", "==", "confermata").get();
  iscrizioniConfermateCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Raggruppa le iscrizioni confermate per corso+giorno+orario assegnati, poi
// tiene solo i gruppi la cui data generata (dal + giorno della settimana,
// ripetuto per nrSessioni volte) include dataIso.
function gruppiConfermatiPerData(dataIso) {
  const gruppiMap = {};
  iscrizioniConfermateCache.forEach(i => {
    if (!i.giornoAssegnato || !i.orarioAssegnato) return;
    const corso = corsiCache.find(c => c.id === i.corsoId);
    if (!corso) return;
    const key = `${i.corsoId}|${i.giornoAssegnato}|${i.orarioAssegnato}`;
    if (!gruppiMap[key]) {
      gruppiMap[key] = { corso, giorno: i.giornoAssegnato, orario: i.orarioAssegnato, iscritti: [] };
    }
    gruppiMap[key].iscritti.push(i);
  });

  return Object.values(gruppiMap)
    .filter(g => generaCalendarioSessioni(g.corso.dal, g.corso.nrSessioni, g.giorno, g.orario, g.corso.durataSessioneMinuti)
      .some(s => s.data === dataIso))
    .sort((a, b) => a.orario.localeCompare(b.orario));
}

function giornoLabelDa(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  return GIORNI_SETTIMANA[(d.getDay() + 6) % 7].label;
}

function gruppoCardHtml(g) {
  const righeIscritti = g.iscritti
    .map(i => ({ ...i, eta: etaDa(i.dataNascita) }))
    .sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999))
    .map(i => `<li>${escapeHtml(i.nome)} ${escapeHtml(i.cognome)}${i.eta != null ? " · " + i.eta + " anni" : ""}</li>`)
    .join("");
  return `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${g.corso.disciplina}">${escapeHtml(disciplinaLabel(g.corso.disciplina))}</span>
        <div class="entry-tipo">${g.orario} · ${escapeHtml(g.corso.nome)}</div>
        <div class="entry-meta">${g.iscritti.length} iscritti</div>
        <ul style="margin:8px 0 0;padding-left:18px;font-size:0.82rem;color:var(--chalk-grey);">${righeIscritti}</ul>
      </div>
    </div>
  `;
}

function renderRiepilogoGiornaliero(dataIso) {
  const el = document.getElementById("riepilogo-giornaliero-list");
  const gruppi = gruppiConfermatiPerData(dataIso);
  el.innerHTML = gruppi.length > 0
    ? gruppi.map(gruppoCardHtml).join("")
    : `<div class="empty-state"><div class="display">Nessun gruppo confermato per questo giorno</div></div>`;
}

function renderRiepilogoSettimanale(dalIso) {
  const el = document.getElementById("riepilogo-settimanale-list");
  const inizio = new Date(dalIso + "T00:00:00");
  let html = "";
  let trovatoQualcosa = false;

  for (let i = 0; i < 7; i++) {
    const d = new Date(inizio);
    d.setDate(inizio.getDate() + i);
    const iso = toISODate(d);
    const gruppi = gruppiConfermatiPerData(iso);
    if (gruppi.length === 0) continue;
    trovatoQualcosa = true;
    html += `<div class="row-label" style="margin:14px 0 6px;">${giornoLabelDa(iso)} ${formatDataBreve(iso)}</div>`;
    html += gruppi.map(gruppoCardHtml).join("");
  }

  el.innerHTML = trovatoQualcosa ? html : `<div class="empty-state"><div class="display">Nessun gruppo confermato in questa settimana</div></div>`;
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function aggiornaRiepiloghi() {
  const dataIso = document.getElementById("riepilogo-data").value;
  if (!dataIso) return;
  renderRiepilogoGiornaliero(dataIso);
  renderRiepilogoSettimanale(dataIso);
}

function stampaRiepilogoSettimanale() {
  const dalIso = document.getElementById("riepilogo-data").value;
  if (!dalIso) return;
  const inizio = new Date(dalIso + "T00:00:00");

  let righe = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(inizio);
    d.setDate(inizio.getDate() + i);
    const iso = toISODate(d);
    const gruppi = gruppiConfermatiPerData(iso);
    gruppi.forEach(g => {
      righe += `
        <tr>
          <td>${giornoLabelDa(iso)} ${formatDataBreve(iso)}</td>
          <td>${g.orario}</td>
          <td>${escapeHtml(g.corso.nome)}</td>
          <td>${escapeHtml(disciplinaLabel(g.corso.disciplina))}</td>
          <td>${g.iscritti.map(x => escapeHtml(x.nome) + " " + escapeHtml(x.cognome) + (etaDa(x.dataNascita) != null ? " (" + etaDa(x.dataNascita) + ")" : "")).join(", ")}</td>
        </tr>
      `;
    });
  }

  document.getElementById("print-area").innerHTML = `
    <h1>Riepilogo settimanale corsi</h1>
    <p>Settimana dal ${formatDataBreve(dalIso)}</p>
    <table>
      <thead><tr><th>Giorno</th><th>Orario</th><th>Corso</th><th>Disciplina</th><th>Iscritti</th></tr></thead>
      <tbody>${righe}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Form: creazione/modifica ----------

function startEditCorso(corso) {
  if (!corso) return;
  editingCorsoId = corso.id;

  document.getElementById("corso-nome").value = corso.nome || "";
  document.getElementById("corso-descrizione").value = corso.descrizione || "";
  document.getElementById("corso-disciplina").value = corso.disciplina || "";
  syncOrariCampiDisciplina();
  document.getElementById("corso-dal").value = corso.dal || "";
  document.getElementById("corso-al").value = corso.al || "";
  document.getElementById("corso-nrsessioni").value = corso.nrSessioni != null ? corso.nrSessioni : "";
  document.getElementById("corso-durata").value = corso.durataSessioneMinuti != null ? corso.durataSessioneMinuti : "";
  Object.entries(corso.giorniOrari || {}).forEach(([giornoId, orari]) => {
    orari.forEach(o => {
      const cb = document.getElementById(`corso-orario-${giornoId}-${o}`);
      if (cb) cb.checked = true;
    });
  });
  (corso.campiNumeri || []).forEach(n => {
    const cb = document.getElementById(`corso-campo-${n}`);
    if (cb) cb.checked = true;
  });
  document.getElementById("corso-eta-min").value = corso.etaMin != null ? corso.etaMin : "";
  document.getElementById("corso-eta-max").value = corso.etaMax != null ? corso.etaMax : "";
  document.getElementById("corso-max-iscritti").value = corso.maxIscrittiPerSessione != null ? corso.maxIscrittiPerSessione : "";
  document.getElementById("corso-min-iscritti").value = corso.minIscrittiConferma != null ? corso.minIscrittiConferma : "";
  document.getElementById("corso-termine-iscrizione").value = corso.terminIscrizione || "";
  document.getElementById("corso-condizioni").value = corso.condizioniGenerali || "";
  document.getElementById("corso-liv-maestro").checked = (corso.livelloIstruttori || []).includes("maestro");
  document.getElementById("corso-liv-monitore").checked = (corso.livelloIstruttori || []).includes("monitore");
  document.getElementById("corso-liv-preparatore").checked = (corso.livelloIstruttori || []).includes("preparatore-atletico");
  document.getElementById("corso-costo-istruttore").value = corso.costoIstruttoreOra != null ? corso.costoIstruttoreOra : "";
  document.getElementById("corso-costo-campo").value = corso.costoCampoOrganizzazioneOra != null ? corso.costoCampoOrganizzazioneOra : "";
  document.getElementById("corso-costo-materiale").value = corso.costoMateriale != null ? corso.costoMateriale : "";
  document.getElementById("corso-prezzo-richiesto").value = corso.prezzoRichiesto != null ? corso.prezzoRichiesto : "";

  aggiornaCostoCalcolato();

  document.getElementById("corso-form-title").querySelector("h2").textContent = "Modifica corso";
  document.getElementById("corso-save-btn").textContent = "Salva modifiche";
  document.getElementById("corso-cancel-edit-btn").classList.remove("hidden");
  document.getElementById("corso-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditCorso() {
  editingCorsoId = null;
  document.getElementById("corso-form").reset();
  syncOrariCampiDisciplina();
  aggiornaCostoCalcolato();
  document.getElementById("corso-form-title").querySelector("h2").textContent = "Nuovo corso";
  document.getElementById("corso-save-btn").textContent = "Crea corso";
  document.getElementById("corso-cancel-edit-btn").classList.add("hidden");
}

async function onSubmitCorso(e) {
  e.preventDefault();
  const btn = document.getElementById("corso-save-btn");
  const errorEl = document.getElementById("corso-form-error");
  errorEl.innerHTML = "";
  btn.disabled = true;

  const form = leggiFormCorso();

  try {
    if (!form.nome) throw new Error("Inserisci il nome del corso.");
    if (!form.disciplina) throw new Error("Seleziona la disciplina.");
    if (!form.dal) throw new Error("Inserisci la data di inizio (Dal).");
    if (!form.nrSessioni || form.nrSessioni < 1) throw new Error("Inserisci il numero di sessioni.");
    if (!form.durataSessioneMinuti) throw new Error("Inserisci la durata di una sessione.");
    if (Object.keys(form.giorniOrari).length === 0) throw new Error("Seleziona almeno un orario per almeno un giorno.");
    if (form.campiNumeri.length === 0) throw new Error("Seleziona almeno un campo proposto.");
    if (!form.minIscrittiConferma) throw new Error("Inserisci il numero minimo di iscritti per la conferma.");
    if (form.prezzoRichiesto == null) throw new Error("Inserisci il prezzo richiesto.");

    const payload = {
      ...form,
      costoTotalePartecipante: calcolaCostoPerPartecipante(form),
      attivo: true
    };

    if (editingCorsoId) {
      await db.collection("corsi").doc(editingCorsoId).update(payload);
    } else {
      payload.creatoDaUid = currentProfile.uid;
      payload.creatoDaNome = currentProfile.nome;
      payload.approvato = false;
      payload.approvatoDaUid = null;
      payload.approvatoDaNome = null;
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("corsi").add(payload);
    }

    cancelEditCorso();
    await loadCorsi();
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "corsi:gestisci") && !hasPermission(profile, "corsi:approva")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("corsi-content").classList.add("hidden");
    return;
  }

  if (!hasPermission(profile, "corsi:gestisci")) {
    document.getElementById("corso-form").classList.add("hidden");
    document.getElementById("corso-form-title").classList.add("hidden");
  }

  await loadDiscipline();
  await loadCampi();

  populateSelect(document.getElementById("corso-disciplina"), DISCIPLINE);
  syncOrariCampiDisciplina();

  document.getElementById("corso-disciplina").addEventListener("change", syncOrariCampiDisciplina);

  ["corso-nrsessioni", "corso-durata", "corso-costo-istruttore", "corso-costo-campo",
    "corso-costo-materiale", "corso-min-iscritti"]
    .forEach(id => document.getElementById(id).addEventListener("input", aggiornaCostoCalcolato));

  document.getElementById("corso-form").addEventListener("submit", onSubmitCorso);
  document.getElementById("corso-cancel-edit-btn").addEventListener("click", cancelEditCorso);

  if (hasPermission(profile, "iscrizioni:gestisci")) {
    document.getElementById("riepilogo-sezione").classList.remove("hidden");
    document.getElementById("riepilogo-data").value = toISODate(new Date());
    document.getElementById("riepilogo-data").addEventListener("change", aggiornaRiepiloghi);
    document.getElementById("stampa-settimanale-btn").addEventListener("click", stampaRiepilogoSettimanale);
    await loadIscrizioniConfermate();
  }

  await loadCorsi();

  if (hasPermission(profile, "iscrizioni:gestisci")) {
    aggiornaRiepiloghi();
  }
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
