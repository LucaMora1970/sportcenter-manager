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
let iscrizioniInAttesaCache = [];
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
    ordine: num("corso-ordine"),
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
    const giorniOrariRighe = Object.entries(c.giorniOrari || {})
      .map(([g, orari]) => `<div class="entry-meta">${(GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g}: ${orari.join(", ")}</div>`)
      .join("") || `<div class="entry-meta">—</div>`;
    const campiLabel = (c.campiNumeri || []).map(n => "Campo " + n).join(", ") || "—";
    return `
    <div class="dipendente-block corso-card" data-id="${c.id}">
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${c.approvato ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"}">${c.approvato ? "Approvato" : "Bozza"}</span>
          <span class="badge ${c.disciplina}">${escapeHtml(disciplinaLabel(c.disciplina))}</span>
          <div class="entry-tipo">${escapeHtml(c.nome)}</div>
          ${puoVedereIscrizioni && c.approvato ? contatoreIscrittiHtml(c) : ""}
          ${terminIscrizioneHtml(c)}
          <div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · ${c.nrSessioni || "—"} sessioni da ${c.durataSessioneMinuti || "—"}' · campi: ${campiLabel}</div>
          <div class="entry-meta giorni-toggle" data-id="${c.id}">+ Giorni e orari proposti</div>
          <div class="hidden" id="giorni-dettaglio-${c.id}">${giorniOrariRighe}</div>
          <div class="entry-meta">Creato da ${escapeHtml(c.creatoDaNome || "—")}${c.approvato ? " · approvato da " + escapeHtml(c.approvatoDaNome || "—") : ""}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${puoGestire ? `<button class="btn btn-ghost edit-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Modifica</button>` : ""}
          ${puoApprovare && !c.approvato ? `<button class="btn btn-primary approva-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Approva</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-primary iscrivi-allievo-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Iscrivi un allievo</button>` : ""}
          ${c.approvato ? `<button class="btn btn-ghost link-diretto-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Copia link diretto</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost iscrizioni-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Iscrizioni</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost panoramica-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Panoramica</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost stampa-lista-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Stampa / PDF</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost storico-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Storico</button>` : ""}
          ${puoGestire ? `<button class="btn btn-danger delete-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Elimina</button>` : ""}
        </div>
      </div>
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="iscrizioni-${c.id}"></div>` : ""}
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="panoramica-${c.id}"></div>` : ""}
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="storico-${c.id}"></div>` : ""}
    </div>
  `;
  }).join("");

  list.querySelectorAll(".giorni-toggle").forEach(el => {
    el.addEventListener("click", () => {
      const dettaglio = document.getElementById(`giorni-dettaglio-${el.dataset.id}`);
      const aperto = !dettaglio.classList.contains("hidden");
      dettaglio.classList.toggle("hidden");
      el.textContent = (aperto ? "+ " : "− ") + "Giorni e orari proposti";
    });
  });

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

  list.querySelectorAll(".iscrivi-allievo-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      window.open(basePageUrl() + "iscrizione-corso.html?corso=" + btn.dataset.id, "_blank");
    });
  });

  list.querySelectorAll(".link-diretto-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const link = basePageUrl() + "iscrizione-corso.html?corso=" + btn.dataset.id;
      copyToClipboard(link, btn);
    });
  });

  list.querySelectorAll(".iscrizioni-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleIscrizioniCorso(btn.dataset.id));
  });

  list.querySelectorAll(".panoramica-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => togglePanoramicaCorso(btn.dataset.id));
  });

  list.querySelectorAll(".stampa-lista-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => stampaListaCorso(btn.dataset.id));
  });

  list.querySelectorAll(".storico-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleStoricoCorso(btn.dataset.id));
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

function nomeEta(i) {
  const eta = etaDa(i.dataNascita);
  return `${escapeHtml(i.nome)} ${escapeHtml(i.cognome)}${eta != null ? " (" + eta + ")" : ""}`;
}

// Il semaforo di un candidato vale solo per lo slot per cui è stato messo
// (semaforoGiorno/semaforoOrario): la stessa persona può comparire come
// candidata in più slot se ha flaggato più disponibilità, e qui vogliamo
// vedere il suo stato SOLO nello slot che stiamo guardando.
function semaforoPerSlot(i, giorno, orario) {
  return (i.semaforoGiorno === giorno && i.semaforoOrario === orario) ? i.semaforo || null : null;
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

    // Se il corso propone più campi per lo stesso giorno/orario, da qui
    // possono nascere più gruppi paralleli (uno per campo): ogni iscritto
    // ha il proprio selettore campo, non è un'unica scelta per lo slot.
    const piuCampi = (corso.campiNumeri || []).length > 1;
    const campoOptions = (corso.campiNumeri || []).map(n => `<option value="${n}">Campo ${n}</option>`).join("");

    const righeConfermati = confermati.map(i => `
      <div class="candidato-row">
        <span class="candidato-nome">${nomeEta(i)}</span>
        ${piuCampi && i.campoAssegnato ? `<span class="candidato-nome">Campo ${escapeHtml(i.campoAssegnato)}</span>` : ""}
      </div>
    `).join("");

    const righeCandidati = candidati.map(i => {
      const attuale = semaforoPerSlot(i, c.giorno, c.orario);
      const dot = (colore) => `<button type="button" class="semaforo-dot ${colore}" data-selected="${attuale === colore}" data-id="${i.id}" data-giorno="${c.giorno}" data-orario="${c.orario}" data-colore="${colore}" aria-label="${colore}"></button>`;
      const campoSelect = piuCampi ? `<select class="candidato-campo-select" data-id="${i.id}" style="font-size:0.7rem;padding:3px 4px;">${campoOptions}</select>` : "";
      return `
        <div class="candidato-row">
          <span class="candidato-nome">${nomeEta(i)}</span>
          <span class="semaforo">${campoSelect}${dot("rosso")}${dot("giallo")}${dot("verde")}</span>
        </div>
      `;
    }).join("");

    html += `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${bastante ? "border-color:#7f9e4a;color:#c1e08f;" : "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);"}">${totale} ${totale === 1 ? "persona" : "persone"}${corso.minIscrittiConferma ? " / min " + corso.minIscrittiConferma : ""}</span>
          <div class="entry-tipo">${c.orario}</div>
          ${piuCampi ? `<div class="entry-meta">Campi proposti: ${(corso.campiNumeri || []).join(", ")} — puoi formare più gruppi paralleli, uno per campo</div>` : ""}
          ${confermati.length > 0 ? `<div class="entry-meta" style="margin-top:10px;">Confermati</div>${righeConfermati}` : ""}
          ${candidati.length > 0 ? `<div class="entry-meta" style="margin-top:10px;">In attesa</div>${righeCandidati}` : ""}
          ${candidati.length > 0 ? `<button type="button" class="btn btn-primary conferma-gruppo-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;margin-top:10px;" data-corso="${corso.id}" data-giorno="${c.giorno}" data-orario="${c.orario}">Conferma gruppo</button>` : ""}
        </div>
      </div>
    `;
  });

  container.innerHTML = html
    ? `<button type="button" class="btn btn-ghost stampa-panoramica-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;margin-bottom:10px;" data-corso="${corso.id}">Stampa / PDF panoramica</button>${html}`
    : `<div class="empty-state"><div class="display">Nessuna disponibilità ricevuta ancora</div></div>`;

  container.querySelectorAll(".semaforo-dot").forEach(btn => {
    btn.addEventListener("click", () => impostaSemaforo(btn.dataset.id, btn.dataset.giorno, btn.dataset.orario, btn.dataset.colore, corso.id));
  });
  container.querySelectorAll(".conferma-gruppo-btn").forEach(btn => {
    btn.addEventListener("click", () => confermaGruppoSlot(btn.dataset.corso, btn.dataset.giorno, btn.dataset.orario, container));
  });
  const stampaBtn = container.querySelector(".stampa-panoramica-btn");
  if (stampaBtn) stampaBtn.addEventListener("click", () => stampaPanoramicaCorso(corso.id, iscrizioni));
}

