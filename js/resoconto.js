// ============================================================
// resoconto.js — totale ore per periodo (dal/al), con breakdown
// per disciplina (vista personale) e, per chi ha il permesso
// diario:leggi_tutti, per dipendente e per tipo di attività con
// cumulo dei costi (in base alle tariffe configurate), quota campo
// dovuta al circolo dai collaboratori/tipi attività marcati come
// soggetti, compenso dovuto ai collaboratori (tariffa oraria per
// utente sui tipi attività marcati come retribuibili), e totale
// complessivo.
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let ultimoTutti = null; // risultato dell'ultimo calcolo admin, per dettaglio/stampa
let ultimoPersonal = null; // { entries } dell'ultimo calcolo personale, per dettaglio/stampa
let ultimoPeriodo = null; // { dal, al } dell'ultimo calcolo

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDataBreve(dataStr) {
  const [y, m, d] = dataStr.split("-");
  return `${d}.${m}.${y}`;
}

function currentMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [toISO(first), toISO(last)];
}

function last7DaysRange() {
  const oggi = new Date();
  const settimanaFa = new Date();
  settimanaFa.setDate(oggi.getDate() - 6);
  return [toISO(settimanaFa), toISO(oggi)];
}

async function loadPersonal(uid, dal, al) {
  const snap = await db.collection("diario")
    .where("userId", "==", uid)
    .where("data", ">=", dal)
    .where("data", "<=", al)
    .get();

  const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const totale = entries.reduce((s, e) => s + (e.ore || 0), 0);
  const perDisciplina = {};
  entries.forEach(e => {
    perDisciplina[e.disciplina] = (perDisciplina[e.disciplina] || 0) + (e.ore || 0);
  });
  return { totale, perDisciplina, entries };
}

// Tra le tariffe di un tipo attività, trova quella "per tutti" (senza
// tipo utenza specifico, dato che il diario non lo registra più) il
// cui periodo copre la data della voce. Se più tariffe si sovrappongono
// vince quella con periodoInizio più recente.
function prezzoPerData(tipoAttivita, dataStr) {
  if (!tipoAttivita || !Array.isArray(tipoAttivita.prezzi)) return null;

  const candidate = tipoAttivita.prezzi
    .filter(p => !p.tipoUtenzaId)
    .filter(p => !p.periodoInizio || dataStr >= p.periodoInizio)
    .filter(p => !p.periodoFine || dataStr <= p.periodoFine)
    .sort((a, b) => (b.periodoInizio || "").localeCompare(a.periodoInizio || ""))[0];

  return candidate ? candidate.prezzoOra : null;
}

function fasciaOrariaFor(oraInizio) {
  if (!oraInizio) return null;
  return oraInizio < "17:00" ? "prima_17" : "dopo_17";
}

// Trova la quota campo dovuta per una voce diario, incrociando
// disciplina, posizione del campo usato, data (periodo) e — solo per
// il padel — durata effettiva della lezione e fascia oraria.
function quotaCampoPerEntry(entry, campiById, quoteCampoList) {
  if (!entry.campoNumero) return null;

  const campo = campiById[entry.disciplina + "|" + entry.campoNumero];
  const posizione = campo ? campo.posizione : null;

  let candidates = quoteCampoList
    .filter(q => q.disciplina === entry.disciplina)
    .filter(q => !q.posizione || q.posizione === posizione)
    .filter(q => !q.periodoInizio || entry.data >= q.periodoInizio)
    .filter(q => !q.periodoFine || entry.data <= q.periodoFine);

  if (entry.disciplina === "padel") {
    const durataEffettiva = entry.oraInizio && entry.oraFine
      ? Math.round(calcOre(entry.oraInizio, entry.oraFine) * 60)
      : null;
    const fascia = fasciaOrariaFor(entry.oraInizio);
    candidates = candidates
      .filter(q => q.fasciaOraria === fascia)
      .filter(q => durataEffettiva != null && q.durataMinuti === durataEffettiva);
  }

  if (candidates.length === 0) return null;

  // preferisci la quota più specifica: posizione indicata invece di
  // "tutti", poi il periodo con inizio più recente
  candidates.sort((a, b) => {
    const aSpecific = a.posizione ? 1 : 0;
    const bSpecific = b.posizione ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return (b.periodoInizio || "").localeCompare(a.periodoInizio || "");
  });

  const match = candidates[0];
  return entry.disciplina === "padel" ? match.importo : (entry.ore || 0) * match.importo;
}

