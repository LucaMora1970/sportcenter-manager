// ============================================================
// guida.js — guida amministratore, pagina di sola lettura.
// Nessun dato da caricare: solo verifica accesso (stesso permesso
// di Configurazione, dato che documenta le sue stesse sezioni).
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

requireAuth(async (profile) => {
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");

  if (!hasPermission(profile, "config:gestisci")) {
    document.getElementById("access-denied").classList.remove("hidden");
    document.getElementById("guida-content").classList.add("hidden");
    return;
  }
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
