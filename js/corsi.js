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
let livelliCorsoCache = []; // [{livello, nome, ...}] attivi, per il <select> livello
let gruppiCorsoCache = []; // [{id, corsoId, giorno, orario, campo, ...}] dal modulo di programmazione
let iscrizioniConfermateCache = [];
let iscrizioniInAttesaCache = [];
let editingCorsoId = null;

async function loadLivelliCorso() {
  try {
    const snap = await db.collection("livelliCorso").get();
    livelliCorsoCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(l => l.attivo !== false)
      .sort((a, b) => (a.ordine ?? a.livello ?? 99) - (b.ordine ?? b.livello ?? 99));
  } catch (err) {
    console.warn("loadLivelliCorso:", err.message);
    livelliCorsoCache = [];
  }
}

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

// ---------- Corso personalizzato forfettario ----------

// Wrapper dei campi che non hanno senso per un corso forfettario (dettagli
// liberi, senza giorni/orari/sessioni/soglie): vengono nascosti nel form e
// salvati a null/{}/[] in leggiFormCorso().
const CAMPI_NON_FORFETTARIO = [
  "corso-row-sessioni", "corso-field-giorniorari", "corso-field-campi",
  "corso-row-eta", "corso-row-iscritti", "corso-nota-calendario",
  "corso-hr-istruttori", "corso-field-livelli", "corso-row-costi1",
  "corso-field-materiale", "corso-scoreboard-costo"
];

function syncForfettario() {
  const forfettario = document.getElementById("corso-forfettario").checked;
  CAMPI_NON_FORFETTARIO.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", forfettario);
  });
  // I campi nascosti con l'attributo required bloccherebbero il submit
  // ("invalid form control is not focusable") pur non essendo visibili.
  ["corso-nrsessioni", "corso-durata", "corso-min-iscritti"].forEach(id => {
    document.getElementById(id).required = !forfettario;
  });
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

  const forfettario = document.getElementById("corso-forfettario").checked;

  const form = {
    nome: document.getElementById("corso-nome").value.trim(),
    descrizione: document.getElementById("corso-descrizione").value.trim(),
    disciplina: document.getElementById("corso-disciplina").value,
    dal: document.getElementById("corso-dal").value,
    al: document.getElementById("corso-al").value || null,
    forfettario,
    nrSessioni: num("corso-nrsessioni"),
    durataSessioneMinuti: num("corso-durata"),
    giorniOrari,
    campiNumeri,
    etaMin: num("corso-eta-min"),
    etaMax: num("corso-eta-max"),
    maxIscrittiPerSessione: num("corso-max-iscritti"),
    minIscrittiConferma: num("corso-min-iscritti"),
    tokenizzazioneAttiva: document.getElementById("corso-tokenizzazione").checked,
    terminIscrizione: document.getElementById("corso-termine-iscrizione").value || null,
    ordine: num("corso-ordine"),
    condizioniGenerali: document.getElementById("corso-condizioni").value.trim(),
    livelloIstruttori,
    costoIstruttoreOra: num("corso-costo-istruttore"),
    costoCampoOrganizzazioneOra: num("corso-costo-campo"),
    costoMateriale: num("corso-costo-materiale"),
    prezzoRichiesto: num("corso-prezzo-richiesto")
  };

  // Corso forfettario: i campi di calendario/soglie/costi non fanno parte
  // della proposta — vengono azzerati a prescindere da eventuali valori
  // residui nei campi nascosti (es. dopo aver spuntato il toggle).
  if (forfettario) {
    Object.assign(form, {
      nrSessioni: null, durataSessioneMinuti: null,
      giorniOrari: {}, campiNumeri: [],
      etaMin: null, etaMax: null,
      maxIscrittiPerSessione: null, minIscrittiConferma: null,
      livelloIstruttori: [],
      costoIstruttoreOra: null, costoCampoOrganizzazioneOra: null, costoMateriale: null
    });
  }

  return form;
}

// ---------- Costo per partecipante, aggiornato dal vivo ----------

function aggiornaCostoCalcolato() {
  const costoEl = document.getElementById("corso-costo-calcolato");
  if (document.getElementById("corso-forfettario").checked) {
    costoEl.textContent = "CHF —";
    return;
  }
  const form = leggiFormCorso();
  const costo = calcolaCostoPerPartecipante(form);
  costoEl.textContent = costo != null
    ? `CHF ${costo.toFixed(2)} (÷ ${form.minIscrittiConferma} iscritti)`
    : "CHF —";
}

// ---------- Elenco corsi ----------

async function loadCorsi() {
  const list = document.getElementById("corsi-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("corsi").get();
  // Stesso criterio della pagina pubblica di iscrizione: ordine numerico
  // crescente (corsi senza "ordine" in fondo), a parità la data di inizio.
  corsiCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.ordine ?? Infinity) - (b.ordine ?? Infinity) || a.dal.localeCompare(b.dal));
  renderCorsi();
}

// Foto disciplina già configurata in Configurazione → Foto discipline
// (stesso FOTO_DISCIPLINE consumato da tcm.html) — Tennis non ha una
// posizione a livello di corso (solo campiNumeri), quindi si preferisce
// la foto Interno con ripiego su Esterno se mancante.
function fotoDisciplinaCorsi(disciplinaId) {
  if (disciplinaId === "tennis") return FOTO_DISCIPLINE.tennisInterno || FOTO_DISCIPLINE.tennisEsterno || "";
  return FOTO_DISCIPLINE[disciplinaId] || "";
}

let filtroDisciplinaCorsi = "tutti";

