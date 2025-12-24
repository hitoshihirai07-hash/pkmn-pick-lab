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
      noLegends: true,
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

  // --- Type chart (Gen9) ---
  // multipliers: 0, 0.5, 1, 2

  const TYPE_JA = {
    Normal: "ノーマル", Fire: "ほのお", Water: "みず", Electric: "でんき", Grass: "くさ", Ice: "こおり",
    Fighting: "かくとう", Poison: "どく", Ground: "じめん", Flying: "ひこう", Psychic: "エスパー", Bug: "むし",
    Rock: "いわ", Ghost: "ゴースト", Dragon: "ドラゴン", Dark: "あく", Steel: "はがね", Fairy: "フェアリー",
  };
  const TYPE_CHART = {
    Normal:   {Rock:.5, Ghost:0, Steel:.5},
    Fire:     {Fire:.5, Water:.5, Grass:2, Ice:2, Bug:2, Rock:.5, Dragon:.5, Steel:2},
    Water:    {Fire:2, Water:.5, Grass:.5, Ground:2, Rock:2, Dragon:.5},
    Electric: {Water:2, Electric:.5, Grass:.5, Ground:0, Flying:2, Dragon:.5},
    Grass:    {Fire:.5, Water:2, Grass:.5, Poison:.5, Ground:2, Flying:.5, Bug:.5, Rock:2, Dragon:.5, Steel:.5},
    Ice:      {Fire:.5, Water:.5, Grass:2, Ice:.5, Ground:2, Flying:2, Dragon:2, Steel:.5},
    Fighting: {Normal:2, Ice:2, Poison:.5, Flying:.5, Psychic:.5, Bug:.5, Rock:2, Ghost:0, Dark:2, Steel:2, Fairy:.5},
    Poison:   {Grass:2, Poison:.5, Ground:.5, Rock:.5, Ghost:.5, Steel:0, Fairy:2},
    Ground:   {Fire:2, Electric:2, Grass:.5, Poison:2, Flying:0, Bug:.5, Rock:2, Steel:2},
    Flying:   {Electric:.5, Grass:2, Fighting:2, Bug:2, Rock:.5, Steel:.5},
    Psychic:  {Fighting:2, Poison:2, Psychic:.5, Dark:0, Steel:.5},
    Bug:      {Fire:.5, Grass:2, Fighting:.5, Poison:.5, Flying:.5, Psychic:2, Ghost:.5, Dark:2, Steel:.5, Fairy:.5},
    Rock:     {Fire:2, Ice:2, Fighting:.5, Ground:.5, Flying:2, Bug:2, Steel:.5},
    Ghost:    {Normal:0, Psychic:2, Ghost:2, Dark:.5},
    Dragon:   {Dragon:2, Steel:.5, Fairy:0},
    Dark:     {Fighting:.5, Psychic:2, Ghost:2, Dark:.5, Fairy:.5},
    Steel:    {Fire:.5, Water:.5, Electric:.5, Ice:2, Rock:2, Fairy:2, Steel:.5},
    Fairy:    {Fire:.5, Fighting:2, Poison:.5, Dragon:2, Dark:2, Steel:.5},
  };

  function typeEffect(attType, defTypes){
    let m = 1;
    for (const dt of defTypes) {
      const row = TYPE_CHART[attType] || {};
      const v = (dt in row) ? row[dt] : 1;
      m *= v;
    }
    return m;
  }

  // --- Stats (only speed for now) ---
  const NATURES = [
    {en:"Hardy", ja:"がんばりや", plus:null, minus:null},
    {en:"Lonely", ja:"さみしがり", plus:"atk", minus:"def"},
    {en:"Brave", ja:"ゆうかん", plus:"atk", minus:"spe"},
    {en:"Adamant", ja:"いじっぱり", plus:"atk", minus:"spa"},
    {en:"Naughty", ja:"やんちゃ", plus:"atk", minus:"spd"},
    {en:"Bold", ja:"ずぶとい", plus:"def", minus:"atk"},
    {en:"Docile", ja:"すなお", plus:null, minus:null},
    {en:"Relaxed", ja:"のんき", plus:"def", minus:"spe"},
    {en:"Impish", ja:"わんぱく", plus:"def", minus:"spa"},
    {en:"Lax", ja:"のうてんき", plus:"def", minus:"spd"},
    {en:"Timid", ja:"おくびょう", plus:"spe", minus:"atk"},
    {en:"Hasty", ja:"せっかち", plus:"spe", minus:"def"},
    {en:"Serious", ja:"まじめ", plus:null, minus:null},
    {en:"Jolly", ja:"ようき", plus:"spe", minus:"spa"},
    {en:"Naive", ja:"むじゃき", plus:"spe", minus:"spd"},
    {en:"Modest", ja:"ひかえめ", plus:"spa", minus:"atk"},
    {en:"Mild", ja:"おっとり", plus:"spa", minus:"def"},
    {en:"Quiet", ja:"れいせい", plus:"spa", minus:"spe"},
    {en:"Bashful", ja:"てれや", plus:null, minus:null},
    {en:"Rash", ja:"うっかりや", plus:"spa", minus:"spd"},
    {en:"Calm", ja:"おだやか", plus:"spd", minus:"atk"},
    {en:"Gentle", ja:"おとなしい", plus:"spd", minus:"def"},
    {en:"Sassy", ja:"なまいき", plus:"spd", minus:"spe"},
    {en:"Careful", ja:"しんちょう", plus:"spd", minus:"spa"},
    {en:"Quirky", ja:"きまぐれ", plus:null, minus:null},
  ];
  const natureMap = new Map(NATURES.map(n => [n.en, n]));

  function calcSpeed(mon){
    if (!mon.speciesId) return 0;
    const p = state.pokedex[mon.speciesId];
    if (!p || !p.baseStats) return 0;
    const base = p.baseStats.spe || 0;
    const iv = (mon.ivSpe === 0) ? 0 : 31;
    const ev = clampInt(mon.evs.spe, 0, 252);
    const level = 50;
    let stat = Math.floor(((2*base + iv + Math.floor(ev/4)) * level) / 100) + 5;
    const nat = natureMap.get(mon.nature);
    let mult = 1.0;
    if (nat?.plus === "spe") mult = 1.1;
    if (nat?.minus === "spe") mult = 0.9;
    stat = Math.floor(stat * mult);
    return stat;
  }



  function calcStat(mon, key){
    if (!mon.speciesId) return 0;
    const p = state.pokedex[mon.speciesId];
    if (!p || !p.baseStats) return 0;
    const base = p.baseStats[key] || 0;
    const level = 50;
    const ev = clampInt(mon.evs[key] || 0, 0, 252);
    const iv = (key === "spe") ? ((mon.ivSpe === 0) ? 0 : 31) : 31;
    if (key === "hp") {
      return Math.floor(((2*base + iv + Math.floor(ev/4)) * level) / 100) + level + 10;
    }
    let stat = Math.floor(((2*base + iv + Math.floor(ev/4)) * level) / 100) + 5;
    const nat = natureMap.get(mon.nature);
    let mult = 1.0;
    if (nat?.plus === key) mult = 1.1;
    if (nat?.minus === key) mult = 0.9;
    return Math.floor(stat * mult);
  }

  function calcAllStats(mon){
    return {
      hp: calcStat(mon, "hp"),
      atk: calcStat(mon, "atk"),
      def: calcStat(mon, "def"),
      spa: calcStat(mon, "spa"),
      spd: calcStat(mon, "spd"),
      spe: calcStat(mon, "spe"),
    };
  }

  function evTotal(mon){
    const e = mon.evs || {};
    return (e.hp||0)+(e.atk||0)+(e.def||0)+(e.spa||0)+(e.spd||0)+(e.spe||0);
  }

  // --- Rendering slots ---
  function renderAll() {
    resetDismissRegistry();
    renderTeam("left", $("#leftSlots"));
    renderTeam("right", $("#rightSlots"));
    $("#toggleLearnset").checked = state.filterLearnset;
    const hide = $("#toggleHideRight");
    if (hide) hide.checked = !!state.ui.hideRightPicks;
    const noLeg = $("#toggleNoLegends");
    if (noLeg) noLeg.checked = !!state.ui.noLegends;
    updateHints();
  }

  function renderTeam(side, root){
    root.innerHTML = "";
    state.teams[side].forEach((mon, idx) => {
      root.appendChild(renderMonCard(side, idx, mon));
    });
  }

  function countPicked(side){
    return (state.teams[side] || []).filter(m => m && m.pick && m.speciesId).length;
  }
  function countFilled(side){
    return (state.teams[side] || []).filter(m => m && m.speciesId).length;
  }
  function updateHints(){
    const lP = countPicked("left");
    const rP = countPicked("right");
    const lF = countFilled("left");
    const rF = countFilled("right");
    const lh = $("#leftHint");
    const rh = $("#rightHint");
    if (lh) lh.textContent = `登録: ${lF}/6  選出: ${lP}/3`;
    if (rh) rh.textContent = `登録: ${rF}/6  選出: ${state.ui.hideRightPicks ? "（非表示）" : (rP+"/3")}`;
  }

  function renderMonCard(side, idx, mon) {
    const title = el("div", {class:"slotHead"},
      el("div", {class:"left"},
        el("span", {class:"badge"}, `#${idx+1}`),
        el("label", {style:"display:flex; gap:8px; align-items:center; font-size:12px; color:var(--muted);"},
          el("input", {type:"checkbox", checked: mon.pick ? "" : null}),
          "選出"
        )
      ),
      el("div", {class:"small"}, mon.speciesId ? fmtSpecies(mon.speciesId) : "未選択")
    );

    // Hook pick checkbox (optionally hide opponent picks)
    const pickInput = title.querySelector("input[type=checkbox]");
    const hideOppPick = (side === "right" && !!state.ui.hideRightPicks);
    if (hideOppPick) {
      // Keep internal state, but don't show/allow toggling.
      if (pickInput) {
        pickInput.disabled = true;
        pickInput.style.display = "none";
        const label = pickInput.parentElement;
        if (label) {
          // Replace visible text
          label.lastChild && (label.lastChild.nodeValue = "選出（非表示）");
        }
      }
    } else {
      pickInput?.addEventListener("change", (e) => {
        mon.pick = !!e.target.checked;
        updateHints();
      });
    }

    const speciesBox = createSearchBox({
      placeholder: "ポケモン名（日本語/英語）で検索",
      getOptions: () => state.speciesOptions,
      onPick: (o) => {
        mon.speciesId = o.id;
        // default ability
        const ab = getAbilities(mon.speciesId);
        mon.ability = ab[0] || "";
        // fetch JP ability names (best-effort, cached)
        for (const a of ab) { if (a && !state.jpAbilityByEn.has(a)) ensureAbilityJa(a); }
        // clear moves if now illegal under learnset filter
        if (state.filterLearnset) {
          const allowed = getAllowedMoveIds(mon.speciesId);
          mon.moves = mon.moves.map(m => (m && allowed.has(m)) ? m : "");
        }
        renderAll();
      },
      formatLabel: (o) => `${o.ja || o.en}`
    });

    if (mon.speciesId) speciesBox.setValue(state.jpPokemonById.get(mon.speciesId)?.ja || state.pokedex[mon.speciesId]?.name || "");

    const abilitySel = el("select");
    const abilities = getAbilities(mon.speciesId);
    abilitySel.appendChild(el("option", {value:""}, "（未選択）"));
    for (const a of abilities) {
      // lazy fetch Japanese name
      if (a && !state.jpAbilityByEn.has(a)) {
        ensureAbilityJa(a).then(() => scheduleRenderAll());
      }
      abilitySel.appendChild(el("option", {value:a}, fmtAbility(a)));
    }
    abilitySel.value = mon.ability || "";
    abilitySel.addEventListener("change", e => mon.ability = e.target.value);

    const itemBox = createSearchBox({
      placeholder: "持ち物（日本語/英語）で検索",
      getOptions: () => state.itemOptions,
      onPick: (o) => {
        mon.item = o.en;
        renderAll();
      },
      formatLabel: (o) => `${o.ja}`
    });

    // show current item
    if (mon.item) {
      const en = mon.item;
      const ja = state.jpItemByEn.get(en) || en;
      itemBox.setValue(ja);
    }

    const teraSel = el("select");
    const TYPES = Object.keys(TYPE_CHART);
    teraSel.appendChild(el("option", {value:""}, "（自由）"));
    for (const t of TYPES) teraSel.appendChild(el("option", {value:t}, `${TYPE_JA[t]||t}`));
    teraSel.value = mon.teraType || "";
    teraSel.addEventListener("change", e => mon.teraType = e.target.value);

    let updateComputed = () => {};

    const natureSel = el("select");
    for (const n of NATURES) {
      natureSel.appendChild(el("option", {value:n.en}, n.ja));
    }
    natureSel.value = mon.nature || "Serious";
    natureSel.addEventListener("change", e => { mon.nature = e.target.value; updateComputed(); });

        const ivSel = el("select");
        ivSel.appendChild(el("option", {value:"31"}, "S個体値 31"));
        ivSel.appendChild(el("option", {value:"0"}, "S個体値 0"));
        ivSel.value = String(mon.ivSpe === 0 ? 0 : 31);
        ivSel.addEventListener("change", e => { mon.ivSpe = (e.target.value === "0" ? 0 : 31); updateComputed(); });
    
        function makeEvField(label, key){
          const input = el("input", {type:"number", min:"0", max:"252", step:"4"});
          input.value = String(mon.evs[key] || 0);
    
          const apply = () => {
            mon.evs[key] = clampInt(input.value, 0, 252);
            input.value = String(mon.evs[key] || 0);
            updateComputed();
          };
          input.addEventListener("input", apply);
    
          const btn0 = el("button", {class:"mini", type:"button"}, "0");
          const btn252 = el("button", {class:"mini", type:"button"}, "252");
          btn0.addEventListener("click", () => { input.value = "0"; apply(); });
          btn252.addEventListener("click", () => { input.value = "252"; apply(); });
    
          const row = el("div", {class:"evRow"}, input, el("div", {class:"evBtns"}, btn0, btn252));
          const field = el("div", {class:"field"}, el("label", {}, label), row);
          return {field, input, btn0, btn252};
        }
    
        // 努力値（全部表示）
        const evHp = makeEvField("努力値H", "hp");
        const evAtk = makeEvField("努力値A", "atk");
        const evDef = makeEvField("努力値B", "def");
        const evSpa = makeEvField("努力値C", "spa");
        const evSpd = makeEvField("努力値D", "spd");
        const evSpe = makeEvField("努力値S", "spe");
    
        const evTotalEl = el("div", {class:"small mono statLine"});
        const statEl = el("div", {class:"small mono statLine"});
        const bulkEl = el("div", {class:"small mono statLine"});
    
        updateComputed = () => {
          if (!mon.speciesId) {
            evTotalEl.textContent = "";
            statEl.textContent = "";
            bulkEl.textContent = "";
            return;
          }
          const tot = evTotal(mon);
          evTotalEl.textContent = `EV合計: ${tot}/510`;
          evTotalEl.className = "small mono statLine" + (tot > 510 ? " warn" : "");
          const st = calcAllStats(mon);
          statEl.textContent = `実数値 Lv50: H${st.hp} A${st.atk} B${st.def} C${st.spa} D${st.spd} S${st.spe}`;
          bulkEl.textContent = `耐久指数: 物理${st.hp * st.def} / 特殊${st.hp * st.spd}`;
        };
    
        updateComputed();
    
        // Set suggestions
    const setBox = el("div", {class:"field"});
    const setTitle = el("div", {class:"small"}, "セット候補（クリックで反映）");
    const chips = el("div", {class:"chips"});
    const setSuggestions = getSetSuggestions(mon.speciesId, 3);
    if (!setSuggestions.length) {
      chips.appendChild(el("div", {class:"note"}, "（候補なし）"));
    } else {
      for (const s of setSuggestions) {
        const chip = el("span", {class:"chip"}, s.name);
        chip.addEventListener("click", () => {
          applySetToMon(mon, s);
          renderAll();
        });
        chips.appendChild(chip);
      }
    }
    setBox.appendChild(setTitle);
    setBox.appendChild(chips);

    // Move inputs
    const moveWrap = el("div", {class:"field"});
    moveWrap.appendChild(el("label", {}, "技（自由入力 + 検索）"));

    const moveInputs = [];
    for (let i=0;i<4;i++){
      const mi = createMoveSearch(mon, i);
      moveInputs.push(mi);
      moveWrap.appendChild(mi.wrap);
    }

    // Recommended move chips
    const recMoves = getRecommendedMoves(mon.speciesId, 12);
    // lazy fetch Japanese for recommended moves
    for (const mid of recMoves) {
      const en = state.moveNameById.get(mid);
      if (en && !state.jpMoveByEn.has(en)) ensureMoveJa(en).then(() => scheduleRenderAll());
    }
    if (recMoves.length) {
      const recBox = el("div", {class:"chips"});
      for (const mid of recMoves) {
        const enName = state.moveNameById.get(mid) || "";
        if (enName && !state.jpMoveByEn.has(enName)) ensureMoveJa(enName).then(()=>renderAll());
        const chip = el("span", {class:"chip"}, fmtMove(mid));
        chip.addEventListener("click", () => {
          // fill first empty slot
          const j = mon.moves.findIndex(x => !x);
          if (j >= 0) mon.moves[j] = mid;
          else mon.moves[0] = mid;
          renderAll();
        });
        recBox.appendChild(chip);
      }
      moveWrap.appendChild(el("div", {class:"small", style:"margin-top:6px"}, "おすすめ（押すと技枠に入る）"));
      moveWrap.appendChild(recBox);
    }

    // Recommended item chips
    const recItems = getRecommendedItems(mon.speciesId, 8);
    const itemRecBox = el("div", {class:"chips"});
    if (recItems.length) {
      for (const itEn of recItems) {
        const ja = state.jpItemByEn.get(itEn) || itEn;
        const chip = el("span", {class:"chip", title: itEn}, ja);
        chip.addEventListener("click", () => {
          mon.item = itEn;
          renderAll();
        });
        itemRecBox.appendChild(chip);
      }
    }

    const card = el("div", {class:"card"},
      title,
      el("div", {class:"row"},
        el("div", {class:"field"}, el("label", {}, "ポケモン"), speciesBox.wrap),
        setBox
      ),
      el("div", {class:"row"},
        el("div", {class:"field"}, el("label", {}, "特性"), abilitySel),
        el("div", {class:"field"}, el("label", {}, "持ち物"), itemBox.wrap),
        el("div", {class:"field"}, el("label", {}, "テラスタイプ"), teraSel)
      ),
      recItems.length ? el("div", {class:"row"}, el("div", {class:"field"}, el("label", {}, "持ち物おすすめ"), itemRecBox)) : null,
      el("div", {class:"row"},
        el("div", {class:"field"}, el("label", {}, "性格"), natureSel),
        el("div", {class:"field"}, el("label", {}, "S個体値"), ivSel)
      ),
      el("div", {class:"row"}, evHp.field, evDef.field, evSpd.field),
      el("div", {class:"row"}, evAtk.field, evSpa.field, evSpe.field),
      evTotalEl,
      statEl,
      bulkEl,
      el("div", {class:"hr"}),
      moveWrap
    );

    return card;
  }

  function clampInt(v, lo, hi){
    const n = Number(v);
    if (Number.isNaN(n)) return lo;
    return Math.max(lo, Math.min(hi, Math.floor(n)));
  }

  function getAbilities(speciesId){
    if (!speciesId || !state.pokedex?.[speciesId]) return [];
    const abs = state.pokedex[speciesId].abilities || {};
    const list = [];
    for (const k of Object.keys(abs)) list.push(abs[k]);
    return list;
  }

  function getAllowedMoveIds(speciesId){
    if (!speciesId || !state.learnsets) return new Set();
    const sid = normalizeId(speciesId);
    const cached = state.learnsetCache.get(sid);
    if (cached) return cached;
    const s = state.learnsets?.[sid];
    const learn = s?.learnset || {};
    const out = new Set(Object.keys(learn));
    state.learnsetCache.set(sid, out);
    return out;
  }


  function createMoveSearch(mon, moveIndex){
    const wrap = el("div", {class:"searchbox"});
    const input = el("input", {type:"text", placeholder:`技${moveIndex+1}`});
    // set current
    if (mon.moves[moveIndex]) input.value = fmtMove(mon.moves[moveIndex]);

    const list = el("div", {class:"card", style:"display:none; position:relative; padding:6px; margin-top:6px"});
    list.style.maxHeight = "220px";
    list.style.overflow = "auto";

    registerDismiss(wrap, list);

    let t = null;
    const MAX = 25;

    const makeBtn = (label, onClick) => {
      const btn = el("button", {style:"width:100%; text-align:left; border:1px solid var(--line); background:#fff; padding:8px; border-radius:10px; margin:4px 0; cursor:pointer;"},
        label
      );
      btn.addEventListener("click", onClick);
      return btn;
    };

    function renderNow(q){
      if (!state.dexLoaded) return;
      const nq = normalize(q);
      const allowed = (state.filterLearnset && mon.speciesId) ? getAllowedMoveIds(mon.speciesId) : null;

      const out = [];

      if (!nq) {
        // Fast path: show recommended moves first (no full scan)
        const rec = getRecommendedMoves(mon.speciesId, 20);
        for (const id of rec) {
          if (allowed && !allowed.has(id)) continue;
          const opt = state.moveOptionById.get(id);
          out.push(opt ? opt : {id, label: fmtMove(id), search:""});
          if (out.length >= 15) break;
        }
        // Fallback: show a few moves from the global list
        if (!out.length) {
          const src = state.moveOptionsAll || [];
          for (let i=0; i<src.length; i++){
            const opt = src[i];
            if (allowed && !allowed.has(opt.id)) continue;
            out.push(opt);
            if (out.length >= 15) break;
          }
        }
      } else {
        // Scan prebuilt options; stop early
        const src = state.moveOptionsAll || [];
        for (let i=0; i<src.length; i++){
          const opt = src[i];
          if (allowed && !allowed.has(opt.id)) continue;
          if (!opt.search.includes(nq)) continue;
          out.push(opt);
          if (out.length >= MAX) break;
        }
      }

      list.innerHTML = "";
      for (const o of out) {
        const label = o.label || fmtMove(o.id) || "";
        list.appendChild(makeBtn(label, () => {
          mon.moves[moveIndex] = o.id;
          const en = state.moveNameById.get(o.id);
          if (en) ensureMoveJa(en).then(() => scheduleRenderAll());
          scheduleRenderAll();
          list.style.display = "none";
        }));
      }
      list.style.display = out.length ? "block" : "none";
    }

    function schedule(q){
      if (t) clearTimeout(t);
      t = setTimeout(() => renderNow(q), 120);
    }

    input.addEventListener("input", () => schedule(input.value));
    input.addEventListener("focus", () => renderNow(input.value));

    wrap.appendChild(input);
    wrap.appendChild(list);
    return {wrap, input};
  }

  function getSetSuggestions(speciesId, limit=3){
    if (!speciesId || !state.sets) return [];
    const p = state.pokedex?.[speciesId];
    const name = p?.name;
    if (!name) return [];
    const setsFor = state.sets[name];
    if (!setsFor) return [];
    // setsFor is object {SetName: {moves, ability, item, nature, teraType, evs, ivs}}
    const out = [];
    for (const [setName, setObj] of Object.entries(setsFor)) {
      out.push({name:setName, data:setObj});
      if (out.length >= limit) break;
    }
    return out;
  }

  function applySetToMon(mon, set){
    const s = set.data || {};
    if (!mon.speciesId) return;
    if (s.ability) mon.ability = s.ability;
    if (s.item) {
      mon.item = s.item;
    }
    if (s.nature) mon.nature = s.nature;
    if (s.teraType) mon.teraType = s.teraType;
    if (s.evs) mon.evs = {...mon.evs, ...s.evs};
    if (s.ivs && typeof s.ivs.spe === "number") mon.ivSpe = (s.ivs.spe === 0 ? 0 : 31);
    if (Array.isArray(s.moves)) {
      // convert move names to IDs
      const ids = s.moves.map(mn => state.moveIdByName.get(mn) || "").filter(Boolean).slice(0,4);
      while (ids.length < 4) ids.push("");
      mon.moves = ids;
    }
  }

  function getRecommendedMoves(speciesId, limit=12){
    if (!speciesId) return [];
    const p = state.pokedex?.[speciesId];
    const name = p?.name;
    const setsFor = state.sets?.[name];
    if (!setsFor) return [];
    const count = new Map();
    for (const s of Object.values(setsFor)) {
      const moves = s.moves || [];
      for (const mn of moves) {
        const id = state.moveIdByName.get(mn);
        if (!id) continue;
        count.set(id, (count.get(id)||0)+1);
      }
    }
    let arr = [...count.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
    if (state.filterLearnset) {
      const allowed = getAllowedMoveIds(speciesId);
      arr = arr.filter(id=>allowed.has(id));
    }
    return arr.slice(0, limit);
  }

  function getRecommendedItems(speciesId, limit=8){
    if (!speciesId) return [];
    const p = state.pokedex?.[speciesId];
    const name = p?.name;
    const setsFor = state.sets?.[name];
    if (!setsFor) return [];
    const count = new Map();
    for (const s of Object.values(setsFor)) {
      const it = s.item;
      if (!it) continue;
      count.set(it, (count.get(it)||0)+1);
    }
    return [...count.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]).slice(0, limit);
  }

  // --- Export / Import ---
  function exportJson() {
    const payload = {
      v: 2,
      filterLearnset: state.filterLearnset,
      teams: state.teams,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pick-lab.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importJson(file) {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj || !obj.teams) throw new Error("JSON形式が違います");
    state.filterLearnset = !!obj.filterLearnset;
    state.teams = obj.teams;
    // normalize legacy saved items (Japanese -> English)
    try{
      for (const side of ["left","right"]) {
        for (const mon of (state.teams[side]||[])) {
          if (!mon || !mon.item) continue;
          // if already an English item, keep
          if (state.jpItemByEn.has(mon.item)) continue;
          // try Japanese -> English
          const hit = (state.itemOptions||[]).find(o => o.ja === mon.item);
          if (hit) mon.item = hit.en;
        }
      }
    }catch{}
    $("#toggleLearnset").checked = state.filterLearnset;
    renderAll();
  }

  // --- Simple simulation ---
  function getTeamPicks(side){
    return state.teams[side].map((m,i)=>({m,i})).filter(x=>x.m.pick && x.m.speciesId);
  }

  function getTeamAll(side){
    return state.teams[side].map((m,i)=>({m,i})).filter(x=>x.m.speciesId);
  }

  function clearPicks(side){
    for (const m of (state.teams[side]||[])) {
      if (!m) continue;
      m.pick = false;
    }
  }

  function sigmoid(x){
    return 1/(1+Math.exp(-x));
  }

  function estimateDiff(L, R){
    // L and R are arrays of mons
    const bestL = L.map(a => Math.max(...R.map(b => matchupScore(a,b))));
    const bestR = R.map(b => Math.max(...L.map(a => -matchupScore(a,b))));
    const sumL = bestL.reduce((x,y)=>x+y,0);
    const sumR = bestR.reduce((x,y)=>x+y,0);
    return sumL - sumR;
  }

  function pickBest3Minimax(side, oppSide){
    const mine = getTeamAll(side);
    const opp = getTeamAll(oppSide);
    if (mine.length === 0) {
      return {ok:false, msg:"候補がありません。まずポケモンを選んでください。"};
    }
    if (mine.length <= 3) {
      return {ok:true, indices: mine.map(x=>x.i), p: null, oppIndices: null, note:"候補が3体以下なので全選出"};
    }
    if (opp.length === 0) {
      return {ok:true, indices: mine.slice(0,3).map(x=>x.i), p: null, oppIndices: null, note:"相手側が未登録なので先頭3体"};
    }

    let best = {p:-Infinity, indices:null, oppIndices:null};

    for (let a=0; a<mine.length; a++){
      for (let b=a+1; b<mine.length; b++){
        for (let c=b+1; c<mine.length; c++){
          const my3 = [mine[a].m, mine[b].m, mine[c].m];
          // opponent chooses 3 to minimize our win prob
          let worstP = Infinity;
          let worstOpp = null;
          const oppMons = opp;
          const oLen = oppMons.length;
          // if opp <= 3, only one choice
          if (oLen <= 3) {
            const opp3 = oppMons.map(x=>x.m);
            const p = sigmoid(estimateDiff(my3, opp3));
            worstP = p;
            worstOpp = oppMons.map(x=>x.i);
          } else {
            for (let i=0;i<oLen;i++){
              for (let j=i+1;j<oLen;j++){
                for (let k=j+1;k<oLen;k++){
                  const opp3 = [oppMons[i].m, oppMons[j].m, oppMons[k].m];
                  const p = sigmoid(estimateDiff(my3, opp3));
                  if (p < worstP) {
                    worstP = p;
                    worstOpp = [oppMons[i].i, oppMons[j].i, oppMons[k].i];
                  }
                }
              }
            }
          }

          if (worstP > best.p) {
            best = {p: worstP, indices:[mine[a].i, mine[b].i, mine[c].i], oppIndices: worstOpp};
          }
        }
      }
    }
    return {ok:true, indices: best.indices, p: best.p, oppIndices: best.oppIndices, note:null};
  }

  function applyPickIndices(side, indices){
    clearPicks(side);
    for (const idx of indices || []) {
      const m = state.teams[side]?.[idx];
      if (m) m.pick = true;
    }
  }

  function sideJa(side){ return side === "left" ? "左（あなた側）" : "右（相手側）"; }


  function getAutoSpeciesPool(){
    // Prefer OU set pool (more "対戦っぽい"ポケモン) ; fallback to all
    let ids = [];
    try{
      const setKeys = state.sets ? Object.keys(state.sets) : [];
      if (setKeys && setKeys.length) {
        ids = setKeys.map(k => normalizeId(k));
      }
    }catch{}
    if (!ids.length) ids = (state.speciesOptions||[]).map(o => o.id);

    // Filter obvious non-playable / special-only entries
    const out = [];
    for (const id of ids) {
      const p = state.pokedex?.[id];
      if (!p) continue;
      if (p.isNonstandard) continue;
      if (p.battleOnly) continue;
      if (state.ui.noLegends) {
        const tags = p.tags || [];
        // Exclude Restricted Legendary / Mythical (必要なら後で調整可)
        if (tags.some(t => /Restricted Legendary/i.test(t))) continue;
        if (tags.some(t => /Mythical/i.test(t))) continue;
      }
      out.push(id);
    }
    return Array.from(new Set(out));
  }

  function sampleUnique(arr, n){
    const a = arr.slice();
    for (let i=a.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, Math.min(n, a.length));
  }

  function autoFillTeam(side){
    const pool = getAutoSpeciesPool();
    if (pool.length < 6) {
      setStatus("おまかせ候補が足りません（図鑑読み込み後に再度お試しください）。", "err");
      return;
    }
    const chosen = sampleUnique(pool, 6);
    const team = chosen.map(id => {
      const m = makeEmptyMon();
      m.speciesId = id;
      const ab = getAbilities(id);
      m.ability = ab[0] || "";
      for (const a of ab) { if (a && !state.jpAbilityByEn.has(a)) ensureAbilityJa(a); }
      return m;
    });
    state.teams[side] = team;
    renderAll();
    setStatus(`${sideJa(side)}をおまかせで6体選びました（気に入らなければもう一回押してください）。`, "ok");
  }

  function clearTeam(side){
    state.teams[side] = makeEmptyTeam();
    renderAll();
    setStatus(`${sideJa(side)}をクリアしました。`, "note");
  }


  function autoPick(side){
    const oppSide = side === "left" ? "right" : "left";
    const res = pickBest3Minimax(side, oppSide);
    if (!res.ok) {
      setStatus(res.msg, "err");
      return;
    }
    applyPickIndices(side, res.indices);
    renderAll();
    if (res.note) {
      setStatus(`${sideJa(side)}：${res.note}`, "note");
    } else {
      const pct = (typeof res.p === "number") ? `${Math.round(res.p*1000)/10}%` : "";
      setStatus(`${sideJa(side)}をおまかせで選出しました（最悪ケース想定 ${pct}）`, "ok");
    }
  }

  function autoPickBoth(){
    const leftRes = pickBest3Minimax("left", "right");
    if (!leftRes.ok) { setStatus(leftRes.msg, "err"); return; }
    applyPickIndices("left", leftRes.indices);
    // opponent best response (minimize left)
    if (leftRes.oppIndices && leftRes.oppIndices.length === 3) {
      applyPickIndices("right", leftRes.oppIndices);
    } else {
      // fallback: compute right vs left
      const rightRes = pickBest3Minimax("right", "left");
      if (rightRes.ok) applyPickIndices("right", rightRes.indices);
    }
    renderAll();
    setStatus("両方おまかせで選出しました（相手は不利になりにくい選出を想定）", "ok");
  }

  function getMoveTypes(mon){
    const types = [];
    for (const mid of (mon.moves||[])) {
      if (!mid) continue;
      const mv = state.moves?.[mid];
      if (!mv || !mv.type) continue;
      if (mv.category === "Status") continue;
      types.push(mv.type);
    }
    if (!types.length && mon.speciesId) {
      const p = state.pokedex?.[mon.speciesId];
      if (p?.types) types.push(...p.types);
    }
    return [...new Set(types)];
  }

  function getDefTypes(mon){
    const p = state.pokedex?.[mon.speciesId];
    return p?.types || [];
  }

  function matchupScore(a, b){
    const aTypes = getMoveTypes(a);
    const bTypes = getMoveTypes(b);
    const aDef = getDefTypes(a);
    const bDef = getDefTypes(b);

    let aOff = 1;
    for (const t of aTypes) aOff = Math.max(aOff, typeEffect(t, bDef));
    let bOff = 1;
    for (const t of bTypes) bOff = Math.max(bOff, typeEffect(t, aDef));

    const sa = Math.log2(aOff) - Math.log2(bOff);

    // small speed nudge
    const spA = calcSpeed(a);
    const spB = calcSpeed(b);
    const sp = spA && spB ? (spA > spB ? 0.12 : (spA < spB ? -0.12 : 0)) : 0;

    return sa + sp;
  }

  function simulate(){
    const left = getTeamPicks("left");
    const right = getTeamPicks("right");
    const out = $("#simOut");
    out.innerHTML = "";

    if (left.length !== 3 || right.length !== 3) {
      out.appendChild(el("div", {class:"err"}, "左右それぞれ3体だけチェックしてください。"));
      return;
    }

    const L = left.map(x=>x.m);
    const R = right.map(x=>x.m);
    const hideR = !!state.ui.hideRightPicks;

    // table
    const table = el("table", {class:"matchTable"});
    const thead = el("thead", {},
      el("tr", {},
        el("th", {}, "左＼右"),
        ...R.map((m,j)=>el("th", {}, hideR ? `相手${j+1}` : fmtSpecies(m.speciesId)))
      )
    );
    const tbody = el("tbody");
    const scores = [];
    for (let i=0;i<3;i++){
      const tr = el("tr");
      tr.appendChild(el("th", {}, fmtSpecies(L[i].speciesId)));
      for (let j=0;j<3;j++){
        const s = matchupScore(L[i], R[j]);
        scores.push(s);
        tr.appendChild(el("td", {}, s.toFixed(2)));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(thead);
    table.appendChild(tbody);

    // simple aggregate
    // each mon takes best matchup; compare sums
    const bestL = L.map(a => Math.max(...R.map(b => matchupScore(a,b))));
    const bestR = R.map(b => Math.max(...L.map(a => -matchupScore(a,b)))); // mirror
    const sumL = bestL.reduce((x,y)=>x+y,0);
    const sumR = bestR.reduce((x,y)=>x+y,0);
    const diff = sumL - sumR;
    const p = 1/(1+Math.exp(-diff));
    const pct = Math.round(p*1000)/10;

    const headline = el("div", {class:"ok"},
      `左（あなた側）の目安勝率: ${pct}%  /  右: ${(100-pct).toFixed(1)}%` + (hideR ? "（相手選出は非表示）" : "")
    );

    const noteText = hideR
      ? "※タイプ相性＋入力した技タイプ＋S実数値の小さな補正だけ。状態異常・積み・回復・持ち物効果などは未考慮。／相手選出は非表示モードです。"
      : "※タイプ相性＋入力した技タイプ＋S実数値の小さな補正だけ。状態異常・積み・回復・持ち物効果などは未考慮。";
    const note = el("div", {class:"note", style:"margin-top:8px"}, noteText);

    out.appendChild(headline);
    out.appendChild(table);
    out.appendChild(note);
  }

  // --- Wire buttons ---
  $("#btnLoad").addEventListener("click", async () => {
    try{
      await loadDex();
    }catch(e){
      console.error(e);
      setStatus(`図鑑データの読み込みに失敗: ${e.message}`, "err");
    }
  });

  $("#btnExport").addEventListener("click", exportJson);

  $("#fileImport").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try{
      await importJson(f);
      setStatus("読込完了", "ok");
    }catch(err){
      console.error(err);
      setStatus(`読込失敗: ${err.message}`, "err");
    } finally {
      e.target.value = "";
    }
  });

  $("#toggleLearnset").addEventListener("change", async (e) => {
    state.filterLearnset = !!e.target.checked;
    if (state.filterLearnset) {
      try {
        await ensureLearnsets();
      } catch (err) {
        console.error(err);
        setStatus(`learnset 読み込み失敗: ${err.message}`, "err");
        state.filterLearnset = false;
        e.target.checked = false;
      }
    }
    renderAll();
  });

  const noLeg = $("#toggleNoLegends");
  if (noLeg) {
    noLeg.addEventListener("change", (e) => {
      state.ui.noLegends = !!e.target.checked;
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

  // initial status
  setStatus("まず「図鑑データ読み込み」を押してください。※新しめの技/特性は、表示時にネット経由で日本語名を自動取得して端末にキャッシュします。");
})();
