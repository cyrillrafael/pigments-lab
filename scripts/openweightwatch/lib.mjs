// Pure helpers for the Open Weight Watch data build.
// Everything here is deterministic and free of I/O so it can be unit-tested
// (see lib.test.mjs); fetch.mjs does the network work and calls into this.

/** Quantisation formats recognised from Hugging Face repo tags. */
export const FORMAT_TAGS = Object.freeze([
  "gguf", "mlx", "awq", "gptq", "fp8", "compressed-tensors",
  "exl2", "exl3", "onnx", "openvino", "bitsandbytes"
]);

/** Derivative relations encoded in `base_model:<relation>:<repo>` tags. */
export const RELATIONS = Object.freeze(["quantized", "finetune", "adapter", "merge"]);

/* ------------------------------------------------------------------ *
 * Licence classes (criteria §2)
 *   osi   L-A  OSI-approved or public-domain dedication
 *   cond  L-B  commercial use for everyone; conditions limited to
 *              attribution, notice or share-alike
 *   restr L-C  use-based restrictions, user thresholds, non-commercial
 *   unk   L-?  unknown / "other" / missing
 * ------------------------------------------------------------------ */
const OSI = new Set([
  "apache-2.0", "mit", "bsd", "bsd-2-clause", "bsd-3-clause", "bsd-3-clause-clear",
  "isc", "mpl-2.0", "gpl", "gpl-2.0", "gpl-3.0", "lgpl", "lgpl-2.1", "lgpl-3.0",
  "lgpl-lr", "agpl-3.0", "artistic-2.0", "ecl-2.0", "afl-3.0", "osl-3.0",
  "epl-1.0", "epl-2.0", "eupl-1.1", "eupl-1.2", "zlib", "unlicense", "cc0-1.0",
  "pddl", "wtfpl", "postgresql", "ms-pl", "ncsa", "bsl-1.0"
]);
const COND = new Set([
  "cc-by-2.0", "cc-by-2.5", "cc-by-3.0", "cc-by-4.0",
  "cc-by-sa-3.0", "cc-by-sa-4.0", "odc-by", "odbl", "cdla-permissive-1.0",
  "cdla-permissive-2.0", "cdla-sharing-1.0"
]);

/**
 * Map a Hugging Face licence identifier to a licence class.
 * @param {string|null|undefined} id
 * @returns {"osi"|"cond"|"restr"|"unk"}
 */
export function licenseClassFromHub(id) {
  if (!id || typeof id !== "string") return "unk";
  const k = id.trim().toLowerCase();
  if (OSI.has(k)) return "osi";
  if (COND.has(k)) return "cond";
  if (k.startsWith("cc-by-nc") || k.startsWith("cc-by-nd") || k.startsWith("llama") ||
      k === "gemma" || k.includes("openrail") || k.includes("rail") ||
      k.startsWith("apple-") || k === "deepfloyd-if-license" || k === "intel-research" ||
      k === "lgpl-lr-nc") {
    return "restr";
  }
  return "unk";
}

/**
 * Extract the licence identifier from Hub model info.
 * Prefers cardData.license, falls back to a `license:<id>` tag.
 */
export function hubLicense(info) {
  const card = info?.cardData?.license;
  const fromCard = Array.isArray(card) ? card[0] : card;
  if (typeof fromCard === "string" && fromCard) return fromCard.toLowerCase();
  const tag = (info?.tags || []).find((t) => typeof t === "string" && t.startsWith("license:"));
  return tag ? tag.slice("license:".length).toLowerCase() : null;
}

/* ------------------------------------------------------------------ *
 * Openness (criteria §3, §4) — shared with the page via the JSON.
 * ------------------------------------------------------------------ */
const LIC_POINTS = { osi: 2, cond: 1, restr: 0, unk: 0 };

export function opennessScore({ cls, code, data, report }) {
  return (LIC_POINTS[cls] ?? 0) + (code === true ? 1 : 0) + (Number.isInteger(data) ? data : 0) + (report === true ? 1 : 0);
}

