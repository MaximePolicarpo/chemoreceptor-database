/* Vertebrate Chemoreceptor Repertoire Database — static frontend, no framework. */
"use strict";

const CONFIG = {
  /* Where the per-genome sequence files live. Each genome provides:
       <SEQ_BASE>/<accession>/functional.fa
       <SEQ_BASE>/<accession>/pseudogenes.fa
     For local preview this is a relative path. For deployment, set it to wherever
     you upload the sequences/ folder — it may be a different host (e.g. Zenodo,
     Hugging Face, an S3 bucket) as long as that host sends permissive CORS
     headers (`Access-Control-Allow-Origin: *`). */
  SEQ_BASE: "./sequences",
  JSZIP_URL: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  MAX_INBROWSER_MB: 500,          // refuse merge/zip above this; suggest the script
  NCBI_ASM: "https://www.ncbi.nlm.nih.gov/datasets/genome/",
};
Object.assign(CONFIG, window.CHEMO_CONFIG || {});

const FAM = ["OR", "V1R", "V2R", "TAAR", "T1R", "T2R"];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtInt = (n) => (n == null ? "" : n.toLocaleString("en-US"));
const prettyOE = (s) => (s ? s.replace(/_/g, " ") : "");
const fmtBp = (n) => {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " Gb";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " Mb";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " kb";
  return n + " bp";
};

const state = {
  all: [],
  view: [],
  page: 0,
  pageSize: 50,
  sort: { key: "s", dir: 1 },
  sel: new Set(),
  summary: null,
};

/* ---------- columns ---------- */
const COLS = [
  { key: "sel", label: "", sort: false, cls: "no-sort",
    render: (g) => {
      const c = document.createElement("input");
      c.type = "checkbox"; c.checked = state.sel.has(g.a);
      c.addEventListener("change", () => {
        c.checked ? state.sel.add(g.a) : state.sel.delete(g.a);
        refreshSelectionUI();
      });
      return c;
    } },
  { key: "s", label: "Species", val: (g) => g.s, cls: "sp",
    render: (g) => txt(g.s) },
  { key: "a", label: "Accession", val: (g) => g.a,
    render: (g) => {
      const a = document.createElement("a");
      a.href = CONFIG.NCBI_ASM + g.a + "/"; a.target = "_blank"; a.rel = "noopener";
      a.textContent = g.a; a.className = "fp";
      return a;
    } },
  { key: "cl", label: "Clade", val: (g) => g.cl || "￿",
    render: (g) => txt(g.cl || "—") },
  { key: "o", label: "Order", val: (g) => g.o || "￿",
    render: (g) => txt(g.o || "—") },
  { key: "oesh", label: "Olfactory epithelium", val: (g) => g.oesh || "￿",
    render: (g) => {
      if (!g.oesh) return txt("—");
      const s = document.createElement("span");
      s.className = "pill";
      s.textContent = prettyOE(g.oesh);
      const bits = [];
      if (g.oelam != null) bits.push(`~${g.oelam} lamellae`);
      if (g.oesurf != null) bits.push(`${g.oesurf} mm² surface`);
      if (g.oeref) bits.push(g.oeref);
      s.title = bits.join("  ·  ");
      return s;
    } },
  { key: "bc", label: "BUSCO C%", val: (g) => (g.bc == null ? -1 : g.bc), cls: "num",
    render: (g) => {
      if (g.bc == null) return txt("—");
      const wrap = document.createElement("span");
      wrap.className = "busco-cell";
      const bar = document.createElement("span");
      bar.className = "busco-bar" + (g.bc < 90 ? " low" : "");
      const i = document.createElement("i"); i.style.width = g.bc + "%";
      bar.appendChild(i);
      const n = document.createElement("span");
      n.textContent = g.bc.toFixed(1);
      n.title = `C:${g.bc}%  S:${g.bs}%  D:${g.bd}%  F:${g.bf}%  M:${g.bm}%  n=${g.bn}`;
      wrap.append(bar, n);
      return wrap;
    } },
  { key: "lv", label: "Assembly", val: (g) => g.lv || "￿",
    render: (g) => {
      const s = document.createElement("span");
      s.className = "pill"; s.textContent = g.lv || "—";
      return s;
    } },
  { key: "gl", label: "Genome", val: (g) => g.gl || -1, cls: "num",
    render: (g) => txt(fmtBp(g.gl)) },
  ...FAM.map((f, idx) => ({
    key: "fam" + idx, label: f,
    val: (g) => g.fc[idx] * 1e6 + g.pc[idx],
    cls: "num",
    render: (g) => {
      const s = document.createElement("span");
      s.className = "fp";
      s.innerHTML = `<span class="f">${g.fc[idx]}</span><span class="sep">/</span><span class="p">${g.pc[idx]}</span>`;
      s.title = `${f}: ${g.fc[idx]} functional, ${g.pc[idx]} pseudogenes`;
      return s;
    },
  })),
  { key: "tf", label: "Σ func", val: (g) => g.tf, cls: "num",
    render: (g) => txt(fmtInt(g.tf)) },
  { key: "tp", label: "Σ pseudo", val: (g) => g.tp, cls: "num",
    render: (g) => txt(fmtInt(g.tp)) },
  { key: "dl", label: "", sort: false, cls: "no-sort",
    render: (g) => {
      const a = document.createElement("a");
      a.href = "#"; a.className = "rowdl"; a.title = "Download this genome's sequences";
      a.textContent = "⬇️";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        downloadSelection([g.a], $("#dl-kind").value, "zip");
      });
      return a;
    } },
];

