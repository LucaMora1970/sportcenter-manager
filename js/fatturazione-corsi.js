// ============================================================
// fatturazione-corsi.js — strumento di supporto per decidere cosa
// fatturare a fine stagione, quando durante l'anno ci sono stati
// spostamenti di allievi tra corsi/gruppi per bilanciare i livelli.
//
// Non emette la fattura: propone un importo per allievo — di base il prezzo del corso a cui si
// è iscritto ORIGINARIAMENTE, non quello attuale — mostra lo storico
// degli spostamenti e le presenze per corso, e lascia correggere
// l'importo a mano prima di segnarlo come gestito. La fattura con
// polizza QR si emette poi dalla pagina Fatture (fatture.html), cui il
// pulsante "Crea fattura" nel dettaglio dell'allievo porta i dati già
// compilati (vedi creaFatturaDaRiga).
//
// Il corso originario non è leggibile direttamente sull'iscrizione:
// iscrizioniCorsi.corsoId viene sovrascritto a ogni spostamento (vedi
// spostaCorsoIscrizione in corsi.js). L'unica traccia è nel registro
// immutabile iscrizioniLog, dove ogni spostamento scrive due righe: una
// contro il corso lasciato (dettaglio che inizia con "Spostato al
// corso"), una contro il corso raggiunto ("Spostato dal corso"). Il
// corso originario è quindi il corsoId della riga "Spostato al corso"
// più vecchia; se non ce n'è nessuna, l'allievo non è mai stato
// spostato e il corso originario è semplicemente quello attuale.
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsiCache = [];
let corsiSelezionati = new Set();
let filtroDisciplina = "tutti";
let righeAllievi = [];       // ultimo risultato di "Carica allievi"
let fatturazioniSalvate = {}; // iscrizioneId -> doc fatturazioniCorsi
let ricercaQuery = "";
let rigaEspansaId = null;

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function formatDataOra(timestamp) {
  if (!timestamp || !timestamp.toDate) return "—";
  return timestamp.toDate().toLocaleDateString("it-CH");
}

// ---------- Caricamento corsi + selettore ----------

async function loadCorsiSelettore() {
  const snap = await db.collection("corsi").get();
  corsiCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.ordine ?? Infinity) - (b.ordine ?? Infinity) || a.dal.localeCompare(b.dal));
}

function disciplineDisponibiliPerProfilo() {
  const puoTutte = hasPermission(currentProfile, "iscrizioni:gestisci");
  const disponibili = puoTutte ? DISCIPLINE : DISCIPLINE.filter(d => d.id === "padel");
  return disponibili.filter(d => corsiCache.some(c => c.disciplina === d.id));
}

