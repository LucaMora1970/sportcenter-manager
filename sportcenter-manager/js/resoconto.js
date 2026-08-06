// ============================================================
// resoconto.js — totale ore per periodo (dal/al), con breakdown
// per disciplina (vista personale) e per dipendente (chi ha il
// permesso diario:leggi_tutti).
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

async function loadTutti(dal, al) {
  const snap = await db.collection("diario")
    .where("data", ">=", dal)
    .where("data", "<=", al)
    .get();

  const entries = snap.docs.map(d => d.data());
  const perUtente = {};
  entries.forEach(e => {
    if (!perUtente[e.userId]) perUtente[e.userId] = { nome: e.userNome || e.userId, totale: 0 };
    perUtente[e.userId].totale += (e.ore || 0);
  });
  return Object.values(perUtente).sort((a, b) => b.totale - a.totale);
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

async function calcola() {
  const dal = document.getElementById("dal").value;
  const al = document.getElementById("al").value;
  const btn = document.getElementById("calcola-btn");
  btn.disabled = true;
  btn.textContent = "Calcolo…";

  try {
    const personal = await loadPersonal(currentProfile.uid, dal, al);
    document.getElementById("totale-ore").innerHTML = `${personal.totale.toFixed(1)}<small>h</small>`;
    renderDisciplinaBreakdown(personal.perDisciplina);

    if (hasPermission(currentProfile, "diario:leggi_tutti")) {
      const tutti = await loadTutti(dal, al);
      renderDipendenti(tutti);
    }
  } catch (err) {
    alert("Errore nel calcolo: " + err.message);
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
