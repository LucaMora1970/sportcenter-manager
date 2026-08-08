// ============================================================
// cassa.js — registrazione vendite (ruolo Bar) e riepilogo per
// periodo, diviso per metodo di pagamento (Twint/Contanti) e per
// articolo. Accesso riservato a chi ha il permesso vendite:gestisci.
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;
let articoliCache = [];
let venditeOggiUnsub = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayISO() {
  return toISO(new Date());
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

// ---------- Catalogo articoli ----------

const ARTICOLO_LIBERO_VALUE = "__altro__";

async function loadArticoli() {
  const snap = await db.collection("articoli").where("attivo", "==", true).get();
  articoliCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));

  const select = document.getElementById("vendita-articolo");
  select.innerHTML = articoliCache.map(a => `<option value="${a.id}">${escapeHtml(a.nome)}</option>`).join("")
    + `<option value="${ARTICOLO_LIBERO_VALUE}">Altro (articolo non previsto)</option>`;
  syncArticoloSelezionato();
}

function syncArticoloSelezionato() {
  const select = document.getElementById("vendita-articolo");
  const liberoField = document.getElementById("vendita-articolo-libero-field");
  const isLibero = select.value === ARTICOLO_LIBERO_VALUE;

  liberoField.classList.toggle("hidden", !isLibero);
  document.getElementById("vendita-articolo-libero").required = isLibero;

  if (isLibero) {
    document.getElementById("vendita-importo").value = "";
    return;
  }

  const articolo = articoliCache.find(a => a.id === select.value);
  if (articolo && articolo.prezzoDefault) {
    document.getElementById("vendita-importo").value = articolo.prezzoDefault;
  }
}

// ---------- Nuova vendita ----------

function metodoLabel(m) {
  return m === "twint" ? "Twint" : "Contanti";
}