function renderSelettoreCorsi() {
  const pillsEl = document.getElementById("fatt-disciplina-pills");
  const listEl = document.getElementById("fatt-corsi-list");

  const discipline = disciplineDisponibiliPerProfilo();
  pillsEl.classList.toggle("hidden", discipline.length <= 1);
  pillsEl.innerHTML = [{ id: "tutti", label: "Tutti" }, ...discipline.map(d => ({ id: d.id, label: d.label }))]
    .map(d => `<button type="button" data-filtro="${d.id}" aria-pressed="${d.id === filtroDisciplina}">${escapeHtml(d.label)}</button>`)
    .join("");
  pillsEl.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      filtroDisciplina = btn.dataset.filtro;
      renderSelettoreCorsi();
    });
  });

  const idDiscipline = new Set(discipline.map(d => d.id));
  const corsiVisibili = corsiCache.filter(c => idDiscipline.has(c.disciplina)
    && (filtroDisciplina === "tutti" || c.disciplina === filtroDisciplina));

  if (corsiVisibili.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun corso trovato</div></div>`;
    return;
  }

  listEl.innerHTML = corsiVisibili.map(c => `
    <div class="checkbox-row">
      <input type="checkbox" id="fatt-corso-${c.id}" data-id="${c.id}" ${corsiSelezionati.has(c.id) ? "checked" : ""}>
      <label for="fatt-corso-${c.id}">${escapeHtml(c.nome)} — ${formatDataBreve(c.dal)}${c.al ? " – " + formatDataBreve(c.al) : ""} · CHF ${c.prezzoRichiesto != null ? c.prezzoRichiesto.toFixed(2) : "—"}</label>
    </div>
  `).join("");

  listEl.querySelectorAll("input[type=checkbox]").forEach(chk => {
    chk.addEventListener("change", () => {
      if (chk.checked) corsiSelezionati.add(chk.dataset.id);
      else corsiSelezionati.delete(chk.dataset.id);
    });
  });
}

// ---------- Raccolta iscrizioni in ambito ----------

function chunk10(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
}

// Un allievo va incluso se il corso attuale è tra quelli selezionati,
// OPPURE se il suo corso originario ricostruito lo è — altrimenti chi è
// stato spostato FUORI dalla scaletta selezionata sparirebbe pur avendo
// ancora un corso originario in ambito.
async function raccogliIscrizioniInAmbito(corsoIds) {
  const iscrizioniPerId = {};

  for (const gruppo of chunk10(corsoIds)) {
    const snap = await db.collection("iscrizioniCorsi").where("corsoId", "in", gruppo).get();
    snap.docs.forEach(d => { iscrizioniPerId[d.id] = { id: d.id, ...d.data() }; });
  }

  const idScoperti = new Set();
  for (const gruppo of chunk10(corsoIds)) {
    const snap = await db.collection("iscrizioniLog")
      .where("corsoId", "in", gruppo)
      .get();
    snap.docs.forEach(d => {
      const l = d.data();
      if ((l.dettaglio || "").startsWith("Spostato al corso") && l.iscrizioneId) {
        idScoperti.add(l.iscrizioneId);
      }
    });
  }
  for (const id of idScoperti) {
    if (iscrizioniPerId[id]) continue;
    try {
      // Il corso ATTUALE di questa iscrizione può essere fuori dalla
      // disciplina del profilo (es. un allievo spostato da Padel a
      // Tennis) — un permission-denied qui non deve bloccare il resto
      // del caricamento, semplicemente quell'allievo non compare.
      const doc = await db.collection("iscrizioniCorsi").doc(id).get();
      if (doc.exists) iscrizioniPerId[id] = { id: doc.id, ...doc.data() };
    } catch (err) {
      console.warn("iscrizione non leggibile con questo profilo:", id, err.message);
    }
  }

  return Object.values(iscrizioniPerId).filter(i => i.stato !== "annullata");
}

// ---------- Ricostruzione corso originale + presenze per allievo ----------

// Iscritti "veri" di un corso (per il listino a scaglioni): esclusi
// annullate, lista d'attesa e ospiti (gli ospiti pagano la quota del corso
// di riferimento, non fanno numero). Cache per caricamento.
let iscrittiPerCorsoCache = {};

async function contaIscrittiCorso(corsoId) {
  if (iscrittiPerCorsoCache[corsoId] == null) {
    const snap = await db.collection("iscrizioniCorsi").where("corsoId", "==", corsoId).get();
    iscrittiPerCorsoCache[corsoId] = snap.docs.filter(d => {
      const i = d.data();
      return i.stato !== "annullata" && i.stato !== "lista_attesa" && i.tipo !== "ospite";
    }).length;
  }
  return iscrittiPerCorsoCache[corsoId];
}

async function calcolaRigaAllievo(iscrizione) {
  // Lo storico può contenere righe contro un corso fuori dalla disciplina
  // del profilo (es. un allievo spostato anche verso/da un'altra
  // disciplina) — un permission-denied sulla query non deve far saltare
  // l'intero caricamento, solo far ripiegare sul corso attuale.
  let partenze = [];
  let storicoNonDisponibile = false;
  try {
    const logSnap = await db.collection("iscrizioniLog").where("iscrizioneId", "==", iscrizione.id).get();
    const log = logSnap.docs.map(d => d.data())
      .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
    partenze = log.filter(l => (l.dettaglio || "").startsWith("Spostato al corso"));
  } catch (err) {
    storicoNonDisponibile = true;
  }

  const corsoOriginaleId = partenze.length > 0 ? partenze[0].corsoId : iscrizione.corsoId;
  const corsoOriginale = corsiCache.find(c => c.id === corsoOriginaleId);

  const storicoSpostamenti = partenze.map(l => ({
    data: l.createdAt,
    corsoLasciato: (corsiCache.find(c => c.id === l.corsoId) || {}).nome || "—"
  }));

  // Le presenze non sono leggibili da chi ha solo iscrizioni:gestisci_padel
  // senza corsi:presenze (regola dedicata in firestore.rules) — un
  // permission-denied qui non deve bloccare l'intera riga, solo lasciare
  // il dettaglio presenze vuoto con un avviso.
  let presenzePerCorso = {};
  let presenzeNonDisponibili = false;
  try {
    const presSnap = await db.collection("presenze").where("iscrizioneId", "==", iscrizione.id).get();
    presSnap.docs.forEach(d => {
      const p = d.data();
      if (!presenzePerCorso[p.corsoId]) presenzePerCorso[p.corsoId] = { corsoNome: p.corsoNome, presenti: 0, totali: 0 };
      presenzePerCorso[p.corsoId].totali++;
      if (p.presente) presenzePerCorso[p.corsoId].presenti++;
    });
  } catch (err) {
    presenzeNonDisponibili = true;
  }

  // Corsi a ora (prezzoAOra): il prezzo del corso vale per ogni ora a
  // settimana, quindi chi ne frequenta 2 o 3 va moltiplicato. Le ore sono
  // quelle dei gruppi assegnati (uno per ora/settimana, durata della
  // sessione del corso originale); se non ha ancora gruppi si ripiega
  // sulle ore richieste all'iscrizione, e in mancanza anche di quelle su 1h
  // (segnalato nella card, da correggere a mano).
  const prezzoAOra = corsoOriginale?.prezzoAOra === true;
  const corsoAttuale = corsiCache.find(c => c.id === iscrizione.corsoId);
  const durataOre = ((corsoOriginale?.durataSessioneMinuti || corsoAttuale?.durataSessioneMinuti || 60)) / 60;
  const nrGruppi = (iscrizione.gruppoIds || []).length;
  const oreAssegnate = nrGruppi * durataOre;
  const oreRichieste = iscrizione.nrOreDesiderate || null;
  let oreFatturabili = 1, oreOrigine = "nessuna";
  if (oreAssegnate > 0) { oreFatturabili = oreAssegnate; oreOrigine = "gruppi"; }
  else if (oreRichieste) { oreFatturabili = oreRichieste; oreOrigine = "richieste"; }
  const haListino = listinoCorso(corsoOriginale).length > 0;
  const nrIscrittiCorso = haListino ? await contaIscrittiCorso(corsoOriginaleId) : null;
  const prezzoUnitario = corsoOriginale
    ? (haListino ? prezzoCorsoPerIscritti(corsoOriginale, nrIscrittiCorso) : (corsoOriginale.prezzoRichiesto ?? null))
    : null;
  const prezzoProposto = prezzoUnitario == null ? null : (prezzoAOra ? prezzoUnitario * oreFatturabili : prezzoUnitario);

  return {
    prezzoAOra,
    prezzoUnitario,
    nrIscrittiCorso,
    nrGruppi,
    oreAssegnate,
    oreRichieste,
    oreFatturabili,
    oreOrigine,
    iscrizioneId: iscrizione.id,
    nome: iscrizione.nome,
    cognome: iscrizione.cognome,
    allievoId: iscrizione.allievoId || null,
    via: iscrizione.via || "",
    cap: iscrizione.cap || "",
    localita: iscrizione.localita || "",
    email: iscrizione.email || "",
    nomeGenitore: iscrizione.nomeGenitore || "",
    telefonoGenitore: iscrizione.telefonoGenitore || "",
    corsoOriginaleId,
    corsoOriginaleNome: corsoOriginale?.nome || "— corso non trovato —",
    prezzoProposto,
    fuMaiSpostato: partenze.length > 0,
    storicoSpostamenti,
    storicoNonDisponibile,
    presenzePerCorso,
    presenzeNonDisponibili
  };
}

async function inBatch(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...await Promise.all(batch.map(fn)));
  }
  return out;
}

// ---------- Fatturazioni salvate ----------

async function caricaFatturazioniEsistenti(iscrizioneIds) {
  fatturazioniSalvate = {};
  for (const gruppo of chunk10(iscrizioneIds)) {
    const snap = await db.collection("fatturazioniCorsi")
      .where(firebase.firestore.FieldPath.documentId(), "in", gruppo)
      .get();
    snap.docs.forEach(d => { fatturazioniSalvate[d.id] = d.data(); });
  }
}

async function salvaRigaFatturazione(iscrizioneId, { importoFinale, nota, stato }) {
  const riga = righeAllievi.find(r => r.iscrizioneId === iscrizioneId);
  if (!riga) return;
  await db.collection("fatturazioniCorsi").doc(iscrizioneId).set({
    iscrizioneId,
    allievoNome: riga.nome,
    allievoCognome: riga.cognome,
    allievoId: riga.allievoId,
    corsoOriginaleId: riga.corsoOriginaleId,
    corsoOriginaleNome: riga.corsoOriginaleNome,
    prezzoProposto: riga.prezzoProposto,
    prezzoAOra: riga.prezzoAOra,
    nrIscrittiCorso: riga.nrIscrittiCorso ?? null,
    prezzoUnitario: riga.prezzoUnitario ?? null,
    oreFatturabili: riga.prezzoAOra ? riga.oreFatturabili : null,
    importoFinale,
    nota,
    stato,
    aggiornatoDaUid: currentProfile.uid,
    aggiornatoDaNome: currentProfile.nome,
    aggiornatoAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdAt: fatturazioniSalvate[iscrizioneId]?.createdAt || firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  fatturazioniSalvate[iscrizioneId] = { ...fatturazioniSalvate[iscrizioneId], importoFinale, nota, stato };
}

// ---------- Caricamento allievi ----------

async function onCaricaAllievi() {
  const errorEl = document.getElementById("fatt-error");
  const btn = document.getElementById("fatt-carica-btn");
  errorEl.textContent = "";

  const corsoIds = Array.from(corsiSelezionati);
  if (corsoIds.length === 0) {
    showError(errorEl, "Seleziona almeno un corso.");
    return;
  }

  btn.disabled = true;
  document.getElementById("fatt-allievi-list").innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;
  document.getElementById("fatt-risultati-sezione").classList.remove("hidden");

  try {
    iscrittiPerCorsoCache = {};
    const iscrizioni = await raccogliIscrizioniInAmbito(corsoIds);
    righeAllievi = await inBatch(iscrizioni, 10, calcolaRigaAllievo);
    righeAllievi.sort((a, b) => (a.cognome || "").localeCompare(b.cognome || "") || (a.nome || "").localeCompare(b.nome || ""));
    await caricaFatturazioniEsistenti(righeAllievi.map(r => r.iscrizioneId));
    rigaEspansaId = null;
    renderRigheAllievi();
  } catch (err) {
    showError(errorEl, "Errore nel caricamento: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Rendering righe ----------

function importoAttuale(riga) {
  const salvata = fatturazioniSalvate[riga.iscrizioneId];
  if (salvata && salvata.importoFinale != null) return salvata.importoFinale;
  return riga.prezzoProposto ?? 0;
}

function statoAttuale(riga) {
  return (fatturazioniSalvate[riga.iscrizioneId] || {}).stato || "da_valutare";
}

const STATI_FATTURAZIONE = [
  { id: "da_valutare", label: "Da valutare", badge: "badge-in-attesa" },
  { id: "da_fatturare", label: "Da fatturare", badge: "badge-in-attesa" },
  { id: "fatturato", label: "Fatturato", badge: "badge-confermata" },
  { id: "rifiutato", label: "Rifiutato", badge: "" }
];

function statoInfo(id) {
  return STATI_FATTURAZIONE.find(s => s.id === id) || STATI_FATTURAZIONE[0];
}

function aggiornaScoreboard(righeFiltrate) {
  const conteggi = { da_valutare: 0, da_fatturare: 0, fatturato: 0, rifiutato: 0 };
  let totale = 0;
  righeFiltrate.forEach(r => {
    conteggi[statoInfo(statoAttuale(r)).id]++;
    // Un rifiutato non verrà fatturato: non entra nel totale.
    if (statoAttuale(r) !== "rifiutato") totale += importoAttuale(r);
  });
  document.getElementById("fatt-conteggio-da-valutare").textContent = conteggi.da_valutare;
  document.getElementById("fatt-conteggio-da-fatturare").textContent = conteggi.da_fatturare;
  document.getElementById("fatt-conteggio-fatturato").textContent = conteggi.fatturato;
  document.getElementById("fatt-conteggio-rifiutato").textContent = conteggi.rifiutato;
  const piuOre = righeFiltrate.filter(r => r.prezzoAOra && r.oreFatturabili > 1).length;
  const piuOreEl = document.getElementById("fatt-piu-ore-info");
  piuOreEl.textContent = piuOre > 0 ? `${piuOre} ${piuOre === 1 ? "allievo frequenta" : "allievi frequentano"} più di 1 ora a settimana (corsi a ora): importo già moltiplicato per le ore.` : "";
  piuOreEl.classList.toggle("hidden", piuOre === 0);
  document.getElementById("fatt-totale-importi").innerHTML = "<small>CHF</small>" + totale.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatOreFatt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Riga "CHF 30.00 × 3h (3 gruppi × 1h)" per i corsi a ora, con avviso se le
// ore non arrivano dai gruppi assegnati o non coincidono con le richieste.
function oreRigaHtml(riga) {
  if (!riga.prezzoAOra) return "";
  const ore = formatOreFatt(riga.oreFatturabili);
  const formula = riga.prezzoUnitario == null ? "" : `CHF ${riga.prezzoUnitario.toFixed(2)} × ${ore}h`;
  const origine = riga.oreOrigine === "gruppi"
    ? `${riga.nrGruppi} ${riga.nrGruppi === 1 ? "gruppo" : "gruppi"} assegnat${riga.nrGruppi === 1 ? "o" : "i"}`
    : riga.oreOrigine === "richieste" ? "ore richieste, nessun gruppo assegnato" : "ore non indicate, proposta 1h";
  let avviso = "";
  if (riga.oreOrigine === "nessuna") avviso = "Ore non indicate né gruppi assegnati: controlla in Allievi/Presenze.";
  else if (riga.oreOrigine === "gruppi" && riga.oreRichieste && riga.oreRichieste !== riga.oreAssegnate)
    avviso = `Ha richiesto ${formatOreFatt(riga.oreRichieste)}h/sett. ma ne ha ${ore}h assegnate.`;
  return `<div class="entry-meta fatt-ore" style="margin-top:6px;"><strong>${ore}h/sett.</strong>${formula ? " · " + formula : ""} <span style="opacity:.8">(${origine})</span></div>`
    + (avviso ? `<div class="entry-meta" style="color:var(--danger);margin-top:2px;">${avviso}</div>` : "");
}

function rigaCardHtml(riga) {
  const salvata = fatturazioniSalvate[riga.iscrizioneId] || {};
  const importo = importoAttuale(riga);
  const stato = statoAttuale(riga);
  const espansa = rigaEspansaId === riga.iscrizioneId;

  const storicoHtml = riga.storicoNonDisponibile
    ? `<p class="entry-meta">Storico spostamenti non disponibile con il tuo permesso.</p>`
    : riga.storicoSpostamenti.length === 0
      ? `<p class="entry-meta">Mai spostato.</p>`
      : `<div class="entry-meta"><strong>Storico spostamenti</strong></div>` + riga.storicoSpostamenti.map(s =>
          `<div class="entry-meta">${formatDataOra(s.data)} — lasciato "${escapeHtml(s.corsoLasciato)}"</div>`
        ).join("");

  const presenzeRighe = Object.values(riga.presenzePerCorso);
  const presenzeHtml = riga.presenzeNonDisponibili
    ? `<p class="entry-meta">Presenze non disponibili con il tuo permesso.</p>`
    : presenzeRighe.length === 0
      ? `<p class="entry-meta">Nessuna presenza registrata.</p>`
      : `<table class="app-table"><thead><tr><th>Corso</th><th>Presenze</th></tr></thead><tbody>${
          presenzeRighe.map(p => `<tr><td>${escapeHtml(p.corsoNome || "—")}</td><td>${p.presenti}/${p.totali}</td></tr>`).join("")
        }</tbody></table>`;

  return `
    <div class="dipendente-block" data-id="${riga.iscrizioneId}">
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(riga.cognome)} ${escapeHtml(riga.nome)}</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
            ${riga.fuMaiSpostato ? `<span class="badge">Spostato</span>` : ""}
            ${riga.prezzoAOra && riga.oreFatturabili > 1 ? `<span class="badge">${formatOreFatt(riga.oreFatturabili)} ore</span>` : ""}
            ${riga.prezzoProposto == null ? `<span class="badge" style="border-color:var(--danger);color:var(--danger);">Prezzo non configurato sul corso originale</span>` : ""}
            <span class="badge ${statoInfo(stato).badge}">${statoInfo(stato).label}</span>
          </div>
          ${salvata.nota ? `<div class="entry-meta" style="margin-top:6px;">📝 ${escapeHtml(salvata.nota)}</div>` : ""}
          <div class="entry-meta" style="margin-top:6px;">Corso originale: ${escapeHtml(riga.corsoOriginaleNome)}</div>
          ${riga.nrIscrittiCorso != null ? `<div class="entry-meta" style="margin-top:6px;">Listino: ${riga.nrIscrittiCorso} iscritti nel corso → CHF ${riga.prezzoUnitario != null ? riga.prezzoUnitario.toFixed(2) : "—"} a persona</div>` : ""}
          ${oreRigaHtml(riga)}
        </div>
        <div class="entry-ore">CHF ${importo.toFixed(2)}</div>
      </div>
      <div class="dipendente-actions">
        <button type="button" class="btn btn-ghost fatt-toggle-btn" data-id="${riga.iscrizioneId}">${espansa ? "Chiudi" : "Dettaglio"}</button>
      </div>
      <div class="dettaglio-giorni ${espansa ? "" : "hidden"}" id="fatt-dettaglio-${riga.iscrizioneId}">
        ${storicoHtml}
        ${presenzeHtml}
        <div class="field">
          <label for="fatt-importo-${riga.iscrizioneId}">Importo da fatturare (CHF)</label>
          <input type="number" step="0.5" min="0" id="fatt-importo-${riga.iscrizioneId}" value="${importo.toFixed(2)}">
        </div>
        <div class="field">
          <label for="fatt-nota-${riga.iscrizioneId}">Nota</label>
          <textarea id="fatt-nota-${riga.iscrizioneId}" rows="2" placeholder="es. spostato dopo metà corso, fatturato pro-rata">${escapeHtml(salvata.nota || "")}</textarea>
        </div>
        <div class="field">
          <label for="fatt-stato-${riga.iscrizioneId}">Stato</label>
          <select id="fatt-stato-${riga.iscrizioneId}">
            ${STATI_FATTURAZIONE.map(st => `<option value="${st.id}" ${stato === st.id ? "selected" : ""}>${st.label}</option>`).join("")}
          </select>
        </div>
        <div class="error-msg" id="fatt-salva-error-${riga.iscrizioneId}"></div>
        <button type="button" class="btn btn-primary fatt-salva-btn" data-id="${riga.iscrizioneId}">Salva</button>
        ${hasPermission(currentProfile, "fatture:gestisci") ? `<button type="button" class="btn btn-ghost fatt-crea-fattura-btn" data-id="${riga.iscrizioneId}" style="margin-top:8px;">Crea fattura con polizza QR</button>` : ""}
      </div>
    </div>
  `;
}

function renderRigheAllievi() {
  const listEl = document.getElementById("fatt-allievi-list");
  const query = ricercaQuery.trim().toLowerCase();
  const righeFiltrate = query
    ? righeAllievi.filter(r => `${r.nome} ${r.cognome}`.toLowerCase().includes(query))
    : righeAllievi;

  aggiornaScoreboard(righeFiltrate);

  if (righeFiltrate.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun allievo</div></div>`;
    return;
  }

  listEl.innerHTML = righeFiltrate.map(rigaCardHtml).join("");

  listEl.querySelectorAll(".fatt-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      rigaEspansaId = rigaEspansaId === id ? null : id;
      renderRigheAllievi();
    });
  });
  listEl.querySelectorAll(".fatt-salva-btn").forEach(btn => {
    btn.addEventListener("click", () => onSalvaRiga(btn.dataset.id));
  });
  listEl.querySelectorAll(".fatt-crea-fattura-btn").forEach(btn => {
    btn.addEventListener("click", () => creaFatturaDaRiga(btn.dataset.id));
  });
}

