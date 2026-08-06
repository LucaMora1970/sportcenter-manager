// ============================================================
// utils.js — costanti e helper condivisi tra le pagine
// ============================================================

const DISCIPLINE = [
  { id: "tennis", label: "Tennis" },
  { id: "padel", label: "Padel" },
  { id: "squash", label: "Squash" }
];

function disciplinaLabel(id) {
  return (DISCIPLINE.find(d => d.id === id) || {}).label || id;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function populateSelect(selectEl, options, placeholder) {
  const placeholderOpt = placeholder !== undefined ? `<option value="">${placeholder}</option>` : "";
  selectEl.innerHTML = placeholderOpt + options.map(o => `<option value="${o.id}">${o.label}</option>`).join("");
}