function corsoCardHtml(c, { puoGestire, puoVedereIscrizioni, puoApprovare }) {
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
          ${c.forfettario
            ? `<div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · Forfait · CHF ${(c.prezzoRichiesto || 0).toFixed(2)}</div>`
            : `<div class="entry-meta">${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · ${c.nrSessioni || "—"} sessioni da ${c.durataSessioneMinuti || "—"}' · campi: ${campiLabel}</div>
          <div class="entry-meta giorni-toggle" data-id="${c.id}">+ Giorni e orari proposti</div>
          <div class="hidden" id="giorni-dettaglio-${c.id}">${giorniOrariRighe}</div>`}
          <div class="entry-meta">Creato da ${escapeHtml(c.creatoDaNome || "—")}${c.approvato ? " · approvato da " + escapeHtml(c.approvatoDaNome || "—") : ""}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${puoGestire ? `<button class="btn btn-ghost edit-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Modifica</button>` : ""}
          ${puoApprovare && !c.approvato ? `<button class="btn btn-primary approva-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Approva</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-primary iscrivi-allievo-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Iscrivi un allievo</button>` : ""}
          ${c.approvato ? `<button class="btn btn-ghost link-diretto-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Copia link diretto</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost iscrizioni-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Iscrizioni</button>` : ""}
          ${puoVedereIscrizioni && c.approvato && !c.forfettario ? `<button class="btn btn-ghost panoramica-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Panoramica</button>` : ""}
          ${puoVedereIscrizioni && c.approvato && !c.forfettario ? `<button class="btn btn-ghost programmazione-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Programmazione</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost stampa-lista-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Stampa / PDF</button>` : ""}
          ${puoVedereIscrizioni && c.approvato ? `<button class="btn btn-ghost storico-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Storico</button>` : ""}
          ${puoGestire ? `<button class="btn btn-danger delete-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Elimina</button>` : ""}
        </div>
      </div>
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="iscrizioni-${c.id}"></div>` : ""}
      ${puoVedereIscrizioni && c.approvato && !c.forfettario ? `<div class="dettaglio-giorni hidden" id="panoramica-${c.id}"></div>` : ""}
      ${puoVedereIscrizioni && c.approvato ? `<div class="dettaglio-giorni hidden" id="storico-${c.id}"></div>` : ""}
    </div>
  `;
}