// Porta l'allievo alla pagina Fatture con la fattura già precompilata.
// Per i minorenni (nomeGenitore compilato) il destinatario è il genitore,
// con l'allievo nominato nella descrizione. Importo e nota sono quelli
// attualmente scritti nel dettaglio (anche se non ancora salvati).
// Passa dalla scelta dell'intestatario (vedi apriIntestatario): di principio
// paga il genitore, ma si chiede sempre a chi intestare la fattura, e con
// genitori separati si può dividerla (metà a ciascuno).
function creaFatturaDaRiga(iscrizioneId) {
  const riga = righeAllievi.find(r => r.iscrizioneId === iscrizioneId);
  if (!riga) return;
  const importoEl = document.getElementById(`fatt-importo-${iscrizioneId}`);
  const notaEl = document.getElementById(`fatt-nota-${iscrizioneId}`);
  const importo = importoEl ? parseFloat(importoEl.value) : importoAttuale(riga);
  const nomeAllievo = `${riga.nome} ${riga.cognome}`.trim();
  const base = {
    oggetto: riga.corsoOriginaleNome,
    note: notaEl ? notaEl.value.trim() : "",
    righe: [{
      descrizione: `${riga.corsoOriginaleNome} — ${nomeAllievo}`,
      quantita: 1,
      prezzoUnitario: Number.isFinite(importo) ? importo : importoAttuale(riga)
    }],
    origine: { tipo: "fatturazioneCorsi", id: iscrizioneId }
  };
  apriIntestatario(riga, base);
}

