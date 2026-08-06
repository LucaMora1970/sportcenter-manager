// ============================================================
// utils.js — costanti e helper condivisi tra le pagine
// ============================================================

const DISCIPLINE = [
  { id: "tennis", label: "Tennis" },
  { id: "padel", label: "Padel" },
  { id: "squash", label: "Squash" }
];

function disciplinaLabel(id) {
  return (DISCIPLINE.find(d => d.id === id) || {}).label || id;
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
