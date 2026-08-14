// ============================================================
// configurazione.js — pannello admin: tipi utenza, campi,
// tipi gruppo padel, tipi attività (con tariffe)
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let tipiUtenzaCache = []; // [{id, nome, attivo}]
let tipiAttivitaCache = [];
let prezzoRowCounter = 0;
let editingTipoAttivitaId = null;
let editingTipoUtenzaId = null;
let editingCampoId = null;
let editingDisciplinaId = null;
let editingAllievoId = null;

const DEFAULT_DISCIPLINE_SEED = [
  { id: "tennis", nome: "Tennis", ordine: 0 },
  { id: "padel", nome: "Padel", ordine: 1 },
  { id: "squash", nome: "Squash", ordine: 2 },
  { id: "preparatore-atletico", nome: "Preparatore atletico", ordine: 3 },
  { id: "sparring", nome: "Sparring", ordine: 4 },
  { id: "mental-coach", nome: "Mental Coach", ordine: 5 },
  { id: "official", nome: "Official", ordine: 6 }
];

// Per le discipline create prima dell'introduzione del campo "ordine"
// (mancante), si assegna questo valore come fallback, preservando
// tennis/padel/squash per primi.
const DEFAULT_DISCIPLINE_ORDER = {};
DEFAULT_DISCIPLINE_SEED.forEach(d => { DEFAULT_DISCIPLINE_ORDER[d.id] = d.ordine; });

const POSIZIONI_CAMPO = [
  { id: "interno", label: "Interno" },
  { id: "esterno", label: "Esterno" }
];

function posizioneLabel(id) {
  return (POSIZIONI_CAMPO.find(p => p.id === id) || {}).label || id;
}

// ---------- Dati del centro ----------

async function loadDatiCentroForm() {
  await loadDatiCentro();
  document.getElementById("centro-nome").value = DATI_CENTRO.nome || "";
  document.getElementById("centro-indirizzo").value = DATI_CENTRO.indirizzo || "";
  document.getElementById("centro-cap").value = DATI_CENTRO.cap || "";
  document.getElementById("centro-localita").value = DATI_CENTRO.localita || "";
  document.getElementById("centro-telefono").value = DATI_CENTRO.telefono || "";
  document.getElementById("centro-email").value = DATI_CENTRO.email || "";
  document.getElementById("centro-homepage").value = DATI_CENTRO.homepage || "";
}

