// Voice note -> transcript -> AI outline -> confirm/edit -> save.
// Talks to the same Vercel-hosted proxy as the chat widget (pigments-lab-chat),
// which holds the transcription + Claude credentials server-side. Saving reuses
// the GitHub-commit helpers already defined in admin.js (loaded first on this
// page, so putFile/appendToManifest/ensureResidency/slugify/fileToBase64 are
// already in scope here as plain globals).

const NOTE_API = "https://pigments-lab-chat.vercel.app/api/note";
const NOTE_MAX_BYTES = 4 * 1024 * 1024; // stay clear of the ~4.5MB function payload cap

let mediaRecorder = null;
let recordedChunks = [];
let recordingBlob = null;
let recordTimer = null;
let recordSeconds = 0;

function setNoteStatus(text) {
  document.getElementById("note-status").textContent = text;
}

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

async function toggleRecording() {
  const btn = document.getElementById("note-record-btn");
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      recordingBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recordTimer);
      btn.textContent = "● Record";
      setPreview(recordingBlob);
    };
    mediaRecorder.start();
    btn.textContent = "■ Stop";
    recordSeconds = 0;
    document.getElementById("note-record-time").textContent = "00:00";
    recordTimer = setInterval(() => {
      recordSeconds += 1;
      document.getElementById("note-record-time").textContent = formatTime(recordSeconds);
    }, 1000);
  } catch (e) {
    setNoteStatus(`Couldn't access the microphone (${e.message}). You can still upload a file below.`);
  }
}

function setPreview(blob) {
  const audio = document.getElementById("note-preview");
  audio.src = URL.createObjectURL(blob);
  audio.hidden = false;
  document.getElementById("note-transcribe-btn").disabled = false;
  if (blob.size > NOTE_MAX_BYTES) {
    setNoteStatus(
      `Warning: this recording is ${(blob.size / 1024 / 1024).toFixed(1)}MB, over the ` +
      `~4MB limit this endpoint currently accepts — transcription will likely fail. ` +
      `Try a shorter clip.`
    );
  } else {
    setNoteStatus("");
  }
}

function onFileChosen(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  recordingBlob = file;
  setPreview(file);
}

async function transcribeAndOutline() {
  if (!recordingBlob) return;
  const btn = document.getElementById("note-transcribe-btn");
  btn.disabled = true;
  setNoteStatus("Uploading and transcribing… this can take a little while.");

  try {
    const arrayBuf = await recordingBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const base64 = bytesToBase64(bytes);

    const res = await fetch(NOTE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: base64, mimeType: recordingBlob.type }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${res.status}`);

    document.getElementById("note-transcript").textContent = data.transcript || "(empty)";
    document.getElementById("note-outline").value = data.outline || "";
    document.getElementById("note-result").hidden = false;
    setNoteStatus("Done — review the outline below before saving.");
  } catch (e) {
    setNoteStatus(`Transcription failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function saveNote() {
  const token = document.getElementById("gh-token").value.trim();
  const statusEl = document.getElementById("note-save-status");
  if (!token) {
    statusEl.textContent = "Paste a GitHub token in the Upload section above first.";
    return;
  }
  const title = document.getElementById("note-title").value.trim() || "voice note";
  const outline = document.getElementById("note-outline").value;
  const transcript = document.getElementById("note-transcript").textContent;
  let residency = document.getElementById("note-residency-select").value;

  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  const filename = `${today}-${slug}.md`;
  const body = `# ${title}\n\n_${today}_\n\n## Outline\n\n${outline}\n\n---\n\n## Raw transcript\n\n${transcript}\n`;

  statusEl.textContent = "Saving…";
  try {
    await putFile(`reports/${filename}`, textToBase64(body), `Add voice note: ${title}`, token);
    await appendToManifest(
      "_data/reports.json",
      { file: filename, title, residency: residency || "general", date: today },
      token
    );
    statusEl.textContent = "Saved. The site will rebuild in a minute or two.";
  } catch (e) {
    statusEl.textContent = `Save failed: ${e.message}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("note-record-btn").addEventListener("click", toggleRecording);
  document.getElementById("note-file-input").addEventListener("change", onFileChosen);
  document.getElementById("note-transcribe-btn").addEventListener("click", transcribeAndOutline);
  document.getElementById("note-save-btn").addEventListener("click", saveNote);

  // Reuse the same residency list the upload form populates from.
  const noteSelect = document.getElementById("note-residency-select");
  for (const r of window.RESIDENCIES || []) {
    const opt = document.createElement("option");
    opt.value = r.slug;
    opt.textContent = r.year ? `${r.label} (${r.year})` : r.label;
    noteSelect.appendChild(opt);
  }
});