// Stampa un'istantanea della Panoramica così com'è in quel momento (con i
// semafori) — pensata per essere usata più volte durante la valutazione,
// non solo a decisione presa.
const SEMAFORO_LABEL = { rosso: "Rosso", giallo: "Giallo", verde: "Verde" };

function stampaPanoramicaCorso(corsoId, iscrizioni) {
  const corso = corsiCache.find(c => c.id === corsoId);
  if (!corso) return;
  const combinazioni = combinazioniCorso(corso);

  let righe = "";
  combinazioni.forEach(c => {
    const candidati = iscrizioni.filter(i => i.stato === "in_attesa" && (i.disponibilita?.[c.giorno] || []).includes(c.orario));
    const confermati = iscrizioni.filter(i => i.stato === "confermata" && i.giornoAssegnato === c.giorno && i.orarioAssegnato === c.orario);
    if (candidati.length === 0 && confermati.length === 0) return;

    confermati.forEach(i => {
      righe += `<tr><td>${c.giornoLabel} ${c.orario}</td><td>${i.campoAssegnato ? "Campo " + escapeHtml(i.campoAssegnato) : "—"}</td><td>${nomeEta(i)}</td><td>Confermato</td></tr>`;
    });
    candidati.forEach(i => {
      const colore = semaforoPerSlot(i, c.giorno, c.orario);
      righe += `<tr><td>${c.giornoLabel} ${c.orario}</td><td>—</td><td>${nomeEta(i)}</td><td>${colore ? SEMAFORO_LABEL[colore] : "Da valutare"}</td></tr>`;
    });
  });

  document.getElementById("print-area").innerHTML = `
    <h1>Panoramica — ${escapeHtml(corso.nome)}</h1>
    <p>Istantanea del ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <thead><tr><th>Slot</th><th>Campo</th><th>Nominativo</th><th>Valutazione</th></tr></thead>
      <tbody>${righe}</tbody>
    </table>
  `;
  window.print();
}

