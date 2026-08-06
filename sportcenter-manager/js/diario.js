// ============================================================
// diario.js — inserimento e riepilogo voci del diario giornaliero
// ============================================================

const DISCIPLINE = [
  { id: "tennis", label: "Tennis" },
  { id: "padel", label: "Padel" },
  { id: "squash", label: "Squash" }
];

const TIPI_ATTIVITA = [
  { id: "lezione_privata", label: "Lezione privata" },
  { id: "corso", label: "Corso" },
  { id: "camp", label: "Camp" },
  { id: "manutenzione", label: "Manutenzione" },
  { id: "amministrazione", label: "Amministrazione" },
  { id: "altro", label: "Altro" }
];

let currentProfile = null;
let viewingUserId = null; // uid di cui si sta visualizzando il diario
let todayEntriesUnsub = null;

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function calcOre(oraInizio, oraFine) {
  if (!oraInizio || !oraFine) return 0;
  const [h1, m1] = oraInizio.split(":").map(Number);
  const [h2, m2] = oraFine.split(":").map(Number);
  let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diff < 0) diff += 24 * 60; // turno a cavallo di mezzanotte, caso raro
  return Math.round((diff / 60) * 100) / 100;
}

function populateSelect(selectEl, options) {
  selectEl.innerHTML = options.map(o => `<option value="${o.id}">${o.label}</option>`).join("");
}

function initForm() {
  populateSelect(document.getElementById("disciplina"), DISCIPLINE);
  populateSelect(document.getElementById("tipoAttivita"), TIPI_ATTIVITA);
  document.getElementById("data").value = todayISO();

  document.getElementById("entry-form").addEventListener("submit", onSubmitEntry);
}

async function onSubmitEntry(e) {
  e.preventDefault();
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "Salvataggio…";

  const oraInizio = document.getElementById("oraInizio").value;
  const oraFine = document.getElementById("oraFine").value;

  const entry = {
    userId: currentProfile.uid,
    userNome: currentProfile.nome,
    data: document.getElementById("data").value,
    disciplina: document.getElementById("disciplina").value,
    tipoAttivita: document.getElementById("tipoAttivita").value,
    oraInizio,
    oraFine,
    ore: calcOre(oraInizio, oraFine),
    note: document.getElementById("note").value.trim(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    await db.collection("diario").add(entry);
    document.getElementById("entry-form").reset();
    document.getElementById("data").value = todayISO();
    document.getElementById("oraInizio").value = "";
    document.getElementById("oraFine").value = "";
    document.getElementById("note").value = "";
  } catch (err) {
    alert("Errore nel salvataggio: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Salva voce";
  }
}

function disciplinaLabel(id) {
  return (DISCIPLINE.find(d => d.id === id) || {}).label || id;
}
function tipoLabel(id) {
  return (TIPI_ATTIVITA.find(t => t.id === id) || {}).label || id;
}

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
    return `
      <div class="entry-card">
        <div class="entry-main">
          <span class="badge ${en.disciplina}">${disciplinaLabel(en.disciplina)}</span>
          <div class="entry-tipo">${tipoLabel(en.tipoAttivita)}</div>
          <div class="entry-meta">${en.oraInizio || "—"}–${en.oraFine || "—"}${en.note ? " · " + en.note : ""}</div>
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

requireAuth((profile) => {
  currentProfile = profile;
  viewingUserId = profile.uid;

  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  // Chi ha il permesso di leggere tutti i diari vede un selettore extra (da popolare in futuro)
  if (hasPermission(profile, "diario:leggi_tutti")) {
    document.getElementById("admin-hint").classList.remove("hidden");
  }

  initForm();
  listenToday();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