async function onSaveDatiCentro(e) {
  e.preventDefault();
  const btn = document.getElementById("salva-centro-btn");
  const errorEl = document.getElementById("centro-error");
  errorEl.textContent = "";
  btn.disabled = true;
  const testoBtn = btn.textContent;

  const dati = {
    nome: document.getElementById("centro-nome").value.trim(),
    indirizzo: document.getElementById("centro-indirizzo").value.trim(),
    cap: document.getElementById("centro-cap").value.trim(),
    localita: document.getElementById("centro-localita").value.trim(),
    telefono: document.getElementById("centro-telefono").value.trim(),
    email: document.getElementById("centro-email").value.trim(),
    homepage: document.getElementById("centro-homepage").value.trim()
  };

  try {
    if (!dati.nome) throw new Error("Il nome del centro è obbligatorio.");
    await db.collection("impostazioni").doc("centro").set(dati, { merge: true });
    DATI_CENTRO = { ...DATI_CENTRO, ...dati };
    // Nessun'altra parte della pagina cambia aspetto dopo il salvataggio
    // (a differenza di liste come Campi/Allievi che si ridisegnano da
    // sole) — senza questa conferma esplicita sembra che il pulsante non
    // faccia nulla, anche quando il salvataggio è andato a buon fine.
    btn.textContent = "Salvato ✓";
    setTimeout(() => { btn.textContent = testoBtn; }, 1800);
  } catch (err) {
    console.error("onSaveDatiCentro:", err);
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Impostazioni generali ----------

async function loadImpostazioniForm() {
  await loadImpostazioni();
  document.getElementById("minuti-eliminazione-diario").value = IMPOSTAZIONI.minutiEliminazioneDiario;
  document.getElementById("impostazioni-festivi").value = (IMPOSTAZIONI.festivi || []).join("\n");
}

async function onSaveImpostazioni(e) {
  e.preventDefault();
  const btn = document.getElementById("salva-impostazioni-btn");
  const errorEl = document.getElementById("impostazioni-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const minuti = parseInt(document.getElementById("minuti-eliminazione-diario").value, 10);
  const festivi = document.getElementById("impostazioni-festivi").value
    .split("\n").map(r => r.trim()).filter(Boolean);

  try {
    if (isNaN(minuti) || minuti < 0) throw new Error("Inserisci un numero di minuti valido.");
    if (festivi.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error("Ogni data festiva deve essere nel formato AAAA-MM-GG.");
    await db.collection("impostazioni").doc("generale").set({ minutiEliminazioneDiario: minuti, festivi }, { merge: true });
    IMPOSTAZIONI.minutiEliminazioneDiario = minuti;
    IMPOSTAZIONI.festivi = festivi;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Helper lista generica con toggle attivo ----------

function renderSimpleList(containerId, items, labelFn, metaFn, collectionName, reloadFn, onEdit, onDuplicate) {
  const list = document.getElementById(containerId);

  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun elemento</div></div>`;
    return;
  }

  list.innerHTML = items.map(it => `
    <div class="entry-card" data-id="${it.id}">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(labelFn(it))}</div>
        <div class="entry-meta">${escapeHtml(metaFn(it))}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${onEdit ? `<button class="btn btn-ghost edit-item-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}">Modifica</button>` : ""}
        ${onDuplicate ? `<button class="btn btn-ghost duplicate-item-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}">Duplica</button>` : ""}
        <button class="btn btn-ghost toggle-active-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}" data-attivo="${it.attivo !== false}">
          ${it.attivo !== false ? "Attivo" : "Disattivato"}
        </button>
        <button class="btn btn-danger delete-item-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}">Elimina</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".toggle-active-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await db.collection(collectionName).doc(btn.dataset.id).update({ attivo: btn.dataset.attivo !== "true" });
        await reloadFn();
      } catch (err) {
        showError(document.getElementById("config-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll(".delete-item-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare definitivamente questo elemento? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection(collectionName).doc(btn.dataset.id).delete();
        await reloadFn();
      } catch (err) {
        showError(document.getElementById("config-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  if (onEdit) {
    list.querySelectorAll(".edit-item-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = items.find(i => i.id === btn.dataset.id);
        onEdit(item);
      });
    });
  }

  if (onDuplicate) {
    list.querySelectorAll(".duplicate-item-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = items.find(i => i.id === btn.dataset.id);
        onDuplicate(item);
      });
    });
  }
}

// ---------- Discipline ----------

// Crea i valori di default solo se la collection è ancora vuota (prima
// attivazione), preservando gli ID storici tennis/padel/squash così le
// voci diario, i colori dei badge e le tariffe già impostate continuano
// a funzionare senza rotture.
async function seedDisciplineIfEmpty() {
  const snap = await db.collection("discipline").limit(1).get();
  if (!snap.empty) return;

  const batch = db.batch();
  DEFAULT_DISCIPLINE_SEED.forEach(d => {
    batch.set(db.collection("discipline").doc(d.id), { nome: d.nome, ordine: d.ordine, attivo: true });
  });
  await batch.commit();
}

// Le discipline create prima dell'introduzione del campo "ordine" non
// ce l'hanno ancora: gliene assegniamo uno la prima volta che vengono
// caricate in Configurazione, così l'ordinamento resta stabile da lì in poi.
async function migrateDisciplineOrderIfMissing(discipline) {
  const missing = discipline.filter(d => d.ordine == null);
  if (missing.length === 0) return false;

  const batch = db.batch();
  missing.forEach(d => {
    const ordine = DEFAULT_DISCIPLINE_ORDER[d.id] != null ? DEFAULT_DISCIPLINE_ORDER[d.id] : 99;
    batch.update(db.collection("discipline").doc(d.id), { ordine });
  });
  await batch.commit();
  return true;
}

// Riusato per qualunque lista con un campo "ordine" opzionale (discipline,
// tipi attività): numero più basso = più in alto; chi non ce l'ha va in
// fondo, poi ordine alfabetico a parità di valore.
function sortByOrdine(items) {
  return items.slice().sort((a, b) => {
    const ao = a.ordine != null ? a.ordine : 99;
    const bo = b.ordine != null ? b.ordine : 99;
    return ao - bo || (a.nome || "").localeCompare(b.nome || "");
  });
}

async function loadDisciplineList() {
  const list = document.getElementById("discipline-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  let snap = await db.collection("discipline").get();
  let discipline = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const migrated = await migrateDisciplineOrderIfMissing(discipline);
  if (migrated) {
    snap = await db.collection("discipline").get();
    discipline = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  discipline = sortByOrdine(discipline);

  renderSimpleList(
    "discipline-list",
    discipline,
    it => it.nome,
    it => `${it.id} · ordine ${it.ordine != null ? it.ordine : "—"}`,
    "discipline",
    loadDisciplineList,
    startEditDisciplina
  );
}

function refreshDisciplinaSelects() {
  populateSelect(document.getElementById("new-campo-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-tipoattivita-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-quotacampo-disciplina"), DISCIPLINE);
}

function startEditDisciplina(item) {
  editingDisciplinaId = item.id;
  document.getElementById("new-disciplina-id").value = item.id;
  document.getElementById("new-disciplina-id").disabled = true;
  document.getElementById("new-disciplina-nome").value = item.nome || "";
  document.getElementById("new-disciplina-ordine").value = item.ordine != null ? item.ordine : "";
  document.getElementById("create-disciplina-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-disciplina-btn").classList.remove("hidden");
  document.getElementById("new-disciplina-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditDisciplina() {
  editingDisciplinaId = null;
  document.getElementById("new-disciplina-form").reset();
  document.getElementById("new-disciplina-id").disabled = false;
  document.getElementById("create-disciplina-btn").textContent = "+ Aggiungi disciplina";
  document.getElementById("cancel-edit-disciplina-btn").classList.add("hidden");
}

async function onCreateDisciplina(e) {
  e.preventDefault();
  const btn = document.getElementById("create-disciplina-btn");
  const errorEl = document.getElementById("new-disciplina-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const id = document.getElementById("new-disciplina-id").value.trim();
  const nome = document.getElementById("new-disciplina-nome").value.trim();
  const ordineRaw = document.getElementById("new-disciplina-ordine").value;
  const ordine = ordineRaw !== "" ? parseInt(ordineRaw, 10) : 99;

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingDisciplinaId) {
      await db.collection("discipline").doc(editingDisciplinaId).update({ nome, ordine });
    } else {
      if (!id) throw new Error("Inserisci un ID disciplina (es. mental-coach).");
      await db.collection("discipline").doc(id).set({ nome, ordine, attivo: true });
    }
    cancelEditDisciplina();
    await loadDisciplineList();
    await loadDiscipline();
    refreshDisciplinaSelects();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Allievi ----------

async function loadAllievi() {
  const list = document.getElementById("allievi-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("allievi").orderBy("nome").get();
  const allievi = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const metaFn = it => [it.tel, it.email].filter(Boolean).join(" · ");
  renderSimpleList("allievi-list", allievi, it => it.nome, metaFn, "allievi", loadAllievi, startEditAllievo);
}

function startEditAllievo(item) {
  editingAllievoId = item.id;
  document.getElementById("new-allievo-nome").value = item.nome || "";
  document.getElementById("new-allievo-tel").value = item.tel || "";
  document.getElementById("new-allievo-email").value = item.email || "";
  document.getElementById("create-allievo-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-allievo-btn").classList.remove("hidden");
  document.getElementById("new-allievo-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditAllievo() {
  editingAllievoId = null;
  document.getElementById("new-allievo-form").reset();
  document.getElementById("create-allievo-btn").textContent = "+ Aggiungi allievo";
  document.getElementById("cancel-edit-allievo-btn").classList.add("hidden");
}

async function onCreateAllievo(e) {
  e.preventDefault();
  const btn = document.getElementById("create-allievo-btn");
  const errorEl = document.getElementById("new-allievo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const nome = document.getElementById("new-allievo-nome").value.trim();
  const tel = document.getElementById("new-allievo-tel").value.trim();
  const email = document.getElementById("new-allievo-email").value.trim();

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingAllievoId) {
      await db.collection("allievi").doc(editingAllievoId).update({ nome, tel: tel || null, email: email || null });
    } else {
      await db.collection("allievi").add({ nome, attivo: true, tel: tel || null, email: email || null });
    }
    cancelEditAllievo();
    await loadAllievi();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Tipi utenza ----------

async function loadTipiUtenza() {
  const list = document.getElementById("tipiutenza-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("tipiUtenza").orderBy("nome").get();
  tipiUtenzaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderSimpleList("tipiutenza-list", tipiUtenzaCache, it => it.nome, () => "", "tipiUtenza", loadTipiUtenza, startEditTipoUtenza);
  refreshPrezzoRowSelects();
}

function startEditTipoUtenza(item) {
  editingTipoUtenzaId = item.id;
  document.getElementById("new-tipoutenza-nome").value = item.nome || "";
  document.getElementById("create-tipoutenza-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-tipoutenza-btn").classList.remove("hidden");
  document.getElementById("new-tipoutenza-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditTipoUtenza() {
  editingTipoUtenzaId = null;
  document.getElementById("new-tipoutenza-form").reset();
  document.getElementById("create-tipoutenza-btn").textContent = "+ Aggiungi tipo utenza";
  document.getElementById("cancel-edit-tipoutenza-btn").classList.add("hidden");
}

async function onCreateTipoUtenza(e) {
  e.preventDefault();
  const btn = document.getElementById("create-tipoutenza-btn");
  const errorEl = document.getElementById("new-tipoutenza-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const nome = document.getElementById("new-tipoutenza-nome").value.trim();

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingTipoUtenzaId) {
      await db.collection("tipiUtenza").doc(editingTipoUtenzaId).update({ nome });
    } else {
      await db.collection("tipiUtenza").add({ nome, attivo: true });
    }
    cancelEditTipoUtenza();
    await loadTipiUtenza();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Campi ----------

async function loadCampi() {
  const list = document.getElementById("campi-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("campi").get();
  const campi = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  campi.sort((a, b) => (a.numero || "").localeCompare(b.numero || "", undefined, { numeric: true }));

  renderSimpleList(
    "campi-list",
    campi,
    it => "Campo " + it.numero,
    it => `${disciplinaLabel(it.disciplina)} · ${posizioneLabel(it.posizione)}`,
    "campi",
    loadCampi,
    startEditCampo
  );
}

function startEditCampo(item) {
  editingCampoId = item.id;
  document.getElementById("new-campo-numero").value = item.numero || "";
  document.getElementById("new-campo-disciplina").value = item.disciplina || "";
  document.getElementById("new-campo-posizione").value = item.posizione || "";
  document.getElementById("create-campo-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-campo-btn").classList.remove("hidden");
  document.getElementById("new-campo-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditCampo() {
  editingCampoId = null;
  document.getElementById("new-campo-form").reset();
  document.getElementById("create-campo-btn").textContent = "+ Aggiungi campo";
  document.getElementById("cancel-edit-campo-btn").classList.add("hidden");
}

async function onCreateCampo(e) {
  e.preventDefault();
  const btn = document.getElementById("create-campo-btn");
  const errorEl = document.getElementById("new-campo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const numero = document.getElementById("new-campo-numero").value.trim();
  const disciplina = document.getElementById("new-campo-disciplina").value;
  const posizione = document.getElementById("new-campo-posizione").value;

  try {
    if (!numero) throw new Error("Inserisci un numero campo.");
    if (editingCampoId) {
      await db.collection("campi").doc(editingCampoId).update({ numero, disciplina, posizione });
    } else {
      await db.collection("campi").add({ numero, disciplina, posizione, attivo: true });
    }
    cancelEditCampo();
    await loadCampi();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Tipi gruppo Padel ----------

async function loadTipiGruppoPadel() {
  const list = document.getElementById("tipigruppopadel-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("tipiGruppoPadel").orderBy("nome").get();
  const tipi = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderSimpleList("tipigruppopadel-list", tipi, it => it.nome, () => "", "tipiGruppoPadel", loadTipiGruppoPadel);
}

async function onCreateTipoGruppoPadel(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const errorEl = document.getElementById("new-tipogruppopadel-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const nome = document.getElementById("new-tipogruppopadel-nome").value.trim();

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    await db.collection("tipiGruppoPadel").add({ nome, attivo: true });
    document.getElementById("new-tipogruppopadel-form").reset();
    await loadTipiGruppoPadel();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Tipi attività (con tariffe per tipo utenza/periodo) ----------

function prezzoRowHtml(rowId) {
  const options = tipiUtenzaCache.map(u => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join("");
  return `
    <div class="row-card prezzo-row" data-row-id="${rowId}">
      <button type="button" class="row-remove" data-remove-prezzo="${rowId}">Rimuovi</button>
      <div class="row-label">Tariffa</div>
      <div class="field">
        <label>Tipo utenza</label>
        <select class="prezzo-tipoutenza">
          <option value="">— tutti —</option>
          ${options}
        </select>
      </div>
      <div class="row2">
        <div class="field">
          <label>Dal</label>
          <input type="date" class="prezzo-periodo-inizio">
        </div>
        <div class="field">
          <label>Al</label>
          <input type="date" class="prezzo-periodo-fine">
        </div>
      </div>
      <div class="field">
        <label>Prezzo/ora (CHF)</label>
        <input type="number" class="prezzo-ora" min="0" step="0.05" placeholder="es. 45">
      </div>
    </div>
  `;
}

function addPrezzoRow(initial) {
  prezzoRowCounter++;
  const container = document.getElementById("prezzi-rows-container");
  container.insertAdjacentHTML("beforeend", prezzoRowHtml(prezzoRowCounter));

  if (initial) {
    const row = container.querySelector(`[data-row-id="${prezzoRowCounter}"]`);
    if (initial.tipoUtenzaId) row.querySelector(".prezzo-tipoutenza").value = initial.tipoUtenzaId;
    if (initial.periodoInizio) row.querySelector(".prezzo-periodo-inizio").value = initial.periodoInizio;
    if (initial.periodoFine) row.querySelector(".prezzo-periodo-fine").value = initial.periodoFine;
    if (initial.prezzoOra != null) row.querySelector(".prezzo-ora").value = initial.prezzoOra;
  }
}

function refreshPrezzoRowSelects() {
  // Se i tipi utenza cambiano dopo che alcune righe tariffa sono già state
  // aggiunte, rigenera le opzioni mantenendo il valore selezionato dove possibile.
  document.querySelectorAll(".prezzo-row").forEach(row => {
    const select = row.querySelector(".prezzo-tipoutenza");
    const current = select.value;
    const options = tipiUtenzaCache.map(u => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join("");
    select.innerHTML = `<option value="">— tutti —</option>${options}`;
    select.value = current;
  });
}

function wirePrezzoRowRemoval() {
  document.getElementById("prezzi-rows-container").addEventListener("click", (e) => {
    if (e.target.matches("[data-remove-prezzo]")) {
      e.target.closest(".prezzo-row").remove();
    }
  });
}

// Ai tipi attività creati prima dell'introduzione del campo "ordine"
// (mancante) si assegna un ordine di partenza basato sull'ordine
// alfabetico attuale, così la lista non salta visivamente al primo
// caricamento; da lì in poi l'admin può aggiustarlo a piacere.
async function migrateTipoAttivitaOrderIfMissing(tipi) {
  const missing = tipi.filter(t => t.ordine == null);
  if (missing.length === 0) return false;

  const ordinati = missing.slice().sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
  const batch = db.batch();
  ordinati.forEach((t, i) => {
    batch.update(db.collection("tipiAttivita").doc(t.id), { ordine: i });
  });
  await batch.commit();
  return true;
}

async function loadTipiAttivita() {
  const list = document.getElementById("tipiattivita-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  let snap = await db.collection("tipiAttivita").get();
  let tipi = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const migrated = await migrateTipoAttivitaOrderIfMissing(tipi);
  if (migrated) {
    snap = await db.collection("tipiAttivita").get();
    tipi = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  tipiAttivitaCache = sortByOrdine(tipi);

  renderTipiAttivitaList();
}

function renderTipiAttivitaList() {
  const list = document.getElementById("tipiattivita-list");

  if (tipiAttivitaCache.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessun elemento</div></div>`;
    return;
  }

  list.innerHTML = tipiAttivitaCache.map(it => `
    <div class="entry-card" data-id="${it.id}">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(it.nome)}</div>
        <div class="entry-meta">${escapeHtml(disciplinaLabel(it.disciplina))} · ordine ${it.ordine != null ? it.ordine : "—"}${it.durataMinuti ? " · " + it.durataMinuti + "'" : ""} · ${(it.prezzi || []).length} tariffe${it.soggettoQuotaCampo ? " · quota campo" : ""}${it.retribuitoCollaboratore ? " · compenso" : ""}${it.richiedeAllievo ? " · richiede allievo" : ""}${it.richiedeCampo === false ? " · niente campo" : ""}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="btn btn-ghost edit-tipoattivita-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}">Modifica</button>
        <button class="btn btn-ghost toggle-active-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}" data-attivo="${it.attivo !== false}">
          ${it.attivo !== false ? "Attivo" : "Disattivato"}
        </button>
        <button class="btn btn-danger delete-tipoattivita-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${it.id}">Elimina</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".toggle-active-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await db.collection("tipiAttivita").doc(btn.dataset.id).update({ attivo: btn.dataset.attivo !== "true" });
        await loadTipiAttivita();
      } catch (err) {
        showError(document.getElementById("config-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll(".delete-tipoattivita-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare definitivamente questo tipo attività? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("tipiAttivita").doc(btn.dataset.id).delete();
        await loadTipiAttivita();
      } catch (err) {
        showError(document.getElementById("config-list-error"), "Errore: " + err.message);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll(".edit-tipoattivita-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tipo = tipiAttivitaCache.find(t => t.id === btn.dataset.id);
      startEditTipoAttivita(tipo);
    });
  });
}

function startEditTipoAttivita(tipo) {
  editingTipoAttivitaId = tipo.id;

  document.getElementById("new-tipoattivita-nome").value = tipo.nome || "";
  document.getElementById("new-tipoattivita-disciplina").value = tipo.disciplina || "";
  document.getElementById("new-tipoattivita-ordine").value = tipo.ordine != null ? tipo.ordine : "";
  document.getElementById("new-tipoattivita-durata").value = tipo.durataMinuti != null ? tipo.durataMinuti : "";
  document.getElementById("new-tipoattivita-quotacampo").checked = !!tipo.soggettoQuotaCampo;
  document.getElementById("new-tipoattivita-retribuito").checked = !!tipo.retribuitoCollaboratore;
  document.getElementById("new-tipoattivita-richiedeallievo").checked = !!tipo.richiedeAllievo;
  document.getElementById("new-tipoattivita-richiedecampo").checked = tipo.richiedeCampo !== false;

  document.getElementById("prezzi-rows-container").innerHTML = "";
  (tipo.prezzi || []).forEach(p => addPrezzoRow(p));

  document.getElementById("tipoattivita-form-title").textContent = "Modifica tipo attività";
  document.getElementById("create-tipoattivita-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-tipoattivita-btn").classList.remove("hidden");

  document.getElementById("new-tipoattivita-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditTipoAttivita() {
  editingTipoAttivitaId = null;
  document.getElementById("new-tipoattivita-form").reset();
  document.getElementById("prezzi-rows-container").innerHTML = "";
  document.getElementById("tipoattivita-form-title").textContent = "Nuovo tipo attività";
  document.getElementById("create-tipoattivita-btn").textContent = "Crea tipo attività";
  document.getElementById("cancel-edit-tipoattivita-btn").classList.add("hidden");
}

async function onCreateTipoAttivita(e) {
  e.preventDefault();
  const btn = document.getElementById("create-tipoattivita-btn");
  const errorEl = document.getElementById("new-tipoattivita-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = editingTipoAttivitaId ? "Salvataggio…" : "Creazione…";

  const nome = document.getElementById("new-tipoattivita-nome").value.trim();
  const disciplina = document.getElementById("new-tipoattivita-disciplina").value;
  const ordineRaw = document.getElementById("new-tipoattivita-ordine").value;
  const ordine = ordineRaw !== "" ? parseInt(ordineRaw, 10) : 99;
  const durataRaw = document.getElementById("new-tipoattivita-durata").value;
  const durataMinuti = durataRaw !== "" ? parseInt(durataRaw, 10) : null;
  const soggettoQuotaCampo = document.getElementById("new-tipoattivita-quotacampo").checked;
  const retribuitoCollaboratore = document.getElementById("new-tipoattivita-retribuito").checked;
  const richiedeAllievo = document.getElementById("new-tipoattivita-richiedeallievo").checked;
  const richiedeCampo = document.getElementById("new-tipoattivita-richiedecampo").checked;

  const prezzi = [];
  document.querySelectorAll(".prezzo-row").forEach(row => {
    const tipoUtenzaId = row.querySelector(".prezzo-tipoutenza").value;
    const prezzoOraRaw = row.querySelector(".prezzo-ora").value;
    if (!prezzoOraRaw) return; // riga incompleta, ignorata
    const tipoUtenza = tipiUtenzaCache.find(u => u.id === tipoUtenzaId);
    prezzi.push({
      tipoUtenzaId: tipoUtenzaId || null,
      tipoUtenzaNome: tipoUtenza ? tipoUtenza.nome : "Tutti",
      periodoInizio: row.querySelector(".prezzo-periodo-inizio").value || null,
      periodoFine: row.querySelector(".prezzo-periodo-fine").value || null,
      prezzoOra: parseFloat(prezzoOraRaw)
    });
  });

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingTipoAttivitaId) {
      await db.collection("tipiAttivita").doc(editingTipoAttivitaId).update({ nome, disciplina, ordine, durataMinuti, soggettoQuotaCampo, retribuitoCollaboratore, richiedeAllievo, richiedeCampo, prezzi });
    } else {
      await db.collection("tipiAttivita").add({ nome, disciplina, ordine, durataMinuti, soggettoQuotaCampo, retribuitoCollaboratore, richiedeAllievo, richiedeCampo, attivo: true, prezzi });
    }
    cancelEditTipoAttivita();
    await loadTipiAttivita();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = editingTipoAttivitaId ? "Salva modifiche" : "Crea tipo attività";
  }
}

// ---------- Quote campo ----------

function quotaCampoLabel(it) {
  return `${disciplinaLabel(it.disciplina)} · ${it.posizione ? posizioneLabel(it.posizione) : "Tutti i campi"}`;
}

const TIPO_GIORNO_LABEL = { feriale: "feriale (lun-sab)", domenica_festivo: "domenica e festivi" };

function quotaCampoMeta(it) {
  const parts = [];
  if (it.periodoInizio || it.periodoFine) {
    parts.push(`${it.periodoInizio || "…"} → ${it.periodoFine || "…"}`);
  }
  if (it.tipoGiorno) parts.push(TIPO_GIORNO_LABEL[it.tipoGiorno] || it.tipoGiorno);
  if (it.disciplina === "padel") {
    parts.push((it.durataMinuti || "—") + " min");
    parts.push(it.fasciaOraria === "dopo_17" ? "dopo le 17:00" : "prima delle 17:00");
    parts.push("CHF " + (it.importo || 0).toFixed(2) + " a lezione");
  } else {
    parts.push("CHF " + (it.importo || 0).toFixed(2) + "/ora");
  }
  return parts.join(" · ");
}

async function loadQuoteCampo() {
  const list = document.getElementById("quotecampo-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("quoteCampo").get();
  const quote = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderSimpleList("quotecampo-list", quote, quotaCampoLabel, quotaCampoMeta, "quoteCampo", loadQuoteCampo);
}

function syncQuotaCampoPadelFields() {
  const isPadel = document.getElementById("new-quotacampo-disciplina").value === "padel";
  document.getElementById("quotacampo-padel-fields").classList.toggle("hidden", !isPadel);
  document.getElementById("quotacampo-importo-label").textContent = isPadel ? "Importo (CHF a lezione)" : "Importo (CHF/ora)";
}

async function onCreateQuotaCampo(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const errorEl = document.getElementById("new-quotacampo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const disciplina = document.getElementById("new-quotacampo-disciplina").value;
  const importoRaw = document.getElementById("new-quotacampo-importo").value;

  const quota = {
    disciplina,
    posizione: document.getElementById("new-quotacampo-posizione").value || null,
    periodoInizio: document.getElementById("new-quotacampo-dal").value || null,
    periodoFine: document.getElementById("new-quotacampo-al").value || null,
    tipoGiorno: document.getElementById("new-quotacampo-giorno").value || null,
    importo: parseFloat(importoRaw),
    attivo: true
  };

  if (disciplina === "padel") {
    quota.durataMinuti = parseInt(document.getElementById("new-quotacampo-durata").value, 10);
    quota.fasciaOraria = document.getElementById("new-quotacampo-fascia").value;
  }

  try {
    if (!importoRaw) throw new Error("Inserisci un importo.");
    await db.collection("quoteCampo").add(quota);
    document.getElementById("new-quotacampo-form").reset();
    syncQuotaCampoPadelFields();
    await loadQuoteCampo();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Articoli (Cassa/Bar) ----------

let editingArticoloId = null;

async function loadArticoli() {
  const list = document.getElementById("articoli-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("articoli").orderBy("nome").get();
  const articoli = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderSimpleList(
    "articoli-list",
    articoli,
    it => it.nome,
    it => it.prezzoDefault ? `CHF ${it.prezzoDefault.toFixed(2)}` : "importo libero",
    "articoli",
    loadArticoli,
    startEditArticolo
  );
}

function startEditArticolo(item) {
  editingArticoloId = item.id;
  document.getElementById("new-articolo-nome").value = item.nome || "";
  document.getElementById("new-articolo-prezzo").value = item.prezzoDefault || "";
  document.getElementById("create-articolo-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-articolo-btn").classList.remove("hidden");
  document.getElementById("new-articolo-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditArticolo() {
  editingArticoloId = null;
  document.getElementById("new-articolo-form").reset();
  document.getElementById("create-articolo-btn").textContent = "+ Aggiungi articolo";
  document.getElementById("cancel-edit-articolo-btn").classList.add("hidden");
}

async function onCreateArticolo(e) {
  e.preventDefault();
  const btn = document.getElementById("create-articolo-btn");
  const errorEl = document.getElementById("new-articolo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const nome = document.getElementById("new-articolo-nome").value.trim();
  const prezzoDefault = parseFloat(document.getElementById("new-articolo-prezzo").value) || 0;

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingArticoloId) {
      await db.collection("articoli").doc(editingArticoloId).update({ nome, prezzoDefault });
    } else {
      await db.collection("articoli").add({ nome, prezzoDefault, attivo: true });
    }
    cancelEditArticolo();
    await loadArticoli();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Prenotazione campi: soci, tariffe, forfait, chiusure ----------

// Le sotto-categorie di tesseramento (Attivi, Famiglia, Studenti, Età AVS,
// Sostenitori, fasce Junior...) sono configurabili in "Categorie socio",
// non più un elenco fisso — "azienda" ed "esterno" restano gli unici due
// valori non di tesseramento, sempre presenti.
let categorieSocioCache = []; // [{id, nome, costoForfait, ordine, attivo}]
let editingCategoriaSocioId = null;

function categorieComplete() {
  return [...categorieSocioCache, { id: "azienda", nome: "Azienda partner" }, { id: "esterno", nome: "Utenti" }];
}

let CATEGORIA_LABEL = { azienda: "Azienda partner", esterno: "Utenti" };
function aggiornaCategoriaLabel() {
  CATEGORIA_LABEL = Object.fromEntries(categorieComplete().map(c => [c.id, c.nome]));
}

const DEFAULT_CATEGORIE_SOCIO_SEED = [
  { id: "attivi", nome: "Attivi", ordine: 0 },
  { id: "famiglia", nome: "Famiglia", ordine: 1 },
  { id: "studenti", nome: "Studenti", ordine: 2 },
  { id: "eta-avs", nome: "Età AVS", ordine: 3 },
  { id: "sostenitori", nome: "Sostenitori", ordine: 4 },
  { id: "junior-fino-12", nome: "Junior fino a 12 anni", ordine: 5 },
  { id: "junior-13-15", nome: "Junior da 13 a 15 anni", ordine: 6 },
  { id: "junior-16-18", nome: "Junior da 16 a 18 anni", ordine: 7 }
];

// Come seedDisciplineIfEmpty(): crea le voci di default solo alla prima
// attivazione (collection ancora vuota), mai in seguito — non deve
// resuscitare una categoria che lo staff ha volutamente eliminato.
async function seedCategorieSocioIfEmpty() {
  const snap = await db.collection("categorieSocio").limit(1).get();
  if (!snap.empty) return;

  const batch = db.batch();
  DEFAULT_CATEGORIE_SOCIO_SEED.forEach(c => {
    batch.set(db.collection("categorieSocio").doc(c.id), { nome: c.nome, costoForfait: null, ordine: c.ordine, attivo: true });
  });
  await batch.commit();
}

async function loadCategorieSocio() {
  const snap = await db.collection("categorieSocio").get();
  categorieSocioCache = sortByOrdine(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  aggiornaCategoriaLabel();
  renderSimpleList(
    "categoriesocio-list",
    categorieSocioCache,
    it => it.nome,
    it => it.costoForfait != null ? `Quota forfait: CHF ${Number(it.costoForfait).toFixed(2)}` : "Quota forfait non ancora impostata",
    "categorieSocio",
    loadCategorieSocio,
    startEditCategoriaSocio
  );
}

function startEditCategoriaSocio(item) {
  editingCategoriaSocioId = item.id;
  document.getElementById("new-categoriasocio-id").value = item.id;
  document.getElementById("new-categoriasocio-id").disabled = true;
  document.getElementById("new-categoriasocio-nome").value = item.nome || "";
  document.getElementById("new-categoriasocio-costo").value = item.costoForfait != null ? item.costoForfait : "";
  document.getElementById("new-categoriasocio-ordine").value = item.ordine != null ? item.ordine : "";
  document.getElementById("create-categoriasocio-btn").textContent = "Salva modifiche";
  document.getElementById("cancel-edit-categoriasocio-btn").classList.remove("hidden");
  document.getElementById("new-categoriasocio-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEditCategoriaSocio() {
  editingCategoriaSocioId = null;
  document.getElementById("new-categoriasocio-form").reset();
  document.getElementById("new-categoriasocio-id").disabled = false;
  document.getElementById("create-categoriasocio-btn").textContent = "+ Aggiungi categoria";
  document.getElementById("cancel-edit-categoriasocio-btn").classList.add("hidden");
}

async function onCreateCategoriaSocio(e) {
  e.preventDefault();
  const btn = document.getElementById("create-categoriasocio-btn");
  const errorEl = document.getElementById("new-categoriasocio-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const id = document.getElementById("new-categoriasocio-id").value.trim();
  const nome = document.getElementById("new-categoriasocio-nome").value.trim();
  const costoRaw = document.getElementById("new-categoriasocio-costo").value;
  const costoForfait = costoRaw !== "" ? parseFloat(costoRaw) : null;
  const ordineRaw = document.getElementById("new-categoriasocio-ordine").value;
  const ordine = ordineRaw !== "" ? parseInt(ordineRaw, 10) : 99;

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingCategoriaSocioId) {
      await db.collection("categorieSocio").doc(editingCategoriaSocioId).update({ nome, costoForfait, ordine });
    } else {
      if (!id) throw new Error("Inserisci un ID categoria (es. attivi) — usato anche nell'import soci.");
      await db.collection("categorieSocio").doc(id).set({ nome, costoForfait, ordine, attivo: true });
    }
    cancelEditCategoriaSocio();
    await loadCategorieSocio();
    await sincronizzaSelectCategorie();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Ripopola tutti i punti che elencano le categorie (select Tariffe campi,
// checkbox Forfait stagionale, form giorni di anticipo) — richiamata dopo
// ogni modifica a "Categorie socio" così restano sempre aggiornati senza
// dover ricaricare la pagina.
function sincronizzaSelectCategorie() {
  populateSelect(document.getElementById("new-tariffacampo-categoria"), categorieComplete().map(c => ({ id: c.id, label: c.nome })));
  document.getElementById("forfaitcampo-categorie-checks").innerHTML = categorieComplete()
    .filter(c => c.id !== "esterno")
    .map(c => `<div class="checkbox-row"><input type="checkbox" id="fc-cat-${c.id}" value="${c.id}"><label for="fc-cat-${c.id}">${escapeHtml(c.nome)}</label></div>`)
    .join("");
  renderCampiAnticipoPrenotazione();
}

// Solo le discipline che usano davvero un tabellone campi (non ha senso
// chiudere "Preparatore atletico" ecc.).
const DISCIPLINE_CHIUDIBILI = [
  { id: "tennis", nome: "Tennis" },
  { id: "squash", nome: "Squash" },
  { id: "padel", nome: "Padel" }
];

async function onImportSoci(e) {
  e.preventDefault();
  const btn = document.getElementById("import-soci-btn");
  const errorEl = document.getElementById("import-soci-error");
  const successEl = document.getElementById("import-soci-success");
  errorEl.textContent = "";
  successEl.textContent = "";
  btn.disabled = true;

  const testo = document.getElementById("import-soci-testo").value.trim();
  const righe = testo.split("\n").map(r => r.trim()).filter(Boolean).map(riga => {
    const [nome, cognome, email, categoria, telefono, tessera] = riga.split(";").map(v => (v || "").trim());
    return { nome, cognome, email, categoria, telefono: telefono || null, tessera: tessera || null };
  });

  try {
    if (righe.length === 0) throw new Error("Incolla almeno una riga.");
    const fn = firebase.functions().httpsCallable("importaSoci");
    const result = await fn({ righe });
    successEl.textContent = `Importati ${result.data.importate} soci`
      + (result.data.scartate ? ` (${result.data.scartate} righe scartate — controlla il formato).` : ".");
    document.getElementById("import-soci-testo").value = "";
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Tariffe campi ----------

function tariffaCampoLabel(it) {
  const posizioneLbl = it.disciplina === "padel" ? "" : ` · ${it.posizione ? posizioneLabel(it.posizione) : "Tutti i campi"}`;
  return `${disciplinaLabel(it.disciplina)}${posizioneLbl} · ${CATEGORIA_LABEL[it.categoria] || it.categoria}`;
}

function tariffaCampoMeta(it) {
  const parts = [];
  const giorniLabel = (it.giorniSettimana || []).length
    ? it.giorniSettimana.map(g => (GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g).join(",")
    : "Tutti i giorni";
  parts.push(giorniLabel);
  if (it.oraInizio && it.oraFine) parts.push(`${it.oraInizio}–${it.oraFine}`);
  if (it.durataMinuti) parts.push(`${it.durataMinuti}'`);
  parts.push("CHF " + (it.prezzo || 0).toFixed(2) + " a slot");
  return parts.join(" · ");
}

async function loadTariffeCampi() {
  const snap = await db.collection("tariffeCampi").get();
  const tariffe = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderSimpleList("tariffecampi-list", tariffe, tariffaCampoLabel, tariffaCampoMeta, "tariffeCampi", loadTariffeCampi, null, startDuplicaTariffaCampo);
}

function syncTariffaCampoPadelFields() {
  const isPadel = document.getElementById("new-tariffacampo-disciplina").value === "padel";
  document.getElementById("tariffacampo-posizione-field").classList.toggle("hidden", isPadel);
}

// Precompila il form con i valori di una tariffa esistente (non è una vera
// modifica: non imposta nessun ID in edit, submit crea sempre una riga
// nuova) — per velocizzare l'inserimento di tante combinazioni
// categoria/durata/fascia simili tra loro senza doverle ridigitare da zero.
function startDuplicaTariffaCampo(item) {
  document.getElementById("new-tariffacampo-disciplina").value = item.disciplina;
  syncTariffaCampoPadelFields();
  document.getElementById("new-tariffacampo-posizione").value = item.posizione || "";
  document.getElementById("new-tariffacampo-categoria").value = item.categoria;
  document.querySelectorAll("#tariffacampo-giorni-checks input").forEach(chk => {
    chk.checked = (item.giorniSettimana || []).includes(chk.value);
  });
  document.getElementById("new-tariffacampo-orainizio").value = item.oraInizio || "";
  document.getElementById("new-tariffacampo-orafine").value = item.oraFine || "";
  document.getElementById("new-tariffacampo-durata").value = item.durataMinuti != null ? item.durataMinuti : "";
  document.getElementById("new-tariffacampo-prezzo").value = item.prezzo != null ? item.prezzo : "";
  document.getElementById("new-tariffacampo-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function onCreateTariffaCampo(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const errorEl = document.getElementById("new-tariffacampo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const prezzoRaw = document.getElementById("new-tariffacampo-prezzo").value;
  const durataRaw = document.getElementById("new-tariffacampo-durata").value;
  const oraInizio = document.getElementById("new-tariffacampo-orainizio").value;
  const oraFine = document.getElementById("new-tariffacampo-orafine").value;
  const disciplina = document.getElementById("new-tariffacampo-disciplina").value;
  const posizione = disciplina === "padel" ? null : (document.getElementById("new-tariffacampo-posizione").value || null);
  const categoria = document.getElementById("new-tariffacampo-categoria").value;
  const durataMinuti = durataRaw !== "" ? parseInt(durataRaw, 10) : null;
  const giorniSettimana = Array.from(document.querySelectorAll("#tariffacampo-giorni-checks input:checked")).map(c => c.value);
  try {
    if (!prezzoRaw) throw new Error("Inserisci un prezzo.");
    if (!oraInizio || !oraFine) throw new Error("Inserisci l'orario di inizio e fine fascia.");
    if (oraInizio >= oraFine) throw new Error("L'orario di fine deve essere successivo a quello di inizio.");

    // Con "Duplica" è facile salvare per sbaglio una copia identica senza
    // aver cambiato nulla — blocco solo il doppione esatto (stessi giorni,
    // stesso orario, stessa durata): fasce sovrapposte ma diverse restano
    // valide, è il modo in cui si definiscono più fasce.
    const giorniOrdinati = [...giorniSettimana].sort().join(",");
    const esistentiSnap = await db.collection("tariffeCampi")
      .where("disciplina", "==", disciplina)
      .where("posizione", "==", posizione)
      .where("categoria", "==", categoria)
      .get();
    const doppione = esistentiSnap.docs.some(d => {
      const t = d.data();
      return t.oraInizio === oraInizio && t.oraFine === oraFine
        && (t.durataMinuti ?? null) === durataMinuti
        && [...(t.giorniSettimana || [])].sort().join(",") === giorniOrdinati;
    });
    if (doppione) throw new Error("Esiste già una tariffa identica (stessa disciplina, posizione, categoria, giorni, orario e durata).");

    await db.collection("tariffeCampi").add({
      disciplina,
      posizione,
      categoria,
      giorniSettimana,
      oraInizio,
      oraFine,
      durataMinuti,
      prezzo: parseFloat(prezzoRaw),
      attivo: true
    });
    document.getElementById("new-tariffacampo-form").reset();
    await loadTariffeCampi();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Forfait stagionale ----------

function forfaitCampoLabel(it) {
  return `${disciplinaLabel(it.disciplina)} · ${it.posizione ? posizioneLabel(it.posizione) : "Tutti i campi"}`;
}

function forfaitCampoMeta(it) {
  const categorie = (it.categorie || []).map(c => CATEGORIA_LABEL[c] || c).join(", ");
  return `${it.periodoInizio} → ${it.periodoFine} · ${categorie || "nessuna categoria"}`;
}

async function loadForfaitCampi() {
  const snap = await db.collection("forfaitCampi").get();
  const forfait = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderSimpleList("forfaitcampi-list", forfait, forfaitCampoLabel, forfaitCampoMeta, "forfaitCampi", loadForfaitCampi);
}

async function onCreateForfaitCampo(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const errorEl = document.getElementById("new-forfaitcampo-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const dal = document.getElementById("new-forfaitcampo-dal").value;
  const al = document.getElementById("new-forfaitcampo-al").value;
  const categorie = Array.from(document.querySelectorAll("#forfaitcampo-categorie-checks input:checked")).map(c => c.value);

  try {
    if (!dal || !al) throw new Error("Inserisci il periodo.");
    if (categorie.length === 0) throw new Error("Seleziona almeno una categoria.");
    await db.collection("forfaitCampi").add({
      disciplina: document.getElementById("new-forfaitcampo-disciplina").value,
      posizione: document.getElementById("new-forfaitcampo-posizione").value || null,
      periodoInizio: dal,
      periodoFine: al,
      categorie,
      attivo: true
    });
    document.getElementById("new-forfaitcampo-form").reset();
    await loadForfaitCampi();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Chiusure centro ----------
//
// Doc ID = data ISO (come chiusurePadel, di cui questa è il complemento
// centro-wide): niente toggle attivo/disattivo, o la chiusura c'è o non
// c'è, quindi non riusa renderSimpleList.

function renderChiusureCentro(chiusure) {
  const el = document.getElementById("chiusurecentro-list");
  if (chiusure.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna chiusura</div></div>`;
    return;
  }
  el.innerHTML = chiusure.map(c => {
    const discipline = (c.discipline || []).map(d => (DISCIPLINE_CHIUDIBILI.find(x => x.id === d) || {}).nome || d).join(", ");
    return `
      <div class="entry-card" data-id="${c.id}">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(c.id)}</div>
          <div class="entry-meta">${escapeHtml(discipline || "Tutto il centro")}${c.motivo ? " · " + escapeHtml(c.motivo) : ""}</div>
        </div>
        <button class="btn btn-danger delete-chiusuracentro-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Elimina</button>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".delete-chiusuracentro-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Riaprire il ${btn.dataset.id}?`)) return;
      btn.disabled = true;
      await db.collection("chiusureCentro").doc(btn.dataset.id).delete();
      await loadChiusureCentro();
    });
  });
}

async function loadChiusureCentro() {
  const snap = await db.collection("chiusureCentro").orderBy(firebase.firestore.FieldPath.documentId()).get();
  renderChiusureCentro(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

async function onCreateChiusuraCentro(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const errorEl = document.getElementById("new-chiusuracentro-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const data = document.getElementById("new-chiusuracentro-data").value;
  const discipline = Array.from(document.querySelectorAll("#chiusuracentro-discipline-checks input:checked")).map(c => c.value);

  try {
    if (!data) throw new Error("Scegli una data.");
    await db.collection("chiusureCentro").doc(data).set({
      motivo: document.getElementById("new-chiusuracentro-motivo").value.trim() || null,
      discipline,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    document.getElementById("new-chiusuracentro-form").reset();
    await loadChiusureCentro();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Impostazioni prenotazioni campi ----------

// Le categorie sono configurabili (vedi "Categorie socio"), quindi i
// campi "giorni di anticipo" non possono più essere fissi in HTML —
// vengono generati per ciascuna voce di categorieComplete() più
// "maestro" (l'unico valore che non è né tesseramento né azienda/esterno).
// prenotazioniCampiAnticipoCache tiene i valori salvati così il form
// resta corretto anche quando si rigenera (es. dopo aver aggiunto una
// categoria in "Categorie socio").
let prenotazioniCampiAnticipoCache = {};

function idPerAnticipo() {
  return [...categorieComplete().map(c => c.id), "maestro"];
}

function renderCampiAnticipoPrenotazione() {
  const container = document.getElementById("pc-anticipo-container");
  if (!container) return;
  container.innerHTML = idPerAnticipo().map(id => `
    <div class="field" style="flex:0 0 160px;">
      <label for="pc-anticipo-${id}">${escapeHtml(CATEGORIA_LABEL[id] || (id === "maestro" ? "Maestro" : id))}</label>
      <input type="number" id="pc-anticipo-${id}" min="0" step="1" value="${prenotazioniCampiAnticipoCache[id] ?? ""}">
    </div>
  `).join("");
}

async function loadPrenotazioniCampiForm() {
  const doc = await db.collection("impostazioni").doc("prenotazioniCampi").get();
  const dati = doc.exists ? doc.data() : {};
  document.getElementById("pc-max-attive").value = dati.maxPrenotazioniAttivePerUtente ?? "";
  document.getElementById("pc-settimane-visibili").value = dati.settimaneVisibili ?? "";
  prenotazioniCampiAnticipoCache = dati.giorniAnticipoPrenotazione || {};
  renderCampiAnticipoPrenotazione();
}

async function onSavePrenotazioniCampi(e) {
  e.preventDefault();
  const btn = document.getElementById("salva-prenotazionicampi-btn");
  const errorEl = document.getElementById("prenotazionicampi-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const numOrNull = (id) => {
    const v = document.getElementById(id).value;
    return v === "" ? null : parseInt(v, 10);
  };

  try {
    const giorniAnticipoPrenotazione = {};
    idPerAnticipo().forEach(id => {
      const v = numOrNull(`pc-anticipo-${id}`);
      if (v != null) giorniAnticipoPrenotazione[id] = v;
    });
    prenotazioniCampiAnticipoCache = giorniAnticipoPrenotazione;
    await db.collection("impostazioni").doc("prenotazioniCampi").set({
      maxPrenotazioniAttivePerUtente: numOrNull("pc-max-attive"),
      settimaneVisibili: numOrNull("pc-settimane-visibili"),
      giorniAnticipoPrenotazione
    }, { merge: true });
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "config:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("admin-content").classList.add("hidden");
    return;
  }

  initLinkCopyBox("link-app", "copia-link-app-btn", "index.html");
  initLinkCopyBox("link-prenota-padel", "copia-link-prenota-padel-btn", "prenota-padel.html");
  initLinkCopyBox("link-tabellone", "copia-link-tabellone-btn", "prenotazioni.html");
  initLinkCopyBox("link-iscrizione-corsi", "copia-link-iscrizione-corsi-btn", "iscrizione-corso.html");
  initLinkCopyBox("link-prenota-campo", "copia-link-prenota-campo-btn", "prenota-campo.html");
  initLinkCopyBox("link-attiva-socio", "copia-link-attiva-socio-btn", "attiva-socio.html");
  initLinkCopyBox("link-chi-in-campo", "copia-link-chi-in-campo-btn", "chi-in-campo.html");

  await seedDisciplineIfEmpty();
  await loadDiscipline();

  populateSelect(document.getElementById("new-campo-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-campo-posizione"), POSIZIONI_CAMPO);
  populateSelect(document.getElementById("new-tipoattivita-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-quotacampo-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-quotacampo-posizione"), POSIZIONI_CAMPO, "— tutti —");
  populateSelect(document.getElementById("new-tariffacampo-posizione"), POSIZIONI_CAMPO, "— tutti —");
  populateSelect(document.getElementById("new-forfaitcampo-posizione"), POSIZIONI_CAMPO, "— tutti —");

  document.getElementById("chiusuracentro-discipline-checks").innerHTML = DISCIPLINE_CHIUDIBILI
    .map(d => `<div class="checkbox-row"><input type="checkbox" id="cc-disc-${d.id}" value="${d.id}"><label for="cc-disc-${d.id}">${d.nome}</label></div>`)
    .join("");
  document.getElementById("tariffacampo-giorni-checks").innerHTML = GIORNI_SETTIMANA
    .map(g => `<div class="checkbox-row"><input type="checkbox" id="tc-giorno-${g.id}" value="${g.id}"><label for="tc-giorno-${g.id}">${g.label}</label></div>`)
    .join("");

  document.getElementById("centro-form").addEventListener("submit", onSaveDatiCentro);
  document.getElementById("impostazioni-form").addEventListener("submit", onSaveImpostazioni);
  document.getElementById("new-disciplina-form").addEventListener("submit", onCreateDisciplina);
  document.getElementById("cancel-edit-disciplina-btn").addEventListener("click", cancelEditDisciplina);
  document.getElementById("new-allievo-form").addEventListener("submit", onCreateAllievo);
  document.getElementById("cancel-edit-allievo-btn").addEventListener("click", cancelEditAllievo);
  document.getElementById("new-tipoutenza-form").addEventListener("submit", onCreateTipoUtenza);
  document.getElementById("cancel-edit-tipoutenza-btn").addEventListener("click", cancelEditTipoUtenza);
  document.getElementById("new-campo-form").addEventListener("submit", onCreateCampo);
  document.getElementById("cancel-edit-campo-btn").addEventListener("click", cancelEditCampo);
  document.getElementById("new-tipogruppopadel-form").addEventListener("submit", onCreateTipoGruppoPadel);
  document.getElementById("new-tipoattivita-form").addEventListener("submit", onCreateTipoAttivita);
  document.getElementById("add-prezzo-row-btn").addEventListener("click", () => addPrezzoRow());
  document.getElementById("cancel-edit-tipoattivita-btn").addEventListener("click", cancelEditTipoAttivita);
  document.getElementById("new-quotacampo-form").addEventListener("submit", onCreateQuotaCampo);
  document.getElementById("new-quotacampo-disciplina").addEventListener("change", syncQuotaCampoPadelFields);
  syncQuotaCampoPadelFields();
  wirePrezzoRowRemoval();
  document.getElementById("new-articolo-form").addEventListener("submit", onCreateArticolo);
  document.getElementById("cancel-edit-articolo-btn").addEventListener("click", cancelEditArticolo);

  document.getElementById("import-soci-form").addEventListener("submit", onImportSoci);
  document.getElementById("new-categoriasocio-form").addEventListener("submit", onCreateCategoriaSocio);
  document.getElementById("cancel-edit-categoriasocio-btn").addEventListener("click", cancelEditCategoriaSocio);
  document.getElementById("new-tariffacampo-form").addEventListener("submit", onCreateTariffaCampo);
  document.getElementById("new-tariffacampo-disciplina").addEventListener("change", syncTariffaCampoPadelFields);
  syncTariffaCampoPadelFields();
  document.getElementById("new-forfaitcampo-form").addEventListener("submit", onCreateForfaitCampo);
  document.getElementById("new-chiusuracentro-form").addEventListener("submit", onCreateChiusuraCentro);
  document.getElementById("prenotazionicampi-form").addEventListener("submit", onSavePrenotazioniCampi);

  await loadImpostazioniForm();
  await loadDatiCentroForm();
  await loadDisciplineList();
  await loadAllievi();
  await loadTipiUtenza();
  await loadCampi();
  await loadTipiGruppoPadel();
  await loadTipiAttivita();
  await loadQuoteCampo();
  await seedCategorieSocioIfEmpty();
  await loadCategorieSocio();
  sincronizzaSelectCategorie();
  await loadTariffeCampi();
  await loadForfaitCampi();
  await loadChiusureCentro();
  await loadPrenotazioniCampiForm();
  await loadArticoli();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