// ---------- Scelta dell'intestatario ----------

let intestatarioCtx = null; // { riga, base, clienti: [...], scelti: Set }

function indirizzoRigaCliente(c) {
  return [c.via && (c.via + (c.civico ? " " + c.civico : "")), [c.cap, c.localita].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "indirizzo mancante";
}

async function apriIntestatario(riga, base) {
  const errEl = document.getElementById("intestatario-error");
  errEl.innerHTML = "";
  intestatarioCtx = { riga, base, clienti: [], scelti: new Set() };
  document.getElementById("intestatario-allievo").textContent = `${riga.nome} ${riga.cognome} — ${riga.corsoOriginaleNome}`;
  document.getElementById("intestatario-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";

  // Clienti già collegati a questo allievo (es. i due genitori).
  try {
    if (riga.allievoId) {
      const snap = await db.collection("clienti").where("allievoIds", "array-contains", riga.allievoId).get();
      intestatarioCtx.clienti = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.attivo !== false);
    }
  } catch (err) {
    showError(errEl, "Anagrafica clienti non disponibile: " + erroreFunzione(err));
  }
  // Un solo intestatario noto: è la scelta più probabile, già selezionata.
  if (intestatarioCtx.clienti.length === 1) intestatarioCtx.scelti.add(intestatarioCtx.clienti[0].id);
  renderIntestatario();
  if (intestatarioCtx.clienti.length === 0) apriNuovoIntestatario("genitore");
}

function chiudiIntestatario() {
  document.getElementById("intestatario-modal").classList.add("hidden");
  document.getElementById("intestatario-nuovo").classList.add("hidden");
  document.body.style.overflow = "";
  intestatarioCtx = null;
}

function renderIntestatario() {
  const ctx = intestatarioCtx;
  if (!ctx) return;
  const lista = document.getElementById("intestatario-lista");
  lista.innerHTML = ctx.clienti.length === 0
    ? `<p class="entry-meta">Nessun intestatario in anagrafica per questo allievo.</p>`
    : ctx.clienti.map(c => `
        <label class="checkbox-row">
          <input type="checkbox" class="intestatario-cb" value="${escapeHtml(c.id)}" ${ctx.scelti.has(c.id) ? "checked" : ""}>
          <span><strong>${escapeHtml(c.nome)}</strong> <span class="entry-meta">(${escapeHtml(c.relazione || "altro")}) · ${escapeHtml(indirizzoRigaCliente(c))}</span></span>
        </label>`).join("");
  lista.querySelectorAll(".intestatario-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) ctx.scelti.add(cb.value); else ctx.scelti.delete(cb.value);
      aggiornaQuoteIntestatario();
    });
  });
  aggiornaQuoteIntestatario();
}

