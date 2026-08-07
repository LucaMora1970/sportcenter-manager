// ============================================================
// utils.js — costanti e helper condivisi tra le pagine
// ============================================================

// Popolata da loadDiscipline() a ogni caricamento pagina (collection
// Firestore "discipline", configurabile da Configurazione). Ogni pagina
// che la usa deve chiamare `await loadDiscipline()` prima di usarla.
let DISCIPLINE = [];

async function loadDiscipline() {
  const snap = await db.collection("discipline").get();
  DISCIPLINE = snap.docs
    .map(d => ({ id: d.id, label: d.data().nome, attivo: d.data().attivo }))
    .filter(d => d.attivo !== false)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function disciplinaLabel(id) {
  return (DISCIPLINE.find(d => d.id === id) || {}).label || id;
}

function calcOre(oraInizio, oraFine) {
  if (!oraInizio || !oraFine) return 0;
  const [h1, m1] = oraInizio.split(":").map(Number);
  const [h2, m2] = oraFine.split(":").map(Number);
  let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diff < 0) diff += 24 * 60; // turno a cavallo di mezzanotte, caso raro
  return Math.round((diff / 60) * 100) / 100;
}

// Etichette per voci diario create prima dell'introduzione dei tipi
// attività configurabili (vedi pannello Configurazione).
const LEGACY_TIPI_ATTIVITA_LABELS = {
  lezione_privata: "Lezione privata",
  corso: "Corso",
  camp: "Camp",
  manutenzione: "Manutenzione",
  amministrazione: "Amministrazione",
  altro: "Altro"
};

function tipoAttivitaLabelFor(entry) {
  if (entry.tipoAttivitaNome) return entry.tipoAttivitaNome;
  return LEGACY_TIPI_ATTIVITA_LABELS[entry.tipoAttivita] || entry.tipoAttivita || "—";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function populateSelect(selectEl, options, placeholder) {
  const placeholderOpt = placeholder !== undefined ? `<option value="">${placeholder}</option>` : "";
  selectEl.innerHTML = placeholderOpt + options.map(o => `<option value="${o.id}">${o.label}</option>`).join("");
}

// Trasforma un messaggio d'errore in HTML sicuro con eventuali URL
// resi cliccabili (es. il link di Firestore per creare un indice) —
// da usare al posto di alert(), che mostra testo non selezionabile
// e non cliccabile.
function renderErrorMessage(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    const url = escapeHtml(match[0]);
    result += `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function showError(el, message) {
  el.innerHTML = renderErrorMessage(message);
}
