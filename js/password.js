// ============================================================
// password.js — permette a qualsiasi utente loggato di cambiare
// la propria password (richiede la password attuale per sicurezza).
// Richiede firebase-config.js, utils.js e auth.js già caricati.
// ============================================================

async function onChangePassword(e) {
  e.preventDefault();
  const btn = document.getElementById("change-password-btn");
  const errorEl = document.getElementById("password-error");
  const successEl = document.getElementById("password-success");
  errorEl.innerHTML = "";
  successEl.classList.add("hidden");

  const currentPassword = document.getElementById("current-password").value;
  const newPassword = document.getElementById("new-password").value;
  const confirmPassword = document.getElementById("confirm-password").value;

  btn.disabled = true;
  btn.textContent = "Aggiornamento…";

  try {
    if (newPassword !== confirmPassword) throw new Error("Le due password non coincidono.");

    const user = auth.currentUser;
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
    await user.reauthenticateWithCredential(credential);
    await user.updatePassword(newPassword);

    document.getElementById("change-password-form").reset();
    successEl.classList.remove("hidden");
  } catch (err) {
    const message = (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential" || err.code === "auth/invalid-login-credentials")
      ? "La password attuale non è corretta."
      : err.message;
    showError(errorEl, message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Aggiorna password";
  }
}

requireAuth((profile) => {
  document.getElementById("user-chip").textContent = profile.nome + (profile.ruoloNome ? " · " + profile.ruoloNome : "");
  document.getElementById("change-password-form").addEventListener("submit", onChangePassword);
});

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  logout();
});
