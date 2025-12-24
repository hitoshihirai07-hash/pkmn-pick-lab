(() => {
  const $ = (sel, root=document) => root.querySelector(sel);
  const el = (tag, attrs={}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs||{})) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined) continue;
      if (typeof kid === "string") e.appendChild(document.createTextNode(kid));
      else e.appendChild(kid);
    }
    return e;
  };

  // --- State ---
  const state = {
    dexLoaded: false,
    filterLearnset: false,
    ui: {
      hideRightPicks: false,
      normalRules: true,
      noLegends: true,
      regEnabled: false,
    },
    reg: {
      loaded: false,
      allowed: new Set(),
      unknown: [],
      rawCsv: "",
    },
    pokedex: null,
    moves: null,
    learnsets: null,
    sets: null,
    jpPokemonById: new Map(), // showdownId -> {ja,en}
    jpItemByEn: new Map(),    // English name -> ja
    jpMoveByEn: new Map(),    // English move name -> ja
    jpAbilityByEn: new Map(), // English ability name -> ja
    pendingJa: { move:new Map(), ability:new Map() },
    moveIdByName: new Map(),  // English move name -> id
    moveNameById: new Map(),  // id -> English name
    moveOptionsAll: [],        // prebuilt move options for fast search
    moveOptionById: new Map(),  // moveId -> option
    learnsetCache: new Map(),   // speciesId -> Set(moveId)
    speciesOptions: [],       // {id, ja, en, search}
    itemOptions: [],          // {ja,en,search}
    itemEnByJa: new Map(),     // Japanese item name -> English name
    teams: {
      left: makeEmptyTeam(),
      right: makeEmptyTeam(),
    },
  };

  function makeEmptyMon() {
    return {
      pick: false,
      speciesId: "",
      ability: "",
      item: "",
      teraType: "",
      nature: "Serious", // neutral
      evs: {hp:0, atk:0, def:0, spa:0, spd:0, spe:0},
      ivSpe: 31, // S only: 31 or 0
      moves: ["","","",""], // store move IDs
    };
  }
  function makeEmptyTeam() {
    return Array.from({length:6}, () => makeEmptyMon());
  }

  // --- UI helpers ---
  function setStatus(msg, kind="note") {
    const box = $("#status");
    box.className = kind === "err" ? "err" : (kind === "ok" ? "ok" : "note");
    box.textContent = msg;
  }

  function normalize(s){ return (s||"").toLowerCase().replace(/[\s'’\-_.:]/g, ""); }

  // --- Global UI optimizations (mobile friendly) ---
  // 1) Avoid adding document-level listeners per input (leaks + slowdown)
  // 2) Debounce full re-render calls
  let dismissRegistry = [];
  document.addEventListener("click", (e) => {
    for (const it of dismissRegistry) {
      if (!it?.wrap?.isConnected) continue;
      if (!it.wrap.contains(e.target)) it.list.style.display = "none";
    }
  }, true);

  function resetDismissRegistry(){ dismissRegistry = []; }
  function registerDismiss(wrap, list){ dismissRegistry.push({wrap, list}); }

  let _rafRender = null;
  function scheduleRenderAll(){
    if (_rafRender) return;
    _rafRender = requestAnimationFrame(() => {
      _rafRender = null;
      renderAll();
    });
  }


  // Simple searchable dropdown (no <datalist> trouble)
  function createSearchBox({placeholder, getOptions, onPick, formatLabel}) {
    const wrap = el("div", {class:"searchbox"});
    const input = el("input", {type:"text", placeholder});
    const list = el("div", {class:"card", style:"display:none; position:relative; padding:6px; margin-top:6px"});
    list.style.maxHeight = "240px";
    list.style.overflow = "auto";

    function render(q) {
      const opts = getOptions();
      const nq = normalize(q);
      let filtered = opts;
      if (nq) filtered = opts.filter(o => o.search.includes(nq)).slice(0, 30);
      else filtered = opts.slice(0, 20);
      list.innerHTML = "";
      for (const o of filtered) {
        const btn = el("button", {style:"width:100%; text-align:left; border:1px solid var(--line); background:#fff; padding:8px; border-radius:10px; margin:4px 0; cursor:pointer;"},
          formatLabel(o)
        );
        btn.addEventListener("click", () => {
          onPick(o);
          list.style.display = "none";
        });
        list.appendChild(btn);
      }
      list.style.display = filtered.length ? "block" : "none";
    }

    input.addEventListener("input", () => render(input.value));
    input.addEventListener("focus", () => render(input.value));
    registerDismiss(wrap, list);

    wrap.appendChild(input);
    wrap.appendChild(list);

    return {wrap, input, setValue:(v)=>{input.value=v||"";}};
  }

  function fmtMove(id){
    if (!id) return "";
    const en = state.moveNameById.get(id) || id;
    const ja = state.jpMoveByEn.get(en);
    return ja ? ja : en;
  }

  function fmtAbility(en){
    if (!en) return "";
    const ja = state.jpAbilityByEn.get(en);
    return ja ? ja : en;
  }

  function fmtSpecies(id){
    const jp = state.jpPokemonById.get(id);
    if (!jp) return id;
    return jp.ja ? jp.ja : jp.en;
  }

  
  // --- i18n (Japanese) ---
  const I18N_CACHE_KEY = "picklab_i18n_cache_v1";
  const REG_CSV_KEY = "PICKLAB_REG_CSV";
  const REG_ENABLED_KEY = "PICKLAB_REG_ENABLED";
  const NORMAL_RULES_KEY = "PICKLAB_NORMAL_RULES";
  const NO_LEGENDS_KEY = "PICKLAB_NO_LEGENDS";
  // If a regulation file is committed next to index.html, we can auto-load it.
  // Place: /regulation.csv (same folder as index.html)
  const DEFAULT_REG_URL = "./regulation.csv";

  function loadI18nCache(){
    try{
      const raw = localStorage.getItem(I18N_CACHE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : {};
    }catch{
      return {};
    }
  }
  let _saveTimer = null;
  function saveI18nCache(){
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try{
        const out = {
          move: Object.fromEntries(state.jpMoveByEn.entries()),
          ability: Object.fromEntries(state.jpAbilityByEn.entries()),
        };
        localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(out));
      }catch{}
    }, 300);
  }

  function pokeSlug(enName){
    return (enName||"")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  async function fetchPokeapi(kind, slug){
    const url = `https://pokeapi.co/api/v2/${kind}/${slug}/`;
    const res = await fetch(url, {cache:"force-cache"});
    if (!res.ok) throw new Error(`PokeAPI ${kind} ${res.status}`);
    return res.json();
  }

  function pickJaName(names){
    if (!Array.isArray(names)) return "";
    // Prefer ja-Hrkt, then ja
    const jaHrkt = names.find(n => n?.language?.name === "ja-Hrkt");
    if (jaHrkt?.name) return jaHrkt.name;
    const ja = names.find(n => n?.language?.name === "ja");
    if (ja?.name) return ja.name;
    return "";
  }

  async function ensureMoveJa(enName){
    if (!enName) return "";
    if (state.jpMoveByEn.has(enName)) return state.jpMoveByEn.get(enName) || "";
    if (state.pendingJa.move.has(enName)) return state.pendingJa.move.get(enName);
    const p = (async () => {
      try{
        const data = await fetchPokeapi("move", pokeSlug(enName));
        const ja = pickJaName(data?.names) || "";
        if (ja) {
          state.jpMoveByEn.set(enName, ja);
          const mid = state.moveIdByName.get(enName);
          const opt = mid ? state.moveOptionById.get(mid) : null;
          if (opt) { opt.label = ja || enName; opt.search = normalize(`${ja} ${enName}`); }
          saveI18nCache();
        }
        return ja;
      }catch{
        return "";
      } finally {
        state.pendingJa.move.delete(enName);
      }
    })();
    state.pendingJa.move.set(enName, p);
    return p;
  }

  async function ensureAbilityJa(enName){
    if (!enName) return "";
    if (state.jpAbilityByEn.has(enName)) return state.jpAbilityByEn.get(enName) || "";
    if (state.pendingJa.ability.has(enName)) return state.pendingJa.ability.get(enName);
    const p = (async () => {
      try{
        const data = await fetchPokeapi("ability", pokeSlug(enName));
        const ja = pickJaName(data?.names) || "";
        if (ja) {
          state.jpAbilityByEn.set(enName, ja);
          saveI18nCache();
        }
        return ja;
      }catch{
        return "";
      } finally {
        state.pendingJa.ability.delete(enName);
      }
    })();
    state.pendingJa.ability.set(enName, p);
    return p;
  }
// --- Dex loading ---
  async function fetchJson(relPath){
    const url = new URL(relPath, location.href).toString();
    const res = await fetch(url, {cache:"force-cache"});
    if (!res.ok) throw new Error(`HTTP ${res.status} : ${relPath}`);
    return res.json();
  }

  // learnsets は重いので必要になった時だけ読み込みます（初期表示を軽くするため）
  let learnsetsPromise = null;
  async function ensureLearnsets() {
    if (state.learnsets) return state.learnsets;
    if (!learnsetsPromise) {
      setStatus("技の習得データ（learnset）を読み込み中…", "note");
      learnsetsPromise = fetchJson("./dex/ps/learnsets.json")
        .then(ls => {
          state.learnsets = ls;
          state.learnsetCache = new Map();
          setStatus("learnset 読み込み完了", "ok");
          return ls;
        })
        .catch(err => {
          learnsetsPromise = null;
          throw err;
        });
    }
    return learnsetsPromise;
  }


  async function loadDex() {
    if (location.protocol === "file:") {
      throw new Error("file:// 直開きだとブラウザ制限でJSONを読めません。Cloudflare Pages等に置いたURLで開いてください。");
    }
    setStatus("図鑑データを読み込み中…（初回は少し重い）");
    const [pokedex, moves, setsWrap, jpPokemonList, jpItemList, moveEnJa] = await Promise.all([
      fetchJson("./dex/ps/pokedex.json"),
      fetchJson("./dex/ps/moves.json"),
      fetchJson("./dex/ps/sets/gen9ou.json"),
      fetchJson("./dex/jp/POKEMON_ALL.json"),
      fetchJson("./dex/jp/ITEM_ALL.json"),
      fetchJson("./dex/jp/move_en_ja.json"),
    ]);

    state.pokedex = pokedex;
    state.moves = moves;
    state.learnsets = null;
    state.sets = setsWrap && setsWrap.dex ? setsWrap.dex : (setsWrap || {});
    state.jpMoveByEn = new Map(Object.entries(moveEnJa || {}));

    // merge cached translations (browser localStorage)
    const cache = loadI18nCache();
    if (cache.move) for (const [en,ja] of Object.entries(cache.move)) state.jpMoveByEn.set(en, ja);
    if (cache.ability) state.jpAbilityByEn = new Map(Object.entries(cache.ability));

    // move maps
    state.moveIdByName = new Map();
    state.moveNameById = new Map();
    for (const [id, m] of Object.entries(moves)) {
      if (!m || !m.name) continue;
      state.moveIdByName.set(m.name, id);
      state.moveNameById.set(id, m.name);
    }


    // prebuild move options for fast search (avoid rebuilding on every key press)
    state.moveOptionsAll = [];
    state.moveOptionById = new Map();
    for (const [id, m] of Object.entries(moves)) {
      if (!m || !m.name) continue;
      const en = m.name;
      const ja = state.jpMoveByEn.get(en) || "";
      const label = ja || en;
      const opt = {id, en, label, search: normalize(`${ja} ${en}`)};
      state.moveOptionsAll.push(opt);
      state.moveOptionById.set(id, opt);
    }
    state.moveOptionsAll.sort((a,b) => a.label.localeCompare(b.label, "ja"));

    // pokemon jp map: use pkmn_id_name (showdown id)
    state.jpPokemonById = new Map();
    for (const p of jpPokemonList || []) {
      const sid = p.pkmn_id_name || p.pokeapi_pokemon_id_name;
      if (!sid) continue;
      const jaBase = p.pokeapi_species_name_ja || p.yakkuncom_name || p.pokeapi_species_name_en || "";
      const jaForm = p.pokeapi_form_name_ja || "";
      const ja = jaForm && jaForm !== "なし" ? `${jaBase}（${jaForm}）` : jaBase;
      const en = p.pkmn_name || p.pokeapi_species_name_en || sid;
      state.jpPokemonById.set(normalizeId(sid), {ja, en});
    }

    // item map
    state.jpItemByEn = new Map();
    state.itemEnByJa = new Map();
    state.itemOptions = [];
    for (const it of jpItemList || []) {
      if (!it || !it.name_en) continue;
      state.jpItemByEn.set(it.name_en, it.name_ja || it.name_en);
      if (it.name_ja) state.itemEnByJa.set(it.name_ja, it.name_en);
      state.itemOptions.push({
        en: it.name_en,
        ja: it.name_ja || it.name_en,
        search: normalize((it.name_ja||"") + " " + it.name_en)
      });
    }

    // species options from pokedex keys
    state.speciesOptions = Object.keys(pokedex).map(id => {
      const sid = normalizeId(id);
      const p = pokedex[id];
      const en = p?.name || id;
      const jp = state.jpPokemonById.get(sid);
      const ja = jp?.ja || "";
      return {id: sid, en, ja, search: normalize(`${ja} ${en} ${sid}`)};
    }).sort((a,b) => (a.ja||a.en).localeCompare(b.ja||b.en, "ja"));

    state.dexLoaded = true;

    // Re-parse regulation CSV now that dex/jp names are loaded (for JP name rows)
    if (state.reg.rawCsv) {
      const r = parseRegCsvText(state.reg.rawCsv);
      state.reg.allowed = r.allowed;
      state.reg.unknown = r.unknown;
      state.reg.loaded = true;
      updateRegInfo();
      if (state.ui.regEnabled && !state.reg.loaded) state.ui.regEnabled = false;
    }

    $("#btnExport").disabled = false;
    $("#btnSim").disabled = false;
    const ids = ["#btnClearPicks", "#btnAutoLeft", "#btnAutoRight", "#btnAutoBoth", "#toggleHideRight", "#btnAutoTeamLeft", "#btnClearTeamLeft", "#btnAutoTeamRight", "#btnClearTeamRight", "#toggleNoLegends"];
    for (const sel of ids) {
      const e = $(sel);
      if (!e) continue;
      if (sel !== "#toggleHideRight") e.disabled = false;
    }
    $("#btnLoad").disabled = true;

    setStatus("読み込み完了。チームを組んでください。", "ok");
    renderAll();
  }

  function normalizeId(id){
    return normalize(id).replace(/[^a-z0-9]/g, "");
  }

  function getPokedexEntry(id){
    return state.pokedex?.[id] || null;
  }

  function collectTagsWithBase(p){
    const tags = [];
    if (p?.tags) tags.push(...p.tags);
    const baseName = p?.baseSpecies || p?.baseForme;
    if (baseName) {
      const baseId = normalizeId(baseName);
      const bp = state.pokedex?.[baseId];
      if (bp?.tags) tags.push(...bp.tags);
    }
    return tags;
  }

  function isLegendLikeId(id){
    const p = getPokedexEntry(id);
    if (!p) return false;
    const tags = collectTagsWithBase(p);
    return tags.some(t => /Restricted Legendary/i.test(t) || /Sub-Legendary/i.test(t) || /Mythical/i.test(t));
  }

  function isPlayableSpeciesId(id){
    const p = getPokedexEntry(id);
    if (!p) return false;
    if (p.isNonstandard) return false;
    if (p.battleOnly) return false;
    return true;
  }

  function isAllowedByNormalRules(id){
    if (!state.ui.normalRules) return true;
    if (state.ui.noLegends && isLegendLikeId(id)) return false;
    return true;
  }

  function isAllowedByRegulation(id){
    if (!state.ui.regEnabled) return true;
    if (!state.reg.loaded) return false;
    return state.reg.allowed.has(id);
  }

  function isSpeciesAllowed(id){
    return isAllowedByNormalRules(id) && isAllowedByRegulation(id);
  }

  function getFilteredSpeciesOptions(){
    const opts = state.speciesOptions || [];
    // If dex not yet loaded, show empty list to avoid invalid picks
    if (!state.pokedex) return [];
    return opts.filter(o => isPlayableSpeciesId(o.id) && isSpeciesAllowed(o.id));
  }

    function parseRegCsvText(text){
      const raw = (text||"").replace(/^\uFEFF/, "");
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) return {allowed:new Set(), unknown:[]};

      // Support multiple formats:
      //  - Legacy: id,allow  (key can be Showdown id or name)
      //  - DexNo/Name: No,名前,allow  (order can vary)
      const allowed = new Set();
      const unknown = [];

      const firstCols = lines[0].split(",").map(s => s.trim());
      const firstLow  = firstCols.map(s => s.toLowerCase());

      const hasHeader =
        firstLow.some(h => h.includes("id")) ||
        firstLow.some(h => h.includes("allow")) ||
        firstCols.some(h => /^(no|No|図鑑番号|図鑑|dex)$/i.test(h)) ||
        firstCols.some(h => /^(name|名前|ポケモン名)$/i.test(h));

      let start = 0;
      let colId = 0, colAllow = 1, colNo = -1, colName = -1;

      if (hasHeader) {
        start = 1;
        for (let j=0; j<firstCols.length; j++){
          const h = firstCols[j].trim();
          const hl = h.toLowerCase();
          if (hl.includes("id")) colId = j;
          if (hl.includes("allow") || hl.includes("reg") || h.includes("判定") || h.includes("採用") || h.includes("使用")) colAllow = j;
          if (hl === "no" || hl.includes("dex") || h.includes("図鑑")) colNo = j;
          if (hl.includes("name") || h.includes("名前") || h.includes("ポケモン")) colName = j;
        }
      }

      function resolveByName(name){
        const nk = normalize(name);
        for (const [sid, v] of state.jpPokemonById.entries()) {
          if (normalize(v.ja) === nk || normalize(v.en) === nk) return sid;
        }
        // fallback: compare with English name in pokedex
        if (state.pokedex) {
          for (const [sid, p] of Object.entries(state.pokedex)) {
            if (p?.name && normalize(p.name) === nk) return sid;
          }
        }
        return "";
      }

      function resolveByDexNo(no, nameHint){
        if (!state.pokedex) return [];
        const n = Number(no);
        if (!Number.isFinite(n) || n <= 0) return [];
        let matches = [];
        for (const [sid, p] of Object.entries(state.pokedex)) {
          if (Number(p?.num) === n && isPlayableSpeciesId(sid)) matches.push(sid);
        }
        if (!matches.length) return [];

        if (nameHint) {
          const nk = normalize(nameHint);
          const byName = matches.filter(sid => {
            const jp = state.jpPokemonById.get(sid);
            if (jp && (normalize(jp.ja) === nk || normalize(jp.en) === nk)) return true;
            const en = state.pokedex[sid]?.name;
            return en && normalize(en) === nk;
          });
          if (byName.length) matches = byName;
        }

        // Prefer base (non-forme) entries when ambiguous
        const base = matches.filter(sid => {
          const p = state.pokedex[sid];
          const formeOk = !p?.forme;
          const baseOk = !p?.baseSpecies || p.baseSpecies === p.name;
          return formeOk && baseOk;
        });
        return base.length ? base : matches;
      }

      for (let i=start; i<lines.length; i++){
        const line = lines[i];
        if (!line || line.startsWith("#")) continue;
        const cols = line.split(",").map(s => s.trim());

        const allowStr = (cols[(hasHeader ? colAllow : 1)] ?? "true").toString().trim().toLowerCase();
        const allow = ["true","1","yes","y","on","t","〇","○"].includes(allowStr);
        if (!allow) continue;

        // Pick values
        const rawId   = (hasHeader ? (cols[colId]   ?? "") : (cols[0] ?? ""));
        const rawNo   = (hasHeader && colNo   >= 0) ? (cols[colNo]   ?? "") : "";
        const rawName = (hasHeader && colName >= 0) ? (cols[colName] ?? "") : "";

        // Legacy fallback: if first col is numeric, treat as DexNo
        const legacyKey = (!hasHeader ? (cols[0] ?? "") : "");
        const legacyIsNo = (!hasHeader && /^[0-9]+$/.test(legacyKey));

        // 1) id first
        let id = "";
        if (rawId) id = normalizeId(rawId);

        // If id looks like a JP name, try resolve by name map
        if ((!id || (state.pokedex && !state.pokedex[id])) && (rawName || (!legacyIsNo && rawId && !/^[0-9]+$/.test(rawId)))) {
          const nameToUse = rawName || rawId;
          const sid = resolveByName(nameToUse);
          if (sid) id = sid;
        }

        // 2) DexNo
        if ((!id || (state.pokedex && !state.pokedex[id])) && (rawNo || legacyIsNo)) {
          const noToUse = rawNo || legacyKey;
          const ids = resolveByDexNo(noToUse, rawName);
          if (ids.length) {
            ids.forEach(s => allowed.add(s));
            continue;
          }
        }

        if (!id) continue;

        if (state.pokedex && !state.pokedex[id]) {
          unknown.push(rawName || rawId || rawNo || legacyKey || "");
          continue;
        }
        allowed.add(id);
      }
      return {allowed, unknown};
    }

  async function loadRegulationFromUrl(url = DEFAULT_REG_URL){
    try{
      const res = await fetch(url, {cache:"no-store"});
      if (!res.ok) return false;
      const text = await res.text();
      if (!text || !text.trim()) return false;
      state.reg.rawCsv = text;
      try{ localStorage.setItem(REG_CSV_KEY, text); }catch{}

      // If dex already loaded, parse immediately. Otherwise, it will be parsed after dex load.
      if (state.dexLoaded) {
        const r = parseRegCsvText(text);
        state.reg.allowed = r.allowed;
        state.reg.unknown = r.unknown;
        state.reg.loaded = true;
        updateRegInfo();
      } else {
        state.reg.loaded = false;
        updateRegInfo();
      }
      return true;
    }catch{
      return false;
    }
  }

  function loadRegulationFromStorage(){
    try{
      const raw = localStorage.getItem(REG_CSV_KEY) || "";
      if (raw) {
        state.reg.rawCsv = raw;
        // If dex not loaded yet, we'll re-parse after dex load
        const r = parseRegCsvText(raw);
        state.reg.allowed = r.allowed;
        state.reg.unknown = r.unknown;
        state.reg.loaded = true;
      }
      const regEnabled = localStorage.getItem(REG_ENABLED_KEY);
      if (regEnabled != null) state.ui.regEnabled = (regEnabled === "true");
      const normalRules = localStorage.getItem(NORMAL_RULES_KEY);
      if (normalRules != null) state.ui.normalRules = (normalRules === "true");
      const noLeg = localStorage.getItem(NO_LEGENDS_KEY);
      if (noLeg != null) state.ui.noLegends = (noLeg === "true");
      if (state.ui.regEnabled && !state.reg.loaded) state.ui.regEnabled = false;
    }catch{}
  }

  function updateRegInfo(){
    const elInfo = $("#regInfo");
    if (!elInfo) return;
    if (!state.reg.loaded) {
      elInfo.textContent = "レギュ: 未設定";
      return;
    }
    const n = state.reg.allowed.size;
    const u = state.reg.unknown?.length || 0;
    elInfo.textContent = u ? `レギュ: ${n}匹（不明${u}件）` : `レギュ: ${n}匹`;
  }

  function syncHeaderToggles(){
    const normal = $("#toggleNormalRules");
    if (normal) normal.checked = !!state.ui.normalRules;

      const normalRules = $("#toggleNormalRules");
  if (normalRules) {
    normalRules.addEventListener("change", (e) => {
      state.ui.normalRules = !!e.target.checked;
      try{ localStorage.setItem(NORMAL_RULES_KEY, String(state.ui.normalRules)); }catch{}
      const noLeg = $("#toggleNoLegends");
      if (noLeg) noLeg.disabled = !state.ui.normalRules;
      renderAll();
    });
  }

  const noLeg = $("#toggleNoLegends");
  if (noLeg) {
    noLeg.addEventListener("change", (e) => {
      state.ui.noLegends = !!e.target.checked;
      try{ localStorage.setItem(NO_LEGENDS_KEY, String(state.ui.noLegends)); }catch{}
      renderAll();
    });
  }

  const regToggle = $("#toggleReg");
  if (regToggle) {
    regToggle.addEventListener("change", async (e) => {
      const want = !!e.target.checked;
      if (want) {
        if (!state.dexLoaded) {
          e.target.checked = false;
          setStatus("先に「図鑑データ読み込み」をしてください。", "err");
          return;
        }
        if (!state.reg.loaded) {
          setStatus("レギュCSV未読込です。サイト直下の regulation.csv を探します…", "note");
          const ok = await loadRegulationFromUrl(DEFAULT_REG_URL);
          if (ok && state.dexLoaded) {
            // Parse now that dex is loaded
            const r = parseRegCsvText(state.reg.rawCsv);
            state.reg.allowed = r.allowed;
            state.reg.unknown = r.unknown;
            state.reg.loaded = true;
            updateRegInfo();
            setStatus(`同梱 regulation.csv を読み込みました（${state.reg.allowed.size}匹）。`, "ok");
          }
          if (!state.reg.loaded) {
            e.target.checked = false;
            state.ui.regEnabled = false;
            setStatus("レギュCSVが未読込です。上部の「レギュCSV読込」か、ルートに regulation.csv を置いてください。", "err");
            return;
          }
        }
      }
      state.ui.regEnabled = want;
      try{ localStorage.setItem(REG_ENABLED_KEY, String(state.ui.regEnabled)); }catch{}
      scheduleRenderAll();
    });
  }

  const btnRegDefault = $("#btnLoadRegDefault");
  if (btnRegDefault) {
    btnRegDefault.addEventListener("click", async () => {
      if (!state.dexLoaded) {
        setStatus("先に「図鑑データ読み込み」をしてください。", "err");
        return;
      }
      setStatus("同梱 regulation.csv を読み込み中…", "note");
      const ok = await loadRegulationFromUrl(DEFAULT_REG_URL);
      if (!ok) {
        setStatus("同梱 regulation.csv が見つかりません（/regulation.csv）。ファイル名と配置場所を確認してください。", "err");
        return;
      }
      const r = parseRegCsvText(state.reg.rawCsv);
      state.reg.allowed = r.allowed;
      state.reg.unknown = r.unknown;
      state.reg.loaded = true;
      updateRegInfo();
      setStatus(`同梱 regulation.csv を読み込みました（${state.reg.allowed.size}匹）。`, "ok");
      if (state.ui.regEnabled) scheduleRenderAll();
    });
  }

  const regFile = $("#fileRegCsv");
  if (regFile) {
    regFile.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const text = await f.text();
      state.reg.rawCsv = text;
      try{ localStorage.setItem(REG_CSV_KEY, text); }catch{}
      // Parse (if dex loaded, JP rows can resolve too)
      const r = parseRegCsvText(text);
      state.reg.allowed = r.allowed;
      state.reg.unknown = r.unknown;
      state.reg.loaded = true;
      updateRegInfo();
      setStatus(`レギュCSVを読み込みました（${state.reg.allowed.size}匹）。`, "ok");
      if (state.ui.regEnabled) renderAll();
      e.target.value = "";
    });
  }
