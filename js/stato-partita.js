// ============================================================
// stato-partita.js — pagina pubblica di sola consultazione per una
// proposta di sessione Community Padel: chi ha aderito, chi manca, e
// quanto deve pagare ciascuno (per la propria categoria reale, come la
// ripartizione già esistente per le prenotazioni dirette). Nessun login
// obbligatorio: conoscere l'id della sessione (nel link ?s=) è di per sé
// l'autorizzazione a leggerla, stesso principio già usato per
// bookingTickets/attivazioniSoci (vedi la Cloud Function statoSessionePadel
// e firestore.rules).
//
// Live: un listener Firestore sul documento sessioniPadel (pubblico in
// lettura) fa ripartire il calcolo quota via Cloud Function ad ogni
// cambiamento — il calcolo va per forza lato server perché richiede di
// leggere "soci" (mai accessibile dal client).
//
// Organizzatore: se chi apre questa pagina è ancora autenticato con la
// stessa sessione con cui ha lanciato la proposta (la persistenza di
// Firebase Auth la mantiene tra le pagine dello stesso dispositivo),
// statoSessionePadel lo riconosce da solo (isOrganizzatore nella
// risposta) e sblocca "Condividi" + l'aggiunta di un invitato a mano —
// nessun parametro nell'URL, nessuna finestra di login: o è già lui, o
// niente. Le funzioni che scrivono (aggiungiInvitatoSessionePadel)
// riverificano comunque l'identità lato server, questo flag è solo per
// decidere cosa mostrare.
//
// Richiede firebase-config.js e utils.js già caricati.
// ============================================================

const STATO_SESSIONE_LABEL = { aperta: "In attesa di conferme", confermata: "Confermata", scaduta: "Scaduta", annullata: "Annullata" };