/** Tier I–IV, first match wins; "—" when the licence is unverified. */
export function tierOf({ cls, code, data }) {
  if (cls === "osi" && code === true && data === 2) return "I";
  if (cls === "osi") return "II";
  if (cls === "cond") return "III";
  if (cls === "restr") return "IV";
  return "—";
}

/** Watercolour-chart transparency code from training-data disclosure. */
export function transparencyOf(data) {
  if (data === 2) return "T";
  if (data === 1) return "ST";
  if (data === 0) return "O";
  return "?";
}

/* ------------------------------------------------------------------ *
 * Derivatives
 * ------------------------------------------------------------------ */

/** Formats present in a repo's tags (lower-cased, de-duplicated, ordered). */
export function formatsFromTags(tags) {
  if (!Array.isArray(tags)) return [];
  const set = new Set(tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase()));
  return FORMAT_TAGS.filter((f) => set.has(f));
}

/**
 * Tally quantised derivatives by format.
 * A repo carrying several format tags counts once towards each.
 * @param {Array<{id:string,downloads?:number,tags?:string[]}>} children
 * @returns {Record<string,{repos:number,downloads:number,top:{id:string,downloads:number}|null}>}
 */
export function tallyFormats(children) {
  const out = {};
  for (const c of children || []) {
    for (const f of formatsFromTags(c.tags)) {
      const slot = (out[f] ??= { repos: 0, downloads: 0, top: null });
      const d = Number.isFinite(c.downloads) ? c.downloads : 0;
      slot.repos += 1;
      slot.downloads += d;
      if (!slot.top || d > slot.top.downloads) slot.top = { id: c.id, downloads: d };
    }
  }
  return out;
}

/** Repo-name markers of quantised or modified repacks that often lack base_model tags. */
const REPACK_ID = /(?:^|[-_.])(gguf|awq|gptq|mlx|exl[23]|bnb|nvfp4|mxfp4|fp8|fp4|int[48]|w4a16|w8a8|[248]-?bit|abliterated|uncensored)(?:$|[-_.])/i;

/** Repo-name markers of auxiliary or intermediate checkpoints (ranked last when resolving). */
const VARIANT_ID = /(?:^|[-_.])(eagle\d*|mtp|draft|sft|dpo|bf16|fp16)(?:$|[-_.])/i;

const repoName = (model) => String(model?.id || "").split("/")[1] || "";

/**
 * True when a repo is a quantised or modified repack, judged by its name.
 * Format tags alone are not enough: official releases often ship natively
 * in FP8 or INT4 and carry the same tags as third-party quantisations.
 */
export function isRepack(model) {
  return REPACK_ID.test(repoName(model));
}

/** True when a repo name marks a repack or an auxiliary/intermediate checkpoint. */
export function isVariant(model) {
  return isRepack(model) || VARIANT_ID.test(repoName(model));
}

/**
 * Discovery rule: keep only first-party releases.
 *   - excluded: repacks (name markers such as -GGUF, -NVFP4, -abliterated);
 *   - excluded: quantisations, adapters and merges of another repo;
 *   - excluded: fine-tunes whose base belongs to a different author.
 */