function txt(t) { const s = document.createElement("span"); s.textContent = t; return s; }

/* ---------- load ---------- */
async function boot() {
  try {
    const [genomes, summary] = await Promise.all([
      fetch("data/genomes.json").then((r) => r.json()),
      fetch("data/summary.json").then((r) => r.json()),
    ]);
    state.all = genomes;
    state.summary = summary;
  } catch (err) {
    $("#body").innerHTML =
      `<tr><td colspan="20" class="muted">Could not load data/genomes.json — run the pipeline first (${err}).</td></tr>`;
    return;
  }
  buildStatStrip();
  buildFacets();
  wireControls();
  apply();
}

function buildStatStrip() {
  const s = state.summary;
  const items = [
    [fmtInt(s.n_genomes), "genome assemblies"],
    [fmtInt(s.n_species), "species"],
    [fmtInt(s.totals.functional), "functional receptors"],
    [fmtInt(s.totals.pseudogene), "pseudogenes"],
    [fmtInt(s.n_with_busco), "with BUSCO"],
    [fmtInt(s.n_with_taxonomy), "with taxonomy"],
  ];
  if (s.n_with_oe != null) items.push([fmtInt(s.n_with_oe), "with OE morphology"]);
  $("#stat-strip").innerHTML = items
    .map(([b, l]) => `<div class="stat"><b>${b}</b><span>${l}</span></div>`)
    .join("");
  $("#foot-meta").textContent =
    `Data generated ${s.generated_at}. BUSCO lineage: vertebrata_odb12. ` +
    `Taxonomy via NCBI Taxonomy.`;
  const sn = $("#scope-note");
  if (sn && s.scope_note) sn.textContent = s.scope_note + " ";
}

