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
let allieviCache = [];
let rowCounter = 0;

// SLOT_TENNIS, ORARI_INIZIO_AUTO, generaOrari(), addMinuti() sono definiti
// in utils.js — condivisi con Corsi (stessa fonte per gli orari "prenotabili"
// per disciplina, niente liste duplicate che potrebbero disallinearsi).

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ---------- Caricamento cataloghi (tipi attività, campi, gruppo padel) ----------

async function loadCatalogs() {
  const [taSnap, cSnap, tgSnap, alSnap] = await Promise.all([
    db.collection("tipiAttivita").where("attivo", "==", true).get(),
    db.collection("campi").where("attivo", "==", true).get(),
    db.collection("tipiGruppoPadel").where("attivo", "==", true).get(),
    db.collection("allievi").where("attivo", "==", true).get()
  ]);
  tipiAttivitaCache = taSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  campiCache = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  tipiGruppoPadelCache = tgSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  allieviCache = alSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
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
        <div class="field" style="flex:0 0 100px;">
          <label>Campo</label>
          <select class="row-campo"></select>
        </div>
        <div class="field row-gruppo-field hidden">
          <label>Tipo gruppo</label>
          <select class="row-gruppo"></select>
        </div>
        <div class="field row-slot-field hidden">
          <label>Seleziona slot</label>
          <select class="row-slot"></select>
        </div>
      </div>
      <div class="field row-allievo-field hidden">
        <label>Allievo</label>
        <select class="row-allievo">
          <option value="">—</option>
        </select>
        <input type="text" class="row-allievo-nuovo hidden" placeholder="Nome allievo" style="margin-top:8px;">
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
          <input type="time" class="row-orainizio-libera">
          <select class="row-orainizio-auto hidden"></select>
        </div>
        <div class="field">
          <label>Ora fine</label>
          <input type="time" class="row-orafine-libera">
          <input type="text" class="row-orafine-auto hidden" readonly tabindex="-1">
        </div>
      </div>
    </div>
  `;
}

function populateRowDependents(rowEl) {
  const disciplina = rowEl.querySelector(".row-disciplina").value;

  const tipiPerDisciplina = tipiAttivitaCache
    .filter(t => t.disciplina === disciplina)
    .sort((a, b) => {
      const ao = a.ordine != null ? a.ordine : 99;
      const bo = b.ordine != null ? b.ordine : 99;
      return ao - bo || (a.nome || "").localeCompare(b.nome || "");
    });
  populateSelect(
    rowEl.querySelector(".row-tipoattivita"),
    tipiPerDisciplina.map(t => ({ id: t.id, label: t.nome }))
  );

  // Campo obbligatorio per tennis/squash (più campi tra cui scegliere) e per
  // il padel (un solo campo: si preseleziona da solo, niente placeholder "—"
  // da dover cambiare a mano).
  const campiPerDisciplina = campiCache
    .filter(c => c.disciplina === disciplina)
    .sort((a, b) => (a.numero || "").localeCompare(b.numero || "", undefined, { numeric: true }));
  const campoSelect = rowEl.querySelector(".row-campo");
  const campoUnico = disciplina === "padel" && campiPerDisciplina.length === 1;
  populateSelect(
    campoSelect,
    campiPerDisciplina.map(c => ({ id: c.numero, label: "Campo " + c.numero })),
    campoUnico ? undefined : "—"
  );
  const richiedeCampo = ["tennis", "squash", "padel"].includes(disciplina);
  campoSelect.required = richiedeCampo && campiPerDisciplina.length > 0;

  const gruppoField = rowEl.querySelector(".row-gruppo-field");
  const gruppoSelect = rowEl.querySelector(".row-gruppo");
  if (disciplina === "padel" && tipiGruppoPadelCache.length > 0) {
    gruppoField.classList.remove("hidden");
    populateSelect(gruppoSelect, tipiGruppoPadelCache.map(g => ({ id: g.id, label: g.nome })), "—");
  } else {
    gruppoField.classList.add("hidden");
    gruppoSelect.innerHTML = "";
  }

  // Il tennis ha uno slot combinato inizio+fine (SLOT_TENNIS) accanto al
  // Campo, per velocizzare l'immissione rispetto a scegliere ora inizio e
  // ora fine separatamente. Resta comunque disponibile l'orario libero più
  // sotto ("oppure specifica gli orari") per situazioni non previste.
  const slotField = rowEl.querySelector(".row-slot-field");
  const slotSelect = rowEl.querySelector(".row-slot");
  if (disciplina === "tennis") {
    slotField.classList.remove("hidden");
    slotSelect.innerHTML = `<option value="">—</option>` +
      SLOT_TENNIS.map(([i, f]) => `<option value="${i}|${f}">${i}–${f}</option>`).join("");
  } else {
    slotField.classList.add("hidden");
    slotSelect.innerHTML = "";
  }

  // Padel e squash: se il tipo attività scelto ha una durata fissa
  // configurata, basta l'ora di inizio (griglia dedicata) e la fine si
  // calcola da sola — vedi syncOrarioAuto().
  syncOrarioAuto(rowEl);

  // Per il padel serve l'orario esatto (fascia oraria per la quota campo),
  // quindi si nasconde "Nr. ore" e si richiede l'orario invece di lasciarlo
  // come alternativa opzionale (gestito dentro syncOrarioAuto). Per il
  // tennis "Nr. ore" si nasconde perché ridondante: lo slot implica già
  // la durata.
  const nrOreField = rowEl.querySelector(".row-nrore-field");
  const orariHint = rowEl.querySelector(".row-orari-hint");

  if (disciplina === "padel" || disciplina === "tennis") {
    nrOreField.classList.add("hidden");
    rowEl.querySelector(".row-nrore").value = "";
  } else {
    nrOreField.classList.remove("hidden");
  }
  // Il padel non ha un vero "oppure" da segnalare (l'orario è comunque
  // obbligatorio, auto o libero che sia); il tennis sì (slot vs manuale).
  orariHint.classList.toggle("hidden", disciplina === "padel");
}

function tipoAttivitaSelezionato(rowEl) {
  return tipiAttivitaCache.find(t => t.id === rowEl.querySelector(".row-tipoattivita").value);
}

// Mostra il select "Ora inizio" a griglia (con fine calcolata in automatico)
// quando disciplina+tipo attività hanno una durata fissa configurata;
// altrimenti mostra l'orario libero. Il padel lo richiede sempre (in un modo
// o nell'altro); lo squash resta facoltativo (Nr. ore è un'alternativa valida).
function syncOrarioAuto(rowEl) {
  const disciplina = rowEl.querySelector(".row-disciplina").value;
  const tipo = tipoAttivitaSelezionato(rowEl);
  const listaInizio = ORARI_INIZIO_AUTO[disciplina];
  const usaAuto = !!(listaInizio && tipo && tipo.durataMinuti);

  const inizioAuto = rowEl.querySelector(".row-orainizio-auto");
  const fineAuto = rowEl.querySelector(".row-orafine-auto");
  const inizioLibera = rowEl.querySelector(".row-orainizio-libera");
  const fineLibera = rowEl.querySelector(".row-orafine-libera");

  inizioAuto.required = false;
  inizioLibera.required = false;
  fineLibera.required = false;

  if (usaAuto) {
    inizioAuto.innerHTML = `<option value="">—</option>` + listaInizio.map(t => `<option value="${t}">${t}</option>`).join("");
    inizioAuto.classList.remove("hidden");
    fineAuto.classList.remove("hidden");
    fineAuto.value = "";
    inizioLibera.classList.add("hidden");
    fineLibera.classList.add("hidden");
    inizioLibera.value = "";
    fineLibera.value = "";
    if (disciplina === "padel") inizioAuto.required = true;
  } else {
    inizioAuto.classList.add("hidden");
    fineAuto.classList.add("hidden");
    inizioAuto.value = "";
    inizioLibera.classList.remove("hidden");
    fineLibera.classList.remove("hidden");
    if (disciplina === "padel") {
      inizioLibera.required = true;
      fineLibera.required = true;
    }
  }
}

// Aggiorna dal vivo l'ora fine calcolata quando cambia l'ora di inizio
// scelta nel select automatico (padel/squash).
function aggiornaOraFineAuto(rowEl) {
  const inizioAuto = rowEl.querySelector(".row-orainizio-auto");
  const fineAuto = rowEl.querySelector(".row-orafine-auto");
  const tipo = tipoAttivitaSelezionato(rowEl);
  fineAuto.value = (inizioAuto.value && tipo && tipo.durataMinuti) ? addMinuti(inizioAuto.value, tipo.durataMinuti) : "";
}

// Per il tennis lo slot combinato ha priorità se scelto; per padel/squash
// l'ora inizio automatica (con fine calcolata) se visibile; altrimenti
// l'orario libero.
function orarioRiga(rowEl) {
  const slotField = rowEl.querySelector(".row-slot-field");
  const slotSelect = rowEl.querySelector(".row-slot");
  if (!slotField.classList.contains("hidden") && slotSelect.value) {
    const [oraInizio, oraFine] = slotSelect.value.split("|");
    return { oraInizio, oraFine };
  }

  const inizioAuto = rowEl.querySelector(".row-orainizio-auto");
  if (!inizioAuto.classList.contains("hidden") && inizioAuto.value) {
    const tipo = tipoAttivitaSelezionato(rowEl);
    const oraInizio = inizioAuto.value;
    const oraFine = tipo && tipo.durataMinuti ? addMinuti(oraInizio, tipo.durataMinuti) : "";
    return { oraInizio, oraFine };
  }
  return {
    oraInizio: rowEl.querySelector(".row-orainizio-libera").value,
    oraFine: rowEl.querySelector(".row-orafine-libera").value
  };
}

// Due voci si sovrappongono se stesso campo/disciplina ed entrambe hanno
// un orario che si incrocia. Voci senza campo o senza orario (es. inserite
// solo con "Nr. ore") non sono confrontabili e vengono ignorate.
function vociSiSovrappongono(a, b) {
  return a.disciplina === b.disciplina
    && a.campoNumero && b.campoNumero && a.campoNumero === b.campoNumero
    && a.oraInizio && a.oraFine && b.oraInizio && b.oraFine
    && a.oraInizio < b.oraFine && b.oraInizio < a.oraFine;
}

// Alcuni tipi attività (es. Sparring) richiedono il nome dell'allievo
// per la fatturazione. Il campo compare solo quando il tipo attività
// selezionato ha il flag richiedeAllievo, e permette di scegliere un
// allievo esistente o aggiungerne uno nuovo al volo.
function syncAllievoField(rowEl) {
  const tipoAttivitaSel = rowEl.querySelector(".row-tipoattivita");
  const tipo = tipiAttivitaCache.find(t => t.id === tipoAttivitaSel.value);
  const field = rowEl.querySelector(".row-allievo-field");
  const select = rowEl.querySelector(".row-allievo");
  const nuovoInput = rowEl.querySelector(".row-allievo-nuovo");

  if (tipo && tipo.richiedeAllievo) {
    field.classList.remove("hidden");
    select.required = true;
    select.innerHTML = `<option value="">—</option>` +
      allieviCache.map(a => `<option value="${a.id}">${escapeHtml(a.nome)}</option>`).join("") +
      `<option value="__new__">+ Nuovo allievo…</option>`;
  } else {
    field.classList.add("hidden");
    select.required = false;
    select.value = "";
    nuovoInput.classList.add("hidden");
    nuovoInput.required = false;
    nuovoInput.value = "";
  }
}

function addRow() {
  rowCounter++;
  const container = document.getElementById("rows-container");
  container.insertAdjacentHTML("beforeend", rowHtml(rowCounter));

  const rowEl = container.querySelector(`[data-row-id="${rowCounter}"]`);
  populateSelect(rowEl.querySelector(".row-disciplina"), DISCIPLINE);
  populateRowDependents(rowEl);
  syncAllievoField(rowEl);

  rowEl.querySelector(".row-disciplina").addEventListener("change", () => {
    populateRowDependents(rowEl);
    syncAllievoField(rowEl);
  });
  rowEl.querySelector(".row-tipoattivita").addEventListener("change", () => {
    syncAllievoField(rowEl);
    syncOrarioAuto(rowEl);
  });
  rowEl.querySelector(".row-orainizio-auto").addEventListener("change", () => aggiornaOraFineAuto(rowEl));
  rowEl.querySelector(".row-allievo").addEventListener("change", (e) => {
    const nuovoInput = rowEl.querySelector(".row-allievo-nuovo");
    if (e.target.value === "__new__") {
      nuovoInput.classList.remove("hidden");
      nuovoInput.required = true;
      nuovoInput.focus();
    } else {
      nuovoInput.classList.add("hidden");
      nuovoInput.required = false;
      nuovoInput.value = "";
    }
  });

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
    const entries = [];
    for (const rowEl of rows) {
      const disciplina = rowEl.querySelector(".row-disciplina").value;
      const tipoAttivitaSel = rowEl.querySelector(".row-tipoattivita");
      const campoSel = rowEl.querySelector(".row-campo");
      const gruppoSel = rowEl.querySelector(".row-gruppo");
      const { oraInizio, oraFine } = orarioRiga(rowEl);
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

      const tipo = tipiAttivitaCache.find(t => t.id === tipoAttivitaSel.value);
      if (tipo && tipo.richiedeAllievo) {
        const allievoSel = rowEl.querySelector(".row-allievo");
        if (allievoSel.value === "__new__") {
          const nomeNuovo = rowEl.querySelector(".row-allievo-nuovo").value.trim();
          if (!nomeNuovo) throw new Error("Inserisci il nome del nuovo allievo.");
          const ref = await db.collection("allievi").add({ nome: nomeNuovo, attivo: true });
          allieviCache.push({ id: ref.id, nome: nomeNuovo, attivo: true });
          entry.allievoId = ref.id;
          entry.allievoNome = nomeNuovo;
        } else if (allievoSel.value) {
          entry.allievoId = allievoSel.value;
          entry.allievoNome = selectedLabel(allievoSel);
        } else {
          throw new Error("Seleziona o inserisci il nome dell'allievo.");
        }
      }

      entries.push(entry);
    }

    // Verifica sovrapposizioni di campo/orario tra le righe appena inserite...
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (vociSiSovrappongono(entries[i], entries[j])) {
          throw new Error(`Due righe si sovrappongono su Campo ${entries[i].campoNumero} (${entries[i].oraInizio}–${entries[i].oraFine} e ${entries[j].oraInizio}–${entries[j].oraFine}).`);
        }
      }
    }

    // ...e con le voci che hai già salvato oggi (stesso utente, stesso giorno).
    const esistentiSnap = await db.collection("diario")
      .where("userId", "==", currentProfile.uid)
      .where("data", "==", dataVal)
      .get();
    const esistenti = esistentiSnap.docs.map(d => d.data());
    for (const nuova of entries) {
      const conflitto = esistenti.find(e => vociSiSovrappongono(nuova, e));
      if (conflitto) {
        throw new Error(`Hai già una voce su Campo ${nuova.campoNumero} dalle ${conflitto.oraInizio} alle ${conflitto.oraFine} che si sovrappone a ${nuova.oraInizio}–${nuova.oraFine}.`);
      }
    }

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
    btn.textContent = "Salva";
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
    if (en.allievoNome) metaParts.push("Allievo: " + en.allievoNome);
    if (en.oraInizio || en.oraFine) metaParts.push(`${en.oraInizio || "—"}–${en.oraFine || "—"}`);
    if (en.note) metaParts.push(en.note);

    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge ${en.disciplina}">${disciplinaLabel(en.disciplina)}</span>
          <div class="entry-tipo">${escapeHtml(tipoAttivitaLabelFor(en))}</div>
          <div class="entry-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div class="entry-ore">${(en.ore || 0).toFixed(1)}h</div>
          ${puoEliminareVoceDiario(en, currentProfile) ? `<button type="button" class="btn btn-danger delete-entry-btn" style="width:auto;padding:6px 10px;font-size:0.65rem;" data-id="${en.id}">Elimina</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  totalEl.textContent = total.toFixed(1);

  list.querySelectorAll(".delete-entry-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
      } catch (err) {
        showError(document.getElementById("entry-form-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
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

  await loadDiscipline();
  await loadImpostazioni();
  await loadCatalogs();
  initForm();
  listenToday();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
