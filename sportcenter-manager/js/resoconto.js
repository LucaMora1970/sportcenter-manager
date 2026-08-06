// ============================================================
// resoconto.js — totale ore per periodo (dal/al), con breakdown
// per disciplina (vista personale) e, per chi ha il permesso
// diario:leggi_tutti, per dipendente e per tipo di attività con
// cumulo dei costi (in base alle tariffe configurate) e totale
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

async function loadTutti(dal, al) {
  const [diarioSnap, tipiSnap] = await Promise.all([
    db.collection("diario").where("data", ">=", dal).where("data", "<=", al).get(),
    db.collection("tipiAttivita").get()
  ]);

  const entries = diarioSnap.docs.map(d => d.data());
  const tipiById = {};
  tipiSnap.docs.forEach(d => { tipiById[d.id] = { id: d.id, ...d.data() }; });

  const perUtente = {};
  const perTipo = {};
  let totaleOre = 0;
  let totaleCosto = 0;
  let vociSenzaTariffa = 0;

  entries.forEach(e => {
    const ore = e.ore || 0;
    totaleOre += ore;

    if (!perUtente[e.userId]) perUtente[e.userId] = { nome: e.userNome || e.userId, totale: 0 };
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
  });

  return {
    perDipendente: Object.values(perUtente).sort((a, b) => b.totale - a.totale),
    perTipoAttivita: Object.values(perTipo).sort((a, b) => b.ore - a.ore),
    totaleOre,
    totaleCosto,
    vociSenzaTariffa
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

      const warningEl = document.getElementById("tariffe-warning");
      warningEl.textContent = tutti.vociSenzaTariffa > 0
        ? `${tutti.vociSenzaTariffa} voci senza tariffa configurata (escluse dal totale costi).`
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
