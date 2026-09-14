// ============================================================
// presenze.js — checklist presenze per sessione, giorno per giorno e ora
// per ora (sessioni ordinate per orario). Riusa la stessa aggregazione
// di corsi.js/piano-occupazione.js (gruppiConfermatiPerData), duplicata
// qui deliberatamente per non toccare pagine già funzionanti a ridosso
// dell'apertura corsi — stesso principio di formatDataBreve, già
// duplicata identica in 8 file diversi in questo progetto.
//
// Ogni presenza è un documento in "presenze" con id deterministico
// "{gruppoId}_{iscrizioneId}_{data}" — un secondo tap corregge lo stesso
// documento invece di duplicarlo. Salvataggio immediato al tap, nessun
// bottone "Salva" collettivo.
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let corsiCache = [];
let iscrizioniConfermateCache = [];
let gruppiCorsoCache = [];
let presenzeCache = []; // presenze già registrate per il giorno mostrato
let gruppiGiornoCache = []; // ultimo risultato di gruppiConfermatiPerData renderizzato

function pad2(n) { return String(n).padStart(2, "0"); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addGiorni(dataIso, n) {
  const d = new Date(dataIso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

const MESI_BREVI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const GIORNI_LUNGHI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
function formatGiornoEsteso(dataIso) {
  const d = new Date(dataIso + "T00:00:00");
  return `${GIORNI_LUNGHI[d.getDay()]} ${d.getDate()} ${MESI_BREVI[d.getMonth()]}`;
}

let statoGiorno = { data: toISODate(new Date()) };

// ---------- Permessi / filtro discipline ----------
// corsi:presenze e iscrizioni:gestisci vedono tutte le discipline (il
// capo corso deve poter supervisionare tutti i maestri); chi ha solo
// iscrizioni:gestisci_padel resta scoped, come altrove nell'app.
function disciplinePresenzeVisibili(profile) {
  if (hasPermission(profile, "corsi:presenze") || hasPermission(profile, "iscrizioni:gestisci")) return null;
  if (hasPermission(profile, "iscrizioni:gestisci_padel")) return ["padel"];
  return [];
}

// ---------- Caricamento dati ----------

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
// usato in corsi.js/piano-occupazione.js.
async function loadIscrizioniConfermate() {
  const discipline = disciplinePresenzeVisibili(currentProfile);
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
// permesso scoped Padel (le rules rifiutano la query non filtrata) —
// stesso pattern di loadGruppiCorso in corsi.js/piano-occupazione.js.
async function loadGruppiCorso() {
  try {
    const discipline = disciplinePresenzeVisibili(currentProfile);
    let query = db.collection("gruppiCorso");
    if (discipline && discipline.length === 1) query = query.where("disciplina", "==", discipline[0]);
    const snap = await query.get();
    gruppiCorsoCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("loadGruppiCorso:", err.message);
    gruppiCorsoCache = [];
  }
}

async function loadPresenzeGiorno(dataIso) {
  const snap = await db.collection("presenze").where("data", "==", dataIso).get();
  presenzeCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------- Aggregazione gruppi confermati per data ----------
// Copia di gruppiConfermatiPerData (js/corsi.js, js/piano-occupazione.js).
function gruppiConfermatiPerData(dataIso) {
  const discipline = disciplinePresenzeVisibili(currentProfile);
  const corsoVisibile = (corso) => corso && (!discipline || discipline.includes(corso.disciplina));
  const gruppiMap = {};

  gruppiCorsoCache.forEach(g => {
    if (g.bozza === true) return;
    if (!g.giorno || !g.orario) return;
    const corso = corsiCache.find(c => c.id === g.corsoId);
    if (!corsoVisibile(corso)) return;
    const iscritti = iscrizioniConfermateCache.filter(i => (i.gruppoIds || []).includes(g.id));
    if (iscritti.length === 0) return;
    gruppiMap["G:" + g.id] = { id: g.id, corso, nome: g.nome || null, giorno: g.giorno, orario: g.orario, campo: g.campo || null, iscritti };
  });

  iscrizioniConfermateCache.forEach(i => {
    if ((i.gruppoIds || []).length) return;
    if (!i.giornoAssegnato || !i.orarioAssegnato) return;
    const corso = corsiCache.find(c => c.id === i.corsoId);
    if (!corsoVisibile(corso)) return;
    const key = `L:${i.corsoId}|${i.giornoAssegnato}|${i.orarioAssegnato}|${i.campoAssegnato || ""}`;
    if (!gruppiMap[key]) {
      gruppiMap[key] = { id: key, corso, nome: null, giorno: i.giornoAssegnato, orario: i.orarioAssegnato, campo: i.campoAssegnato || null, iscritti: [] };
    }
    gruppiMap[key].iscritti.push(i);
  });

  return Object.values(gruppiMap)
    .filter(g => generaCalendarioSessioni(g.corso.dal, g.corso.nrSessioni, g.giorno, g.orario, g.corso.durataSessioneMinuti)
      .some(s => s.data === dataIso))
    .sort((a, b) => a.orario.localeCompare(b.orario) || (a.campo || "").localeCompare(b.campo || ""));
}

// ---------- Presenze: lettura/scrittura ----------

function presenzaKey(gruppoId, iscrizioneId, data) {
  return `${gruppoId}_${iscrizioneId}_${data}`;
}

function presenzaDi(gruppoId, iscrizioneId, data) {
  return presenzeCache.find(p => p.id === presenzaKey(gruppoId, iscrizioneId, data));
}

// Salvataggio immediato al tap (nessun bottone "Salva" collettivo). Id
// deterministico: un secondo tap corregge lo stesso documento, non lo
// duplica — comodo anche per cambiare idea durante l'appello.
//
// Tracciabilità (importante: chi ha inserito/modificato una presenza, e
// quando): il documento distingue inseritoDa* (scritto una sola volta,
// mai più toccato) da modificatoDa* (aggiornato a ogni correzione
// successiva) — rilegge lo stato attuale da Firestore, non dalla cache
// locale, per decidere quale dei due si applica. In più, ogni cambio
// aggiunge una riga a presenzeLog (registro immutabile, mai aggiornato
// né cancellato — stesso principio di iscrizioniLog altrove in
// quest'app): il documento sopra mostra solo l'ultimo stato, il log
// conserva la sequenza completa di ogni correzione in caso di
// contestazione (es. un genitore che dice "mio figlio c'era").
async function segnaPresenza(g, iscrizione, presente) {
  const dataIso = statoGiorno.data;
  const id = presenzaKey(g.id, iscrizione.id, dataIso);
  const ref = db.collection("presenze").doc(id);
  try {
    const snap = await ref.get();
    const esistente = snap.exists ? snap.data() : null;
    const adesso = firebase.firestore.FieldValue.serverTimestamp();

    const payload = {
      gruppoId: g.id,
      iscrizioneId: iscrizione.id,
      allievoId: iscrizione.allievoId || null,
      corsoId: g.corso.id,
      data: dataIso,
      giorno: g.giorno,
      orario: g.orario,
      campo: g.campo || null,
      corsoNome: g.corso.nome,
      disciplina: g.corso.disciplina,
      presente: !!presente
    };
    if (!esistente) {
      payload.inseritoDaUid = currentProfile.uid;
      payload.inseritoDaNome = currentProfile.nome;
      payload.inseritoAt = adesso;
    } else {
      payload.modificatoDaUid = currentProfile.uid;
      payload.modificatoDaNome = currentProfile.nome;
      payload.modificatoAt = adesso;
    }

    await ref.set(payload, { merge: true });
    await db.collection("presenzeLog").add({
      presenzaId: id,
      gruppoId: g.id,
      iscrizioneId: iscrizione.id,
      allievoId: iscrizione.allievoId || null,
      corsoId: g.corso.id,
      data: dataIso,
      valorePrecedente: esistente ? !!esistente.presente : null,
      valoreNuovo: !!presente,
      registratoDaUid: currentProfile.uid,
      registratoDaNome: currentProfile.nome,
      registratoAt: adesso
    });

    const idx = presenzeCache.findIndex(p => p.id === id);
    const merged = { id, ...(esistente || {}), ...payload };
    if (idx === -1) presenzeCache.push(merged);
    else presenzeCache[idx] = merged;
    renderGiorno();
  } catch (err) {
    alert("Errore nel salvataggio della presenza: " + err.message);
  }
}

// ---------- Render ----------

function pillHtml(g, i) {
  const p = presenzaDi(g.id, i.id, statoGiorno.data);
  const presente = p ? p.presente : null;
  const stilePresente = presente === true ? "border-color:#7f9e4a;color:#c1e08f;" : "";
  const stileAssente = presente === false ? "border-color:var(--danger);color:var(--danger);" : "";
  return `
    <div class="candidato-row">
      <span class="candidato-nome">${escapeHtml(i.cognome)} ${escapeHtml(i.nome)}</span>
      <span style="display:flex;gap:6px;flex-shrink:0;">
        <button type="button" class="btn btn-ghost presenza-btn" data-g="${escapeHtml(g.id)}" data-i="${escapeHtml(i.id)}" data-presente="true" style="width:auto;padding:6px 12px;font-size:0.7rem;${stilePresente}">✓ Presente</button>
        <button type="button" class="btn btn-ghost presenza-btn" data-g="${escapeHtml(g.id)}" data-i="${escapeHtml(i.id)}" data-presente="false" style="width:auto;padding:6px 12px;font-size:0.7rem;${stileAssente}">✗ Assente</button>
      </span>
    </div>
  `;
}

function sessioneHtml(g) {
  const membri = g.iscritti.slice().sort(compareCognomeNome);
  const nomeSessione = g.nome ? ` (${escapeHtml(g.nome)})` : "";
  return `
    <div class="entry-card" style="display:block;">
      <div class="entry-tipo">${g.orario} · ${escapeHtml(g.corso.nome)}${nomeSessione}${g.campo ? " · Campo " + escapeHtml(String(g.campo)) : ""}</div>
      <div class="entry-meta" style="margin-bottom:8px;">${membri.length} iscritt${membri.length === 1 ? "o" : "i"}</div>
      ${membri.map(i => pillHtml(g, i)).join("")}
    </div>
  `;
}

function renderGiorno() {
  gruppiGiornoCache = gruppiConfermatiPerData(statoGiorno.data);
  document.getElementById("presenze-data-label").textContent = formatGiornoEsteso(statoGiorno.data);
  document.getElementById("presenze-data-input").value = statoGiorno.data;

  const listEl = document.getElementById("presenze-list");
  if (gruppiGiornoCache.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">Nessuna sessione confermata in questo giorno</div></div>`;
    return;
  }

  listEl.innerHTML = gruppiGiornoCache.map(sessioneHtml).join("");
  listEl.querySelectorAll(".presenza-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const g = gruppiGiornoCache.find(x => x.id === btn.dataset.g);
      const i = g && g.iscritti.find(x => x.id === btn.dataset.i);
      if (!g || !i) return;
      segnaPresenza(g, i, btn.dataset.presente === "true");
    });
  });
}

// ---------- Init ----------

async function cambiaGiorno(dataIso) {
  statoGiorno.data = dataIso;
  await loadPresenzeGiorno(dataIso);
  renderGiorno();
}

document.getElementById("giorno-prev-btn").addEventListener("click", () => cambiaGiorno(addGiorni(statoGiorno.data, -1)));
document.getElementById("giorno-next-btn").addEventListener("click", () => cambiaGiorno(addGiorni(statoGiorno.data, 1)));
document.getElementById("giorno-oggi-btn").addEventListener("click", () => cambiaGiorno(toISODate(new Date())));
document.getElementById("presenze-data-input").addEventListener("change", (e) => {
  if (!e.target.value) return;
  cambiaGiorno(e.target.value);
});

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "corsi:presenze") && !hasPermission(profile, "iscrizioni:gestisci") && !hasPermission(profile, "iscrizioni:gestisci_padel")) {
    document.getElementById("access-denied").classList.remove("hidden");
    return;
  }

  await Promise.all([loadCorsi(), loadIscrizioniConfermate(), loadGruppiCorso()]);
  await loadPresenzeGiorno(statoGiorno.data);

  document.getElementById("presenze-content").classList.remove("hidden");
  renderGiorno();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
