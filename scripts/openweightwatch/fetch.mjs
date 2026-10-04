#!/usr/bin/env node
// Open Weight Watch — data build.
//
// Reads the curated registries in ./registry, enriches them with live data
// from the Hugging Face Hub and the GitHub REST API, and writes one JSON
// document for the /weights/ page. Runs in GitHub Actions on a schedule
// (see .github/workflows/jekyll.yml); needs Node 20+ and no dependencies.
//
// Robustness contract:
//   - every network call retries on 429/5xx/timeouts with backoff;
//   - a failure on one item never aborts the build: the item falls back to
//     the previously published values (marked `stale`) and is logged;
//   - the process exits 0 whenever it could write a document.
//
// Environment:
//   HF_TOKEN            optional Hub token (raises rate limits)
//   GITHUB_TOKEN        optional GitHub token (raises rate limits)
//   OWW_PREVIOUS_URL    URL of the currently published watch.json (history + fallback)
//   OWW_OUT             output path (default: weights/data/watch.json)
//   OWW_CONCURRENCY     parallel items (default 4)
//   OWW_MAX_PAGES       max 1000-row pages per derivative listing (default 5)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as L from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SCHEMA = 1;

export function config(env = process.env) {
  return {
    hf: (env.HF_ENDPOINT || "https://huggingface.co").replace(/\/$/, ""),
    gh: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    hfToken: env.HF_TOKEN || "",
    ghToken: env.GITHUB_TOKEN || "",
    previousUrl: env.OWW_PREVIOUS_URL || "",
    out: env.OWW_OUT || path.join(ROOT, "weights/data/watch.json"),
    concurrency: clampInt(env.OWW_CONCURRENCY, 4, 1, 16),
    maxPages: clampInt(env.OWW_MAX_PAGES, 5, 1, 50),
    pageSize: 1000,
    discoverLimit: 24,
    spacesPerPigment: 8,
    maxSpaces: 60,
    historyCap: 56,
    timeoutMs: 30_000,
    retries: 4,
    refreshHours: 3
  };
}

function clampInt(v, dflt, lo, hi) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/* ================================================================== *
 * HTTP
 * ================================================================== */

