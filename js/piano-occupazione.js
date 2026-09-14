// ============================================================
// piano-occupazione.js — piano settimanale di occupazione campi per i
// gruppi corso confermati (gruppiCorso non-bozza + iscrizioniCorsi
// confermate senza gruppo, stesso flusso storico "Conferma gruppo").
// Stessa logica di aggregazione del Riepilogo di corsi.js
// (gruppiConfermatiPerData, con le eccezioni di calendario gestite da
// generaCalendarioSessioni in utils.js) ma su una grid campi×giorni per
// tutta la settimana invece che una lista di card per giorno.
//
// Le prenotazioni singole (bookings, tennis/padel/squash a partita)
// restano volutamente fuori: dominio diverso, nessun collegamento reale
// tra le due collection (il campo assegnato a un gruppo è testo libero,
// non blocca nulla in "bookings").
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsiCache = [];
let iscrizioniConfermateCache = [];
let gruppiCorsoCache = [];
let CAMPI = [];

function pad2(n) { return String(n).padStart(2, "0"); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addGiorni(dataIso, n) {
  const d = new Date(dataIso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
function lunediSettimana(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  const offset = (d.getDay() + 6) % 7; // 0 = lunedì, coerente con GIORNI_SETTIMANA
  d.setDate(d.getDate() - offset);
  return toISODate(d);
}

const MESI_BREVI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
function formatDataBreve(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  return `${d.getDate()} ${MESI_BREVI[d.getMonth()]}`;
}
function formatRangeSettimana(lunediIso) {
  const domenicaIso = addGiorni(lunediIso, 6);
  const anno = new Date(domenicaIso + "T00:00:00").getFullYear();
  return `${formatDataBreve(lunediIso)} – ${formatDataBreve(domenicaIso)} ${anno}`;
}

let statoSettimana = { lunedi: lunediSettimana(toISODate(new Date())) };

// ---------- Permessi / filtro discipline ----------
// Stessa logica di disciplineIscrizioniVisibili in corsi.js: chi ha solo
// iscrizioni:gestisci_padel vede solo i gruppi/campi padel — null significa
// "nessun filtro" (permesso pieno).
function disciplineIscrizioniVisibili(profile) {
  if (hasPermission(profile, "iscrizioni:gestisci")) return null;
  if (hasPermission(profile, "iscrizioni:gestisci_padel")) return ["padel"];
  return [];
}

// ---------- Caricamento dati ----------

async function loadCampi() {
  const snap = await db.collection("campi").where("attivo", "==", true).get();
  CAMPI = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.ordine ?? Infinity) - (b.ordine ?? Infinity) || (a.numero || "").localeCompare(b.numero || "", undefined, { numeric: true }));
}

async function loadCorsi() {
  const snap = await db.collection("corsi").get();
  corsiCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Chi ha solo iscrizioni:gestisci_padel non può leggere in blocco tutta la
// collection iscrizioniCorsi con una query "piatta": le rules la rifiutano
// per intero appena il risultato conterrebbe anche un solo documento di
// un'altra disciplina (tennis/squash). Si interroga quindi "corsi" per
// sapere quali sono i corsi Padel (lettura pubblica, nessun problema di
// permesso) e si fa una query per corso (corsoId + stato, entrambi in
// uguaglianza: nessun indice composito da creare) — stesso pattern già
// usato in corsi.js/presenze.js.
async function loadIscrizioniConfermate() {
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  if (!discipline) {
    const snap = await db.collection("iscrizioniCorsi").where("stato", "==", "confermata").get();
    iscrizioniConfermateCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return;
  }
  if (discipline.length === 0) { iscrizioniConfermateCache = []; return; }
  const corsiSnap = await db.collection("corsi").where("disciplina", "in", discipline).get();
  const corsiIds = corsiSnap.docs.map(d => d.id);
  if (corsiIds.length === 0) { iscrizioniConfermateCache = []; return; }
  const risultati = await Promise.all(corsiIds.map(id =>
    db.collection("iscrizioniCorsi").where("corsoId", "==", id).where("stato", "==", "confermata").get()
  ));
  iscrizioniConfermateCache = risultati.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

// Collection piccola: si legge tutta e si filtra lato client, salvo il
// permesso scoped Padel (le rules rifiutano la query non filtrata) — stesso
// pattern di loadGruppiCorso in corsi.js.
async function loadGruppiCorso() {
  try {
    const discipline = disciplineIscrizioniVisibili(currentProfile);
    let query = db.collection("gruppiCorso");
    if (discipline && discipline.length === 1) query = query.where("disciplina", "==", discipline[0]);
    const snap = await query.get();
    gruppiCorsoCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("loadGruppiCorso:", err.message);
    gruppiCorsoCache = [];
  }
}

// ---------- Aggregazione gruppi confermati per data ----------
// Copia di gruppiConfermatiPerData (js/corsi.js) — stesse due fonti (gruppi
// persistenti del modulo di programmazione + flusso storico "Conferma
// gruppo"), stesso filtro di calendario via generaCalendarioSessioni.

function gruppiConfermatiPerData(dataIso) {
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  const corsoVisibile = (corso) => corso && (!discipline || discipline.includes(corso.disciplina));
  const gruppiMap = {};

  gruppiCorsoCache.forEach(g => {
    if (g.bozza === true) return;
    if (!g.giorno || !g.orario) return;
    const corso = corsiCache.find(c => c.id === g.corsoId);
    if (!corsoVisibile(corso)) return;
    const iscritti = iscrizioniConfermateCache.filter(i => (i.gruppoIds || []).includes(g.id));
    if (iscritti.length === 0) return;
    gruppiMap["G:" + g.id] = { corso, nome: g.nome || null, giorno: g.giorno, orario: g.orario, campo: g.campo || null, iscritti };
  });

  iscrizioniConfermateCache.forEach(i => {
    if ((i.gruppoIds || []).length) return;
    if (!i.giornoAssegnato || !i.orarioAssegnato) return;
    const corso = corsiCache.find(c => c.id === i.corsoId);
    if (!corsoVisibile(corso)) return;
    const key = `L:${i.corsoId}|${i.giornoAssegnato}|${i.orarioAssegnato}|${i.campoAssegnato || ""}`;
    if (!gruppiMap[key]) {
      gruppiMap[key] = { corso, nome: null, giorno: i.giornoAssegnato, orario: i.orarioAssegnato, campo: i.campoAssegnato || null, iscritti: [] };
    }
    gruppiMap[key].iscritti.push(i);
  });

  return Object.values(gruppiMap)
    .filter(g => generaCalendarioSessioni(g.corso.dal, g.corso.nrSessioni, g.giorno, g.orario, g.corso.durataSessioneMinuti)
      .some(s => s.data === dataIso))
    .sort((a, b) => a.orario.localeCompare(b.orario) || (a.campo || "").localeCompare(b.campo || ""));
}

// ---------- Render ----------

// Campi attivi visibili (filtrati per disciplina consentita), raggruppati e
// ordinati per disciplina — stesso pattern di perDisciplina() in
// tabellone-generale.js, ordine da DISCIPLINE (loadDiscipline, utils.js).
function perDisciplina() {
  const discipline = disciplineIscrizioniVisibili(currentProfile);
  const campiVisibili = CAMPI.filter(c => !discipline || discipline.includes(c.disciplina));
  const gruppi = {};
  campiVisibili.forEach(c => { (gruppi[c.disciplina] = gruppi[c.disciplina] || []).push(c); });
  return DISCIPLINE
    .map(d => d.id)
    .filter(id => gruppi[id])
    .map(id => ({ disciplina: id, campi: gruppi[id] }));
}

// L'elenco nominale (.iscritti-nomi) viene sempre generato: è il CSS a
// nasconderlo sotto i 900px per non affollare i chip in mobile, dove resta
// visibile solo il conteggio — stesso principio già usato altrove nel
// progetto (es. .tg-seg.occ span in tabellone-generale.html).
function chipHtml(g, mostraCampo) {
  const nomeGruppo = g.nome ? ` (${escapeHtml(g.nome)})` : "";
  const campoTxt = mostraCampo && g.campo ? `${escapeHtml(g.campo)} · ` : "";
  const nomiIscritti = g.iscritti
    .map(i => escapeHtml(`${i.nome} ${i.cognome}`))
    .join(", ");
  return `
    <div class="piano-chip">
      <span class="ora">${g.orario}</span> · ${campoTxt}<span class="corso-nome">${escapeHtml(g.corso.nome)}</span>${nomeGruppo}<br>
      <span class="iscritti">${g.iscritti.length} iscritt${g.iscritti.length === 1 ? "o" : "i"}</span>
      <div class="iscritti-nomi">${nomiIscritti}</div>
    </div>
  `;
}

function renderGrid() {
  const giorni = Array.from({ length: 7 }, (_, i) => addGiorni(statoSettimana.lunedi, i));
  const oggiIso = toISODate(new Date());
  const gruppiPerGiorno = giorni.map(gruppiConfermatiPerData);
  const gruppiDisciplina = perDisciplina();

  let html = `<div class="piano-cell piano-head"></div>`;
  giorni.forEach(iso => {
    const d = new Date(iso + "T00:00:00");
    html += `
      <div class="piano-cell piano-head${iso === oggiIso ? " oggi" : ""}">
        ${GIORNI_SETTIMANA[(d.getDay() + 6) % 7].label}
        <span class="giorno-num">${formatDataBreve(iso)}</span>
      </div>
    `;
  });

  gruppiDisciplina.forEach(({ disciplina, campi }) => {
    html += `<div class="piano-disc-label">${escapeHtml(disciplinaLabel(disciplina))}</div>`;
    campi.forEach(campo => {
      html += `<div class="piano-cell piano-campo-label">${escapeHtml(campo.numero)}</div>`;
      gruppiPerGiorno.forEach(gruppiGiorno => {
        const gruppi = gruppiGiorno.filter(g => g.campo === campo.numero);
        html += `<div class="piano-cell piano-day-cell${gruppi.length === 0 ? " empty" : ""}">${gruppi.length ? gruppi.map(g => chipHtml(g, false)).join("") : "—"}</div>`;
      });
    });
  });

  // Riga "Non assegnato": gruppi il cui campo (testo libero, vedi
  // campiNumeri in corsi.js) non corrisponde a nessun campo attivo
  // visibile — per non far sparire dati con un'etichetta non allineata.
  const campiNumeriVisibili = new Set(gruppiDisciplina.flatMap(({ campi }) => campi.map(c => c.numero)));
  const nonAssegnatoPerGiorno = gruppiPerGiorno.map(gg => gg.filter(g => !campiNumeriVisibili.has(g.campo)));
  if (nonAssegnatoPerGiorno.some(gg => gg.length > 0)) {
    html += `<div class="piano-disc-label piano-non-assegnato">Non assegnato</div>`;
    html += `<div class="piano-cell piano-campo-label">—</div>`;
    nonAssegnatoPerGiorno.forEach(gruppi => {
      html += `<div class="piano-cell piano-day-cell${gruppi.length === 0 ? " empty" : ""}">${gruppi.length ? gruppi.map(g => chipHtml(g, true)).join("") : "—"}</div>`;
    });
  }

  document.getElementById("piano-grid").innerHTML = html;
  document.getElementById("piano-week-range").textContent = formatRangeSettimana(statoSettimana.lunedi);
  document.getElementById("piano-data-input").value = statoSettimana.lunedi;
}

// ---------- Init ----------

function cambiaSettimana(passi) {
  statoSettimana.lunedi = addGiorni(statoSettimana.lunedi, passi * 7);
  renderGrid();
}

document.getElementById("settimana-prev-btn").addEventListener("click", () => cambiaSettimana(-1));
document.getElementById("settimana-next-btn").addEventListener("click", () => cambiaSettimana(1));
document.getElementById("settimana-oggi-btn").addEventListener("click", () => {
  statoSettimana.lunedi = lunediSettimana(toISODate(new Date()));
  renderGrid();
});
document.getElementById("piano-data-input").addEventListener("change", (e) => {
  if (!e.target.value) return;
  statoSettimana.lunedi = lunediSettimana(e.target.value);
  renderGrid();
});

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "iscrizioni:gestisci") && !hasPermission(profile, "iscrizioni:gestisci_padel")) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  await Promise.all([loadDiscipline(), loadCampi(), loadCorsi(), loadIscrizioniConfermate(), loadGruppiCorso()]);

  document.getElementById("piano-content").classList.remove("hidden");
  renderGrid();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