function renderCorsi() {
  const list = document.getElementById("corsi-list");
  const pillsEl = document.getElementById("corsi-filtro-pills");

  if (corsiCache.length === 0) {
    pillsEl.classList.add("hidden");
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun corso creato</div></div>`;
    return;
  }

  const puoGestireTutti = hasPermission(currentProfile, "corsi:gestisci");
  const puoGestirePadel = hasPermission(currentProfile, "corsi:gestisci_padel");
  const puoApprovare = hasPermission(currentProfile, "corsi:approva");
  const puoVedereIscrizioniTutte = hasPermission(currentProfile, "iscrizioni:gestisci");
  const puoVedereIscrizioniPadel = hasPermission(currentProfile, "iscrizioni:gestisci_padel");
  // Istruttore Padel (solo permessi scoped, niente pieno): la vista si
  // riduce a Padel + le discipline trasversali, per non affollarla di
  // sezioni che comunque non può gestire.
  const soloVistaPadel = !puoGestireTutti && !puoVedereIscrizioniTutte && (puoGestirePadel || puoVedereIscrizioniPadel);

  const disciplineConCorsi = DISCIPLINE.filter(d => corsiCache.some(c => c.disciplina === d.id));
  const sezioni = soloVistaPadel
    ? disciplineConCorsi.filter(d => d.id === "padel" || d.trasversale)
    : disciplineConCorsi;
  const isTrasversale = (filtroId) => sezioni.some(d => d.id === filtroId && d.trasversale);

  pillsEl.classList.toggle("hidden", sezioni.length <= 1);
  pillsEl.innerHTML = [{ id: "tutti", label: "Tutti" }, ...sezioni.map(d => ({ id: d.id, label: d.label }))]
    .map(d => `<button type="button" data-filtro="${d.id}" aria-pressed="${d.id === filtroDisciplinaCorsi}">${escapeHtml(d.label)}</button>`)
    .join("");
  pillsEl.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      filtroDisciplinaCorsi = btn.dataset.filtro;
      renderCorsi();
    });
  });

  list.innerHTML = sezioni.map(d => {
    const corsiSezione = corsiCache.filter(c => c.disciplina === d.id);
    if (corsiSezione.length === 0) return "";
    const visibile = filtroDisciplinaCorsi === "tutti" || filtroDisciplinaCorsi === d.id
      || (d.trasversale && !isTrasversale(filtroDisciplinaCorsi));
    const foto = fotoDisciplinaCorsi(d.id);
    const headerHtml = foto
      ? `<div class="corsi-sezione-header con-foto" style="background-image:url('${foto}')"><h3>${escapeHtml(d.label)}</h3></div>`
      : `<div class="corsi-sezione-header"><h3>${escapeHtml(d.label)}</h3></div>`;
    const cardsHtml = corsiSezione.map(c => corsoCardHtml(c, {
      puoGestire: puoGestireTutti || (puoGestirePadel && c.disciplina === "padel"),
      puoVedereIscrizioni: puoVedereIscrizioniTutte || (puoVedereIscrizioniPadel && c.disciplina === "padel"),
      puoApprovare
    })).join("");
    return `<div class="corsi-sezione${visibile ? "" : " hidden"}" data-disciplina="${d.id}">${headerHtml}${cardsHtml}</div>`;
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

  list.querySelectorAll(".programmazione-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      window.open(basePageUrl() + "programmazione-corso.html?corso=" + btn.dataset.id, "_blank");
    });
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

// "Nome Cognome (età · Nh)" — l'età e, se indicate, le ore/settimana
// desiderate, nella stessa parentesi.
function nomeEta(i) {
  const eta = etaDa(i.dataNascita);
  const dettagli = [];
  if (eta != null) dettagli.push(eta);
  if (i.nrOreDesiderate) dettagli.push(i.nrOreDesiderate + "h");
  return `${escapeHtml(i.nome)} ${escapeHtml(i.cognome)}${dettagli.length ? " (" + dettagli.join(" · ") + ")" : ""}`;
}

// Disponibilità dichiarata dall'iscritto, compatta: "Lun 08:00/09:00 · Mer 17:00".
function disponibilitaBreve(i) {
  return Object.entries(i.disponibilita || {})
    .map(([g, orari]) => `${(GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g} ${(orari || []).join("/")}`)
    .join(" · ");
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
      const disp = disponibilitaBreve(i);
      return `
        <div class="candidato-row" style="align-items:flex-start;">
          <span class="candidato-nome">${nomeEta(i)}${disp ? `<span style="display:block;color:var(--chalk-grey-dim);font-size:0.74rem;margin-top:2px;">${disp}</span>` : ""}</span>
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
      righe += `<tr><td>${c.giornoLabel} ${c.orario}</td><td>${i.campoAssegnato ? "Campo " + escapeHtml(i.campoAssegnato) : "—"}</td><td>${nomeEta(i)}</td><td>—</td><td>Confermato</td></tr>`;
    });
    candidati.forEach(i => {
      const colore = semaforoPerSlot(i, c.giorno, c.orario);
      righe += `<tr><td>${c.giornoLabel} ${c.orario}</td><td>—</td><td>${nomeEta(i)}</td><td>${escapeHtml(disponibilitaBreve(i)) || "—"}</td><td>${colore ? SEMAFORO_LABEL[colore] : "Da valutare"}</td></tr>`;
    });
    // Riga vuota di separazione dopo ogni slot (giorno/orario) per rendere
    // i gruppi leggibili a colpo d'occhio sulla stampa.
    righe += `<tr class="spacer"><td colspan="5">&nbsp;</td></tr>`;
  });

  document.getElementById("print-area").innerHTML = `
    ${intestazioneStampaHtml()}
    <h1>Panoramica — ${escapeHtml(corso.nome)}</h1>
    <p>Istantanea del ${new Date().toLocaleString("it-CH")}</p>
    <table>
      <thead><tr><th>Slot</th><th>Campo</th><th>Nominativo (età · ore)</th><th>Disponibilità</th><th>Valutazione</th></tr></thead>
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
    addebitaIscrittiConCartaSalvata(daConfermare);
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);

    const emails = daConfermare.map(i => i.email).filter(Boolean);
    if (emails.length > 0 && confirm(`Aprire un'email di conferma per i ${emails.length} iscritti confermati (in copia nascosta)?`)) {
      apriEmailCcn(emails, `Conferma iscrizione corso — ${corso.nome}`,
        `Gentile iscritto/a,\n\nSiamo lieti di confermarti nel corso "${corso.nome}":\n\nGiorno: ${giornoLabel}\nOrario: ${orario}\n\nA presto!`);
    }
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Per ciascun iscritto appena confermato che aveva salvato la carta
// all'iscrizione (tokenStato "ATTIVO"), avvia l'addebito automatico —
// fire-and-forget: la riga si aggiorna da sola (via ricaricaIscrizioniCorso
// richiamato altrove) quando il webhook risolve l'esito, non c'è da
// aspettare qui la risposta prima di continuare.
function addebitaIscrittiConCartaSalvata(iscritti) {
  const fn = cloudFunctions().httpsCallable("addebitaIscrizioneCorso");
  iscritti.filter(i => i.tokenStato === "ATTIVO").forEach(i => {
    fn({ iscrizioneId: i.id }).catch(err => console.error("addebitaIscrizioneCorso:", err));
  });
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

// Etichetta pagamento (tokenizzazione carta, vedi avviaTokenizzazioneCorso/
// addebitaIscrizioneCorso): prima dell'iscrizione confermata mostra solo
// se la carta è stata salvata; dopo la conferma mostra l'esito
// dell'addebito automatico. Nessuna etichetta se l'iscritto non ha mai
// avviato il salvataggio carta — resta "da pagare" come sempre, senza
// nuovo testo che confonda chi non usa questa funzione.
function pagamentoBadgeHtml(i) {
  if (i.stato === "in_attesa") {
    if (i.tokenStato === "ATTIVO") return `<div class="entry-meta">💳 Carta salvata</div>`;
    if (i.tokenStato === "PENDING") return `<div class="entry-meta">💳 Salvataggio carta in corso</div>`;
    return "";
  }
  if (i.stato === "confermata") {
    const label = {
      IN_CORSO: "Addebito automatico in corso…",
      PAGATO: "✓ Pagato (carta salvata)",
      FALLITO_LINK_INVIATO: "⚠ Addebito fallito — link di pagamento inviato"
    }[i.pagamentoStato];
    return label ? `<div class="entry-meta">${label}</div>` : "";
  }
  return "";
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
    const disponibilitaLabel = disponibilitaBreve(i) || "—";
    const eta = etaDa(i.dataNascita);
    const disponibileSet = new Set(Object.entries(i.disponibilita || {}).flatMap(([g, orari]) => orari.map(o => `${g}|${o}`)));

    const piuCampi = (corso.campiNumeri || []).length > 1;
    // Corso forfettario: niente slot da assegnare, la conferma è secca.
    const selectSlot = (i.stato === "in_attesa" && !corso.forfettario) ? `
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
          ${pagamentoBadgeHtml(i)}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${selectSlot}
          ${i.stato === "in_attesa" ? `<button class="btn btn-primary conferma-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}" data-nome="${escapeHtml(i.nome + " " + i.cognome)}" data-email="${escapeHtml(i.email || "")}">${corso.forfettario ? "Conferma iscrizione" : "Conferma in questo slot"}</button>` : ""}
          ${i.stato === "in_attesa" ? `<button class="btn btn-danger annulla-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso="${corso.id}" data-nome="${escapeHtml(i.nome + " " + i.cognome)}" data-email="${escapeHtml(i.email || "")}">Rifiuta</button>` : ""}
          ${i.stato !== "annullata" ? `<button class="btn btn-ghost modifica-iscrizione-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${i.id}">Modifica</button>` : ""}
        </div>
      </div>
      ${i.stato !== "annullata" ? `<div class="dettaglio-giorni hidden" id="modifica-isc-iscrizioni-${i.id}"></div>` : ""}
    `;
  }).join("");

  container.querySelectorAll(".conferma-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const select = container.querySelector(`.assegna-slot-select[data-id="${btn.dataset.id}"]`);
      const [giorno, orario] = select ? select.value.split("|") : [null, null];
      const campoSelect = container.querySelector(`.assegna-campo-select[data-id="${btn.dataset.id}"]`);
      const campo = campoSelect ? campoSelect.value : ((corso.campiNumeri || []).length === 1 ? corso.campiNumeri[0] : null);
      confermaIscrizione(btn.dataset.id, btn.dataset.corso, giorno, orario, btn.dataset.nome, campo, btn.dataset.email);
    });
  });
  container.querySelectorAll(".annulla-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => rifiutaIscrizione(btn.dataset.id, btn.dataset.corso, btn.dataset.nome, btn.dataset.email));
  });
  container.querySelectorAll(".modifica-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = iscrizioni.find(x => x.id === btn.dataset.id);
      if (i) toggleModificaIscrizione(i, corso, "iscrizioni");
    });
  });
}

// ---------- Modifica parametri di un'iscrizione ----------
// Un'iscrizione arriva dal modulo pubblico (iscrizione-corso.js) e finora
// era immutabile: lo staff poteva solo confermare/rifiutare/spostare di
// corso. Qui si permette di correggerne i dati (anagrafica, contatti,
// ore/settimana e disponibilità) sia in attesa sia confermata, lasciando
// una riga nello Storico. Stessi campi del modulo pubblico; ore e
// disponibilità solo sui corsi non forfettari, esattamente come lì. Non
// tocca stato, slot assegnato o pagamento (per i corsi normali il prezzo
// è a livello di corso, non per ora: cambiare le ore non lo modifica).

// Ordina chiavi e orari così due disponibilità si confrontano stabilmente.
function normalizzaDisponibilita(d) {
  const out = {};
  Object.keys(d || {}).sort().forEach(g => {
    const orari = [...(d[g] || [])].sort();
    if (orari.length) out[g] = orari;
  });
  return out;
}

function formModificaIscrizioneHtml(i, corso, uid) {
  const v = s => escapeHtml(s == null ? "" : String(s));
  const forfettario = corso?.forfettario === true;

  const dispSet = new Set(
    Object.entries(i.disponibilita || {}).flatMap(([g, orari]) => (orari || []).map(o => `${g}|${o}`))
  );
  const giorniConOrari = GIORNI_SETTIMANA.filter(g => (corso?.giorniOrari || {})[g.id]?.length > 0);
  const disponibilitaHtml = giorniConOrari.map(g => `
    <div class="row-label" style="margin:10px 0 4px;">${g.label}</div>
    <div class="checkbox-list">
      ${corso.giorniOrari[g.id].map(o => `
        <div class="checkbox-row">
          <input type="checkbox" class="mod-disp-cb" data-giorno="${g.id}" value="${o}" id="mod-${uid}-disp-${g.id}-${o}"${dispSet.has(`${g.id}|${o}`) ? " checked" : ""}>
          <label for="mod-${uid}-disp-${g.id}-${o}">${o}</label>
        </div>
      `).join("")}
    </div>
  `).join("");

  return `
    <div class="entry-card" style="margin-top:8px;">
      <div class="row-label" style="margin-bottom:10px;">Modifica iscrizione</div>
      <div class="row2">
        <div class="field"><label for="mod-${uid}-nome">Nome</label><input type="text" id="mod-${uid}-nome" value="${v(i.nome)}"></div>
        <div class="field"><label for="mod-${uid}-cognome">Cognome</label><input type="text" id="mod-${uid}-cognome" value="${v(i.cognome)}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="mod-${uid}-datanascita">Data di nascita</label><input type="date" id="mod-${uid}-datanascita" value="${v(i.dataNascita)}"></div>
        <div class="field"><label for="mod-${uid}-nazionalita">Nazionalità</label><input type="text" id="mod-${uid}-nazionalita" value="${v(i.nazionalita)}"></div>
      </div>
      <div class="field"><label for="mod-${uid}-via">Via</label><input type="text" id="mod-${uid}-via" value="${v(i.via)}"></div>
      <div class="row2">
        <div class="field" style="flex:0 0 110px;"><label for="mod-${uid}-cap">CAP</label><input type="text" id="mod-${uid}-cap" value="${v(i.cap)}"></div>
        <div class="field"><label for="mod-${uid}-localita">Località</label><input type="text" id="mod-${uid}-localita" value="${v(i.localita)}"></div>
      </div>
      <div class="field"><label for="mod-${uid}-email">Email</label><input type="email" id="mod-${uid}-email" value="${v(i.email)}"></div>
      <div class="row2">
        <div class="field"><label for="mod-${uid}-nomegenitore">Nome del genitore</label><input type="text" id="mod-${uid}-nomegenitore" value="${v(i.nomeGenitore)}"></div>
        <div class="field"><label for="mod-${uid}-telgenitore">Telefono del genitore</label><input type="tel" id="mod-${uid}-telgenitore" value="${v(i.telefonoGenitore)}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="mod-${uid}-scuola">Scuola frequentata</label><input type="text" id="mod-${uid}-scuola" value="${v(i.scuolaFrequentata)}"></div>
        <div class="field"><label for="mod-${uid}-altrisport">Altri sport praticati</label><input type="text" id="mod-${uid}-altrisport" value="${v(i.altriSportPraticati)}"></div>
      </div>
      ${forfettario ? "" : `
        <div class="row2">
          <div class="field">
            <label for="mod-${uid}-nrore">Nr. ore di corso desiderate (a settimana)</label>
            <input type="number" min="0" step="0.5" id="mod-${uid}-nrore" value="${i.nrOreDesiderate != null ? i.nrOreDesiderate : ""}">
          </div>
          <div class="field">
            <label for="mod-${uid}-livello">Livello</label>
            <select id="mod-${uid}-livello">
              <option value="">—</option>
              ${livelliCorsoCache.map(l => `<option value="${l.livello}"${String(i.livello) === String(l.livello) ? " selected" : ""}>${l.livello} · ${escapeHtml(l.nome)}</option>`).join("")}
            </select>
          </div>
        </div>
        ${disponibilitaHtml ? `<div class="field"><label>Giorni e orari disponibili</label>${disponibilitaHtml}</div>` : ""}
      `}
      <div class="error-msg mod-error"></div>
      <div style="display:flex;gap:8px;">
        <button type="button" class="btn btn-primary mod-salva-btn" style="width:auto;padding:8px 14px;font-size:0.72rem;">Salva</button>
        <button type="button" class="btn btn-ghost mod-annulla-btn" style="width:auto;padding:8px 14px;font-size:0.72rem;">Annulla</button>
      </div>
    </div>
  `;
}

// origine: "iscrizioni" (pannello Iscrizioni di un corso) o "cerca"
// (sezione Cerca allievo) — serve a sapere cosa ridisegnare dopo il salvataggio
// e a dare id univoci ai campi (lo stesso allievo può comparire in entrambi).
function toggleModificaIscrizione(iscrizione, corso, origine) {
  const container = document.getElementById(`modifica-isc-${origine}-${iscrizione.id}`);
  if (!container || !corso) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const uid = `${origine}-${iscrizione.id}`;
  container.innerHTML = formModificaIscrizioneHtml(iscrizione, corso, uid);
  container.classList.remove("hidden");

  container.querySelector(".mod-salva-btn").addEventListener("click", () => salvaModificaIscrizione(iscrizione, corso, origine, container, uid));
  container.querySelector(".mod-annulla-btn").addEventListener("click", () => {
    container.classList.add("hidden");
    container.innerHTML = "";
  });
}

async function salvaModificaIscrizione(iscrizione, corso, origine, container, uid) {
  const id = iscrizione.id;
  const corsoId = corso.id;
  const errorEl = container.querySelector(".mod-error");
  const get = suffix => document.getElementById(`mod-${uid}-${suffix}`);
  const val = suffix => (get(suffix)?.value || "").trim();
  errorEl.textContent = "";

  const forfettario = corso.forfettario === true;

  const nuovo = {
    nome: val("nome"),
    cognome: val("cognome"),
    dataNascita: get("datanascita")?.value || "",
    nazionalita: val("nazionalita"),
    via: val("via"),
    cap: val("cap"),
    localita: val("localita"),
    email: val("email"),
    nomeGenitore: val("nomegenitore"),
    telefonoGenitore: val("telgenitore"),
    scuolaFrequentata: val("scuola"),
    altriSportPraticati: val("altrisport")
  };
  nuovo.eta = etaDa(nuovo.dataNascita);

  if (!forfettario) {
    const nrOreRaw = get("nrore")?.value ?? "";
    nuovo.nrOreDesiderate = nrOreRaw !== "" ? parseFloat(nrOreRaw) : null;
    const livRaw = get("livello")?.value ?? "";
    nuovo.livello = livRaw !== "" ? parseInt(livRaw, 10) : null;
    const disponibilita = {};
    container.querySelectorAll(".mod-disp-cb:checked").forEach(cb => {
      const g = cb.dataset.giorno;
      (disponibilita[g] = disponibilita[g] || []).push(cb.value);
    });
    nuovo.disponibilita = disponibilita;
  }

  // Stesse regole del modulo pubblico e delle firestore.rules.
  if (!nuovo.nome || !nuovo.cognome) { showError(errorEl, "Nome e cognome sono obbligatori."); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nuovo.email)) { showError(errorEl, "Email non valida."); return; }
  if (nuovo.eta != null && nuovo.eta < 18 && (!nuovo.nomeGenitore || !nuovo.telefonoGenitore)) {
    showError(errorEl, "Per un allievo minorenne servono nome e telefono di un genitore.");
    return;
  }

  const etichette = {
    nome: "Nome", cognome: "Cognome", dataNascita: "Data di nascita", nazionalita: "Nazionalità",
    via: "Via", cap: "CAP", localita: "Località", email: "Email", nomeGenitore: "Genitore",
    telefonoGenitore: "Tel. genitore", scuolaFrequentata: "Scuola", altriSportPraticati: "Altri sport",
    nrOreDesiderate: "Ore/sett.", livello: "Livello"
  };
  const fmt = x => (x == null || x === "") ? "—" : String(x);
  const cambi = [];
  const payload = {};
  Object.keys(etichette).forEach(k => {
    if (!(k in nuovo)) return;
    const prima = iscrizione[k] ?? null;
    const dopo = nuovo[k] ?? null;
    if (fmt(prima) !== fmt(dopo)) {
      cambi.push(`${etichette[k]}: ${fmt(prima)} → ${fmt(dopo)}`);
      payload[k] = dopo;
    }
  });
  if ((iscrizione.eta ?? null) !== (nuovo.eta ?? null)) payload.eta = nuovo.eta ?? null;

  if (!forfettario) {
    const dispPrima = JSON.stringify(normalizzaDisponibilita(iscrizione.disponibilita));
    const dispDopo = JSON.stringify(normalizzaDisponibilita(nuovo.disponibilita));
    if (dispPrima !== dispDopo) {
      cambi.push("Disponibilità aggiornata");
      payload.disponibilita = nuovo.disponibilita;
    }
  }

  if (cambi.length === 0) { showError(errorEl, "Nessuna modifica da salvare."); return; }

  const salvaBtn = container.querySelector(".mod-salva-btn");
  if (salvaBtn) { salvaBtn.disabled = true; salvaBtn.textContent = "Salvataggio…"; }

  try {
    await db.collection("iscrizioniCorsi").doc(id).update({
      ...payload,
      modificataDaUid: currentProfile.uid,
      modificataDaNome: currentProfile.nome,
      modificataAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registraLog(id, corsoId, `${nuovo.nome} ${nuovo.cognome}`, "modificato", cambi.join(" · "));
    await aggiornaContatoriDopoModifica(corsoId);
    if (origine === "cerca") {
      renderRicercaAllievi();
    } else {
      await ricaricaIscrizioniCorso(corsoId);
      await ricaricaPanoramicaSeAperta(corsoId);
    }
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    if (salvaBtn) { salvaBtn.disabled = false; salvaBtn.textContent = "Salva"; }
  }
}

// Bozza email pronta ma invio manuale (nessun backend per l'invio
// automatico): apre il client di posta dello staff già compilato, che
// resta libero di rivedere il testo e decidere se/quando inviarlo.
function corpoEmailConCalce(corpo) {
  const calce = `${DATI_CENTRO.nome}\nSportcenter Manager OS\n${basePageUrl()}index.html`;
  return corpo + "\n\n--\n" + calce;
}

function apriEmailA(to, oggetto, corpo) {
  window.location.href = `mailto:?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(corpoEmailConCalce(corpo))}`;
}

function apriEmailCcn(emails, oggetto, corpo) {
  window.location.href = `mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(corpoEmailConCalce(corpo))}`;
}

// Conferma l'iscritto nello slot scelto nel select — può essere diverso da
// quanto aveva flaggato come disponibile (spostamento previo suo accordo,
// concordato fuori dall'app: qui si registra solo l'esito).
async function confermaIscrizione(iscrizioneId, corsoId, giorno, orario, nome, campo, email) {
  const corso = corsiCache.find(c => c.id === corsoId);
  const giornoLabel = (GIORNI_SETTIMANA.find(g => g.id === giorno) || {}).label || giorno;
  const forfettario = corso?.forfettario === true;
  const iscrizioneCache = iscrizioniInAttesaCache.find(i => i.id === iscrizioneId);
  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      stato: "confermata",
      giornoAssegnato: giorno || null,
      orarioAssegnato: orario || null,
      campoAssegnato: campo || null,
      motivoRifiuto: null,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await registraLog(iscrizioneId, corsoId, nome, "confermato",
      forfettario ? "Confermato (corso forfettario)" : `Confermato su ${giornoLabel} ${orario}${campo ? " Campo " + campo : ""}`);
    addebitaIscrittiConCartaSalvata([{ id: iscrizioneId, tokenStato: iscrizioneCache?.tokenStato }]);
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);

    if (email && confirm(`Aprire l'email di conferma per ${nome}?`)) {
      apriEmailA(email, `Conferma iscrizione corso — ${corso?.nome || ""}`,
        forfettario
          ? `Gentile ${nome},\n\nSiamo lieti di confermarti nel corso "${corso?.nome || ""}".\n\nA presto!`
          : `Gentile ${nome},\n\nSiamo lieti di confermarti nel corso "${corso?.nome || ""}":\n\nGiorno: ${giornoLabel}\nOrario: ${orario}${campo ? "\nCampo: " + campo : ""}\n\nA presto!`);
    }
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Chiede un motivo (es. "numero insufficiente di iscritti nella fascia
// richiesta") così lo staff ha una nota pronta per avvisare l'interessato.
async function rifiutaIscrizione(iscrizioneId, corsoId, nome, email) {
  const corso = corsiCache.find(c => c.id === corsoId);
  const iscrizioneCache = iscrizioniInAttesaCache.find(i => i.id === iscrizioneId);
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
    // Corso che non parte (o iscritto scartato): la carta salvata va
    // eliminata esplicitamente, non lasciata semplicemente inutilizzata.
    if (iscrizioneCache?.tokenStato === "ATTIVO") {
      cloudFunctions().httpsCallable("eliminaTokenIscrizione")({ iscrizioneId })
        .catch(err => console.error("eliminaTokenIscrizione:", err));
    }
    await ricaricaIscrizioniCorso(corsoId);
    await ricaricaPanoramicaSeAperta(corsoId);
    await aggiornaContatoriDopoModifica(corsoId);

    if (email && confirm(`Aprire l'email di avviso per ${nome}?`)) {
      apriEmailA(email, `Esito iscrizione corso — ${corso?.nome || ""}`,
        `Gentile ${nome},\n\nTi scriviamo in merito alla tua iscrizione al corso "${corso?.nome || ""}".\n\nPurtroppo non è stato possibile confermarti in nessuno degli orari proposti: ${motivo}\n\nRestiamo a disposizione per qualsiasi chiarimento.`);
    }
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

// Gruppi persistenti creati nel modulo di programmazione (programmazione-corso.html).
// Collection piccola: si legge tutta e si filtra lato client come il resto del modulo.
async function loadGruppiCorso() {
  try {
    // Chi ha solo il permesso scoped Padel non può leggere in blocco tutta
    // la collection (le rules rifiutano la query se un doc non è padel):
    // in quel caso si filtra la query alla sola disciplina consentita.
    const discipline = disciplineIscrizioniVisibili(currentProfile);
    let query = db.collection("gruppiCorso");
    if (discipline && discipline.length === 1) query = query.where("disciplina", "==", discipline[0]);
    const snap = await query.get();
    gruppiCorsoCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("loadGruppiCorso:", err.message);
    gruppiCorsoCache = [];
  }
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
  if (hasPermission(currentProfile, "iscrizioni:gestisci") || hasPermission(currentProfile, "iscrizioni:gestisci_padel")) aggiornaRiepiloghi();
}

// ---------- Ricerca allievo su tutti i corsi ----------

// Stessa cache di confermati/in attesa già caricata per i riepiloghi
// (nessuna lettura extra a Firestore) — annullate escluse, non sono più
// iscrizioni "attive" da poter spostare. Stesso filtro disciplina dei
// riepiloghi/panoramiche: un profilo con solo iscrizioni:gestisci_padel
// non deve vedere né poter spostare allievi di altre discipline.
function iscrizioniRicercabili() {
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  return [...iscrizioniConfermateCache, ...iscrizioniInAttesaCache]
    .map(i => ({ ...i, corso: corsiCache.find(c => c.id === i.corsoId) }))
    .filter(i => i.corso && (!discipline || discipline.includes(i.corso.disciplina)));
}

function renderRicercaAllievi() {
  const query = document.getElementById("cerca-allievo-input").value.trim().toLowerCase();
  const risultatiEl = document.getElementById("cerca-allievo-risultati");
  if (!query) {
    risultatiEl.innerHTML = "";
    return;
  }

  const statoLabel = { in_attesa: "In attesa", confermata: "Confermata" };
  const statoStyle = {
    in_attesa: "border-color:var(--chalk-grey-dim);color:var(--chalk-grey);",
    confermata: "border-color:#7f9e4a;color:#c1e08f;"
  };

  const risultati = iscrizioniRicercabili()
    .filter(i => `${i.nome} ${i.cognome}`.toLowerCase().includes(query))
    .sort((a, b) => (a.cognome || "").localeCompare(b.cognome || "", "it", { sensitivity: "base" })
      || (a.nome || "").localeCompare(b.nome || "", "it", { sensitivity: "base" }));

  if (risultati.length === 0) {
    risultatiEl.innerHTML = `<div class="empty-state"><div class="display">Nessun allievo trovato</div></div>`;
    return;
  }

  const puoSpostare = hasPermission(currentProfile, "iscrizioni:gestisci") || hasPermission(currentProfile, "iscrizioni:gestisci_padel");
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  const corsiDestinazionePossibili = corsiCache.filter(c => c.approvato && (!discipline || discipline.includes(c.disciplina)));

  risultatiEl.innerHTML = risultati.map(i => {
    const altriCorsi = corsiDestinazionePossibili.filter(c => c.id !== i.corsoId);
    const opzioniCorsi = altriCorsi.map(c => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("");
    return `
      <div class="entry-card cerca-allievo-card">
        <div class="entry-main">
          <span class="badge" style="${statoStyle[i.stato] || statoStyle.in_attesa}">${statoLabel[i.stato] || i.stato}</span>
          <div class="entry-tipo">${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}</div>
          <div class="entry-meta">${escapeHtml(i.corso.nome)} · ${escapeHtml(disciplinaLabel(i.corso.disciplina))}${i.nrOreDesiderate ? " · " + i.nrOreDesiderate + "h/sett." : ""}</div>
        </div>
        ${puoSpostare ? `
          <div class="cerca-allievo-azioni">
            ${altriCorsi.length > 0 ? `
              <select class="sposta-corso-select" data-id="${i.id}" style="font-size:0.72rem;padding:6px 8px;">
                <option value="">Sposta al corso…</option>
                ${opzioniCorsi}
              </select>
              <button type="button" class="btn btn-ghost sposta-corso-btn" style="padding:8px 12px;font-size:0.7rem;" data-id="${i.id}" data-corso-attuale="${i.corsoId}" data-nome="${escapeHtml(i.nome + " " + i.cognome)}">Sposta</button>
            ` : ""}
            <button type="button" class="btn btn-ghost modifica-iscrizione-btn" style="padding:8px 12px;font-size:0.7rem;" data-id="${i.id}">Modifica</button>
          </div>
        ` : ""}
      </div>
      ${puoSpostare ? `<div class="dettaglio-giorni hidden" id="modifica-isc-cerca-${i.id}"></div>` : ""}
    `;
  }).join("");

  risultatiEl.querySelectorAll(".sposta-corso-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const select = risultatiEl.querySelector(`.sposta-corso-select[data-id="${btn.dataset.id}"]`);
      const nuovoCorsoId = select.value;
      if (!nuovoCorsoId) { alert("Scegli il corso di destinazione."); return; }
      spostaCorsoIscrizione(btn.dataset.id, btn.dataset.corsoAttuale, nuovoCorsoId, btn.dataset.nome);
    });
  });
  risultatiEl.querySelectorAll(".modifica-iscrizione-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = risultati.find(x => x.id === btn.dataset.id);
      if (i) toggleModificaIscrizione(i, i.corso, "cerca");
    });
  });
}