async function loadTutti(dal, al) {
  const [diarioSnap, tipiSnap, campiSnap, usersSnap, quoteCampoSnap] = await Promise.all([
    db.collection("diario").where("data", ">=", dal).where("data", "<=", al).get(),
    db.collection("tipiAttivita").get(),
    db.collection("campi").get(),
    db.collection("users").get(),
    db.collection("quoteCampo").get()
  ]);

  const entries = diarioSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const tipiById = {};
  tipiSnap.docs.forEach(d => { tipiById[d.id] = { id: d.id, ...d.data() }; });

  const campiById = {};
  campiSnap.docs.forEach(d => {
    const c = d.data();
    campiById[c.disciplina + "|" + c.numero] = c;
  });

  const usersById = {};
  usersSnap.docs.forEach(d => { usersById[d.id] = d.data(); });

  const quoteCampoList = quoteCampoSnap.docs.map(d => d.data());

  const perUtente = {};
  const perTipo = {};
  const perAllievo = {};
  let totaleOre = 0;
  let totaleCosto = 0;
  let totaleQuotaCampo = 0;
  let totaleCompenso = 0;
  let vociSenzaTariffa = 0;
  let vociSenzaQuotaCampo = 0;
  let vociSenzaCompenso = 0;

  entries.forEach(e => {
    const ore = e.ore || 0;
    totaleOre += ore;

    if (!perUtente[e.userId]) perUtente[e.userId] = { uid: e.userId, nome: e.userNome || e.userId, totale: 0, quotaCampo: 0, compenso: 0, entries: [] };
    perUtente[e.userId].totale += ore;
    perUtente[e.userId].entries.push(e);

    const tipoKey = (e.tipoAttivitaId || ("legacy:" + (e.tipoAttivita || "altro"))) + "|" + (e.disciplina || "");
    if (!perTipo[tipoKey]) perTipo[tipoKey] = { nome: tipoAttivitaLabelFor(e), disciplina: e.disciplina, ore: 0, costo: 0 };
    perTipo[tipoKey].ore += ore;

    if (e.allievoId) {
      if (!perAllievo[e.allievoId]) perAllievo[e.allievoId] = { aid: e.allievoId, nome: e.allievoNome || e.allievoId, totale: 0, entries: [] };
      perAllievo[e.allievoId].totale += ore;
      perAllievo[e.allievoId].entries.push(e);
    }

    const tipoAttivitaDoc = e.tipoAttivitaId ? tipiById[e.tipoAttivitaId] : null;
    const prezzoOra = prezzoPerData(tipoAttivitaDoc, e.data);
    if (prezzoOra != null) {
      const costo = ore * prezzoOra;
      perTipo[tipoKey].costo += costo;
      totaleCosto += costo;
    } else {
      vociSenzaTariffa++;
    }

    const utente = usersById[e.userId];
    if (utente && utente.soggettoQuotaCampo && tipoAttivitaDoc && tipoAttivitaDoc.soggettoQuotaCampo) {
      const quota = quotaCampoPerEntry(e, campiById, quoteCampoList);
      if (quota != null) {
        perUtente[e.userId].quotaCampo += quota;
        totaleQuotaCampo += quota;
      } else {
        vociSenzaQuotaCampo++;
      }
    }

    if (tipoAttivitaDoc && tipoAttivitaDoc.retribuitoCollaboratore) {
      const tariffaDisciplina = utente && utente.tariffeOrarie ? utente.tariffeOrarie[e.disciplina] : null;
      if (tariffaDisciplina) {
        const compenso = ore * tariffaDisciplina;
        perUtente[e.userId].compenso += compenso;
        totaleCompenso += compenso;
      } else {
        vociSenzaCompenso++;
      }
    }
  });

  return {
    perDipendente: Object.values(perUtente).sort((a, b) => b.totale - a.totale),
    perTipoAttivita: Object.values(perTipo).sort((a, b) => b.ore - a.ore),
    perAllievo: Object.values(perAllievo).sort((a, b) => a.nome.localeCompare(b.nome)),
    totaleOre,
    totaleCosto,
    totaleQuotaCampo,
    totaleCompenso,
    vociSenzaTariffa,
    vociSenzaQuotaCampo,
    vociSenzaCompenso
  };
}

