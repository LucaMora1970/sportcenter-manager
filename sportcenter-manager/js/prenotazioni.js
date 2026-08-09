// ============================================================
// prenotazioni.js — tabellone prenotazione campo padel.
// Fase di test interna: dietro login (come tutte le altre pagine),
// nessun accesso pubblico/anonimo ancora — vedi memoria di progetto per
// il perché (le firestore.rules sono il vero confine di sicurezza, non
// l'URL). Nessun pagamento in questa fase: la prenotazione si conferma
// subito alla pressione di "Prenota"; il collegamento a PostFinance
// Checkout arriva in una fase successiva.
//
// Logica anti-buchi confermata (vedi mockup validato):
// - fino alle 17:00: inizi ogni 30', validi solo se non lasciano un buco
//   riutilizzabile < 60' prima del prossimo impegno
// - dalle 17:00: blocchi da 90' incatenati subito dopo l'ultimo impegno
//   (non su una griglia fissa assoluta) — se un'occupazione finisce es.
//   alle 18:00, il prossimo slot proposto è 18:00, non il successivo
//   multiplo di 90' da 17:00
//
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

let currentProfile = null;

const OPEN = 8 * 60;       // 08:00
const CLOSE = 23 * 60;     // 23:00
const BOUNDARY = 17 * 60;  // 17:00 — 6h fino alla chiusura = esattamente 4 blocchi da 90', zero buchi residui
const PX_PER_MIN = 1.1;    // 60' = 66px, 90' = 99px: comodo da toccare su mobile
const EDGE_PAD = 10;       // margine sopra/sotto perché le etichette 08:00 e 23:00 non debordino dalla card
const GIORNI_BREVI = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"]; // Date.getDay(): 0=Dom
const NR_GIORNI_STRIP = 14;

let state = { data: null, duration: null, selected: null, bookings: [] };
let bookingsUnsub = null;

function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function px(min) { return (min - OPEN) * PX_PER_MIN + EDGE_PAD; }
function label(min) { return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); }
function orarioToMin(orario) {
  const [h, m] = orario.split(":").map(Number);
  return h * 60 + m;
}

// ---------- Logica anti-buchi (invariata dal mockup validato) ----------

function freeIntervals(bookings) {
  const sorted = [...bookings].sort((a, b) => a.start - b.start);
  const free = [];
  let cursor = OPEN;
  sorted.forEach(b => {
    if (b.start > cursor) free.push([cursor, b.start]);
    cursor = Math.max(cursor, b.end);
  });
  if (cursor < CLOSE) free.push([cursor, CLOSE]);
  return free;
}

function slotsInInterval(a, b, duration) {
  const starts = [];
  if (duration === 90) {
    for (let t = a; t < BOUNDARY && t + 90 <= b; t += 30) {
      const remain = b - (t + 90);
      if (remain === 0 || remain >= 60) starts.push(t);
    }
    for (let t = Math.max(a, BOUNDARY); t + 90 <= b; t += 90) {
      starts.push(t);
    }
  } else {
    const limit = Math.min(b, BOUNDARY);
    for (let t = a; t + 60 <= limit; t += 30) {
      const remain = limit - (t + 60);
      if (remain === 0 || remain >= 60) starts.push(t);
    }
  }
  return starts;
}

function validStarts(bookings, duration) {
  const free = freeIntervals(bookings);
  let starts = [];
  free.forEach(([a, b]) => { starts = starts.concat(slotsInInterval(a, b, duration)); });
  return [...new Set(starts)].sort((x, y) => x - y);
}

// ---------- Day strip ----------

function buildDayStrip() {
  const el = document.getElementById("dayStrip");
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);

  const giorni = [];
  for (let i = 0; i < NR_GIORNI_STRIP; i++) {
    const d = new Date(oggi);
    d.setDate(oggi.getDate() + i);
    giorni.push(d);
  }

  el.innerHTML = giorni.map(d => {
    const iso = toISO(d);
    return `
      <button type="button" class="day-btn" role="tab" data-data="${iso}" aria-pressed="${iso === state.data}">
        <span class="d">${GIORNI_BREVI[d.getDay()]}</span>
        <span class="n">${d.getDate()}</span>
      </button>
    `;
  }).join("");

  el.querySelectorAll(".day-btn").forEach(btn => {
    btn.addEventListener("click", () => selezionaGiorno(btn.dataset.data));
  });
}

function selezionaGiorno(dataIso) {
  state.data = dataIso;
  state.selected = null;
  document.querySelectorAll(".day-btn").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.data === dataIso));
  });
  ascoltaPrenotazioniGiorno();
}

// ---------- Dati Firestore ----------