async function onSubmitVendita(e) {
  e.preventDefault();
  const btn = document.getElementById("vendita-btn");
  const errorEl = document.getElementById("vendita-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Registrazione…";

  const select = document.getElementById("vendita-articolo");
  const isLibero = select.value === ARTICOLO_LIBERO_VALUE;
  const nomeLibero = document.getElementById("vendita-articolo-libero").value.trim();
  const importo = parseFloat(document.getElementById("vendita-importo").value) || 0;
  const metodoPagamento = document.getElementById("vendita-metodo").value;

  try {
    if (!select.value) throw new Error("Seleziona un articolo.");
    if (isLibero && !nomeLibero) throw new Error("Inserisci il nome dell'articolo.");
    if (importo <= 0) throw new Error("Inserisci un importo maggiore di zero.");

    await db.collection("vendite").add({
      data: todayISO(),
      articoloId: isLibero ? null : select.value,
      articoloNome: isLibero ? nomeLibero : select.options[select.selectedIndex].textContent,
      importo,
      metodoPagamento,
      userId: currentProfile.uid,
      userNome: currentProfile.nome,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    document.getElementById("vendita-metodo").value = "twint";
    document.getElementById("vendita-articolo-libero").value = "";
    syncArticoloSelezionato();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Registra vendita";
  }
}

// ---------- Vendite di oggi ----------

function renderVenditeOggi(vendite) {
  const list = document.getElementById("vendite-oggi-list");
  const totaleEl = document.getElementById("oggi-totale");

  if (vendite.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="display">Nessuna vendita oggi</div></div>`;
    totaleEl.innerHTML = `0.00<small>CHF</small>`;
    return;
  }

  let totale = 0;
  list.innerHTML = vendite.map(v => {
    totale += v.importo || 0;
    return `
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(v.articoloNome)}</div>
          <div class="entry-meta">${metodoLabel(v.metodoPagamento)} · ${escapeHtml(v.userNome || "")}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div class="entry-ore">CHF ${(v.importo || 0).toFixed(2)}</div>
          <button type="button" class="btn btn-danger delete-vendita-btn" style="width:auto;padding:6px 10px;font-size:0.65rem;" data-id="${v.id}">Elimina</button>
        </div>
      </div>
    `;
  }).join("");

  totaleEl.innerHTML = `${totale.toFixed(2)}<small>CHF</small>`;

  list.querySelectorAll(".delete-vendita-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Eliminare questa vendita? L'operazione non è reversibile.")) return;
      btn.disabled = true;
      try {
        await db.collection("vendite").doc(btn.dataset.id).delete();
      } catch (err) {
        showError(document.getElementById("vendita-error"), "Errore nell'eliminazione: " + err.message);
        btn.disabled = false;
      }
    });
  });
}

function listenVenditeOggi() {
  if (venditeOggiUnsub) venditeOggiUnsub();

  venditeOggiUnsub = db.collection("vendite")
    .where("data", "==", todayISO())
    .onSnapshot(
      (snap) => {
        const vendite = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt ? b.createdAt.toMillis() : 0) - (a.createdAt ? a.createdAt.toMillis() : 0));
        renderVenditeOggi(vendite);
      },
      (err) => {
        console.error(err);
        document.getElementById("vendite-oggi-list").innerHTML =
          `<div class="empty-state"><div class="display">Errore di lettura</div><p>${err.message}</p></div>`;
      }
    );
}

// ---------- Riepilogo periodo ----------

function renderPerArticolo(perArticolo) {
  const el = document.getElementById("per-articolo-list");
  const righe = Object.values(perArticolo).sort((a, b) => b.totale - a.totale);

  if (righe.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="display">Nessuna vendita nel periodo</div></div>`;
    return;
  }

  el.innerHTML = righe.map(r => `
    <div class="entry-card">
      <div class="entry-main">
        <div class="entry-tipo">${escapeHtml(r.nome)}</div>
        <div class="entry-meta">${r.quantita} vendite</div>
      </div>
      <div class="entry-ore">CHF ${r.totale.toFixed(2)}</div>
    </div>
  `).join("");
}

async function calcolaPeriodo() {
  const dal = document.getElementById("dal").value;
  const al = document.getElementById("al").value;
  const btn = document.getElementById("calcola-btn");
  const errorEl = document.getElementById("periodo-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Calcolo…";

  try {
    const snap = await db.collection("vendite")
      .where("data", ">=", dal)
      .where("data", "<=", al)
      .get();

    const vendite = snap.docs.map(d => d.data());

    let totaleTwint = 0;
    let totaleContanti = 0;
    const perArticolo = {};

    vendite.forEach(v => {
      const importo = v.importo || 0;
      if (v.metodoPagamento === "twint") totaleTwint += importo;
      else totaleContanti += importo;

      const key = v.articoloId || v.articoloNome;
      if (!perArticolo[key]) perArticolo[key] = { nome: v.articoloNome || "—", totale: 0, quantita: 0 };
      perArticolo[key].totale += importo;
      perArticolo[key].quantita += 1;
    });

    document.getElementById("totale-twint").textContent = `CHF ${totaleTwint.toFixed(2)}`;
    document.getElementById("totale-contanti").textContent = `CHF ${totaleContanti.toFixed(2)}`;
    document.getElementById("totale-periodo").innerHTML = `${(totaleTwint + totaleContanti).toFixed(2)}<small>CHF</small>`;
    renderPerArticolo(perArticolo);
  } catch (err) {
    showError(errorEl, "Errore nel calcolo: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcola";
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "vendite:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("cassa-content").classList.add("hidden");
    return;
  }

  const [dal, al] = currentMonthRange();
  document.getElementById("dal").value = dal;
  document.getElementById("al").value = al;

  document.getElementById("vendita-form").addEventListener("submit", onSubmitVendita);
  document.getElementById("vendita-articolo").addEventListener("change", syncArticoloSelezionato);

  document.getElementById("periodo-form").addEventListener("submit", (e) => {
    e.preventDefault();
    calcolaPeriodo();
  });

  document.getElementById("preset-7giorni").addEventListener("click", () => {
    const [d, a] = last7DaysRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcolaPeriodo();
  });

  document.getElementById("preset-mese-corrente").addEventListener("click", () => {
    const [d, a] = currentMonthRange();
    document.getElementById("dal").value = d;
    document.getElementById("al").value = a;
    calcolaPeriodo();
  });

  await loadArticoli();
  listenVenditeOggi();
  calcolaPeriodo();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