function renderDisciplinaBreakdown(perDisciplina) {
  const el = document.getElementById("disciplina-breakdown");
  const righe = DISCIPLINE.filter(d => perDisciplina[d.id]);

  if (righe.length === 0) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = righe.map(d => `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${d.id}">${d.label}</span>
      </div>
      <div class="entry-ore">${(perDisciplina[d.id] || 0).toFixed(1)}h</div>
    </div>
  `).join("");
}

function renderDipendenti(lista) {
  const el = document.getElementById("dipendenti-list");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(d => `
    <div class="dipendente-block" data-uid="${d.uid}">
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(d.nome)}</div>
          ${d.quotaCampo > 0 ? `<div class="entry-meta">Quota campo dovuta: CHF ${d.quotaCampo.toFixed(2)}</div>` : ""}
          ${d.compenso > 0 ? `<div class="entry-meta">Compenso dovuto: CHF ${d.compenso.toFixed(2)}</div>` : ""}
        </div>
        <div class="entry-ore">${d.totale.toFixed(1)}h</div>
      </div>
      <div class="dipendente-actions">
        <button type="button" class="btn btn-ghost toggle-dettaglio-btn" data-uid="${d.uid}">Dettaglio</button>
        <button type="button" class="btn btn-ghost stampa-btn" data-uid="${d.uid}">Stampa / PDF</button>
      </div>
      <div class="dettaglio-giorni hidden" id="dettaglio-${d.uid}"></div>
    </div>
  `).join("");

  el.querySelectorAll(".toggle-dettaglio-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleDettaglioDipendente(btn.dataset.uid));
  });
  el.querySelectorAll(".stampa-btn").forEach(btn => {
    btn.addEventListener("click", () => stampaReportDipendente(btn.dataset.uid));
  });
}

function renderAllievi(lista) {
  const el = document.getElementById("allievi-list-report");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(a => `
    <div class="dipendente-block" data-aid="${a.aid}">
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(a.nome)}</div>
        </div>
        <div class="entry-ore">${a.totale.toFixed(1)}h</div>
      </div>
      <div class="dipendente-actions">
        <button type="button" class="btn btn-ghost toggle-dettaglio-allievo-btn" data-aid="${a.aid}">Dettaglio</button>
        <button type="button" class="btn btn-ghost stampa-allievo-btn" data-aid="${a.aid}">Stampa / PDF</button>
      </div>
      <div class="dettaglio-giorni hidden" id="dettaglio-allievo-${a.aid}"></div>
    </div>
  `).join("");

  el.querySelectorAll(".toggle-dettaglio-allievo-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleDettaglioAllievo(btn.dataset.aid));
  });
  el.querySelectorAll(".stampa-allievo-btn").forEach(btn => {
    btn.addEventListener("click", () => stampaReportAllievo(btn.dataset.aid));
  });
}

