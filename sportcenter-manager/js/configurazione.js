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

const DEFAULT_DISCIPLINE_SEED = [
  { id: "tennis", nome: "Tennis" },
  { id: "padel", nome: "Padel" },
  { id: "squash", nome: "Squash" },
  { id: "preparatore-atletico", nome: "Preparatore atletico" },
  { id: "sparring", nome: "Sparring" },
  { id: "mental-coach", nome: "Mental Coach" },
  { id: "official", nome: "Official" }
];

const POSIZIONI_CAMPO = [
  { id: "interno", label: "Interno" },
  { id: "esterno", label: "Esterno" }
];

function posizioneLabel(id) {
  return (POSIZIONI_CAMPO.find(p => p.id === id) || {}).label || id;
}

// ---------- Helper lista generica con toggle attivo ----------

function renderSimpleList(containerId, items, labelFn, metaFn, collectionName, reloadFn, onEdit) {
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
    batch.set(db.collection("discipline").doc(d.id), { nome: d.nome, attivo: true });
  });
  await batch.commit();
}

async function loadDisciplineList() {
  const list = document.getElementById("discipline-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("discipline").orderBy("nome").get();
  const discipline = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderSimpleList("discipline-list", discipline, it => it.nome, it => it.id, "discipline", loadDisciplineList, startEditDisciplina);
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

  try {
    if (!nome) throw new Error("Inserisci un nome.");
    if (editingDisciplinaId) {
      await db.collection("discipline").doc(editingDisciplinaId).update({ nome });
    } else {
      if (!id) throw new Error("Inserisci un ID disciplina (es. mental-coach).");
      await db.collection("discipline").doc(id).set({ nome, attivo: true });
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

async function loadTipiAttivita() {
  const list = document.getElementById("tipiattivita-list");
  list.innerHTML = `<div class="empty-state"><div class="display">Caricamento…</div></div>`;

  const snap = await db.collection("tipiAttivita").orderBy("nome").get();
  tipiAttivitaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));

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
        <div class="entry-meta">${escapeHtml(disciplinaLabel(it.disciplina))} · ${(it.prezzi || []).length} tariffe${it.soggettoQuotaCampo ? " · quota campo" : ""}${it.retribuitoCollaboratore ? " · compenso" : ""}</div>
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
  document.getElementById("new-tipoattivita-quotacampo").checked = !!tipo.soggettoQuotaCampo;
  document.getElementById("new-tipoattivita-retribuito").checked = !!tipo.retribuitoCollaboratore;

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
  const soggettoQuotaCampo = document.getElementById("new-tipoattivita-quotacampo").checked;
  const retribuitoCollaboratore = document.getElementById("new-tipoattivita-retribuito").checked;

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
      await db.collection("tipiAttivita").doc(editingTipoAttivitaId).update({ nome, disciplina, soggettoQuotaCampo, retribuitoCollaboratore, prezzi });
    } else {
      await db.collection("tipiAttivita").add({ nome, disciplina, soggettoQuotaCampo, retribuitoCollaboratore, attivo: true, prezzi });
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

function quotaCampoMeta(it) {
  const parts = [];
  if (it.periodoInizio || it.periodoFine) {
    parts.push(`${it.periodoInizio || "…"} → ${it.periodoFine || "…"}`);
  }
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

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "config:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("admin-content").classList.add("hidden");
    return;
  }

  await seedDisciplineIfEmpty();
  await loadDiscipline();

  populateSelect(document.getElementById("new-campo-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-campo-posizione"), POSIZIONI_CAMPO);
  populateSelect(document.getElementById("new-tipoattivita-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-quotacampo-disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("new-quotacampo-posizione"), POSIZIONI_CAMPO, "— tutti —");

  document.getElementById("new-disciplina-form").addEventListener("submit", onCreateDisciplina);
  document.getElementById("cancel-edit-disciplina-btn").addEventListener("click", cancelEditDisciplina);
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

  await loadDisciplineList();
  await loadTipiUtenza();
  await loadCampi();
  await loadTipiGruppoPadel();
  await loadTipiAttivita();
  await loadQuoteCampo();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