function aggiornaQuoteIntestatario() {
  const ctx = intestatarioCtx;
  const box = document.getElementById("intestatario-quote");
  if (ctx.scelti.size === 2) {
    const [a, b] = [...ctx.scelti].map(id => ctx.clienti.find(c => c.id === id));
    box.innerHTML = `
      <p class="entry-meta" style="margin:10px 0 6px;">Fattura divisa: ogni intestatario riceve una fattura propria (numero e polizza QR propri).</p>
      <div class="row2">
        <div class="field"><label for="quota-a">Quota di ${escapeHtml(a.nome)} (%)</label>
          <input type="number" id="quota-a" min="1" max="99" step="0.01" value="50"></div>
        <div class="field"><label>Quota di ${escapeHtml(b.nome)}</label>
          <div id="quota-b" class="entry-meta" style="padding-top:10px;">50%</div></div>
      </div>`;
    document.getElementById("quota-a").addEventListener("input", (e) => {
      const q = parseFloat(e.target.value);
      document.getElementById("quota-b").textContent = (Number.isFinite(q) ? Math.round((100 - q) * 100) / 100 : "—") + "%";
    });
    box.classList.remove("hidden");
  } else {
    box.innerHTML = "";
    box.classList.add("hidden");
  }
}

function apriNuovoIntestatario(relazione) {
  const ctx = intestatarioCtx;
  const r = ctx.riga;
  const comeAllievo = relazione === "allievo";
  const set = (id, v) => { document.getElementById(id).value = v || ""; };
  set("int-nome", comeAllievo ? `${r.nome} ${r.cognome}`.trim() : (r.nomeGenitore || ""));
  set("int-via", r.via); set("int-civico", ""); set("int-cap", r.cap); set("int-localita", r.localita);
  set("int-email", r.email); set("int-telefono", comeAllievo ? "" : (r.telefonoGenitore || ""));
  document.getElementById("int-relazione").value = relazione;
  document.getElementById("intestatario-nuovo-error").innerHTML = "";
  document.getElementById("intestatario-nuovo").classList.remove("hidden");
}

