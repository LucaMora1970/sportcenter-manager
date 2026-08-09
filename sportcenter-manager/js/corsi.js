// ============================================================
// corsi.js — fase 1: creazione e gestione interna dei corsi (dietro
// login). Un corso è una "proposta": chi lo crea sceglie un sottoinsieme
// di giorni/orari/campi tra quelli realmente disponibili per la
// disciplina (stessi orari usati in Diario, stessi campi configurati).
// Il calendario reale delle sessioni si genera più avanti, quando dagli
// iscritti risulta quale combinazione attivare — non qui.
// Niente modulo pubblico di iscrizione ancora: quello e il flusso di
// conferma/pagamento arrivano in una fase successiva.
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsiCache = [];
let campiCache = [];
let editingCorsoId = null;

const GIORNI_SETTIMANA = [
  { id: "lun", label: "Lun" },
  { id: "mar", label: "Mar" },
  { id: "mer", label: "Mer" },
  { id: "gio", label: "Gio" },
  { id: "ven", label: "Ven" },
  { id: "sab", label: "Sab" },
  { id: "dom", label: "Dom" }
];

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

  list.innerHTML = corsiCache.map(c => {
    const giorniOrariLabel = Object.entries(c.giorniOrari || {})
      .map(([g, orari]) => `${(GIORNI_SETTIMANA.find(x => x.id === g) || {}).label || g} ${orari.join("/")}`)
      .join(" · ") || "—";
    const campiLabel = (c.campiNumeri || []).map(n => "Campo " + n).join(", ") || "—";
    return `
    <div class="entry-card" data-id="${c.id}">
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
        ${puoGestire ? `<button class="btn btn-danger delete-corso-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;" data-id="${c.id}">Elimina</button>` : ""}
      </div>
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

  await loadCorsi();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