function mostraStato(id) {
  ["stato-caricamento", "stato-errore", "stato-content"].forEach(s => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function formatoQuota(q) {
  return q != null ? `CHF ${Number(q).toFixed(2)}` : "—";
}

function formatoOraScadenza(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Attende il primo esito di onAuthStateChanged (l'SDK Firebase Auth
// risolve la persistenza in modo asincrono) — senza aspettarlo, la prima
// chiamata a statoSessionePadel partirebbe senza request.auth anche per
// l'organizzatore stesso, e isOrganizzatore risulterebbe erroneamente
// falso finché non arriva un secondo aggiornamento.
function attendiAuthPronta() {
  return new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(user => { unsub(); resolve(user); });
  });
}

function linkInvito(token) {
  return `${location.origin}/giocatori-padel.html?invito=${token}`;
}

async function aggiornaStato(sessioneId) {
  try {
    const fn = cloudFunctions().httpsCallable("statoSessionePadel");
    const { data } = await fn({ sessioneId });

    const scadenzaTxt = data.scadenzaAt
      ? ` — si libera automaticamente alle ${formatoOraScadenza(data.scadenzaAt)} se non confermata`
      : "";
    document.getElementById("stato-countdown").innerHTML = `
      <div class="entry-meta">Stato: ${escapeHtml(STATO_SESSIONE_LABEL[data.stato] || data.stato)}${escapeHtml(scadenzaTxt)}</div>
    `;

    document.getElementById("stato-riepilogo").innerHTML = `
      <div class="entry-tipo">${escapeHtml(data.organizzatore.pseudonimo)} propone</div>
      <div class="entry-meta">Disciplina: ${escapeHtml(data.disciplina)}</div>
      <div class="entry-meta">Data: ${escapeHtml(data.date)}</div>
      <div class="entry-meta">Ora: ${escapeHtml(data.startTime)}–${escapeHtml(data.endTime)}</div>
      <div class="entry-meta">Luogo: ${escapeHtml(data.luogo)}</div>
      <div class="entry-meta" style="margin-top:6px;font-family:'Space Mono',monospace;">Costo campo: ${formatoQuota(data.costoCampoTotale)} — quota a testa: ${formatoQuota(data.organizzatore.quota)}</div>
    `;

    document.getElementById("stato-confermati").innerHTML = data.confermati.map((c, idx) => `
      <div class="gp-classifica-row">
        <span>${idx + 1}. ${escapeHtml(c.pseudonimo)}</span>
        <span class="livello">${formatoQuota(c.quota)}</span>
      </div>
    `).join("");

    document.getElementById("stato-in-attesa").innerHTML = data.inAttesa.length > 0
      ? `<p style="color:var(--chalk-grey);font-size:0.8rem;margin:0 0 8px;">Richiesta inviata, in attesa di risposta a:</p>`
        + data.inAttesa.map(c => `<div class="gp-classifica-row"><span>… ${escapeHtml(c.pseudonimo)}</span></div>`).join("")
      : `<p style="color:var(--chalk-grey);font-size:0.84rem;">Nessuno in attesa.</p>`;

    const condividiEl = document.getElementById("stato-condividi");
    if (data.isOrganizzatore) {
      const statoLinkUrl = `${location.origin}/stato-partita.html?s=${encodeURIComponent(sessioneId)}`;
      const rigaLinkAperto = data.tokenAperto ? `
        <div class="gp-invito-riga">
          <span>Link aperto — per chiunque, primo arrivato primo servito</span>
          <span>
            <button type="button" class="btn btn-ghost condividi-copia-btn" data-link="${escapeHtml(linkInvito(data.tokenAperto))}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Copia link</button>
            <a href="https://wa.me/?text=${encodeURIComponent(linkInvito(data.tokenAperto))}" target="_blank" rel="noopener" class="btn btn-ghost" style="width:auto;padding:6px 10px;font-size:0.7rem;display:inline-block;">WhatsApp</a>
          </span>
        </div>
      ` : "";
      condividiEl.innerHTML = `
        <div class="gp-card">
          ${data.stato === "aperta" ? `
            <p style="margin:0 0 8px;"><strong>Aggiungi un invitato</strong></p>
            <p style="color:var(--chalk-grey);font-size:0.78rem;margin:0 0 8px;">Conosci qualcuno che vuoi invitare al volo? Scrivi il suo nome, genero un link personale da inoltrargli tu.</p>
            <div class="gp-invito-riga" style="gap:8px;">
              <input type="text" id="aggiungi-invitato-nome" maxlength="40" placeholder="Nome" style="flex:1;">
              <button type="button" class="btn btn-ghost" id="aggiungi-invitato-btn" style="width:auto;padding:8px 14px;">Aggiungi</button>
            </div>
            <div class="error-msg" id="aggiungi-invitato-error"></div>
            <div id="aggiungi-invitato-esito"></div>
          ` : ""}
          <p style="margin:16px 0 10px;"><strong>Condividi</strong></p>
          ${rigaLinkAperto}
          <div class="gp-invito-riga">
            <span>Questa pagina di stato — chi ha aderito e quanto si paga, sempre aggiornata</span>
            <span>
              <button type="button" class="btn btn-ghost condividi-copia-btn" data-link="${escapeHtml(statoLinkUrl)}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Copia link</button>
              <a href="https://wa.me/?text=${encodeURIComponent(statoLinkUrl)}" target="_blank" rel="noopener" class="btn btn-ghost" style="width:auto;padding:6px 10px;font-size:0.7rem;display:inline-block;">WhatsApp</a>
            </span>
          </div>
        </div>
      `;
      condividiEl.querySelectorAll(".condividi-copia-btn").forEach(b => b.addEventListener("click", () => copyToClipboard(b.dataset.link, b)));
      const aggiungiBtn = document.getElementById("aggiungi-invitato-btn");
      if (aggiungiBtn) aggiungiBtn.addEventListener("click", () => aggiungiInvitato(sessioneId));
      condividiEl.classList.remove("hidden");
    } else {
      condividiEl.classList.add("hidden");
    }

    const partecipaEl = document.getElementById("stato-partecipa");
    if (data.tokenAperto) {
      partecipaEl.innerHTML = `
        <div class="gp-card" style="text-align:center;">
          <p style="margin:0 0 10px;">Vuoi partecipare a questa partita?</p>
          <a class="btn btn-primary" href="giocatori-padel.html?invito=${encodeURIComponent(data.tokenAperto)}">Rispondi qui</a>
        </div>
      `;
      partecipaEl.classList.remove("hidden");
    } else {
      partecipaEl.classList.add("hidden");
    }

    mostraStato("stato-content");
  } catch (err) {
    document.getElementById("stato-errore-testo").textContent = err.message || "Il link non è valido.";
    mostraStato("stato-errore");
  }
}

async function aggiungiInvitato(sessioneId) {
  const input = document.getElementById("aggiungi-invitato-nome");
  const btn = document.getElementById("aggiungi-invitato-btn");
  const errorEl = document.getElementById("aggiungi-invitato-error");
  const esitoEl = document.getElementById("aggiungi-invitato-esito");
  errorEl.textContent = "";
  const nome = input.value.trim();
  if (nome.length < 2) {
    showError(errorEl, "Inserisci un nome.");
    return;
  }

  btn.disabled = true;
  try {
    const fn = cloudFunctions().httpsCallable("aggiungiInvitatoSessionePadel");
    const { data } = await fn({ sessioneId, nome });
    input.value = "";
    esitoEl.innerHTML = `
      <div class="gp-invito-riga" style="margin-top:8px;">
        <span>Link per ${escapeHtml(nome)}</span>
        <span>
          <button type="button" class="btn btn-ghost condividi-copia-btn" data-link="${escapeHtml(data.link)}" style="width:auto;padding:6px 10px;font-size:0.7rem;">Copia link</button>
          <a href="https://wa.me/?text=${encodeURIComponent(data.link)}" target="_blank" rel="noopener" class="btn btn-ghost" style="width:auto;padding:6px 10px;font-size:0.7rem;display:inline-block;">WhatsApp</a>
        </span>
      </div>
    `;
    esitoEl.querySelectorAll(".condividi-copia-btn").forEach(b => b.addEventListener("click", () => copyToClipboard(b.dataset.link, b)));
  } catch (err) {
    showError(errorEl, "Errore: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

(async function init() {
  await loadDatiCentro();
  document.getElementById("centro-kicker").textContent = DATI_CENTRO.nome;

  const sessioneId = new URLSearchParams(location.search).get("s");
  if (!sessioneId) {
    document.getElementById("stato-errore-testo").textContent = "Link incompleto.";
    mostraStato("stato-errore");
    return;
  }

  await attendiAuthPronta();

  // onSnapshot chiama il callback anche subito con lo stato attuale, non
  // serve un primo aggiornaStato() separato prima di attaccare il listener.
  db.collection("sessioniPadel").doc(sessioneId).onSnapshot(
    () => aggiornaStato(sessioneId),
    () => aggiornaStato(sessioneId) // errore di lettura: lascia che sia la Cloud Function a spiegare perché
  );
})();