async function salvaNuovoIntestatario() {
  const ctx = intestatarioCtx;
  const errEl = document.getElementById("intestatario-nuovo-error");
  errEl.innerHTML = "";
  const val = id => document.getElementById(id).value.trim();
  const btn = document.getElementById("intestatario-nuovo-salva");
  btn.disabled = true;
  try {
    const nomeAllievo = `${ctx.riga.nome} ${ctx.riga.cognome}`.trim();
    const id = await salvaClienteConControllo({
      nome: val("int-nome"), via: val("int-via"), civico: val("int-civico"), cap: val("int-cap"),
      localita: val("int-localita"), email: val("int-email"), telefono: val("int-telefono"),
      relazione: document.getElementById("int-relazione").value,
      allievi: ctx.riga.allievoId ? [{ id: ctx.riga.allievoId, nome: nomeAllievo }] : []
    });
    if (!id) return;
    // Il cliente (nuovo o già esistente) va collegato anche a questo allievo.
    const doc = await db.collection("clienti").doc(id).get();
    const dati = { id: doc.id, ...doc.data() };
    if (ctx.riga.allievoId && !(dati.allievoIds || []).includes(ctx.riga.allievoId)) {
      await cloudFunctions().httpsCallable("salvaCliente")({
        ...datiClienteDaDoc(dati), forza: true,
        allievi: [...(dati.allievi || []), { id: ctx.riga.allievoId, nome: nomeAllievo }]
      });
      dati.allievoIds = [...(dati.allievoIds || []), ctx.riga.allievoId];
    }
    if (!ctx.clienti.some(c => c.id === id)) ctx.clienti.push(dati);
    ctx.scelti.add(id);
    document.getElementById("intestatario-nuovo").classList.add("hidden");
    renderIntestatario();
  } catch (err) {
    showError(errEl, erroreFunzione(err));
  } finally {
    btn.disabled = false;
  }
}

