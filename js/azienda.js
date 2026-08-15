// ============================================================
// azienda.js — portale self-service per il referente di un'azienda
// convenzionata: gestione dipendenti (aggiunta/disattivazione/tetto
// personalizzato) e consumo mensile. Nessun dato letto direttamente da
// Firestore lato client (la collection "soci" resta bloccata come per
// tutto il resto dell'app) — tutto passa dalle Cloud Function dedicate
// (functions/index.js, sezione "Aziende convenzionate: portale
// referente"), che verificano ambito e permesso lato server.
// Richiede firebase-config.js, utils.js, auth.js già caricati.
// ============================================================

let datiAzienda = null; // ultima risposta di listaSociAzienda

function pad2(n) { return String(n).padStart(2, "0"); }
function toISO(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }

function formatCHF(n) {
  return `CHF ${Number(n || 0).toFixed(2)}`;
}

function barraConsumo(consumato, tetto) {
  if (tetto == null) return `<p style="color:var(--chalk-grey);font-size:0.82rem;">${formatCHF(consumato)} consumati — nessun tetto impostato.</p>`;
  const pct = Math.min(100, Math.round((consumato / tetto) * 100));
  const sopra = consumato > tetto;
  return `
    <p style="color:var(--chalk-grey);font-size:0.82rem;margin-bottom:4px;">${formatCHF(consumato)} su ${formatCHF(tetto)} questo mese${sopra ? " — tetto superato, tariffa esterno applicata oltre il limite" : ""}</p>
    <div style="background:var(--court-blue-700);border-radius:6px;height:8px;overflow:hidden;">
      <div style="width:${pct}%;height:100%;background:${sopra ? "var(--danger)" : "var(--ball)"};"></div>
    </div>
  `;
}

const STATO_ADDEBITO_LABEL = { IN_CORSO: "in corso", PAGATO: "pagato", FALLITO: "fallito" };

function renderCartaStato() {
  const el = document.getElementById("carta-stato");
  const stato = datiAzienda.azienda.tokenStato;
  const ultimo = datiAzienda.azienda.ultimoAddebito;
  const ultimoHtml = ultimo
    ? `<p style="color:var(--chalk-grey);font-size:0.8rem;margin-top:8px;">Ultimo addebito: ${escapeHtml(ultimo.dal)} → ${escapeHtml(ultimo.al)}, ${formatCHF(ultimo.importo)} — ${STATO_ADDEBITO_LABEL[ultimo.stato] || ultimo.stato}</p>`
    : "";

  if (stato === "ATTIVO") {
    el.innerHTML = `
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-tipo">Carta salvata</div>
          <div class="entry-meta">Puoi addebitare quanto dovuto direttamente dal report qui sotto.${ultimoHtml}</div>
        </div>
        <button type="button" class="btn btn-ghost" id="rimuovi-carta-btn" style="width:auto;flex-shrink:0;">Rimuovi carta</button>
      </div>
    `;
    document.getElementById("rimuovi-carta-btn").addEventListener("click", onRimuoviCarta);
    return;
  }

  const messaggio = stato === "PENDING" ? "Salvataggio in corso — se hai appena completato la verifica, ricarica la pagina tra qualche secondo."
    : stato === "FALLITO" ? "L'ultimo tentativo di salvataggio carta non è riuscito. Riprova."
    : "Nessuna carta salvata.";
  el.innerHTML = `
    <div class="entry-card">
      <div class="entry-main">
        <div class="entry-tipo">${messaggio}</div>
        <div class="entry-meta">Facoltativo — senza carta salvata potrete comunque saldare quanto dovuto in altro modo.${ultimoHtml}</div>
      </div>
      <button type="button" class="btn btn-primary" id="salva-carta-btn" style="width:auto;">Salva carta</button>
    </div>
  `;
  document.getElementById("salva-carta-btn").addEventListener("click", onSalvaCarta);
}