function ascoltaPrenotazioniGiorno() {
  if (bookingsUnsub) bookingsUnsub();

  bookingsUnsub = db.collection("prenotazioniPadel")
    .where("data", "==", state.data)
    .onSnapshot(
      (snap) => {
        state.bookings = snap.docs.map(d => {
          const p = d.data();
          return { id: d.id, userId: p.userId, start: orarioToMin(p.oraInizio), end: orarioToMin(p.oraFine), label: p.userNome || "Prenotato" };
        });
        render();
      },
      (err) => {
        showError(document.getElementById("tabellone-error"), "Errore nel caricamento: " + err.message);
      }
    );
}

async function prenotaSlot() {
  if (!state.selected || !state.duration) return;
  const btn = document.getElementById("summaryCta");
  const errorEl = document.getElementById("tabellone-error");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Prenotazione…";

  try {
    await db.collection("prenotazioniPadel").add({
      data: state.data,
      oraInizio: label(state.selected.start),
      oraFine: label(state.selected.end),
      durataMinuti: state.duration,
      userId: currentProfile.uid,
      userNome: currentProfile.nome,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    state.selected = null;
    state.duration = null;
    document.querySelectorAll("#durationSeg button").forEach(b => b.setAttribute("aria-pressed", "false"));
    render();
  } catch (err) {
    showError(errorEl, "Errore nella prenotazione: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Prenota";
  }
}

// ---------- Render griglia ----------

function hourGridHtml() {
  let html = `<div class="gutter-line"></div>`;
  for (let h = 8; h <= 23; h++) {
    const top = px(h * 60);
    html += `<div class="hour-row" style="top:${top}px"></div>
             <div class="hour-label" style="top:${top}px">${pad2(h)}:00</div>`;
    if (h < 23) {
      const halfTop = px(h * 60 + 30);
      html += `<div class="half-row" style="top:${halfTop}px"></div>
               <div class="half-label" style="top:${halfTop}px">${pad2(h)}:30</div>`;
    }
  }
  const bTop = px(BOUNDARY);
  html += `<div class="boundary-line" style="top:${bTop}px"></div>
           <div class="boundary-label" style="top:${bTop}px">17:00 → solo 90'</div>`;
  return html;
}

function render() {
  const timelineEl = document.getElementById("timeline");
  const totalPx = px(CLOSE) + EDGE_PAD;
  timelineEl.style.height = totalPx + "px";

  let html = hourGridHtml();

  const puoGestireTutte = hasPermission(currentProfile, "prenotazioni:gestisci");
  html += state.bookings.map(b => `
    <div class="busy" style="top:${px(b.start)}px;height:${px(b.end) - px(b.start)}px">
      <span class="name">${escapeHtml(b.label)}</span>
      <span class="time">${label(b.start)}–${label(b.end)}</span>
      ${(b.userId === currentProfile.uid || puoGestireTutte) ? `<button type="button" class="delete-booking-btn" data-id="${b.id}" style="align-self:flex-start;background:none;border:none;color:var(--danger);font-size:0.65rem;text-decoration:underline;cursor:pointer;padding:0;">Elimina</button>` : ""}
    </div>
  `).join("");

  if (state.duration) {
    const starts = validStarts(state.bookings, state.duration);
    html += starts.map(s => {
      const end = s + state.duration;
      const isSel = state.selected && state.selected.start === s;
      return `<div class="slot" role="button" tabindex="0" data-selected="${!!isSel}"
                data-start="${s}" data-end="${end}"
                style="top:${px(s)}px;height:${px(end) - px(s)}px"
                aria-label="${label(s)}–${label(end)}">
                <span class="time">${label(s)}–${label(end)}</span>
              </div>`;
    }).join("");
  }

  timelineEl.innerHTML = html;

  timelineEl.querySelectorAll(".delete-booking-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Eliminare questa prenotazione?")) return;
      try {
        await db.collection("prenotazioniPadel").doc(btn.dataset.id).delete();
      } catch (err) {
        showError(document.getElementById("tabellone-error"), "Errore nell'eliminazione: " + err.message);
      }
    });
  });

  timelineEl.querySelectorAll(".slot").forEach(el => {
    const activate = () => {
      state.selected = { start: parseInt(el.dataset.start, 10), end: parseInt(el.dataset.end, 10) };
      render();
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
  });

  const bar = document.getElementById("summaryBar");
  if (state.selected) {
    document.getElementById("summaryTitle").textContent = `${label(state.selected.start)}–${label(state.selected.end)}`;
    bar.classList.add("show");
  } else {
    bar.classList.remove("show");
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  currentProfile = profile;
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  state.data = toISO(new Date());
  buildDayStrip();

  document.querySelectorAll("#durationSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      const dur = parseInt(btn.dataset.dur, 10);
      state.duration = (state.duration === dur) ? null : dur;
      state.selected = null;
      document.querySelectorAll("#durationSeg button").forEach(b =>
        b.setAttribute("aria-pressed", String(parseInt(b.dataset.dur, 10) === state.duration))
      );
      render();
    });
  });

  document.getElementById("summaryCta").addEventListener("click", prenotaSlot);

  ascoltaPrenotazioniGiorno();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