function confermaIntestatario() {
  const ctx = intestatarioCtx;
  const errEl = document.getElementById("intestatario-error");
  errEl.innerHTML = "";
  const scelti = [...ctx.scelti].map(id => ctx.clienti.find(c => c.id === id)).filter(Boolean);
  if (scelti.length === 0) return showError(errEl, "Scegli a chi intestare la fattura (o aggiungi un intestatario).");
  if (scelti.length > 2) return showError(errEl, "Seleziona al massimo due intestatari.");
  const dest = c => ({ nome: c.nome, via: c.via, civico: c.civico, cap: c.cap, localita: c.localita, email: c.email });
  const pre = { ...ctx.base };
  if (scelti.length === 1) {
    pre.destinatario = dest(scelti[0]);
    pre.clienteId = scelti[0].id;
  } else {
    const qa = parseFloat(document.getElementById("quota-a").value);
    if (!(qa >= 1 && qa <= 99)) return showError(errEl, "La quota del primo intestatario deve essere tra 1 e 99%.");
    const qb = Math.round((100 - qa) * 100) / 100;
    pre.ripartizione = [
      { clienteId: scelti[0].id, destinatario: dest(scelti[0]), percentuale: qa },
      { clienteId: scelti[1].id, destinatario: dest(scelti[1]), percentuale: qb }
    ];
  }
  try {
    sessionStorage.setItem("fatturaPrefill", JSON.stringify(pre));
  } catch {
    alert("Il browser non permette di passare i dati alla pagina Fatture: compila la fattura a mano.");
  }
  location.href = "fatture.html";
}