function toggleDettaglioAllievo(aid) {
  const container = document.getElementById(`dettaglio-allievo-${aid}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  const allievo = (ultimoTutti.perAllievo || []).find(a => a.aid === aid);
  container.innerHTML = renderDettaglioGiorniHtml(allievo);
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
}

function stampaReportAllievo(aid) {
  const allievo = (ultimoTutti.perAllievo || []).find(a => a.aid === aid);
  if (!allievo) return;
  stampaReport({ nome: allievo.nome, entries: allievo.entries, totale: allievo.totale, quotaCampo: 0, compenso: 0 });
}

// Raggruppa le voci di un dipendente per data (più recente prima), con
// un mini-totale per giorno, riusando lo stesso stile card del diario.
function renderDettaglioGiorniHtml(dipendente) {
  if (!dipendente || dipendente.entries.length === 0) {
    return `<div class="empty-state"><div class="display">Nessuna voce</div></div>`;
  }

  const perGiorno = {};
  dipendente.entries.forEach(en => {
    if (!perGiorno[en.data]) perGiorno[en.data] = [];
    perGiorno[en.data].push(en);
  });

  const giorni = Object.keys(perGiorno).sort().reverse();

  return giorni.map(data => {
    const entries = perGiorno[data];
    const totaleGiorno = entries.reduce((s, en) => s + (en.ore || 0), 0);
    return `
      <div class="row-label">${formatDataBreve(data)} · ${totaleGiorno.toFixed(1)}h</div>
      ${entries.map(en => entryRowHtml(en)).join("")}
    `;
  }).join("");
}

function entryRowHtml(en) {
  const metaParts = [];
  if (en.campoNumero) metaParts.push("Campo " + en.campoNumero);
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
        ${puoEliminareVoceDiario(en, currentProfile) ? `<button type="button" class="btn btn-danger delete-diario-btn" style="width:auto;padding:6px 10px;font-size:0.65rem;" data-id="${en.id}">Elimina</button>` : ""}
      </div>
    </div>
  `;
}

function toggleDettaglioDipendente(uid) {
  const container = document.getElementById(`dettaglio-${uid}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  const dipendente = (ultimoTutti.perDipendente || []).find(d => d.uid === uid);
  container.innerHTML = renderDettaglioGiorniHtml(dipendente);
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
}

// Tabella di stampa condivisa tra il report di un singolo dipendente
// (vista admin) e il report personale (vista collaboratore).
function stampaReport({ nome, entries, totale, quotaCampo, compenso }) {
  const perGiorno = {};
  entries.forEach(en => {
    if (!perGiorno[en.data]) perGiorno[en.data] = [];
    perGiorno[en.data].push(en);
  });
  const giorni = Object.keys(perGiorno).sort();

  const righe = giorni.flatMap(data =>
    perGiorno[data].map(en => `
      <tr>
        <td>${formatDataBreve(data)}</td>
        <td>${escapeHtml(disciplinaLabel(en.disciplina))}</td>
        <td>${escapeHtml(tipoAttivitaLabelFor(en))}</td>
        <td>${en.campoNumero ? escapeHtml(String(en.campoNumero)) : "—"}</td>
        <td>${escapeHtml(en.allievoNome || "—")}</td>
        <td>${en.oraInizio || "—"}–${en.oraFine || "—"}</td>
        <td>${(en.ore || 0).toFixed(2)}</td>
        <td>${escapeHtml(en.note || "")}</td>
      </tr>
    `)
  ).join("");

  const totaliParts = [`<p><strong>Totale ore:</strong> ${totale.toFixed(2)}</p>`];
  if (quotaCampo > 0) totaliParts.push(`<p><strong>Quota campo dovuta:</strong> CHF ${quotaCampo.toFixed(2)}</p>`);
  if (compenso > 0) totaliParts.push(`<p><strong>Compenso dovuto:</strong> CHF ${compenso.toFixed(2)}</p>`);

  document.getElementById("print-area").innerHTML = `
    <h1>${escapeHtml(nome)}</h1>
    <p>Periodo: ${formatDataBreve(ultimoPeriodo.dal)} – ${formatDataBreve(ultimoPeriodo.al)}</p>
    <table>
      <thead>
        <tr><th>Data</th><th>Disciplina</th><th>Tipo attività</th><th>Campo</th><th>Allievo</th><th>Orario</th><th>Ore</th><th>Note</th></tr>
      </thead>
      <tbody>${righe}</tbody>
    </table>
    ${totaliParts.join("")}
  `;

  window.print();
}

function stampaReportDipendente(uid) {
  const dipendente = (ultimoTutti.perDipendente || []).find(d => d.uid === uid);
  if (!dipendente) return;
  stampaReport({ nome: dipendente.nome, entries: dipendente.entries, totale: dipendente.totale, quotaCampo: dipendente.quotaCampo, compenso: dipendente.compenso });
}

function stampaReportPersonale() {
  if (!ultimoPersonal) return;
  stampaReport({ nome: currentProfile.nome, entries: ultimoPersonal.entries, totale: ultimoPersonal.totale, quotaCampo: 0, compenso: 0 });
}

function togglePersonalDettaglio() {
  const container = document.getElementById("personal-dettaglio");
  if (!container || !ultimoPersonal) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = renderDettaglioGiorniHtml(ultimoPersonal);
  container.querySelectorAll(".delete-diario-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa voce? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("diario").doc(btn.dataset.id).delete();
        await calcola();
      } catch (err) {
        showError(document.getElementById("resoconto-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
  container.classList.remove("hidden");
}

// Tabella consolidata pensata per segretaria/contabile: un colpo
// d'occhio su ore, quanto retribuire e quanto ricevere per ciascun
// dipendente, con totali di riga.
function renderRiepilogoContabilita(lista) {
  const el = document.getElementById("riepilogo-contabilita-table");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  const totOre = lista.reduce((s, d) => s + d.totale, 0);
  const totCompenso = lista.reduce((s, d) => s + d.compenso, 0);
  const totQuota = lista.reduce((s, d) => s + d.quotaCampo, 0);

  el.innerHTML = `
    <table class="app-table">
      <thead>
        <tr><th>Dipendente</th><th>Ore</th><th>Da retribuire</th><th>Da ricevere</th></tr>
      </thead>
      <tbody>
        ${lista.map(d => `
          <tr>
            <td>${escapeHtml(d.nome)}</td>
            <td>${d.totale.toFixed(1)}h</td>
            <td>${d.compenso > 0 ? "CHF " + d.compenso.toFixed(2) : "—"}</td>
            <td>${d.quotaCampo > 0 ? "CHF " + d.quotaCampo.toFixed(2) : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>Totale</strong></td>
          <td><strong>${totOre.toFixed(1)}h</strong></td>
          <td><strong>CHF ${totCompenso.toFixed(2)}</strong></td>
          <td><strong>CHF ${totQuota.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

function stampaRiepilogoCompleto() {
  if (!ultimoTutti || !ultimoTutti.perDipendente) return;
  const lista = ultimoTutti.perDipendente;

  const righe = lista.map(d => `
    <tr>
      <td>${escapeHtml(d.nome)}</td>
      <td>${d.totale.toFixed(2)}</td>
      <td>${d.compenso > 0 ? d.compenso.toFixed(2) : "—"}</td>
      <td>${d.quotaCampo > 0 ? d.quotaCampo.toFixed(2) : "—"}</td>
    </tr>
  `).join("");

  const totOre = lista.reduce((s, d) => s + d.totale, 0);
  const totCompenso = lista.reduce((s, d) => s + d.compenso, 0);
  const totQuota = lista.reduce((s, d) => s + d.quotaCampo, 0);

  document.getElementById("print-area").innerHTML = `
    <h1>Riepilogo complessivo dipendenti</h1>
    <p>Periodo: ${formatDataBreve(ultimoPeriodo.dal)} – ${formatDataBreve(ultimoPeriodo.al)}</p>
    <table>
      <thead>
        <tr><th>Dipendente</th><th>Ore</th><th>Da retribuire (CHF)</th><th>Da ricevere (CHF)</th></tr>
      </thead>
      <tbody>${righe}</tbody>
      <tfoot>
        <tr>
          <th>Totale</th>
          <th>${totOre.toFixed(2)}</th>
          <th>${totCompenso.toFixed(2)}</th>
          <th>${totQuota.toFixed(2)}</th>
        </tr>
      </tfoot>
    </table>
  `;

  window.print();
}

function renderPerTipoAttivita(lista) {
  const el = document.getElementById("tipoattivita-list");

  if (lista.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna voce nel periodo</div></div>`;
    return;
  }

  el.innerHTML = lista.map(t => `
    <div class="entry-card">
      <div class="entry-main">
        <span class="badge ${t.disciplina}">${escapeHtml(disciplinaLabel(t.disciplina))}</span>
        <div class="entry-tipo">${escapeHtml(t.nome)}</div>
        <div class="entry-meta">${t.ore.toFixed(1)}h</div>
      </div>
      <div class="entry-ore">CHF ${t.costo.toFixed(2)}</div>
    </div>
  `).join("");
}

async function calcola() {
  const dal = document.getElementById("dal").value;
  const al = document.getElementById("al").value;
  const btn = document.getElementById("calcola-btn");
  const errorEl = document.getElementById("resoconto-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Calcolo…";

  try {
    ultimoPeriodo = { dal, al };

    const personal = await loadPersonal(currentProfile.uid, dal, al);
    ultimoPersonal = personal;
    document.getElementById("totale-ore").innerHTML = `${personal.totale.toFixed(1)}<small>h</small>`;
    renderDisciplinaBreakdown(personal.perDisciplina);

    const personalDettaglioEl = document.getElementById("personal-dettaglio");
    personalDettaglioEl.innerHTML = "";
    personalDettaglioEl.classList.add("hidden");

    if (hasPermission(currentProfile, "diario:leggi_tutti")) {
      const tutti = await loadTutti(dal, al);
      ultimoTutti = tutti;
      renderDipendenti(tutti.perDipendente);
      renderRiepilogoContabilita(tutti.perDipendente);
      renderPerTipoAttivita(tutti.perTipoAttivita);
      renderAllievi(tutti.perAllievo);

      document.getElementById("totale-complessivo-ore").innerHTML = `${tutti.totaleOre.toFixed(1)}<small>h</small>`;
      document.getElementById("totale-complessivo-costo").textContent = `CHF ${tutti.totaleCosto.toFixed(2)}`;
      document.getElementById("totale-quotacampo").textContent = `CHF ${tutti.totaleQuotaCampo.toFixed(2)}`;
      document.getElementById("totale-compenso").textContent = `CHF ${tutti.totaleCompenso.toFixed(2)}`;

      const warningEl = document.getElementById("tariffe-warning");
      warningEl.textContent = tutti.vociSenzaTariffa > 0
        ? `${tutti.vociSenzaTariffa} voci senza tariffa configurata (escluse dal totale costi).`
        : "";

      const quotaWarningEl = document.getElementById("quotacampo-warning");
      quotaWarningEl.textContent = tutti.vociSenzaQuotaCampo > 0
        ? `${tutti.vociSenzaQuotaCampo} voci soggette a quota campo ma senza tariffa corrispondente (escluse dal totale).`
        : "";

      const compensoWarningEl = document.getElementById("compenso-warning");
      compensoWarningEl.textContent = tutti.vociSenzaCompenso > 0
        ? `${tutti.vociSenzaCompenso} voci retribuibili ma senza tariffa oraria impostata sul collaboratore per quella disciplina (escluse dal totale).`
        : "";
    }
  } catch (err) {
    showError(errorEl, "Errore nel calcolo: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcola";
  }
}

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  const [dal, al] = currentMonthRange();
  document.getElementById("dal").value = dal;
  document.getElementById("al").value = al;

  if (hasPermission(profile, "diario:leggi_tutti")) {
    document.getElementById("admin-section").classList.remove("hidden");
    document.getElementById("totale-label").textContent = "Le tue ore nel periodo";
  }

  document.getElementById("period-form").addEventListener("submit", (e) => {
    e.preventDefault();
    calcola();
  });

  document.getElementById("personal-dettaglio-btn").addEventListener("click", togglePersonalDettaglio);
  document.getElementById("personal-stampa-btn").addEventListener("click", stampaReportPersonale);

  document.getElementById("preset-7giorni").addEventListener("click", () => {
    const [d, a] = last7DaysRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcola();
  });

  document.getElementById("preset-mese-corrente").addEventListener("click", () => {
    const [d, a] = currentMonthRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcola();
  });

  document.getElementById("stampa-tutti-btn").addEventListener("click", stampaRiepilogoCompleto);

  await loadDiscipline();
  await loadImpostazioni();
  calcola();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
