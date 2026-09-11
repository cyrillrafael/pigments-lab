// Admin console: client-side password gate + multi-file upload straight to
// the repo via the GitHub Contents API. There is no backend — the "gate" is
// obscurity (a SHA-256 check anyone could bypass by reading this file), not
// real access control. The actual write boundary is the GitHub token the
// admin pastes in: only someone holding a token with write access to this
// repo can actually commit anything, regardless of the password screen.

const REPO = "cyrillrafael/pigments-lab";
const API = `https://api.github.com/repos/${REPO}/contents/`;

// --- password gate --------------------------------------------------

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function tryUnlock() {
  const pw = document.getElementById("gate-password").value;
  const hash = await sha256Hex(pw);
  const errEl = document.getElementById("gate-error");
  const gate = document.getElementById("gate");
  if (hash === window.ADMIN_PASSWORD_HASH) {
    sessionStorage.setItem("admin-unlocked", "1");
    errEl.textContent = "";
    revealUploadPanel();
    gate.classList.add("unlocking");
    // matches the CSS transition duration + delay (0.55s + 0.12s)
    setTimeout(() => { gate.hidden = true; }, 700);
  } else {
    errEl.textContent = "Wrong password.";
  }
}

function revealUploadPanel() {
  const panel = document.getElementById("upload-panel");
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("visible"));
  populateResidencies();
}

function checkExistingUnlock() {
  if (sessionStorage.getItem("admin-unlocked") === "1") {
    // already unlocked this session (e.g. page reload) — skip the animation
    document.getElementById("gate").hidden = true;
    revealUploadPanel();
    document.getElementById("upload-panel").classList.add("visible");
  }
}

// --- base64 helpers (UTF-8 safe) --------------------------------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToText(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\- ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

// --- GitHub Contents API ----------------------------------------------

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

async function getFile(path, token) {
  const res = await fetch(API + encodeURIComponent(path).replace(/%2F/g, "/"), {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function putFile(path, base64Content, message, token, sha) {
  const body = { message, content: base64Content, branch: "main" };
  if (sha) body.sha = sha;
  const res = await fetch(API + encodeURIComponent(path).replace(/%2F/g, "/"), {
    method: "PUT",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`PUT ${path} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Read-modify-write on a small JSON manifest. If another upload racing the
// same file wins the commit first, the sha we read is now stale and GitHub
// rejects the PUT with 409/422 -- re-read and retry once rather than
// silently losing this entry (the image file itself is already committed
// by this point, so losing the manifest entry would orphan it from the
// gallery/reports list).
async function appendToManifest(manifestPath, entry, token, attempt = 0) {
  const existing = await getFile(manifestPath, token);
  let list = [];
  let sha;
  if (existing) {
    list = JSON.parse(base64ToText(existing.content));
    sha = existing.sha;
  }
  list.push(entry);
  const newContent = textToBase64(JSON.stringify(list, null, 2) + "\n");
  try {
    await putFile(manifestPath, newContent, `Add ${entry.file} to ${manifestPath}`, token, sha);
  } catch (e) {
    if ((e.status === 409 || e.status === 422) && attempt < 2) {
      return appendToManifest(manifestPath, entry, token, attempt + 1);
    }
    throw e;
  }
}

async function ensureResidency(slug, label, token) {
  if (!slug) return;
  const existing = await getFile("_data/residencies.json", token);
  let list = existing ? JSON.parse(base64ToText(existing.content)) : [];
  if (list.some(r => r.slug === slug)) return;
  list.push({ slug, label: label || slug, place: "", year: new Date().getFullYear() });
  const newContent = textToBase64(JSON.stringify(list, null, 2) + "\n");
  await putFile("_data/residencies.json", newContent, `Add residency: ${label || slug}`, token, existing && existing.sha);
}

// --- residency dropdown -------------------------------------------------

function populateResidencies() {
  // window.RESIDENCIES is embedded at build time by admin.md (site.data.residencies
  // isn't a served file — _data/*.json is Jekyll-internal only), so this list
  // reflects residencies as of the last deploy. A residency added in the upload
  // form just now won't appear here until the site rebuilds.
  const sel = document.getElementById("residency-select");
  if (sel.dataset.populated) return;
  for (const r of window.RESIDENCIES || []) {
    const opt = document.createElement("option");
    opt.value = r.slug;
    opt.textContent = r.year ? `${r.label} (${r.year})` : r.label;
    sel.appendChild(opt);
  }
  sel.dataset.populated = "1";
}

// --- upload submit -------------------------------------------------------

async function submitUpload(evt) {
  evt.preventDefault();
  const token = document.getElementById("gh-token").value.trim();
  const category = document.getElementById("category-select").value;
  let residencySlug = document.getElementById("residency-select").value;
  const newResidency = document.getElementById("new-residency").value.trim();
  const caption = document.getElementById("caption").value.trim();
  const files = document.getElementById("file-input").files;
  const statusEl = document.getElementById("upload-status");

  if (!token) { statusEl.textContent = "Paste a GitHub token first."; return; }
  if (!files.length) { statusEl.textContent = "Pick at least one file."; return; }

  if (newResidency) {
    residencySlug = slugify(newResidency);
    statusEl.textContent = "Registering new residency…";
    try {
      await ensureResidency(residencySlug, newResidency, token);
    } catch (e) {
      statusEl.textContent = "Failed to register residency: " + e.message;
      return;
    }
  }

  const manifestPath = `_data/${category}.json`;
  const folder = category === "reports" ? "reports" : category;
  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    statusEl.textContent = `Uploading ${i + 1}/${files.length}: ${file.name}…`;
    try {
      const base64 = await fileToBase64(file);
      const stamp = Date.now() + "-" + i;
      const filename = `${today}-${stamp}-${slugify(file.name)}`;
      await putFile(`${folder}/${filename}`, base64, `Add ${filename} (${category})`, token);
      await appendToManifest(manifestPath, {
        file: filename,
        title: file.name,
        caption: caption || null,
        residency: residencySlug || "general",
        date: today,
      }, token);
      results.push(`✓ ${file.name}`);
    } catch (e) {
      results.push(`✗ ${file.name}: ${e.message}`);
    }
    statusEl.textContent = results.join("\n");
  }

  statusEl.textContent = results.join("\n") + "\n\nDone. The site will rebuild in a minute or two.";
}

document.addEventListener("DOMContentLoaded", () => {
  checkExistingUnlock();
  document.getElementById("gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    tryUnlock();
  });
  document.getElementById("upload-form").addEventListener("submit", submitUpload);
});