export class HttpError extends Error {
  constructor(url, status, detail) {
    super(`HTTP ${status} for ${url}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
    this.url = url;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient({ fetchImpl, cfg, stats, sleepImpl = sleep }) {
  async function request(url, { headers = {}, allow404 = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      stats.requests += 1;
      let res;
      try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
      } catch (err) {
        if (attempt < cfg.retries) { await sleepImpl(backoff(attempt)); continue; }
        throw new HttpError(url, 0, err?.message || "network error");
      }
      if (res.status === 404 && allow404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < cfg.retries) {
        const ra = L.retryAfterSeconds(res.headers.get("retry-after"));
        await sleepImpl(ra != null ? Math.min(ra, 120) * 1000 : backoff(attempt));
        continue;
      }
      if (!res.ok) throw new HttpError(url, res.status, await res.text().catch(() => ""));
      return res;
    }
  }
  const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);

  async function json(url, opts) {
    const res = await request(url, opts);
    if (!res) return null;
    return { data: await res.json(), link: res.headers.get("link") };
  }
  return { json };
}

/* ================================================================== *
 * Hugging Face Hub
 * ================================================================== */

function hubApi(cfg, client) {
  const headers = { "User-Agent": "open-weight-watch (+pigments-lab)", Accept: "application/json" };
  if (cfg.hfToken) headers.Authorization = `Bearer ${cfg.hfToken}`;

  const repoPath = (id) => id.split("/").map(encodeURIComponent).join("/");
  const qs = (params, expand = []) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") sp.append(k, String(v));
    for (const e of expand) sp.append("expand[]", e);
    return sp.toString();
  };

  /** GET a paginated listing, following Link: rel=next up to `pages` pages. */
  async function list(kind, params, { expand = [], pages = 1 } = {}) {
    const first = `${cfg.hf}/api/${kind}?${qs(params, expand)}`;
    let page;
    try {
      page = await client.json(first, { headers });
    } catch (err) {
      // Older or stricter Hub deployments reject unknown expand keys; retry plain.
      if (err instanceof HttpError && err.status === 400 && expand.length) {
        return list(kind, params, { expand: [], pages });
      }
      throw err;
    }
    const items = [...(page?.data || [])];
    let next = L.nextLink(page?.link);
    let n = 1;
    while (next && n < pages) {
      page = await client.json(next, { headers });
      items.push(...(page?.data || []));
      next = L.nextLink(page?.link);
      n += 1;
    }
    return { items, capped: Boolean(next) };
  }

  return {
    model: async (id) => (await client.json(`${cfg.hf}/api/models/${repoPath(id)}`, { headers, allow404: true }))?.data ?? null,
    modelExtras: async (id) =>
      (await client.json(`${cfg.hf}/api/models/${repoPath(id)}?${qs({}, ["downloadsAllTime", "trendingScore"])}`, { headers, allow404: true }))?.data ?? null,
    space: async (id) => (await client.json(`${cfg.hf}/api/spaces/${repoPath(id)}`, { headers, allow404: true }))?.data ?? null,
    models: (params, opts) => list("models", params, opts),
    spaces: (params, opts) => list("spaces", params, opts)
  };
}

/* ================================================================== *
 * GitHub
 * ================================================================== */

function githubApi(cfg, client) {
  const headers = {
    "User-Agent": "open-weight-watch (+pigments-lab)",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (cfg.ghToken) headers.Authorization = `Bearer ${cfg.ghToken}`;
  return {
    repo: async (full) => (await client.json(`${cfg.gh}/repos/${full}`, { headers, allow404: true }))?.data ?? null,
    latestRelease: async (full) => (await client.json(`${cfg.gh}/repos/${full}/releases/latest`, { headers, allow404: true }))?.data ?? null
  };
}

/* ================================================================== *
 * Utilities
 * ================================================================== */

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function loadPrevious(cfg, fetchImpl, log) {
  if (!cfg.previousUrl) return null;
  try {
    const res = await fetchImpl(cfg.previousUrl, { signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!res.ok) { log(`previous: HTTP ${res.status}, starting fresh`); return null; }
    const doc = await res.json();
    if (doc?.schema !== SCHEMA) { log("previous: schema mismatch, starting fresh"); return null; }
    return doc;
  } catch (err) {
    log(`previous: ${err.message}, starting fresh`);
    return null;
  }
}

const num = (v) => (Number.isFinite(v) ? v : null);

/* ================================================================== *
 * Build
 * ================================================================== */

/**
 * Build the watch document.
 * @param {{fetchImpl?: typeof fetch, env?: object, now?: Date, log?: (s:string)=>void, sleepImpl?: Function}} [opts]
 */
export async function build(opts = {}) {
  const cfg = config(opts.env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const log = opts.log || ((s) => console.log(s));
  const started = Date.now();
  const generatedAt = (opts.now || new Date()).toISOString();
  const stats = { requests: 0 };
  const errors = [];
  const fail = (scope, id, err) => {
    const message = err?.message || String(err);
    if (errors.length < 200) errors.push({ scope, id, message });
    log(`! ${scope} ${id}: ${message}`);
  };

  const client = makeClient({ fetchImpl, cfg, stats, sleepImpl: opts.sleepImpl });
  const hub = hubApi(cfg, client);
  const gh = githubApi(cfg, client);

  const [labs, registry, runtimesReg, licenses] = await Promise.all([
    readJson(path.join(HERE, "registry/labs.json")),
    readJson(path.join(HERE, "registry/pigments.json")),
    readJson(path.join(HERE, "registry/runtimes.json")),
    readJson(path.join(HERE, "registry/licenses.json"))
  ]);
  const previous = await loadPrevious(cfg, fetchImpl, log);
  const prevPig = new Map((previous?.pigments || []).map((p) => [p.id, p]));
  const prevRt = new Map((previous?.runtimes || []).map((r) => [r.repo, r]));

  /* ---------- pigments ---------- */
  log(`pigments: ${registry.length}`);
  const pigments = await pool(registry, cfg.concurrency, async (entry) => {
    const lic = licenses[entry.license] || licenses.unverified;
    const base = {
      ...entry,
      licenseName: entry.licenseName || lic.name,
      cls: lic.cls,
      tier: L.tierOf({ cls: lic.cls, code: entry.code, data: entry.data }),
      score: L.opennessScore({ cls: lic.cls, code: entry.code, data: entry.data, report: entry.report }),
      transparency: L.transparencyOf(entry.data)
    };
    let live = null;
    try {
      live = await livePigment(entry);
    } catch (err) {
      fail("pigment", entry.id, err);
    }
    const prev = prevPig.get(entry.id);
    if (!live && prev?.hub?.found) {
      live = { ...prev.hub, stale: true, staleSince: prev.hub.staleSince || previous.generatedAt };
    }
    const hubBlock = live || { found: false, id: entry.hf || null };
    const history = hubBlock.found && !hubBlock.stale
      ? L.mergeHistory(prev?.history, { t: generatedAt, d: hubBlock.downloads, l: hubBlock.likes }, cfg.historyCap)
      : (prev?.history || []);
    return { ...base, hub: hubBlock, checks: checksFor(base, hubBlock), history };
  });

  async function livePigment(entry) {
    let id = entry.hf || null;
    let resolvedBy = id ? "registry" : null;
    let info = id ? await hub.model(id) : null;
    if (!info && entry.resolve) {
      const { items } = await hub.models(
        { author: entry.resolve.author, search: entry.resolve.search, sort: "downloads", direction: -1, limit: 50 },
        { expand: ["tags", "downloads"] }
      );
      const picked = L.pickResolved(items, entry.resolve);
      if (picked) {
        id = picked;
        resolvedBy = "search";
        info = await hub.model(picked);
      }
    }
    if (!info) return { found: false, id, resolvedBy: null };
    id = info.id || info.modelId || id;

    const extras = await hub.modelExtras(id).catch((err) => { fail("extras", id, err); return null; });
    const derivatives = {};
    for (const rel of L.RELATIONS) {
      const { items, capped } = await hub.models(
        { filter: `base_model:${rel}:${id}`, sort: "downloads", direction: -1, limit: cfg.pageSize },
        { expand: ["tags", "downloads"], pages: cfg.maxPages }
      );
      derivatives[rel] = {
        count: items.length,
        capped,
        top: items[0] ? { id: items[0].id, downloads: num(items[0].downloads) ?? 0 } : null
      };
      if (rel === "quantized") derivatives.quantized.formats = L.tallyFormats(items);
    }
    const { items: spaces } = await hub.spaces(
      { models: id, sort: "likes", direction: -1, limit: cfg.spacesPerPigment },
      { expand: ["likes"] }
    ).catch((err) => { fail("spaces", id, err); return { items: [] }; });

    const license = L.hubLicense(info);
    return {
      found: true,
      id,
      url: `${cfg.hf}/${id}`,
      resolvedBy,
      downloads: num(info.downloads),
      downloadsAllTime: num(extras?.downloadsAllTime),
      likes: num(info.likes),
      trendingScore: num(extras?.trendingScore),
      createdAt: info.createdAt || null,
      lastModified: info.lastModified || null,
      gated: info.gated || false,
      license,
      licenseClass: L.licenseClassFromHub(license),
      params: num(info.safetensors?.total),
      library: info.library_name || null,
      pipeline: info.pipeline_tag || null,
      derivatives,
      spaces: spaces.map((s) => ({ id: s.id, likes: num(s.likes) ?? 0 }))
    };
  }

  function checksFor(base, h) {
    const out = [];
    if (!h.found) {
      out.push({ kind: "missing", message: "Not located on the Hugging Face Hub." });
      return out;
    }
    if (h.licenseClass && h.licenseClass !== "unk" && base.cls !== "unk" && h.licenseClass !== base.cls) {
      out.push({ kind: "licence", message: `Hub licence tag “${h.license}” implies a different class than the curated licence.` });
    }
    if (base.total && h.params) {
      const ratio = h.params / 1e9 / base.total;
      if (Math.abs(ratio - 1) > 0.15) {
        out.push({ kind: "params", message: `Hub safetensors metadata reports ${(h.params / 1e9).toFixed(1)}B parameters (curated: ${base.total}B). Packed quantised tensors can cause this.` });
      }
    }
    return out;
  }

  /* ---------- discovery: trending first-party releases not in the registry ---------- */
  const catalogued = new Set(pigments.map((p) => p.hub?.id).filter(Boolean).map((s) => s.toLowerCase()));
  let discovered = [];
  try {
    const lists = await Promise.all(["text-generation", "image-text-to-text"].map((pipeline_tag) =>
      hub.models({ pipeline_tag, sort: "trendingScore", direction: -1, limit: 100 },
                 { expand: ["tags", "downloads", "likes", "trendingScore", "createdAt"] })
        .then((r) => r.items)
        .catch((err) => { fail("discover", pipeline_tag, err); return []; })
    ));
    const seen = new Set();
    const candidates = lists.flat()
      .filter((m) => typeof m?.id === "string" && !seen.has(m.id) && seen.add(m.id))
      .filter((m) => !catalogued.has(m.id.toLowerCase()) && L.isFirstPartyRelease(m))
      .sort((a, b) => (b.trendingScore ?? 0) - (a.trendingScore ?? 0))
      .slice(0, cfg.discoverLimit);
    discovered = (await pool(candidates, cfg.concurrency, async (m) => {
      const info = await hub.model(m.id).catch((err) => { fail("discover", m.id, err); return null; });
      const license = L.hubLicense(info || m);
      return {
        id: m.id,
        author: m.id.split("/")[0],
        url: `${cfg.hf}/${m.id}`,
        downloads: num(info?.downloads ?? m.downloads),
        likes: num(info?.likes ?? m.likes),
        trendingScore: num(m.trendingScore),
        createdAt: info?.createdAt || m.createdAt || null,
        license,
        licenseClass: L.licenseClassFromHub(license),
        params: num(info?.safetensors?.total),
        pipeline: info?.pipeline_tag || null,
        gated: info?.gated || false
      };
    })).filter(Boolean);
  } catch (err) {
    fail("discover", "*", err);
  }
  if (!discovered.length && previous?.discovered?.length) {
    discovered = previous.discovered.map((d) => ({ ...d, stale: true }));
  }

  /* ---------- runtimes (GitHub) ---------- */
  log(`runtimes: ${runtimesReg.length}`);
  const runtimes = await pool(runtimesReg, cfg.concurrency, async (rt) => {
    const prev = prevRt.get(rt.repo);
    let gh_ = null;
    try {
      const [repo, rel] = await Promise.all([gh.repo(rt.repo), gh.latestRelease(rt.repo)]);
      if (repo) {
        gh_ = {
          url: repo.html_url,
          fullName: repo.full_name,
          description: repo.description || null,
          stars: num(repo.stargazers_count),
          forks: num(repo.forks_count),
          openIssues: num(repo.open_issues_count),
          pushedAt: repo.pushed_at || null,
          license: repo.license?.spdx_id || null,
          archived: Boolean(repo.archived),
          release: rel ? { tag: rel.tag_name, publishedAt: rel.published_at, url: rel.html_url } : null
        };
      } else {
        fail("runtime", rt.repo, new Error("repository not found"));
      }
    } catch (err) {
      fail("runtime", rt.repo, err);
    }
    if (!gh_ && prev?.github) gh_ = { ...prev.github, stale: true };
    const composition = L.runtimeEvidence(rt, pigments);
    const history = gh_ && !gh_.stale
      ? L.mergeHistory(prev?.history, { t: generatedAt, s: gh_.stars }, cfg.historyCap)
      : (prev?.history || []);
    return { ...rt, github: gh_, composition, history };
  });

  /* ---------- spaces (Hugging Face) ---------- */
  const spaceLikes = new Map();
  for (const p of pigments) for (const s of p.hub?.spaces || []) {
    spaceLikes.set(s.id, Math.max(spaceLikes.get(s.id) ?? 0, s.likes ?? 0));
  }
  const spaceIds = [...spaceLikes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cfg.maxSpaces).map(([id]) => id);
  const hubIdToPigment = new Map(pigments.filter((p) => p.hub?.id).map((p) => [p.hub.id.toLowerCase(), p.id]));
  log(`spaces: ${spaceIds.length}`);
  let spaces = (await pool(spaceIds, cfg.concurrency, async (id) => {
    const info = await hub.space(id).catch((err) => { fail("space", id, err); return null; });
    if (!info) return null;
    const models = Array.isArray(info.models) ? info.models : [];
    const pigmentsUsed = [...new Set(models.map((m) => hubIdToPigment.get(String(m).toLowerCase())).filter(Boolean))];
    return {
      id: info.id || id,
      url: `${cfg.hf}/spaces/${info.id || id}`,
      title: info.cardData?.title || (info.id || id).split("/")[1],
      emoji: info.cardData?.emoji || null,
      sdk: info.sdk || info.cardData?.sdk || null,
      likes: num(info.likes) ?? spaceLikes.get(id) ?? 0,
      lastModified: info.lastModified || null,
      stage: info.runtime?.stage || null,
      pigments: pigmentsUsed,
      otherModels: models.filter((m) => !hubIdToPigment.has(String(m).toLowerCase())).slice(0, 30),
      modelCount: models.length
    };
  })).filter((s) => s && s.pigments.length);
  if (!spaces.length && previous?.spaces?.length) spaces = previous.spaces.map((s) => ({ ...s, stale: true }));

  const foundCount = pigments.filter((p) => p.hub?.found && !p.hub?.stale).length;
  const doc = {
    schema: SCHEMA,
    generatedAt,
    refreshHours: cfg.refreshHours,
    sources: {
      huggingface: cfg.hf,
      github: cfg.gh
    },
    stats: {
      requests: stats.requests,
      durationMs: Date.now() - started,
      pigmentsLive: foundCount,
      pigmentsTotal: pigments.length,
      errors: errors.length
    },
    licenses,
    labs,
    pigments,
    discovered,
    runtimes,
    spaces,
    errors
  };

  // Total outage: keep the last good document rather than publishing an empty one.
  if (foundCount === 0 && previous) {
    log("no live pigment data this run; republishing previous document with failure note");
    return { ...previous, lastAttempt: { at: generatedAt, errors: errors.slice(0, 20) } };
  }
  return doc;
}

export async function main() {
  const cfg = config();
  const doc = await build();
  await mkdir(path.dirname(cfg.out), { recursive: true });
  await writeFile(cfg.out, JSON.stringify(doc));
  const s = doc.stats || {};
  console.log(`wrote ${cfg.out}: ${s.pigmentsLive}/${s.pigmentsTotal} pigments live, ` +
    `${doc.runtimes?.length ?? 0} runtimes, ${doc.spaces?.length ?? 0} spaces, ${doc.discovered?.length ?? 0} discovered, ` +
    `${s.requests} requests, ${s.errors} errors, ${Math.round((s.durationMs || 0) / 1000)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
