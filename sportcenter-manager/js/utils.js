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
    .map(d => ({ id: d.id, label: d.data().nome, attivo: d.data().attivo, ordine: d.data().ordine }))
    .filter(d => d.attivo !== false)
    .sort((a, b) => {
      const ao = a.ordine != null ? a.ordine : 99;
      const bo = b.ordine != null ? b.ordine : 99;
      return ao - bo || a.label.localeCompare(b.label);
    });
}

function disciplinaLabel(id) {
  return (DISCIPLINE.find(d => d.id === id) || {}).label || id;
}

// Popolata da loadImpostazioni() (doc Firestore "impostazioni/generale",
// configurabile da Configurazione). Ogni pagina che deve controllare
// puoEliminareVoceDiario() deve chiamare `await loadImpostazioni()` a inizio pagina.
let IMPOSTAZIONI = { minutiEliminazioneDiario: 15 };

async function loadImpostazioni() {
  // Se le firestore.rules per "impostazioni" non sono ancora state pubblicate
  // (o la lettura fallisce per qualsiasi altro motivo), resta il default
  // hardcoded sopra invece di bloccare l'inizializzazione dell'intera pagina.
  try {
    const doc = await db.collection("impostazioni").doc("generale").get();
    if (doc.exists) IMPOSTAZIONI = { minutiEliminazioneDiario: 15, ...doc.data() };
  } catch (err) {
    console.warn("loadImpostazioni: uso il default, lettura fallita:", err.message);
  }
}

// Un dipendente può eliminare una propria voce diario solo entro i primi
// IMPOSTAZIONI.minutiEliminazioneDiario minuti dall'inserimento; oltre,
// serve il permesso diario:gestisci_tutti (admin/supervisore). Stessa
// regola applicata anche lato firestore.rules (che resta l'unica fonte
// di verità: questo helper serve solo a mostrare/nascondere il pulsante).
function puoEliminareVoceDiario(entry, profile) {
  if (hasPermission(profile, "diario:gestisci_tutti")) return true;
  if (entry.userId !== profile.uid) return false;
  if (!entry.createdAt || typeof entry.createdAt.toMillis !== "function") return false;
  const limiteMs = (IMPOSTAZIONI.minutiEliminazioneDiario || 15) * 60000;
  return (Date.now() - entry.createdAt.toMillis()) <= limiteMs;
}

// Orari di inizio "prenotabili" per disciplina — stessa fonte usata sia dal
// Diario (per lo slot/orario di una singola voce) sia da Corsi (per
// proporre agli iscritti solo combinazioni realmente compatibili con i
// campi). Tennis ha un salto pranzo 12:15→13:30 quindi resta gestito con
// coppie inizio-fine esplicite; padel/squash con una griglia inizio+durata.
const SLOT_TENNIS = [
  ["08:15", "09:15"], ["09:15", "10:15"], ["10:15", "11:15"], ["11:15", "12:15"],
  ["13:30", "14:30"], ["14:30", "15:30"], ["15:30", "16:30"], ["16:30", "17:30"],
  ["17:30", "18:30"], ["18:30", "19:30"], ["19:30", "20:30"], ["20:30", "21:30"], ["21:30", "22:30"]
];

function minutiToOrario(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function generaOrari(inizioMin, fineMin, stepMin) {
  const out = [];
  for (let m = inizioMin; m <= fineMin; m += stepMin) out.push(minutiToOrario(m));
  return out;
}

function addMinuti(orario, minuti) {
  const [h, m] = orario.split(":").map(Number);
  return minutiToOrario(h * 60 + m + minuti);
}

// Orari di inizio ammessi per padel e squash quando il tipo attività (o il
// corso) ha una durata fissa: basta scegliere l'inizio, la fine si calcola
// da sola (addMinuti).
const ORARI_INIZIO_AUTO = {
  padel: generaOrari(8 * 60, 21 * 60 + 30, 15),      // 08:00–21:30 ogni 15'
  squash: generaOrari(8 * 60 + 15, 21 * 60 + 45, 45)  // 08:15–21:45 ogni 45'
};

// Elenco piatto degli orari di inizio "prenotabili" per una disciplina,
// indipendentemente da come sono modellati sotto (coppie per il tennis,
// griglia per padel/squash). Usato per proporre scelte in Corsi.
function orariInizioPerDisciplina(disciplina) {
  if (disciplina === "tennis") return SLOT_TENNIS.map(([i]) => i);
  return ORARI_INIZIO_AUTO[disciplina] || [];
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