export function isFirstPartyRelease(model) {
  const author = String(model?.id || "").split("/")[0].toLowerCase();
  if (isRepack(model)) return false;
  for (const t of model?.tags || []) {
    if (typeof t !== "string" || !t.startsWith("base_model:")) continue;
    const parts = t.split(":");
    if (parts.length < 3) continue; // plain `base_model:<repo>` carries no relation
    const [, relation, ...rest] = parts;
    const baseAuthor = rest.join(":").split("/")[0].toLowerCase();
    if (relation === "quantized" || relation === "adapter" || relation === "merge") return false;
    if (relation === "finetune" && baseAuthor !== author) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Mosaics
 * ------------------------------------------------------------------ */

/**
 * Largest-remainder apportionment of `n` tiles across weighted parts.
 * Parts with zero or negative weight receive nothing. Ties break by
 * input order, so the result is stable for stable input.
 * @param {Array<{key:string,weight:number}>} parts
 * @param {number} n
 * @returns {Array<{key:string,tiles:number}>} non-zero allocations, descending
 */
export function apportion(parts, n) {
  const live = parts.filter((p) => Number.isFinite(p.weight) && p.weight > 0);
  const total = live.reduce((s, p) => s + p.weight, 0);
  if (!total || n <= 0) return [];
  const rows = live.map((p, i) => {
    const exact = (p.weight / total) * n;
    return { key: p.key, i, tiles: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = n - rows.reduce((s, r) => s + r.tiles, 0);
  [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i).forEach((r) => { if (left > 0) { r.tiles += 1; left -= 1; } });
  return rows.filter((r) => r.tiles > 0).sort((a, b) => b.tiles - a.tiles || a.i - b.i).map(({ key, tiles }) => ({ key, tiles }));
}

/**
 * Evidence that a runtime uses each pigment, from that runtime's
 * declared formats and/or derivative relations.
 * @returns {Array<{pigment:string, weight:number}>} sorted by weight desc
 */
export function runtimeEvidence(runtime, pigments) {
  const formats = runtime?.evidence?.formats || [];
  const relations = runtime?.evidence?.relations || [];
  const rows = [];
  for (const p of pigments) {
    const der = p?.hub?.derivatives;
    if (!der) continue;
    let w = 0;
    for (const f of formats) w += der.quantized?.formats?.[f]?.repos ?? 0;
    for (const r of relations) w += der[r]?.count ?? 0;
    if (w > 0) rows.push({ pigment: p.id, weight: w });
  }
  return rows.sort((a, b) => b.weight - a.weight || a.pigment.localeCompare(b.pigment));
}

/* ------------------------------------------------------------------ *
 * Time series
 * ------------------------------------------------------------------ */

/**
 * Append a point to a history series, de-duplicating by timestamp and
 * keeping the newest `cap` points in chronological order.
 */
export function mergeHistory(prev, point, cap = 56) {
  const series = Array.isArray(prev) ? prev.filter((p) => p && typeof p.t === "string") : [];
  const byT = new Map(series.map((p) => [p.t, p]));
  if (point && typeof point.t === "string") byT.set(point.t, point);
  return [...byT.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-cap);
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

/** Parse the `rel="next"` URL out of an RFC 8288 Link header. */
export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

/** Seconds to wait from a Retry-After header (delta-seconds or HTTP date). */
export function retryAfterSeconds(header, now = Date.now()) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(header);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : null;
}

/**
 * Pick the best candidate from a Hub search for a `resolve` hint:
 * same author, search text present in the repo name, optional regex, not
 * a declared derivative; clean names beat variants, then 30-day downloads.
 */
export function pickResolved(candidates, resolve) {
  if (!Array.isArray(candidates) || !resolve) return null;
  const author = String(resolve.author || "").toLowerCase();
  const needle = String(resolve.search || "").toLowerCase();
  const re = resolve.match ? new RegExp(resolve.match, "i") : null;
  // Hub search is fuzzy, so the search text must also appear literally in the repo name.
  const pool = candidates.filter((c) =>
    typeof c?.id === "string" &&
    (!author || c.id.toLowerCase().startsWith(author + "/")) &&
    (!needle || repoName(c).toLowerCase().includes(needle)) &&
    (!re || re.test(c.id)) &&
    !(c.tags || []).some((t) => /^base_model:(quantized|adapter|merge):/.test(t))
  );
  // Clean names first (variants such as -BF16, -Eagle, -SFT, -NVFP4 only as a fallback), then downloads.
  pool.sort((a, b) =>
    Number(isVariant(a)) - Number(isVariant(b)) ||
    (b.downloads ?? 0) - (a.downloads ?? 0) ||
    a.id.localeCompare(b.id));
  return pool[0]?.id ?? null;
}