async function onSalvaCarta() {
  const btn = document.getElementById("salva-carta-btn");
  const errorEl = document.getElementById("carta-error");
  errorEl.textContent = "";
  btn.disabled = true;
  try {
    const fn = firebase.functions().httpsCallable("avviaTokenizzazioneAzienda");
    const { data } = await fn();
    window.location.href = data.paymentPageUrl;
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onRimuoviCarta() {
  const btn = document.getElementById("rimuovi-carta-btn");
  const errorEl = document.getElementById("carta-error");
  errorEl.textContent = "";
  btn.disabled = true;
  try {
    const fn = firebase.functions().httpsCallable("eliminaTokenAzienda");
    await fn();
    await caricaDatiAzienda();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function caricaDatiAzienda() {
  const riepilogoEl = document.getElementById("riepilogo-azienda");
  const listEl = document.getElementById("dipendenti-list");
  try {
    const fn = firebase.functions().httpsCallable("listaSociAzienda");
    const { data } = await fn();
    datiAzienda = data;

    document.getElementById("azienda-titolo").textContent = data.azienda.nome;
    riepilogoEl.innerHTML = barraConsumo(data.consumoTotaleAzienda, data.azienda.tettoMensileAzienda);
    renderCartaStato();

    if (data.dipendenti.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="display">Nessun dipendente</div><p>Aggiungine uno dal form qui sotto.</p></div>`;
      return;
    }
    listEl.innerHTML = data.dipendenti.map(d => {
      const tetto = d.tettoPersonalizzato ?? data.azienda.tettoDefaultPerUtente;
      return `
      <div class="entry-card" data-id="${d.id}">
        <div class="entry-main">
          <div class="entry-tipo">${escapeHtml(d.nome)} ${escapeHtml(d.cognome)}</div>
          <div class="entry-meta">${barraConsumo(d.consumoMese, tetto)}</div>
          <div class="team-card-row" style="margin-top:8px;">
            <input type="number" class="dipendente-tetto-input" min="0" step="1" placeholder="Tetto personalizzato (CHF)" value="${d.tettoPersonalizzato != null ? d.tettoPersonalizzato : ""}" data-id="${d.id}">
            <button class="btn btn-ghost salva-tetto-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;flex-shrink:0;" data-id="${d.id}">Salva</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="btn btn-ghost toggle-dipendente-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;flex-shrink:0;" data-id="${d.id}" data-attivo="${d.attivo}">
            ${d.attivo ? "Disattiva" : "Riattiva"}
          </button>
          <button class="btn btn-danger elimina-dipendente-btn" style="width:auto;padding:8px 12px;font-size:0.7rem;flex-shrink:0;" data-id="${d.id}" data-nome="${escapeHtml(d.nome)} ${escapeHtml(d.cognome)}">
            Elimina
          </button>
        </div>
      </div>
    `;
    }).join("");

    listEl.querySelectorAll(".salva-tetto-btn").forEach(btn => btn.addEventListener("click", onSalvaTetto));
    listEl.querySelectorAll(".toggle-dipendente-btn").forEach(btn => btn.addEventListener("click", onToggleDipendente));
    listEl.querySelectorAll(".elimina-dipendente-btn").forEach(btn => btn.addEventListener("click", onEliminaDipendente));
  } catch (err) {
    showError(document.getElementById("dipendenti-error"), "Errore: " + err.message);
  }
}

async function onSalvaTetto(e) {
  const btn = e.currentTarget;
  const socioId = btn.dataset.id;
  const input = document.querySelector(`.dipendente-tetto-input[data-id="${socioId}"]`);
  btn.disabled = true;
  try {
    const fn = firebase.functions().httpsCallable("impostaTettoDipendenteAzienda");
    await fn({ socioId, tetto: input.value !== "" ? input.value : null });
    await caricaDatiAzienda();
  } catch (err) {
    showError(document.getElementById("dipendenti-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onEliminaDipendente(e) {
  const btn = e.currentTarget;
  const socioId = btn.dataset.id;
  const nome = btn.dataset.nome;
  if (!confirm(`Eliminare definitivamente "${nome}"? Verranno cancellati il profilo e l'eventuale accesso già attivato — non è reversibile.`)) return;
  btn.disabled = true;
  btn.textContent = "Elimino…";
  try {
    const fn = firebase.functions().httpsCallable("eliminaDipendenteAzienda");
    await fn({ socioId });
    await caricaDatiAzienda();
  } catch (err) {
    showError(document.getElementById("dipendenti-error"), "Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Elimina";
  }
}

async function onToggleDipendente(e) {
  const btn = e.currentTarget;
  const socioId = btn.dataset.id;
  const nuovoStato = btn.dataset.attivo !== "true";
  btn.disabled = true;
  try {
    const fn = firebase.functions().httpsCallable("disattivaDipendenteAzienda");
    await fn({ socioId, attivo: nuovoStato });
    await caricaDatiAzienda();
  } catch (err) {
    showError(document.getElementById("dipendenti-error"), "Errore: " + err.message);
    btn.disabled = false;
  }
}

async function onCreateDipendente(e) {
  e.preventDefault();
  const btn = document.getElementById("create-dipendente-btn");
  const errorEl = document.getElementById("new-dipendente-error");
  errorEl.textContent = "";
  btn.disabled = true;

  const nome = document.getElementById("new-dipendente-nome").value.trim();
  const cognome = document.getElementById("new-dipendente-cognome").value.trim();
  const email = document.getElementById("new-dipendente-email").value.trim();

  try {
    const fn = firebase.functions().httpsCallable("aggiungiDipendenteAzienda");
    const { data } = await fn({ nome, cognome, email });

    const url = `${basePageUrl()}attiva-socio.html?t=${data.token}`;
    const container = document.getElementById("nuovo-dipendente-qr-container");
    container.innerHTML = "";
    new QRCode(container, {
      text: url, width: 200, height: 200,
      colorDark: "#0d1f30", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M
    });
    document.getElementById("nuovo-dipendente-qr-nome").textContent = `${nome} ${cognome} — fai scansionare questo QR (o invia il link) per collegare il suo dispositivo`;
    document.getElementById("nuovo-dipendente-qr-link").textContent = url;
    document.getElementById("nuovo-dipendente-qr-box").classList.remove("hidden");

    const inviaBox = document.getElementById("nuovo-dipendente-invia-box");
    const inviaBtn = document.getElementById("invia-link-dipendente-btn");
    if (email) {
      inviaBox.classList.remove("hidden");
      inviaBtn.disabled = false;
      inviaBtn.textContent = "Invia link via email";
      inviaBtn.style.color = "";
      inviaBtn.onclick = () => onInviaLinkDipendente(data.socioId, email, inviaBtn);
    } else {
      inviaBox.classList.add("hidden");
    }

    document.getElementById("new-dipendente-form").reset();
    await caricaDatiAzienda();
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Bottone separato (non invio automatico alla creazione) così un
// fallimento SMTP è sempre visibile qui, invece di perdersi in silenzio —
// stesso schema già usato per "Invia invito" al referente in Configurazione.
async function onInviaLinkDipendente(socioId, email, btn) {
  const errorEl = document.getElementById("new-dipendente-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Invio…";
  btn.style.color = "";
  try {
    const fn = firebase.functions().httpsCallable("inviaInvitoDipendente");
    await fn({ socioId });
    btn.textContent = `✓ Inviato a ${email}`;
    btn.style.color = "var(--ball)";
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.textContent = "Invia link via email";
  } finally {
    btn.disabled = false;
  }
}

let ultimoReport = null; // { dal, al, totale } — per il bottone "Addebita"

async function onGeneraReport() {
  const btn = document.getElementById("genera-report-btn");
  const errorEl = document.getElementById("report-error");
  const risultatoEl = document.getElementById("report-risultato");
  errorEl.textContent = "";
  const dal = document.getElementById("report-dal").value;
  const al = document.getElementById("report-al").value;
  if (!dal || !al) { showError(errorEl, "Seleziona l'intervallo di date."); return; }

  btn.disabled = true;
  risultatoEl.innerHTML = `<div class="empty-state"><div class="display">Calcolo…</div></div>`;
  try {
    const fn = firebase.functions().httpsCallable("reportAzienda");
    const { data } = await fn({ dal, al });
    ultimoReport = { dal, al, totale: data.totale };

    const addebitaHtml = datiAzienda.azienda.tokenStato === "ATTIVO" && data.totale > 0
      ? `<button type="button" class="btn btn-primary" id="addebita-btn" style="margin-bottom:14px;">Addebita ${formatCHF(data.totale)} alla carta registrata</button>`
      : "";

    if (data.righe.length === 0) {
      risultatoEl.innerHTML = `<div class="empty-state"><div class="display">Nessuna prenotazione nel periodo</div></div>`;
    } else {
      risultatoEl.innerHTML = `
        <p style="color:var(--chalk-grey);font-size:0.85rem;margin-bottom:10px;">Totale periodo: <strong style="color:var(--line-white);">${formatCHF(data.totale)}</strong></p>
        ${addebitaHtml}
        ${data.righe.map(r => `
          <div class="entry-card">
            <div class="entry-main">
              <div class="entry-tipo">${escapeHtml(r.nome)}</div>
              <div class="entry-meta">${r.prenotazioni} prenotazion${r.prenotazioni === 1 ? "e" : "i"}</div>
            </div>
            <span class="entry-ore">${formatCHF(r.totale)}</span>
          </div>
        `).join("")}
      `;
    }
    const addebitaBtn = document.getElementById("addebita-btn");
    if (addebitaBtn) addebitaBtn.addEventListener("click", onAddebita);
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    risultatoEl.innerHTML = "";
  } finally {
    btn.disabled = false;
  }
}

async function onAddebita() {
  const btn = document.getElementById("addebita-btn");
  const errorEl = document.getElementById("report-error");
  errorEl.textContent = "";
  if (!ultimoReport) return;
  btn.disabled = true;
  btn.textContent = "Addebito in corso…";
  try {
    const fn = firebase.functions().httpsCallable("addebitaAzienda");
    const { data } = await fn({ dal: ultimoReport.dal, al: ultimoReport.al });
    if (!data.addebitato) {
      showError(errorEl, data.motivo || "Addebito non riuscito.");
    } else {
      btn.textContent = "Addebito avviato — controlla lo stato qui sotto tra poco";
      await caricaDatiAzienda();
    }
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
    btn.disabled = false;
    btn.textContent = "Riprova ad addebitare";
  }
}

// ---------- Init ----------

requireAuth(async (profile) => {
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "azienda:propria")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("azienda-content").classList.add("hidden");
    return;
  }
  document.getElementById("azienda-content").classList.remove("hidden");

  if (new URLSearchParams(location.search).get("tokenizzazione")) {
    history.replaceState(null, "", location.pathname);
  }

  document.getElementById("new-dipendente-form").addEventListener("submit", onCreateDipendente);
  document.getElementById("genera-report-btn").addEventListener("click", onGeneraReport);

  const oggi = toISO(new Date());
  document.getElementById("report-dal").value = oggi.slice(0, 7) + "-01";
  document.getElementById("report-al").value = oggi;

  await caricaDatiAzienda();
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
