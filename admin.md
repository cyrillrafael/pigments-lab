---
layout: default
title: Admin
permalink: /admin/
---

<div id="gate" class="gate">
  <div class="iris">
    <div class="seg" data-dir="up-left"></div>
    <div class="seg" data-dir="up"></div>
    <div class="seg" data-dir="up-right"></div>
    <div class="seg" data-dir="left"></div>
    <div class="seg seg-center" data-dir="center">
      <div class="warn-box">
        Not real security — this password check runs in browser
        JavaScript, visible to anyone who views the page source. It keeps
        casual visitors out, not anyone determined. The actual boundary is
        the GitHub token pasted in on the next screen: only someone
        holding a token with write access to this repo can commit
        anything, regardless of this password.
      </div>
      <form id="gate-form" class="gate-form-wrap">
        <input type="password" id="gate-password" placeholder="Password" autocomplete="off" />
        <button type="submit">Enter</button>
        <div class="error" id="gate-error"></div>
      </form>
    </div>
    <div class="seg" data-dir="right"></div>
    <div class="seg" data-dir="down-left"></div>
    <div class="seg" data-dir="down"></div>
    <div class="seg" data-dir="down-right"></div>
  </div>
</div>

<div id="upload-panel" hidden>
  <h3>Upload</h3>
  <form id="upload-form" class="upload-form">
    <label for="gh-token">GitHub token (write access to this repo — not stored anywhere)</label>
    <input type="password" id="gh-token" autocomplete="off" />

    <label for="category-select">Category</label>
    <select id="category-select">
      <option value="pigments">Pigments</option>
      <option value="sketchbooks">Sketchbooks</option>
      <option value="workshop">Workshop</option>
      <option value="reports">Reports &amp; Notes</option>
    </select>

    <label for="residency-select">Residency / journey</label>
    <select id="residency-select"></select>

    <label for="new-residency">…or add a new one (leave blank otherwise)</label>
    <input type="text" id="new-residency" placeholder="e.g. Somewhere 2027" />

    <label for="caption">Caption / note (applies to this whole batch)</label>
    <input type="text" id="caption" placeholder="optional" />

    <label for="file-input">Files</label>
    <input type="file" id="file-input" multiple />

    <button type="submit">Upload</button>
    <div class="upload-status" id="upload-status"></div>
  </form>

  <h3>Studio Assistant</h3>
  <div id="chat-widget">
    <div id="chat-log"></div>
    <form id="chat-form">
      <input type="text" id="chat-input" placeholder="Ask something…" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  </div>

  <h3>Voice Note → Outline</h3>
  <p class="lede">
    Record or upload a voice memo. It's transcribed and turned into a draft
    outline with marked actionables — review and edit before saving; nothing
    is written to the repo until you confirm.
  </p>
  <div id="note-widget">
    <div class="note-controls">
      <button type="button" id="note-record-btn">● Record</button>
      <span id="note-record-time">00:00</span>
      <label for="note-file-input" class="note-upload-label">or upload a file</label>
      <input type="file" id="note-file-input" accept="audio/*" />
    </div>
    <audio id="note-preview" controls hidden></audio>
    <button type="button" id="note-transcribe-btn" disabled>Transcribe &amp; Outline</button>
    <div class="note-status" id="note-status"></div>

    <div id="note-result" hidden>
      <details class="note-transcript-details">
        <summary>Raw transcript</summary>
        <div class="note-transcript" id="note-transcript"></div>
      </details>

      <label for="note-outline">Outline (edit freely — confirm, correct, or argue with it before saving)</label>
      <textarea id="note-outline" rows="14"></textarea>

      <label for="note-title">Title</label>
      <input type="text" id="note-title" placeholder="e.g. 2026-09-11 voice note" />

      <label for="note-residency-select">Residency / journey</label>
      <select id="note-residency-select"></select>

      <button type="button" id="note-save-btn">Save to Reports</button>
      <div class="note-save-status" id="note-save-status"></div>
    </div>
  </div>

  <h3>Systems &amp; Access</h3>
  <p class="lede">
    What's actually deployed, where, and how each piece authenticates —
    not a real key-issuance system, just an honest map so nothing here
    stays tribal knowledge. No secret values are ever shown here, only
    what kind of credential each system needs and where it's held.
  </p>
  <div class="systems-list">
    {% for s in site.data.systems %}
    <div class="system-card">
      <div class="system-name">
        {{ s.name }}
        {%- assign status_word = s.status | split: ' ' | first | downcase -%}
        <span class="system-status system-status-{{ status_word }}">{{ s.status }}</span>
      </div>
      {% if s.url %}<div class="system-url"><a href="{{ s.url }}" target="_blank" rel="noopener">{{ s.url }} ↗</a></div>{% endif %}
      <dl>
        <dt>Repo</dt><dd>{{ s.repo }}</dd>
        <dt>Hosting</dt><dd>{{ s.hosting }}</dd>
        <dt>Deploy</dt><dd>{{ s.deploy }}</dd>
        <dt>Auth</dt><dd>{{ s.auth }}</dd>
      </dl>
    </div>
    {% endfor %}
  </div>
</div>

<script>
  window.ADMIN_PASSWORD_HASH = "ee38c6016327b4ca679404eac16ddc13f037f3ed9b8e6a1f1ea7806d32ac7e33";
  window.RESIDENCIES = {{ site.data.residencies | jsonify }};
</script>
<script src="{{ '/assets/js/admin.js' | relative_url }}"></script>
<script src="{{ '/assets/js/chat-widget.js' | relative_url }}"></script>
<script src="{{ '/assets/js/note-widget.js' | relative_url }}"></script>
