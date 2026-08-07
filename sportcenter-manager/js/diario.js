// ============================================================
// diario.js — inserimento e riepilogo voci del diario giornaliero
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let viewingUserId = null; // uid di cui si sta visualizzando il diario
let todayEntriesUnsub = null;

let tipiAttivitaCache = [];
let campiCache = [];
let tipiGruppoPadelCache = [];
let rowCounter = 0;

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ---------- Caricamento cataloghi (tipi attività, campi, gruppo padel) ----------

async function loadCatalogs() {
  const [taSnap, cSnap, tgSnap] = await Promise.all([
    db.collection("tipiAttivita").where("attivo", "==", true).get(),
    db.collection("campi").where("attivo", "==", true).get(),
    db.collection("tipiGruppoPadel").where("attivo", "==", true).get()
  ]);
  tipiAttivitaCache = taSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  campiCache = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  tipiGruppoPadelCache = tgSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------- Righe ripetibili del form ----------

function rowHtml(rowId) {
  return `
    <div class="row-card entry-row" data-row-id="${rowId}">
      <button type="button" class="row-remove" data-remove-row="${rowId}">Rimuovi</button>
      <div class="row2">
        <div class="field">
          <label>Disciplina</label>
          <select class="row-disciplina" required></select>
        </div>
        <div class="field">
          <label>Tipo attività</label>
          <select class="row-tipoattivita" required></select>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>Campo</label>
          <select class="row-campo"></select>
        </div>
        <div class="field row-gruppo-field hidden">
          <label>Tipo gruppo</label>
          <select class="row-gruppo"></select>
        </div>
      </div>
      <div class="row2">
        <div class="field row-nrore-field" style="flex:0 0 110px;">
          <label>Nr. ore</label>
          <input type="number" class="row-nrore" min="0" step="0.25" placeholder="es. 1.5">
        </div>
        <div class="field">
          <label>Note (opzionale)</label>
          <input type="text" class="row-note" placeholder="es. nome allievo">
        </div>
      </div>
      <div class="row-label row-orari-hint">oppure specifica gli orari</div>
      <div class="row2">
        <div class="field">
          <label>Ora inizio</label>
          <input type="time" class="row-orainizio">
        </div>
        <div class="field">
          <label>Ora fine</label>
          <input type="time" class="row-orafine">
        </div>
      </div>
    </div>
  `;
}

function populateRowDependents(rowEl) {
  const disciplina = rowEl.querySelector(".row-disciplina").value;

  const tipiPerDisciplina = tipiAttivitaCache.filter(t => t.disciplina === disciplina);
  populateSelect(
    rowEl.querySelector(".row-tipoattivita"),
    tipiPerDisciplina.map(t => ({ id: t.id, label: t.nome }))
  );

  const campiPerDisciplina = campiCache.filter(c => c.disciplina === disciplina);
  populateSelect(
    rowEl.querySelector(".row-campo"),
    campiPerDisciplina.map(c => ({ id: c.numero, label: "Campo " + c.numero })),
    "—"
  );

  const gruppoField = rowEl.querySelector(".row-gruppo-field");
  const gruppoSelect = rowEl.querySelector(".row-gruppo");
  if (disciplina === "padel" && tipiGruppoPadelCache.length > 0) {
    gruppoField.classList.remove("hidden");
    populateSelect(gruppoSelect, tipiGruppoPadelCache.map(g => ({ id: g.id, label: g.nome })), "—");
  } else {
    gruppoField.classList.add("hidden");
    gruppoSelect.innerHTML = "";
  }

  // Per il padel serve l'orario esatto (durata 60/90 min e fascia oraria
  // per la quota campo), quindi si nasconde "Nr. ore" e si richiedono
  // ora inizio/fine invece di lasciarli come alternativa opzionale.
  const nrOreField = rowEl.querySelector(".row-nrore-field");
  const orariHint = rowEl.querySelector(".row-orari-hint");
  const oraInizioInput = rowEl.querySelector(".row-orainizio");
  const oraFineInput = rowEl.querySelector(".row-orafine");

  if (disciplina === "padel") {
    nrOreField.classList.add("hidden");
    rowEl.querySelector(".row-nrore").value = "";
    orariHint.classList.add("hidden");
    oraInizioInput.required = true;
    oraFineInput.required = true;
  } else {
    nrOreField.classList.remove("hidden");
    orariHint.classList.remove("hidden");
    oraInizioInput.required = false;
    oraFineInput.required = false;
  }
}

function addRow() {
  rowCounter++;
  const container = document.getElementById("rows-container");
  container.insertAdjacentHTML("beforeend", rowHtml(rowCounter));

  const rowEl = container.querySelector(`[data-row-id="${rowCounter}"]`);
  populateSelect(rowEl.querySelector(".row-disciplina"), DISCIPLINE);
  populateRowDependents(rowEl);

  rowEl.querySelector(".row-disciplina").addEventListener("change", () => populateRowDependents(rowEl));
  updateRemoveButtons();
}

function updateRemoveButtons() {
  const rows = document.querySelectorAll(".entry-row");
  rows.forEach(r => {
    r.querySelector(".row-remove").classList.toggle("hidden", rows.length <= 1);
  });
}

function wireRowRemoval() {
  document.getElementById("rows-container").addEventListener("click", (e) => {
    if (e.target.matches("[data-remove-row]")) {
      e.target.closest(".entry-row").remove();
      updateRemoveButtons();
    }
  });
}

// ---------- Init form ----------

function initForm() {
  document.getElementById("data").value = todayISO();

  if (tipiAttivitaCache.length === 0) {
    document.getElementById("catalog-warning").classList.remove("hidden");
    document.getElementById("entry-form").classList.add("hidden");
    return;
  }

  addRow();
  document.getElementById("add-row-btn").addEventListener("click", addRow);
  wireRowRemoval();
  document.getElementById("entry-form").addEventListener("submit", onSubmitEntry);
}

function selectedLabel(selectEl) {
  const opt = selectEl.options[selectEl.selectedIndex];
  return opt ? opt.textContent : "";
}

async function onSubmitEntry(e) {
  e.preventDefault();
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Salvataggio…";

  const errorEl = document.getElementById("entry-form-error");
  errorEl.innerHTML = "";

  const dataVal = document.getElementById("data").value;
  const rows = Array.from(document.querySelectorAll(".entry-row"));

  try {
    const entries = rows.map(rowEl => {
      const disciplina = rowEl.querySelector(".row-disciplina").value;
      const tipoAttivitaSel = rowEl.querySelector(".row-tipoattivita");
      const campoSel = rowEl.querySelector(".row-campo");
      const gruppoSel = rowEl.querySelector(".row-gruppo");
      const oraInizio = rowEl.querySelector(".row-orainizio").value;
      const oraFine = rowEl.querySelector(".row-orafine").value;
      const nrOreRaw = rowEl.querySelector(".row-nrore").value;
      const note = rowEl.querySelector(".row-note").value.trim();

      let ore;
      if (nrOreRaw) {
        ore = parseFloat(nrOreRaw);
      } else if (oraInizio && oraFine) {
        ore = calcOre(oraInizio, oraFine);
      } else {
        throw new Error("Per ogni riga inserisci il numero di ore oppure ora inizio e ora fine.");
      }

      const entry = {
        userId: currentProfile.uid,
        userNome: currentProfile.nome,
        data: dataVal,
        disciplina,
        tipoAttivitaId: tipoAttivitaSel.value,
        tipoAttivitaNome: selectedLabel(tipoAttivitaSel),
        ore,
        note,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      if (oraInizio) entry.oraInizio = oraInizio;
      if (oraFine) entry.oraFine = oraFine;
      if (campoSel.value) entry.campoNumero = campoSel.value;
      if (disciplina === "padel" && gruppoSel && gruppoSel.value) {
        entry.tipoGruppoId = gruppoSel.value;
        entry.tipoGruppoNome = selectedLabel(gruppoSel);
      }

      return entry;
    });

    const batch = db.batch();
    entries.forEach(entry => {
      batch.set(db.collection("diario").doc(), entry);
    });
    await batch.commit();

    document.getElementById("rows-container").innerHTML = "";
    rowCounter = 0;
    addRow();
    document.getElementById("data").value = dataVal;
  } catch (err) {
    showError(errorEl, "Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Salva voce";
  }
}

// ---------- Elenco voci di oggi ----------

function renderEntries(entries) {
  const list = document.getElementById("entries-list");
  const totalEl = document.getElementById("today-total");

  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="display">Nessuna voce oggi</div>
      <p>Inserisci la prima attività dal form qui sopra.</p>
    </div>`;
    totalEl.textContent = "0.0";
    return;
  }

  let total = 0;
  list.innerHTML = entries.map(en => {
    total += en.ore || 0;

    const metaParts = [];
    if (en.campoNumero) metaParts.push("Campo " + en.campoNumero);
    if (en.tipoUtenzaNome) metaParts.push(en.tipoUtenzaNome);
    if (en.tipoGruppoNome) metaParts.push(en.tipoGruppoNome);
    if (en.oraInizio || en.oraFine) metaParts.push(`${en.oraInizio || "—"}–${en.oraFine || "—"}`);
    if (en.note) metaParts.push(en.note);

    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge ${en.disciplina}">${disciplinaLabel(en.disciplina)}</span>
          <div class="entry-tipo">${escapeHtml(tipoAttivitaLabelFor(en))}</div>
          <div class="entry-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        <div class="entry-ore">${(en.ore || 0).toFixed(1)}h</div>
      </div>
    `;
  }).join("");

  totalEl.textContent = total.toFixed(1);
}

function listenToday() {
  if (todayEntriesUnsub) todayEntriesUnsub();

  todayEntriesUnsub = db.collection("diario")
    .where("userId", "==", viewingUserId)
    .where("data", "==", todayISO())
    .orderBy("createdAt", "desc")
    .onSnapshot(
      (snap) => {
        const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderEntries(entries);
      },
      (err) => {
        console.error(err);
        document.getElementById("entries-list").innerHTML =
          `<div class="empty-state"><div class="display">Errore di lettura</div><p>${err.message}</p></div>`;
      }
    );
}

requireAuth(async (profile) => {
  currentProfile = profile;
  viewingUserId = profile.uid;

  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  // Chi ha il permesso di leggere tutti i diari vede un selettore extra (da popolare in futuro)
  if (hasPermission(profile, "diario:leggi_tutti")) {
    document.getElementById("admin-hint").classList.remove("hidden");
  }

  await loadCatalogs();
  initForm();
  listenToday();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