function buildFacets() {
  const s = state.summary;
  $("#clade-fieldset").hidden = s.clades.length <= 1;
  $("#clade-facets").innerHTML = s.clades
    .map((c) => facetRow("clade", c, s.clade_counts[c] || 0))
    .join("");
  $("#level-facets").innerHTML = s.assembly_levels
    .map((c) => facetRow("level", c, "")).join("");
  $("#family-facets").innerHTML = FAM
    .map((f) => facetRow("family", f, "")).join("");
  $("#order-list").innerHTML = s.orders
    .map((o) => `<option value="${esc(o)}">`).join("");
  const hasOE = Array.isArray(s.oe_shapes) && s.oe_shapes.length > 0;
  $("#oe-fieldset").hidden = !hasOE;
  $("#oe-required-row").hidden = !hasOE;
  if (hasOE) {
    $("#oe-facets").innerHTML = s.oe_shapes
      .map((sh) => facetRow("oeshape", sh, s.oe_shape_counts?.[sh] || 0, prettyOE(sh)))
      .join("");
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function facetRow(group, value, count, label) {
  const cnt = count === "" ? "" : `<span class="fc-count">${fmtInt(count)}</span>`;
  return `<label><input type="checkbox" data-facet="${group}" value="${esc(value)}"> ${esc(label ?? value)} ${cnt}</label>`;
}

/* ---------- filtering ---------- */
function readFilters() {
  const checked = (g) =>
    $$(`input[data-facet="${g}"]:checked`).map((el) => el.value);
  return {
    q: $("#q").value.trim().toLowerCase(),
    buscoMin: +$("#busco-min").value,
    buscoRequired: $("#busco-required").checked,
    clades: new Set(checked("clade")),
    levels: new Set(checked("level")),
    families: checked("family"),
    oeShapes: new Set(checked("oeshape")),
    order: $("#order").value.trim().toLowerCase(),
    taxRequired: $("#tax-required").checked,
    completeRequired: $("#complete-required").checked,
    oeRequired: $("#oe-required") ? $("#oe-required").checked : false,
  };
}

function passes(g, f) {
  if (f.q) {
    const hay = (g.s + " " + g.a + " " + (g.o || "") + " " + (g.g || "")).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  if (f.buscoRequired && g.bc == null) return false;
  if (f.buscoMin > 0 && (g.bc == null || g.bc < f.buscoMin)) return false;
  if (f.clades.size && !f.clades.has(g.cl)) return false;
  if (f.levels.size && !f.levels.has(g.lv)) return false;
  if (f.order && !(g.o || "").toLowerCase().includes(f.order)) return false;
  if (f.families.length) {
    const anyFam = f.families.some((fam) => g.fc[FAM.indexOf(fam)] > 0);
    if (!anyFam) return false;
  }
  if (f.taxRequired && !g.ht) return false;
  if (f.completeRequired && !g.ok) return false;
  if (f.oeRequired && !g.oesh) return false;
  if (f.oeShapes.size && !f.oeShapes.has(g.oesh)) return false;
  return true;
}

function apply() {
  const f = readFilters();
  state.view = state.all.filter((g) => passes(g, f));
  sortView();
  state.page = 0;
  render();
}

function sortView() {
  const col = COLS.find((c) => c.key === state.sort.key);
  if (!col || !col.val) return;
  const dir = state.sort.dir;
  state.view.sort((a, b) => {
    const va = col.val(a), vb = col.val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return a.s < b.s ? -1 : 1;
  });
}

/* ---------- render ---------- */
function render() {
  renderHead();
  const total = state.view.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * state.pageSize;
  const rows = state.view.slice(start, start + state.pageSize);

  const body = $("#body");
  body.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const g of rows) {
    const tr = document.createElement("tr");
    for (const c of COLS) {
      const td = document.createElement("td");
      if (c.cls) td.className = c.cls;
      td.appendChild(c.render(g));
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  $("#count-line").innerHTML =
    `${fmtInt(total)} genome${total === 1 ? "" : "s"} ` +
    `<small>of ${fmtInt(state.all.length)} — ` +
    `Σ ${fmtInt(sum(state.view, "tf"))} functional, ` +
    `${fmtInt(sum(state.view, "tp"))} pseudogenes</small>`;
  $("#page-info").textContent =
    `Page ${state.page + 1} / ${pages}  (${fmtInt(start + 1)}–${fmtInt(Math.min(total, start + state.pageSize))})`;
  $("#prev").disabled = state.page === 0;
  $("#next").disabled = state.page >= pages - 1;
  refreshSelectionUI();
}
const sum = (arr, k) => arr.reduce((a, g) => a + (g[k] || 0), 0);

function renderHead() {
  const tr = $("#head-row");
  tr.innerHTML = "";
  // master checkbox
  for (const c of COLS) {
    const th = document.createElement("th");
    if (c.cls === "no-sort" || c.sort === false) th.className = "no-sort";
    if (c.key === "sel") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.title = "select / clear all filtered genomes";
      cb.checked = state.view.length > 0 && state.view.every((g) => state.sel.has(g.a));
      cb.addEventListener("change", () => {
        if (cb.checked) state.view.forEach((g) => state.sel.add(g.a));
        else state.view.forEach((g) => state.sel.delete(g.a));
        render();
      });
      th.appendChild(cb);
    } else {
      th.textContent = c.label;
      if (c.sort !== false && c.val) {
        if (state.sort.key === c.key) {
          const ar = document.createElement("span");
          ar.className = "arrow";
          ar.textContent = state.sort.dir > 0 ? " ▲" : " ▼";
          th.appendChild(ar);
        }
        th.addEventListener("click", () => {
          if (state.sort.key === c.key) state.sort.dir *= -1;
          else state.sort = { key: c.key, dir: c.key === "s" ? 1 : -1 };
          sortView();
          render();
        });
      }
    }
    tr.appendChild(th);
  }
}

/* ---------- selection + download ---------- */
function refreshSelectionUI() {
  const n = state.sel.size;
  const bar = $("#download-bar");
  bar.hidden = n === 0;
  if (n) {
    const chosen = state.all.filter((g) => state.sel.has(g.a));
    const mb = chosen.reduce((a, g) => a + (g.fb || 0) + (g.pb || 0), 0) / 1e6;
    $("#sel-count").innerHTML =
      `<b>${fmtInt(n)}</b> genome${n === 1 ? "" : "s"} selected ` +
      `<span class="dl-msg">(~${mb.toFixed(1)} MB of sequence)</span>`;
  }
}

async function ensureJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = CONFIG.JSZIP_URL; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

function seqURL(acc, kind) {
  // kind: "functional" | "pseudogenes"
  return `${CONFIG.SEQ_BASE.replace(/\/$/, "")}/${acc}/${kind}.fa`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadSelection(accs, kind, format) {
  const kinds = kind === "both" ? ["functional", "pseudogenes"] : [kind];
  const msg = $("#dl-msg");
  const prog = $("#dl-progress");

  // Only set in the optional single-file offline build (pipeline/06_preview.py),
  // where there is no server to fetch sequence files from. Never set on the site.
  if (CONFIG.OFFLINE_BUNDLE) {
    msg.textContent =
      "Sequence downloads need the hosted site. Table export (TSV) works here.";
    return;
  }

  if (format === "script") {
    const lines = ["#!/usr/bin/env bash", "set -euo pipefail"];
    for (const acc of accs) {
      lines.push(`mkdir -p "${acc}"`);
      for (const k of kinds) {
        const abs = new URL(seqURL(acc, k), location.href).href;
        lines.push(`curl -fsSL "${abs}" -o "${acc}/${k}.fa"`);
      }
    }
    triggerDownload(new Blob([lines.join("\n") + "\n"], { type: "text/x-sh" }),
      `download_${accs.length}_genomes.sh`);
    msg.textContent = `wrote script for ${accs.length} genomes`;
    return;
  }

  const chosen = state.all.filter((g) => state.sel.has(g.a) || accs.includes(g.a));
  const estMB = chosen.reduce((a, g) => a + (g.fb || 0) + (g.pb || 0), 0) / 1e6;
  if (estMB > CONFIG.MAX_INBROWSER_MB) {
    msg.textContent =
      `Selection is ~${estMB.toFixed(0)} MB — too large to build in the browser. ` +
      `Use the "download script" option instead.`;
    return;
  }

  prog.hidden = false; prog.value = 0; prog.max = accs.length * kinds.length;
  let done = 0;
  const fetchText = async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return "";
      return await r.text();
    } catch { return ""; }
    finally { prog.value = ++done; }
  };

  if (format === "merged") {
    const merged = {};
    for (const k of kinds) merged[k] = [];
    for (const acc of accs) {
      for (const k of kinds) {
        const t = await fetchText(seqURL(acc, k));
        if (t.trim()) merged[k].push(t.endsWith("\n") ? t : t + "\n");
      }
    }
    if (kinds.length === 1) {
      triggerDownload(new Blob([merged[kinds[0]].join("")], { type: "text/plain" }),
        `${kinds[0]}.fa`);
    } else {
      const JSZip = await ensureJSZip();
      const zip = new JSZip();
      for (const k of kinds) zip.file(`${k}.fa`, merged[k].join(""));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      triggerDownload(blob, `chemoreceptors_merged_${accs.length}_genomes.zip`);
    }
    msg.textContent = `done — ${accs.length} genomes`;
    prog.hidden = true;
    return;
  }

  // format === "zip": one folder per genome
  const JSZip = await ensureJSZip();
  const zip = new JSZip();
  for (const acc of accs) {
    for (const k of kinds) {
      const t = await fetchText(seqURL(acc, k));
      zip.file(`${acc}/${k}.fa`, t || "");
    }
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  triggerDownload(blob,
    accs.length === 1 ? `${accs[0]}.zip` : `chemoreceptors_${accs.length}_genomes.zip`);
  msg.textContent = `done — ${accs.length} genomes`;
  prog.hidden = true;
}

/* ---------- table TSV export ---------- */
function exportTSV() {
  const head = ["species", "accession", "taxid", "clade", "class", "order", "genus",
    "assembly_level", "busco_C", "busco_S", "busco_D", "busco_F", "busco_M", "busco_n",
    "genome_bp", "scaffold_n50_bp", "n_scaffolds",
    ...FAM.flatMap((f) => [`${f}_func`, `${f}_pseudo`]),
    "total_functional", "total_pseudogene",
    "OE_shape", "OE_mean_lamellae", "OE_surface_mm2", "OE_ref"];
  const rows = [head.join("\t")];
  for (const g of state.view) {
    rows.push([
      g.s, g.a, g.t, g.cl, g.c, g.o, g.g, g.lv,
      g.bc, g.bs, g.bd, g.bf, g.bm, g.bn,
      g.gl, g.n50, g.nsc,
      ...FAM.flatMap((f, i) => [g.fc[i], g.pc[i]]),
      g.tf, g.tp,
      g.oesh || "", g.oelam, g.oesurf, g.oeref || "",
    ].map((x) => (x == null ? "" : x)).join("\t"));
  }
  triggerDownload(new Blob([rows.join("\n") + "\n"], { type: "text/tab-separated-values" }),
    `chemoreceptor_table_${state.view.length}_genomes.tsv`);
}

/* ---------- controls ---------- */
function wireControls() {
  const deb = (fn, ms = 180) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const applyDeb = deb(apply);
  $("#q").addEventListener("input", applyDeb);
  $("#order").addEventListener("input", applyDeb);
  $("#busco-min").addEventListener("input", () => {
    $("#busco-min-out").textContent = $("#busco-min").value + "%";
    applyDeb();
  });
  $("#busco-required").addEventListener("change", apply);
  $("#tax-required").addEventListener("change", apply);
  $("#complete-required").addEventListener("change", apply);
  if ($("#oe-required")) $("#oe-required").addEventListener("change", apply);
  $("#filters").addEventListener("change", (e) => {
    if (e.target.matches("input[data-facet]")) apply();
  });
  $("#reset-filters").addEventListener("click", () => {
    $("#q").value = ""; $("#order").value = "";
    $("#busco-min").value = 0; $("#busco-min-out").textContent = "0%";
    $$("#filters input[type=checkbox]").forEach((c) => (c.checked = false));
    apply();
  });
  $("#page-size").addEventListener("change", () => {
    state.pageSize = +$("#page-size").value; state.page = 0; render();
  });
  $("#prev").addEventListener("click", () => { state.page--; render(); });
  $("#next").addEventListener("click", () => { state.page++; render(); });
  $("#export-tsv").addEventListener("click", exportTSV);
  $("#sel-clear").addEventListener("click", () => { state.sel.clear(); render(); });
  $("#dl-go").addEventListener("click", () => {
    const accs = [...state.sel];
    if (!accs.length) return;
    downloadSelection(accs, $("#dl-kind").value, $("#dl-format").value);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
