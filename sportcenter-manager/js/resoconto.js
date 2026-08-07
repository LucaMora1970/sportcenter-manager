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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function currentMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [toISO(first), toISO(last)];
}

async function loadPersonal(uid, dal, al) {
  const snap = await db.collection("diario")
    .where("userId", "==", uid)
    .where("data", ">=", dal)
    .where("data", "<=", al)
    .get();

  const entries = snap.docs.map(d => d.data());
  const totale = entries.reduce((s, e) => s + (e.ore || 0), 0);
  const perDisciplina = {};
  entries.forEach(e => {
    perDisciplina[e.disciplina] = (perDisciplina[e.disciplina] || 0) + (e.ore || 0);
  });
  return { totale, perDisciplina };
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

  const entries = diarioSnap.docs.map(d => d.data());

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

    if (!perUtente[e.userId]) perUtente[e.userId] = { nome: e.userNome || e.userId, totale: 0, quotaCampo: 0, compenso: 0 };
    perUtente[e.userId].totale += ore;

    const tipoKey = e.tipoAttivitaId || ("legacy:" + (e.tipoAttivita || "altro"));
    if (!perTipo[tipoKey]) perTipo[tipoKey] = { nome: tipoAttivitaLabelFor(e), ore: 0, costo: 0 };
    perTipo[tipoKey].ore += ore;

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
      if (utente && utente.tariffaOraria) {
        const compenso = ore * utente.tariffaOraria;
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
    <div class="entry-card">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(d.nome)}</div>
        ${d.quotaCampo > 0 ? `<div class="entry-meta">Quota campo dovuta: CHF ${d.quotaCampo.toFixed(2)}</div>` : ""}
        ${d.compenso > 0 ? `<div class="entry-meta">Compenso dovuto: CHF ${d.compenso.toFixed(2)}</div>` : ""}
      </div>
      <div class="entry-ore">${d.totale.toFixed(1)}h</div>
    </div>
  `).join("");
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
    const personal = await loadPersonal(currentProfile.uid, dal, al);
    document.getElementById("totale-ore").innerHTML = `${personal.totale.toFixed(1)}<small>h</small>`;
    renderDisciplinaBreakdown(personal.perDisciplina);

    if (hasPermission(currentProfile, "diario:leggi_tutti")) {
      const tutti = await loadTutti(dal, al);
      renderDipendenti(tutti.perDipendente);
      renderPerTipoAttivita(tutti.perTipoAttivita);

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
        ? `${tutti.vociSenzaCompenso} voci retribuibili ma senza tariffa oraria impostata sul collaboratore (escluse dal totale).`
        : "";
    }
  } catch (err) {
    showError(errorEl, "Errore nel calcolo: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcola";
  }
}

requireAuth((profile) => {
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

  calcola();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