// Sposta un'iscrizione su un altro corso in caso di iscrizione errata:
// l'allievo torna in attesa nel nuovo corso (l'eventuale slot/campo
// assegnato nel corso di provenienza non ha senso nel nuovo corso, così
// come il semaforo di valutazione). La carta eventualmente salvata resta
// valida: non è cambiata la persona, solo il corso a cui è iscritta.
// Due righe di log (una per corso) così lo Storico di entrambi resta
// autosufficiente per ricostruire cos'è successo.
async function spostaCorsoIscrizione(iscrizioneId, corsoAttualeId, nuovoCorsoId, nome) {
  const corsoAttuale = corsiCache.find(c => c.id === corsoAttualeId);
  const nuovoCorso = corsiCache.find(c => c.id === nuovoCorsoId);
  if (!nuovoCorso) return;
  if (!confirm(`Spostare ${nome} dal corso "${corsoAttuale?.nome || "—"}" al corso "${nuovoCorso.nome}"? Verrà rimesso in attesa nel nuovo corso.`)) return;

  try {
    await db.collection("iscrizioniCorsi").doc(iscrizioneId).update({
      corsoId: nuovoCorsoId,
      stato: "in_attesa",
      giornoAssegnato: null,
      orarioAssegnato: null,
      campoAssegnato: null,
      semaforo: null,
      semaforoGiorno: null,
      semaforoOrario: null,
      motivoRifiuto: null,
      gestitaDaUid: currentProfile.uid,
      gestitaDaNome: currentProfile.nome
    });
    await registraLog(iscrizioneId, corsoAttualeId, nome, "spostato", `Spostato al corso "${nuovoCorso.nome}", rimesso in attesa`);
    await registraLog(iscrizioneId, nuovoCorsoId, nome, "spostato", `Spostato dal corso "${corsoAttuale?.nome || "—"}", rimesso in attesa`);

    await aggiornaContatoriDopoModifica(corsoAttualeId);
    await aggiornaContatoriDopoModifica(nuovoCorsoId);
    await ricaricaIscrizioniCorso(corsoAttualeId);
    await ricaricaIscrizioniCorso(nuovoCorsoId);
    await ricaricaPanoramicaSeAperta(corsoAttualeId);
    await ricaricaPanoramicaSeAperta(nuovoCorsoId);
    renderRicercaAllievi();
  } catch (err) {
    showError(document.getElementById("corsi-list-error"), "Errore: " + err.message);
  }
}