const hideToggle = $("#toggleHideRight");
  if (hideToggle) {
    hideToggle.addEventListener("change", (e) => {
      state.ui.hideRightPicks = !!e.target.checked;
      renderAll();
    });
  }

  const clearBtn = $("#btnClearPicks");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearPicks("left");
      clearPicks("right");
      renderAll();
      setStatus("選出をリセットしました。", "ok");
    });
  }

  const autoL = $("#btnAutoLeft");
  if (autoL) autoL.addEventListener("click", () => autoPick("left"));
  const autoR = $("#btnAutoRight");
  if (autoR) autoR.addEventListener("click", () => autoPick("right"));
  const autoB = $("#btnAutoBoth");
  if (autoB) autoB.addEventListener("click", () => autoPickBoth());

  const autoTL = $("#btnAutoTeamLeft");
  if (autoTL) autoTL.addEventListener("click", () => autoFillTeam("left"));
  const clearTL = $("#btnClearTeamLeft");
  if (clearTL) clearTL.addEventListener("click", () => clearTeam("left"));

  const autoTR = $("#btnAutoTeamRight");
  if (autoTR) autoTR.addEventListener("click", () => autoFillTeam("right"));
  const clearTR = $("#btnClearTeamRight");
  if (clearTR) clearTR.addEventListener("click", () => clearTeam("right"));

  $("#btnSim").addEventListener("click", simulate);

  loadRegulationFromStorage();
  syncHeaderToggles();

  // initial status
  setStatus("まず「図鑑データ読み込み」を押してください。※新しめの技/特性は、表示時にネット経由で日本語名を自動取得して端末にキャッシュします。");
})();