// Storico immutabile: una riga per ogni azione che cambia lo stato di
// un'iscrizione, per poter ricostruire cosa è successo in caso di errori
// di organizzazione/attribuzione. Non blocca l'azione principale se il
// log fallisce (es. rete) — meglio un log mancante che un'azione bloccata.
async function registraLog(iscrizioneId, corsoId, iscrittoNome, azione, dettaglio) {
  try {
    await db.collection("iscrizioniLog").add({
      iscrizioneId,
      corsoId,
      iscrittoNome,
      azione,
      dettaglio,
      daUid: currentProfile.uid,
      daNome: currentProfile.nome,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn("registraLog fallito:", err.message);
  }
}

// Rimettere lo stesso colore già selezionato lo toglie (torna neutro).
async function impostaSemaforo(iscrizioneId, giorno, orario, colore, corsoId) {
  try {
    const doc = await db.collection("iscrizioniCorsi").doc(iscrizioneId).get();
    const attuale = doc.data();
    const giaSelezionato = attuale.semaforoGiorno === giorno && attuale.semaforoOrario === orario && attuale.semaforo === colore;
    const nomeCompleto = `${attuale.nome} ${attuale.cognome}`;
    const giornoLabel = (GIORNI_SETTIMANA.find(g => g.id === giorno) || {}).label || giorno;

    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update(
      giaSelezionato
        ? { semaforo: null, semaforoGiorno: null, semaforoOrario: null }
        : { semaforo: colore, semaforoGiorno: giorno, semaforoOrario: orario }
    );
    await registraLog(iscrizioneId, corsoId, nomeCompleto,
      giaSelezionato ? "semaforo_rimosso" : "semaforo",
      giaSelezionato ? `Tolto ${colore} su ${giornoLabel} ${orario}` : `${colore} su ${giornoLabel} ${orario}`);
    await ricaricaPanoramicaSeAperta(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Conferma in blocco solo chi è segnato verde per QUESTO slot — chi è
// giallo/rosso, o verde per un altro slot, resta in attesa. Salta (con
// avviso) chi ha richiesto meno ore di quante ne dura questa sessione:
// non possiamo confermarlo per più ore di quante ne abbia chieste.
async function confermaGruppoSlot(corsoId, giorno, orario, container) {
  const corso = corsiCache.find(c => c.id === corsoId);
  if (!corso) return;

  const snap = await db.collection("iscrizioniCorsi")
    .where("corsoId", "==", corsoId)
    .where("stato", "==", "in_attesa")
    .get();
  const candidatiVerdi = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(i => i.semaforoGiorno === giorno && i.semaforoOrario === orario && i.semaforo === "verde");

  if (candidatiVerdi.length === 0) {
    alert("Nessun iscritto segnato verde per questo slot.");
    return;
  }

  // Con un solo campo proposto non c'è scelta da fare; con più campi si
  // legge quello scelto da ciascuno nel proprio selettore (permette di
  // formare più gruppi paralleli in un'unica conferma).
  const unicoCampo = (corso.campiNumeri || []).length === 1 ? corso.campiNumeri[0] : null;
  candidatiVerdi.forEach(i => {
    const select = container?.querySelector(`.candidato-campo-select[data-id="${i.id}"]`);
    i.campoAssegnato = select ? select.value : unicoCampo;
  });

  const oreSessione = (corso.durataSessioneMinuti || 0) / 60;
  const daConfermare = candidatiVerdi.filter(i => !i.nrOreDesiderate || i.nrOreDesiderate >= oreSessione);
  const saltati = candidatiVerdi.filter(i => i.nrOreDesiderate && i.nrOreDesiderate < oreSessione);

  if (saltati.length > 0) {
    const nomi = saltati.map(i => `${i.nome} ${i.cognome} (ha chiesto ${i.nrOreDesiderate}h, la sessione dura ${oreSessione}h)`).join("\n");
    if (!confirm(`Questi iscritti hanno richiesto meno ore di quante dura la sessione e NON verranno confermati:\n\n${nomi}\n\nProseguire con gli altri ${daConfermare.length}?`)) return;
  }
  if (daConfermare.length === 0) return;

  const giornoLabel = (GIORNI_SETTIMANA.find(g => g.id === giorno) || {}).label || giorno;

  try {
    const batch = db.batch();
    daConfermare.forEach(i => {
      batch.update(db.collection("iscrizioniCorsi").doc(i.id), {
        stato: "confermata",
        giornoAssegnato: giorno,
        orarioAssegnato: orario,
        campoAssegnato: i.campoAssegnato || null,
        semaforo: null,
        semaforoGiorno: null,
        semaforoOrario: null,
        motivoRifiuto: null,
        gestitaDaUid: currentProfile.uid,
        gestitaDaNome: currentProfile.nome
      });
    });
    await batch.commit();
    await Promise.all(daConfermare.map(i =>
      registraLog(i.id, corsoId, `${i.nome} ${i.cognome}`, "confermato",
        `Confermato su ${giornoLabel} ${orario}${i.campoAssegnato ? " Campo " + i.campoAssegnato : ""} (conferma gruppo)`)
    ));
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
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

    const piuCampi = (corso.campiNumeri || []).length > 1;
    const selectSlot = i.stato === "in_attesa" ? `
      <select class="assegna-slot-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;">
        ${combinazioni.map(c => `<option value="${c.giorno}|${c.orario}">${c.giornoLabel} ${c.orario}${disponibileSet.has(`${c.giorno}|${c.orario}`) ? " ✓" : ""}</option>`).join("")}
      </select>
      ${piuCampi ? `<select class="assegna-campo-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;margin-top:6px;">${(corso.campiNumeri || []).map(n => `<option value="${n}">Campo ${n}</option>`).join("")}</select>` : ""}
    ` : "";

    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge" style="${statoStyle[i.stato] || statoStyle.in_attesa}">${statoLabel[i.stato] || i.stato}</span>
          <div class="entry-tipo">${escapeHtml(i.nome)} ${escapeHtml(i.cognome)}${eta != null ? " · " + eta + " anni" : ""}</div>
          ${i.inseritaDaStaff ? `<div class="entry-meta">Inserita dallo staff (${escapeHtml(i.inseritaDaNome || "—")})</div>` : ""}
          <div class="entry-meta">${escapeHtml(i.email)}${i.nrOreDesiderate ? " · " + i.nrOreDesiderate + "h/sett." : ""}${i.scuolaFrequentata ? " · " + escapeHtml(i.scuolaFrequentata) : ""}</div>
          ${i.nomeGenitore || i.telefonoGenitore ? `<div class="entry-meta">Genitore: ${escapeHtml(i.nomeGenitore || "—")}${i.telefonoGenitore ? " · " + escapeHtml(i.telefonoGenitore) : ""}</div>` : ""}
          <div class="entry-meta">Disponibilità: ${disponibilitaLabel}</div>
          ${i.stato === "confermata" && i.giornoAssegnato ? `<div class="entry-meta">Assegnato: ${(GIORNI_SETTIMANA.find(x => x.id === i.giornoAssegnato) || {}).label || i.giornoAssegnato} ${i.orarioAssegnato}${i.campoAssegnato ? " · Campo " + escapeHtml(i.campoAssegnato) : ""}</div>` : ""}
          ${i.stato === "annullata" && i.motivoRifiuto ? `<div class="entry-meta">Motivo: ${escapeHtml(i.motivoRifiuto)}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${selectSlot}
          ${i.stato === "in_attesa" ? `<button class="btn btn-primary conferma-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}" data-nome="${escapeHtml(i.nome + " " + i.cognome)}">Conferma in questo slot</button>` : ""}
          ${i.stato === "in_attesa" ? `<button class="btn btn-danger annulla-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}" data-nome="${escapeHtml(i.nome + " " + i.cognome)}">Rifiuta</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".conferma-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const select = container.querySelector(`.assegna-slot-select[data-id="${btn.dataset.id}"]`);
      const [giorno, orario] = select.value.split("|");
      const campoSelect = container.querySelector(`.assegna-campo-select[data-id="${btn.dataset.id}"]`);
      const campo = campoSelect ? campoSelect.value : ((corso.campiNumeri || []).length === 1 ? corso.campiNumeri[0] : null);
      confermaIscrizione(btn.dataset.id, btn.dataset.corso, giorno, orario, btn.dataset.nome, campo);
    });
  });
  container.querySelectorAll(".annulla-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => rifiutaIscrizione(btn.dataset.id, btn.dataset.corso, btn.dataset.nome));
  });
}

// Conferma l'iscritto nello slot scelto nel select — può essere diverso da
// quanto aveva flaggato come disponibile (spostamento previo suo accordo,
// concordato fuori dall'app: qui si registra solo l'esito).
async function confermaIscrizione(iscrizioneId, corsoId, giorno, orario, nome, campo) {
  const giornoLabel = (GIORNI_SETTIMANA.find(g => g.id === giorno) || {}).label || giorno;
  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      stato: "confermata",
      giornoAssegnato: giorno,
      orarioAssegnato: orario,
      campoAssegnato: campo || null,
      motivoRifiuto: null,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await registraLog(iscrizioneId, corsoId, nome, "confermato", `Confermato su ${giornoLabel} ${orario}${campo ? " Campo " + campo : ""}`);
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Chiede un motivo (es. "numero insufficiente di iscritti nella fascia
// richiesta") così lo staff ha una nota pronta per avvisare l'interessato.
async function rifiutaIscrizione(iscrizioneId, corsoId, nome) {
  const motivo = prompt("Motivo del rifiuto (es. numero insufficiente di iscritti nella fascia richiesta) — verrà usato per avvisare l'interessato:", "Numero insufficiente di iscritti nella fascia richiesta");
  if (motivo === null) return;

  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      stato: "annullata",
      motivoRifiuto: motivo,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await registraLog(iscrizioneId, corsoId, nome, "rifiutato", motivo);
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// ---------- Riepilogo giornaliero/settimanale (gruppi confermati) ----------

async function loadIscrizioniConfermate() {
  const snap = await db.collection("iscrizioniCorsi").where("stato", "==", "confermata").get();
  iscrizioniConfermateCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadIscrizioniInAttesa() {
  const snap = await db.collection("iscrizioniCorsi").where("stato", "==", "in_attesa").get();
  iscrizioniInAttesaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Conteggio iscritti per corso, visibile in elenco senza dover aprire
// Iscrizioni/Panoramica — usa le stesse cache già caricate per il
// riepilogo giornaliero/settimanale (nessuna lettura extra a Firestore).
function conteggioIscrittiCorso(corsoId) {
  const confermati = iscrizioniConfermateCache.filter(i => i.corsoId === corsoId).length;
  const inAttesa = iscrizioniInAttesaCache.filter(i => i.corsoId === corsoId).length;
  return { confermati, inAttesa, totale: confermati + inAttesa };
}

function contatoreIscrittiHtml(corso) {
  const { confermati, inAttesa, totale } = conteggioIscrittiCorso(corso.id);
  const bastante = corso.minIscrittiConferma && confermati >= corso.minIscrittiConferma;
  return `<span class="badge" id="corso-contatore-${corso.id}" style="${bastante ? "border-color:#7f9e4a;color:#c1e08f;" : ""}">${totale} iscritt${totale === 1 ? "o" : "i"} (${confermati} conf. · ${inAttesa} in attesa)</span>`;
}

// Data di chiusura iscrizioni ben visibile in elenco, colorata in base
// all'urgenza — chiusa/entro 7 giorni/normale — così non serve aprire il
// corso per accorgersi che le iscrizioni stanno per finire.
function terminIscrizioneHtml(corso) {
  if (!corso.terminIscrizione) return "";
  const oggi = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
  const termine = new Date(corso.terminIscrizione + "T00:00:00");
  const giorni = Math.round((termine - oggi) / 86400000);

  let stile = "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);";
  let testo = `Chiusura iscrizioni: ${formatDataBreve(corso.terminIscrizione)}`;
  if (giorni < 0) {
    stile = "border-color:var(--danger);color:var(--danger);";
    testo = `Iscrizioni chiuse dal ${formatDataBreve(corso.terminIscrizione)}`;
  } else if (giorni <= 7) {
    stile = "border-color:#d4b83a;color:#e0c85a;";
    testo = `Chiusura iscrizioni tra ${giorni}g (${formatDataBreve(corso.terminIscrizione)})`;
  }
  return `<span class="badge" style="${stile}">${testo}</span>`;
}

// Aggiorna solo il badge contatore di un corso nel DOM (senza ridisegnare
// l'intera scheda) dopo conferma/rifiuto/formazione gruppo, così eventuali
// pannelli Iscrizioni/Panoramica/Storico già aperti restano al loro posto.
function aggiornaContatoreCorso(corsoId) {
  const el = document.getElementById(`corso-contatore-${corsoId}`);
  const corso = corsiCache.find(c => c.id === corsoId);
  if (!el || !corso) return;
  el.outerHTML = contatoreIscrittiHtml(corso);
}

async function aggiornaContatoriDopoModifica(corsoId) {
  await loadIscrizioniConfermate();
  await loadIscrizioniInAttesa();
  aggiornaContatoreCorso(corsoId);
  if (hasPermission(currentProfile, "iscrizioni:gestisci")) aggiornaRiepiloghi();
}

// Raggruppa le iscrizioni confermate per corso+giorno+orario assegnati, poi
// tiene solo i gruppi la cui data generata (dal + giorno della settimana,
// ripetuto per nrSessioni volte) include dataIso.
// Un gruppo è per corso+giorno+orario+campo: se il corso propone più campi
// nello stesso giorno/orario possono coesistere più gruppi paralleli
// (uno per campo), da mostrare come voci separate — non un unico elenco
// che mischia chi gioca su campi diversi allo stesso orario.
function gruppiConfermatiPerData(dataIso) {
  const gruppiMap = {};
  iscrizioniConfermateCache.forEach(i => {
    if (!i.giornoAssegnato || !i.orarioAssegnato) return;
    const corso = corsiCache.find(c => c.id === i.corsoId);
    if (!corso) return;
    const key = `${i.corsoId}|${i.giornoAssegnato}|${i.orarioAssegnato}|${i.campoAssegnato || ""}`;
    if (!gruppiMap[key]) {
      gruppiMap[key] = { corso, giorno: i.giornoAssegnato, orario: i.orarioAssegnato, campo: i.campoAssegnato || null, iscritti: [] };
    }
    gruppiMap[key].iscritti.push(i);
  });

  return Object.values(gruppiMap)
    .filter(g => generaCalendarioSessioni(g.corso.dal, g.corso.nrSessioni, g.giorno, g.orario, g.corso.durataSessioneMinuti)
      .some(s => s.data === dataIso))
    .sort((a, b) => a.orario.localeCompare(b.orario) || (a.campo || "").localeCompare(b.campo || ""));
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
        <div class="entry-tipo">${g.orario}${g.campo ? " · Campo " + escapeHtml(g.campo) : ""} · ${escapeHtml(g.corso.nome)}</div>
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
          <td>${g.campo ? "Campo " + escapeHtml(g.campo) : "—"}</td>
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
      <thead><tr><th>Giorno</th><th>Orario</th><th>Campo</th><th>Corso</th><th>Disciplina</th><th>Iscritti</th></tr></thead>
      <tbody>${righe}</tbody>
    </table>
  `;
  window.print();
}

// Lista stampabile di tutti gli iscritti di un corso (qualunque stato),
// con lo slot assegnato per i confermati — utile come lista da portare
// alla prima sessione o per condividerla con lo staff.
async function stampaListaCorso(corsoId) {
  const corso = corsiCache.find(c => c.id === corsoId);
  if (!corso) return;

  const snap = await db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get();
  const iscrizioni = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.cognome || "").localeCompare(b.cognome || ""));

  const statoLabel = { in_attesa: "In attesa", confermata: "Confermata", annullata: "Annullata" };

  const righe = iscrizioni.map(i => {
    const eta = etaDa(i.dataNascita);
    const slot = i.stato === "confermata" && i.giornoAssegnato
      ? `${(GIORNI_SETTIMANA.find(g => g.id === i.giornoAssegnato) || {}).label || i.giornoAssegnato} ${i.orarioAssegnato}${i.campoAssegnato ? " Campo " + i.campoAssegnato : ""}`
      : "—";
    return `
      <tr>
        <td>${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}</td>
        <td>${eta != null ? eta : "—"}</td>
        <td>${statoLabel[i.stato] || i.stato}</td>
        <td>${slot}</td>
        <td>${escapeHtml(i.email || "")}</td>
        <td>${escapeHtml(i.telefonoGenitore || "")}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("print-area").innerHTML = `
    <h1>${escapeHtml(corso.nome)}</h1>
    <p>${formatDataBreve(corso.dal)}${corso.al ? " – " + formatDataBreve(corso.al) : ""} · ${escapeHtml(disciplinaLabel(corso.disciplina))} · ${iscrizioni.length} iscritti</p>
    <table>
      <thead><tr><th>Nominativo</th><th>Età</th><th>Stato</th><th>Slot assegnato</th><th>Email</th><th>Telefono genitore</th></tr></thead>
      <tbody>${righe}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Storico azioni (permesso iscrizioni:gestisci) ----------

const AZIONE_LABEL = {
  semaforo: "Semaforo impostato",
  semaforo_rimosso: "Semaforo tolto",
  confermato: "Confermato",
  rifiutato: "Rifiutato"
};

async function toggleStoricoCorso(corsoId) {
  const container = document.getElementById(`storico-${corsoId}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  container.classList.remove("hidden");

  // Niente orderBy nella query (eviterebbe un indice composito con
  // corsoId==): si ordina lato client per data decrescente.
  const snap = await db.collection("iscrizioniLog").where("corsoId", "==", corsoId).get();
  const log = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

  if (log.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="display">Nessuna azione registrata ancora</div></div>`;
    return;
  }

  container.innerHTML = log.map(l => `
    <div class="entry-card">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(l.iscrittoNome || "—")}</div>
        <div class="entry-meta">${AZIONE_LABEL[l.azione] || l.azione}${l.dettaglio ? " — " + escapeHtml(l.dettaglio) : ""}</div>
        <div class="entry-meta">${l.createdAt ? l.createdAt.toDate().toLocaleString("it-CH") : "—"} · ${escapeHtml(l.daNome || "—")}</div>
      </div>
    </div>
  `).join("");
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
  document.getElementById("corso-ordine").value = corso.ordine != null ? corso.ordine : "";
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

  initLinkCopyBox("link-iscrizione", "copia-link-iscrizione-btn", "iscrizione-corso.html");

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
    await loadIscrizioniInAttesa();
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