// Raggruppa le iscrizioni confermate per corso+giorno+orario assegnati, poi
// tiene solo i gruppi la cui data generata (dal + giorno della settimana,
// ripetuto per nrSessioni volte) include dataIso.
// Un gruppo è per corso+giorno+orario+campo: se il corso propone più campi
// nello stesso giorno/orario possono coesistere più gruppi paralleli
// (uno per campo), da mostrare come voci separate — non un unico elenco
// che mischia chi gioca su campi diversi allo stesso orario.
// Un istruttore con solo iscrizioni:gestisci_padel (non il permesso pieno)
// vede riepiloghi/panoramiche filtrati alle sole discipline consentite —
// null significa "nessun filtro" (permesso pieno).
function disciplineIscrizioniVisibili(profile) {
  if (hasPermission(profile, "iscrizioni:gestisci")) return null;
  if (hasPermission(profile, "iscrizioni:gestisci_padel")) return ["padel"];
  return [];
}

function gruppiConfermatiPerData(dataIso) {
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  const corsoVisibile = (corso) => corso && (!discipline || discipline.includes(corso.disciplina));
  const gruppiMap = {};

  // 1) Gruppi persistenti del modulo di programmazione: i membri sono le
  // iscrizioni confermate che hanno l'id del gruppo in gruppoIds.
  gruppiCorsoCache.forEach(g => {
    if (g.bozza === true) return; // le bozze non entrano nei riepiloghi
    if (!g.giorno || !g.orario) return;
    const corso = corsiCache.find(c => c.id === g.corsoId);
    if (!corsoVisibile(corso)) return;
    const iscritti = iscrizioniConfermateCache.filter(i => (i.gruppoIds || []).includes(g.id));
    if (iscritti.length === 0) return;
    gruppiMap["G:" + g.id] = { corso, nome: g.nome || null, giorno: g.giorno, orario: g.orario, campo: g.campo || null, iscritti };
  });

  // 2) Flusso storico (Panoramica / "Conferma gruppo"): confermati senza
  // gruppoIds, raggruppati per corso+giorno+orario+campo assegnati.
  iscrizioniConfermateCache.forEach(i => {
    if ((i.gruppoIds || []).length) return;
    if (!i.giornoAssegnato || !i.orarioAssegnato) return;
    const corso = corsiCache.find(c => c.id === i.corsoId);
    if (!corsoVisibile(corso)) return;
    const key = `L:${i.corsoId}|${i.giornoAssegnato}|${i.orarioAssegnato}|${i.campoAssegnato || ""}`;
    if (!gruppiMap[key]) {
      gruppiMap[key] = { corso, nome: null, giorno: i.giornoAssegnato, orario: i.orarioAssegnato, campo: i.campoAssegnato || null, iscritti: [] };
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
        ${g.nome ? `<div class="entry-meta">${escapeHtml(g.nome)}</div>` : ""}
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
    ${intestazioneStampaHtml()}
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
    ${intestazioneStampaHtml()}
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
  rifiutato: "Rifiutato",
  spostato: "Spostato corso",
  modificato: "Iscrizione modificata",
  livello_impostato: "Livello impostato",
  raggruppato: "Gruppi aggiornati"
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

  document.getElementById("corso-forfettario").checked = corso.forfettario === true;
  syncForfettario();

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
  document.getElementById("corso-tokenizzazione").checked = corso.tokenizzazioneAttiva !== false;
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
  syncForfettario();
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
    if (!form.forfettario) {
      if (!form.nrSessioni || form.nrSessioni < 1) throw new Error("Inserisci il numero di sessioni.");
      if (!form.durataSessioneMinuti) throw new Error("Inserisci la durata di una sessione.");
      if (Object.keys(form.giorniOrari).length === 0) throw new Error("Seleziona almeno un orario per almeno un giorno.");
      if (form.campiNumeri.length === 0) throw new Error("Seleziona almeno un campo proposto.");
      if (!form.minIscrittiConferma) throw new Error("Inserisci il numero minimo di iscritti per la conferma.");
    }
    if (form.prezzoRichiesto == null) throw new Error("Inserisci il prezzo richiesto.");
    if (!hasPermission(currentProfile, "corsi:gestisci") && form.disciplina !== "padel") {
      throw new Error("Con questo permesso puoi creare/modificare solo corsi di disciplina Padel.");
    }

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

  const puoGestireCorsiAlmenoPadel = hasPermission(profile, "corsi:gestisci") || hasPermission(profile, "corsi:gestisci_padel");
  const puoVedereIscrizioniAlmenoPadel = hasPermission(profile, "iscrizioni:gestisci") || hasPermission(profile, "iscrizioni:gestisci_padel");

  if (!puoGestireCorsiAlmenoPadel && !hasPermission(profile, "corsi:approva") && !puoVedereIscrizioniAlmenoPadel) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("corsi-content").classList.add("hidden");
    return;
  }

  if (!puoGestireCorsiAlmenoPadel) {
    document.getElementById("corso-form").classList.add("hidden");
    document.getElementById("corso-form-title").classList.add("hidden");
  }

  initLinkCopyBox("link-iscrizione", "copia-link-iscrizione-btn", "iscrizione-corso.html");

  if (hasPermission(profile, "corsi:gestisci_padel") || hasPermission(profile, "iscrizioni:gestisci_padel")) {
    document.getElementById("link-giocatori-padel-admin").classList.remove("hidden");
  }

  await loadDatiCentro();
  await loadDiscipline();
  await loadCampi();
  await loadFotoDiscipline();

  populateSelect(document.getElementById("corso-disciplina"), DISCIPLINE);

  if (puoGestireCorsiAlmenoPadel && !hasPermission(profile, "corsi:gestisci")) {
    // Solo corsi:gestisci_padel: disciplina fissa su Padel, non selezionabile.
    const disciplinaSelect = document.getElementById("corso-disciplina");
    disciplinaSelect.value = "padel";
    disciplinaSelect.disabled = true;
  }

  syncForfettario();
  syncOrariCampiDisciplina();

  document.getElementById("corso-disciplina").addEventListener("change", syncOrariCampiDisciplina);
  document.getElementById("corso-forfettario").addEventListener("change", () => {
    syncForfettario();
    aggiornaCostoCalcolato();
  });

  ["corso-nrsessioni", "corso-durata", "corso-costo-istruttore", "corso-costo-campo",
    "corso-costo-materiale", "corso-min-iscritti"]
    .forEach(id => document.getElementById(id).addEventListener("input", aggiornaCostoCalcolato));

  document.getElementById("corso-form").addEventListener("submit", onSubmitCorso);
  document.getElementById("corso-cancel-edit-btn").addEventListener("click", cancelEditCorso);

  if (puoVedereIscrizioniAlmenoPadel) {
    await loadLivelliCorso();
    document.getElementById("riepilogo-sezione").classList.remove("hidden");
    document.getElementById("riepilogo-data").value = toISODate(new Date());
    document.getElementById("riepilogo-data").addEventListener("change", aggiornaRiepiloghi);
    document.getElementById("stampa-settimanale-btn").addEventListener("click", stampaRiepilogoSettimanale);
    await loadIscrizioniConfermate();
    await loadIscrizioniInAttesa();
    await loadGruppiCorso();

    document.getElementById("cerca-allievo-sezione").classList.remove("hidden");
    document.getElementById("cerca-allievo-input").addEventListener("input", renderRicercaAllievi);
  }

  await loadCorsi();

  if (puoVedereIscrizioniAlmenoPadel) {
    aggiornaRiepiloghi();
  }
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
