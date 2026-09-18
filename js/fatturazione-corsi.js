// ============================================================
// fatturazione-corsi.js — strumento di supporto per decidere cosa
// fatturare a fine stagione, quando durante l'anno ci sono stati
// spostamenti di allievi tra corsi/gruppi per bilanciare i livelli.
//
// NON genera una fattura vera (l'app non ha numerazione fiscale/IVA):
// propone un importo per allievo — di base il prezzo del corso a cui si
// è iscritto ORIGINARIAMENTE, non quello attuale — mostra lo storico
// degli spostamenti e le presenze per corso, e lascia correggere
// l'importo a mano prima di segnarlo come gestito. La fattura vera la
// emette lo staff fuori da Sport-OS, con i propri strumenti di
// contabilità; questo è solo il riepilogo su cui basarsi.
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

  return {
    iscrizioneId: iscrizione.id,
    nome: iscrizione.nome,
    cognome: iscrizione.cognome,
    allievoId: iscrizione.allievoId || null,
    corsoOriginaleId,
    corsoOriginaleNome: corsoOriginale?.nome || "— corso non trovato —",
    prezzoProposto: corsoOriginale && corsoOriginale.prezzoRichiesto != null ? corsoOriginale.prezzoRichiesto : null,
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

function aggiornaScoreboard(righeFiltrate) {
  let daValutare = 0, fatturato = 0, totale = 0;
  righeFiltrate.forEach(r => {
    if (statoAttuale(r) === "fatturato") fatturato++; else daValutare++;
    totale += importoAttuale(r);
  });
  document.getElementById("fatt-conteggio-da-valutare").textContent = daValutare;
  document.getElementById("fatt-conteggio-fatturato").textContent = fatturato;
  document.getElementById("fatt-totale-importi").textContent = "CHF " + totale.toFixed(2);
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
            ${riga.prezzoProposto == null ? `<span class="badge" style="border-color:var(--danger);color:var(--danger);">Prezzo non configurato sul corso originale</span>` : ""}
            <span class="badge ${stato === "fatturato" ? "badge-confermata" : "badge-in-attesa"}">${stato === "fatturato" ? "Fatturato" : "Da valutare"}</span>
          </div>
          <div class="entry-meta" style="margin-top:6px;">Corso originale: ${escapeHtml(riga.corsoOriginaleNome)}</div>
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
            <option value="da_valutare" ${stato === "da_valutare" ? "selected" : ""}>Da valutare</option>
            <option value="fatturato" ${stato === "fatturato" ? "selected" : ""}>Fatturato</option>
          </select>
        </div>
        <div class="error-msg" id="fatt-salva-error-${riga.iscrizioneId}"></div>
        <button type="button" class="btn btn-primary fatt-salva-btn" data-id="${riga.iscrizioneId}">Salva</button>
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
        <td>${statoAttuale(r) === "fatturato" ? "Fatturato" : "Da valutare"}</td>
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
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