async function onSalvaRiga(iscrizioneId) {
  const errorEl = document.getElementById(`fatt-salva-error-${iscrizioneId}`);
  const btn = document.querySelector(`.fatt-salva-btn[data-id="${iscrizioneId}"]`);
  errorEl.textContent = "";

  const importoFinale = parseFloat(document.getElementById(`fatt-importo-${iscrizioneId}`).value);
  if (Number.isNaN(importoFinale) || importoFinale < 0) {
    showError(errorEl, "Importo non valido.");
    return;
  }
  const nota = document.getElementById(`fatt-nota-${iscrizioneId}`).value.trim();
  const stato = document.getElementById(`fatt-stato-${iscrizioneId}`).value;

  btn.disabled = true;
  try {
    await salvaRigaFatturazione(iscrizioneId, { importoFinale, nota, stato });
    renderRigheAllievi();
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Stampa ----------

function stampaRiepilogo() {
  const query = ricercaQuery.trim().toLowerCase();
  const righeFiltrate = query
    ? righeAllievi.filter(r => `${r.nome} ${r.cognome}`.toLowerCase().includes(query))
    : righeAllievi;

  const righeHtml = righeFiltrate.map(r => {
    const salvata = fatturazioniSalvate[r.iscrizioneId] || {};
    return `
      <tr>
        <td>${escapeHtml(r.cognome)} ${escapeHtml(r.nome)}</td>
        <td>${escapeHtml(r.corsoOriginaleNome)}</td>
        <td>CHF ${importoAttuale(r).toFixed(2)}</td>
        <td>${escapeHtml(salvata.nota || "")}</td>
        <td>${statoInfo(statoAttuale(r)).label}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("print-area").innerHTML = `
    ${intestazioneStampaHtml()}
    <h1>Fatturazione corsi</h1>
    <table>
      <thead><tr><th>Allievo</th><th>Corso originale</th><th>Importo</th><th>Nota</th><th>Stato</th></tr></thead>
      <tbody>${righeHtml}</tbody>
    </table>
  `;
  window.print();
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  const puoTutte = hasPermission(profile, "iscrizioni:gestisci");
  const puoPadel = hasPermission(profile, "iscrizioni:gestisci_padel");
  if (!puoTutte && !puoPadel) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  try {
    await loadDatiCentro();
    await loadDiscipline();
    await loadCorsiSelettore();
  } catch (err) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("access-denied").querySelector("p").textContent = err.message;
    return;
  }

  document.getElementById("content").classList.remove("hidden");
  renderSelettoreCorsi();

  document.getElementById("fatt-carica-btn").addEventListener("click", onCaricaAllievi);
  document.getElementById("fatt-search-input").addEventListener("input", (e) => {
    ricercaQuery = e.target.value;
    renderRigheAllievi();
  });
  document.getElementById("fatt-stampa-btn").addEventListener("click", stampaRiepilogo);
  document.getElementById("intestatario-chiudi").addEventListener("click", chiudiIntestatario);
  document.getElementById("intestatario-modal").addEventListener("click", (e) => { if (e.target.id === "intestatario-modal") chiudiIntestatario(); });
  document.getElementById("intestatario-conferma").addEventListener("click", confermaIntestatario);
  document.getElementById("intestatario-aggiungi-genitore").addEventListener("click", () => apriNuovoIntestatario("genitore"));
  document.getElementById("intestatario-aggiungi-allievo").addEventListener("click", () => apriNuovoIntestatario("allievo"));
  document.getElementById("intestatario-nuovo-salva").addEventListener("click", salvaNuovoIntestatario);
  document.getElementById("intestatario-nuovo-annulla").addEventListener("click", () => document.getElementById("intestatario-nuovo").classList.add("hidden"));
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
