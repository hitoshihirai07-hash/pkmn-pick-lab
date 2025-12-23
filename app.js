// Pick Lab - 対戦・選出シミュレーター（MVP）
// 静的サイト向け：GitHub Pages / Cloudflare Pages でそのまま動く想定

const PS_DATA_BASE = './dex/ps/';
const PS_SETS_BASE = './dex/ps/sets/';
const MOTEMEN_BASE = './dex/jp/';

const CACHE_KEY = 'picklab_cache_v1';

const TYPES = [
  'Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'
];

// nature: plus/minus
const NATURES = [
  {en:'Hardy', ja:'がんばりや', plus:null, minus:null},
  {en:'Lonely', ja:'さみしがり', plus:'atk', minus:'def'},
  {en:'Brave', ja:'ゆうかん', plus:'atk', minus:'spe'},
  {en:'Adamant', ja:'いじっぱり', plus:'atk', minus:'spa'},
  {en:'Naughty', ja:'やんちゃ', plus:'atk', minus:'spd'},

  {en:'Bold', ja:'ずぶとい', plus:'def', minus:'atk'},
  {en:'Docile', ja:'すなお', plus:null, minus:null},
  {en:'Relaxed', ja:'のんき', plus:'def', minus:'spe'},
  {en:'Impish', ja:'わんぱく', plus:'def', minus:'spa'},
  {en:'Lax', ja:'のうてんき', plus:'def', minus:'spd'},

  {en:'Timid', ja:'おくびょう', plus:'spe', minus:'atk'},
  {en:'Hasty', ja:'せっかち', plus:'spe', minus:'def'},
  {en:'Serious', ja:'まじめ', plus:null, minus:null},
  {en:'Jolly', ja:'ようき', plus:'spe', minus:'spa'},
  {en:'Naive', ja:'むじゃき', plus:'spe', minus:'spd'},

  {en:'Modest', ja:'ひかえめ', plus:'spa', minus:'atk'},
  {en:'Mild', ja:'おっとり', plus:'spa', minus:'def'},
  {en:'Quiet', ja:'れいせい', plus:'spa', minus:'spe'},
  {en:'Bashful', ja:'てれや', plus:null, minus:null},
  {en:'Rash', ja:'うっかりや', plus:'spa', minus:'spd'},

  {en:'Calm', ja:'おだやか', plus:'spd', minus:'atk'},
  {en:'Gentle', ja:'おとなしい', plus:'spd', minus:'def'},
  {en:'Sassy', ja:'なまいき', plus:'spd', minus:'spe'},
  {en:'Careful', ja:'しんちょう', plus:'spd', minus:'spa'},
  {en:'Quirky', ja:'きまぐれ', plus:null, minus:null},
];

// ざっくりタイプ相性（攻撃→防御）
// 参照元を埋め込まずに自前テーブル化（軽量・安定）
const TYPE_CHART = (() => {
  // defaults to 1
  const chart = {};
  for (const a of TYPES) {
    chart[a] = {};
    for (const d of TYPES) chart[a][d] = 1;
  }
  const set = (a, ds, m) => ds.forEach(d => chart[a][d] = m);
  // Normal
  set('Normal', ['Rock','Steel'], 0.5); set('Normal',['Ghost'],0);
  // Fire
  set('Fire',['Grass','Ice','Bug','Steel'],2);
  set('Fire',['Fire','Water','Rock','Dragon'],0.5);
  // Water
  set('Water',['Fire','Ground','Rock'],2);
  set('Water',['Water','Grass','Dragon'],0.5);
  // Electric
  set('Electric',['Water','Flying'],2);
  set('Electric',['Electric','Grass','Dragon'],0.5);
  set('Electric',['Ground'],0);
  // Grass
  set('Grass',['Water','Ground','Rock'],2);
  set('Grass',['Fire','Grass','Poison','Flying','Bug','Dragon','Steel'],0.5);
  // Ice
  set('Ice',['Grass','Ground','Flying','Dragon'],2);
  set('Ice',['Fire','Water','Ice','Steel'],0.5);
  // Fighting
  set('Fighting',['Normal','Ice','Rock','Dark','Steel'],2);
  set('Fighting',['Poison','Flying','Psychic','Bug','Fairy'],0.5);
  set('Fighting',['Ghost'],0);
  // Poison
  set('Poison',['Grass','Fairy'],2);
  set('Poison',['Poison','Ground','Rock','Ghost'],0.5);
  set('Poison',['Steel'],0);
  // Ground
  set('Ground',['Fire','Electric','Poison','Rock','Steel'],2);
  set('Ground',['Grass','Bug'],0.5);
  set('Ground',['Flying'],0);
  // Flying
  set('Flying',['Grass','Fighting','Bug'],2);
  set('Flying',['Electric','Rock','Steel'],0.5);
  // Psychic
  set('Psychic',['Fighting','Poison'],2);
  set('Psychic',['Psychic','Steel'],0.5);
  set('Psychic',['Dark'],0);
  // Bug
  set('Bug',['Grass','Psychic','Dark'],2);
  set('Bug',['Fire','Fighting','Poison','Flying','Ghost','Steel','Fairy'],0.5);
  // Rock
  set('Rock',['Fire','Ice','Flying','Bug'],2);
  set('Rock',['Fighting','Ground','Steel'],0.5);
  // Ghost
  set('Ghost',['Psychic','Ghost'],2);
  set('Ghost',['Dark'],0.5);
  set('Ghost',['Normal'],0);
  // Dragon
  set('Dragon',['Dragon'],2);
  set('Dragon',['Steel'],0.5);
  set('Dragon',['Fairy'],0);
  // Dark
  set('Dark',['Psychic','Ghost'],2);
  set('Dark',['Fighting','Dark','Fairy'],0.5);
  // Steel
  set('Steel',['Ice','Rock','Fairy'],2);
  set('Steel',['Fire','Water','Electric','Steel'],0.5);
  // Fairy
  set('Fairy',['Fighting','Dragon','Dark'],2);
  set('Fairy',['Fire','Poison','Steel'],0.5);
  return chart;
})();

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const toId = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

function formatPct(x){
  const p = x * 100;
  return `${p.toFixed(1)}%`;
}

function safeJsonParse(text){
  try { return JSON.parse(text); } catch { return null; }
}

function htmlEscape(s){
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- Cache
function loadCache(){
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;
  return parsed;
}
function saveCache(obj){
  localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
}
function clearCache(){
  localStorage.removeItem(CACHE_KEY);
}

// --- Dex loading
async function fetchJson(url){
  const res = await fetch(url, {cache:'no-store'});
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  return await res.json();
}

async function loadDex({format='gen9ou'}={}){
  // 1) cache hit?
  const cache = loadCache();
  if (cache?.dex?.pokedex && cache?.dex?.moves && cache?.dex?.learnsets && cache?.jp?.pokemonMap && cache?.jp?.itemMap) {
    return cache;
  }

  const [pokedex, moves, learnsets] = await Promise.all([
    fetchJson(`${PS_DATA_BASE}pokedex.json`),
    fetchJson(`${PS_DATA_BASE}moves.json`),
    fetchJson(`${PS_DATA_BASE}learnsets.json`),
  ]);

  // Japanese + item names (optional but基本ON)
  const [pokemonAll, itemAll] = await Promise.all([
    fetchJson(`${MOTEMEN_BASE}POKEMON_ALL.json`),
    fetchJson(`${MOTEMEN_BASE}ITEM_ALL.json`),
  ]);

  // Map: showdown id -> japanese name
  const pokemonMap = {}; // id -> {ja,en,number}
  for (const row of pokemonAll) {
    const id = row.pkmn_id_name;
    if (!id) continue;
    const ja = row.pokeapi_species_name_ja;
    const en = row.pokeapi_species_name_en;
    const num = row.national_pokedex_number;
    // form: add form name if exists
    const formJa = row.pokeapi_form_name_ja;
    const formEn = row.pokeapi_form_name_en;
    const fullJa = (formJa && formJa !== ja) ? `${ja}（${formJa}）` : ja;
    const fullEn = (formEn && formEn !== en) ? `${en} (${formEn})` : en;
    if (!pokemonMap[id]) pokemonMap[id] = {ja: fullJa, en: fullEn, number: num};
  }

  // items: id (pokeapi id not helpful). We build a name->name map for autocomplete
  // We'll store both ja and en; key by normalized name.
  const itemMap = { byJa:{}, byEn:{}, list:[] };
  for (const it of itemAll) {
    const ja = it.name_ja;
    const en = it.name_en;
    if (ja) itemMap.byJa[ja] = it;
    if (en) itemMap.byEn[en] = it;
    itemMap.list.push({ja, en});
  }

  // Load sets (recommended) - do not block dex if it fails
  let setsData = null;
  try {
    setsData = await fetchJson(`${PS_SETS_BASE}${format}.json`);
  } catch {
    setsData = null;
  }

  const next = {
    dex: {pokedex, moves, learnsets, setsData, format},
    jp: {pokemonMap, itemMap},
  };
  saveCache(next);
  return next;
}

async function reloadSets(cache, format){
  cache.dex.format = format;
  try {
    cache.dex.setsData = await fetchJson(`${PS_SETS_BASE}${format}.json`);
  } catch {
    cache.dex.setsData = null;
  }
  saveCache(cache);
}

// --- Recommendation (sets) parser (robust-ish)
function getSetsForSpecies(setsData, speciesKeyCandidates){
  if (!setsData) return [];
  let entry = null;
  for (const k of speciesKeyCandidates) {
    if (k && setsData[k]) { entry = setsData[k]; break; }
  }
  if (!entry) return [];

  // array => already sets
  if (Array.isArray(entry)) return entry;

  // single set-like object
  if (typeof entry === 'object' && (entry.moves || entry.item || entry.ability)) {
    return [entry];
  }

  // map of set names
  if (typeof entry === 'object') {
    const vals = Object.values(entry).filter(v => v && typeof v === 'object');
    // some formats nest deeper; flatten one level
    const flattened = [];
    for (const v of vals) {
      if (v.moves || v.item || v.ability) flattened.push(v);
      else if (typeof v === 'object') {
        for (const vv of Object.values(v)) if (vv && (vv.moves || vv.item || vv.ability)) flattened.push(vv);
      }
    }
    return flattened;
  }

  return [];
}

function summarizeSet(setObj){
  const item = setObj.item || '';
  const ability = setObj.ability || '';
  const nature = setObj.nature || '';
  const tera = setObj.teraType || setObj.tera || '';
  const moves = (setObj.moves || []).slice(0,4).join(' / ');
  return `${item} / ${ability}${nature?` / ${nature}`:''}${tera?` / Tera:${tera}`:''}\n${moves}`;
}

function normalizeEvs(evs){
  const out = {hp:0, atk:0, def:0, spa:0, spd:0, spe:0};
  if (!evs || typeof evs !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (typeof evs[k] === 'number') out[k] = evs[k];
    // alternate keys
    if (k === 'spe' && typeof evs['spd'] === 'number') {
      // ignore typo; keep spe
    }
  }
  // handle PS keys 'spA','spD' etc (rare)
  if (typeof evs.spA === 'number') out.spa = evs.spA;
  if (typeof evs.spD === 'number') out.spd = evs.spD;
  if (typeof evs.spd === 'number') out.spd = evs.spd;
  if (typeof evs.spa === 'number') out.spa = evs.spa;
  if (typeof evs.spe === 'number') out.spe = evs.spe;
  return out;
}

// --- UI
function setStatus(tone, text){
  const status = $('#status');
  const badge = status.querySelector('.badge');
  badge.dataset.tone = tone;
  badge.textContent = text;
}

function makeAutocomplete(inputEl, getItems, onPick){
  const wrap = document.createElement('div');
  wrap.className = 'autocomplete';
  inputEl.parentNode.insertBefore(wrap, inputEl);
  wrap.appendChild(inputEl);

  const list = document.createElement('div');
  list.className = 'acList';
  list.style.display = 'none';
  wrap.appendChild(list);

  let active = false;

  function close(){
    list.style.display = 'none';
    list.innerHTML = '';
    active = false;
  }

  function open(items){
    list.innerHTML = '';
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'acItem';
      div.innerHTML = `${htmlEscape(it.label)}${it.sub ? `<small>${htmlEscape(it.sub)}</small>`:''}`;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onPick(it);
        close();
      });
      list.appendChild(div);
    }
    list.style.display = items.length ? 'block' : 'none';
    active = items.length > 0;
  }

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim();
    if (!q) return close();
    const items = getItems(q).slice(0, 15);
    open(items);
  });

  inputEl.addEventListener('blur', () => {
    // give mousedown time
    setTimeout(() => close(), 120);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && active) {
      e.preventDefault();
      const first = list.querySelector('.acItem');
      if (first) first.dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  return {close};
}

function createMonState(){
  return {
    speciesId: '',
    ability: '',
    item: '',
    teraType: '',
    nature: 'Serious',
    evs: {hp:'', atk:'', def:'', spa:'', spd:'', spe:''},
    ivs: {hp:31, atk:31, def:31, spa:31, spd:31, spe:31},
    ivSpe: 31,
    moves: ['', '', '', ''],
    select: false,
  };
}

function createTeamState(){
  return Array.from({length:6}, () => createMonState());
}

function makeSlot(teamName, idx, state, ctx){
  const slot = document.createElement('div');
  slot.className = 'slot';

  const top = document.createElement('div');
  top.className = 'slotTop';
  slot.appendChild(top);

  const title = document.createElement('div');
  title.className = 'slotTitle';
  title.innerHTML = `<strong>${teamName} ${idx+1}</strong><span class="muted" id="name_${teamName}_${idx}">未選択</span>`;
  top.appendChild(title);

  const right = document.createElement('div');
  right.className = 'tagRow';
  right.innerHTML = `
    <label class="checkbox"><input type="checkbox" id="sel_${teamName}_${idx}"> 選出</label>
    <button class="btn" id="toggle_${teamName}_${idx}">開く/閉じる</button>
  `;
  top.appendChild(right);

  const body = document.createElement('div');
  body.className = 'slotBody';
  slot.appendChild(body);

  // --- species
  const speciesWrap = document.createElement('label');
  speciesWrap.className = 'field';
  speciesWrap.innerHTML = `
    <span>ポケモン</span>
    <input type="text" id="pk_${teamName}_${idx}" placeholder="例：カイリュー / Dragonite" autocomplete="off">
    <small>日本語/英語どちらでも検索できます（図鑑データ読込後）。</small>
  `;
  body.appendChild(speciesWrap);

  const pkInput = speciesWrap.querySelector('input');

  // --- set candidates
  const setBox = document.createElement('div');
  setBox.innerHTML = `
    <div class="hr"></div>
    <div class="field">
      <span>セット候補（3つ）</span>
      <div class="pills" id="sets_${teamName}_${idx}"></div>
      <small>※参照元（format）に該当セットが無い場合は出ません。</small>
    </div>
  `;
  body.appendChild(setBox);

  // --- basics
  const basics = document.createElement('div');
  basics.className = 'split';
  basics.innerHTML = `
    <label class="field">
      <span>特性（図鑑通り）</span>
      <select id="ab_${teamName}_${idx}"><option value="">未選択</option></select>
    </label>
    <label class="field">
      <span>持ち物（自由選択 + おすすめ）</span>
      <input type="text" id="it_${teamName}_${idx}" placeholder="例：こだわりスカーフ / Choice Scarf" autocomplete="off">
      <div class="pills" id="itrec_${teamName}_${idx}"></div>
    </label>
    <label class="field">
      <span>テラスタイプ（自由）</span>
      <select id="tera_${teamName}_${idx}"><option value="">未選択</option></select>
    </label>
    <label class="field">
      <span>性格（自由）</span>
      <select id="nat_${teamName}_${idx}"></select>
    </label>
  `;
  body.appendChild(basics);

  const abSel = basics.querySelector(`#ab_${teamName}_${idx}`);
  const itInput = basics.querySelector(`#it_${teamName}_${idx}`);
  const itRecPills = basics.querySelector(`#itrec_${teamName}_${idx}`);
  const teraSel = basics.querySelector(`#tera_${teamName}_${idx}`);
  const natSel = basics.querySelector(`#nat_${teamName}_${idx}`);

  // populate tera types
  for (const t of TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    teraSel.appendChild(opt);
  }
  // populate nature
  for (const n of NATURES) {
    const opt = document.createElement('option');
    opt.value = n.en;
    opt.textContent = `${n.ja}（${n.en}）`;
    natSel.appendChild(opt);
  }

  // --- EV/IV
  const eviv = document.createElement('div');
  eviv.innerHTML = `
    <div class="hr"></div>
    <div class="split">
      <div class="field">
        <span>努力値（空欄でもOK / 0扱い）</span>
        <div class="movesGrid">
          ${['hp','atk','def','spa','spd','spe'].map(s => `
            <label class="field"><span>${s.toUpperCase()}</span><input type="number" min="0" max="252" step="4" id="ev_${teamName}_${idx}_${s}" placeholder="0"></label>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <span>個体値（Sだけ 0/31 切替。その他は31固定）</span>
        <label class="field"><span>S</span>
          <select id="iv_${teamName}_${idx}_spe"><option value="31" selected>31</option><option value="0">0</option></select>
        </label>
        <small>※簡易シミュ用。細かいIVは後で増やせます。</small>
      </div>
    </div>
  `;
  body.appendChild(eviv);

  // --- Moves
  const moves = document.createElement('div');
  moves.innerHTML = `
    <div class="hr"></div>
    <div class="field">
      <span>技（自由選択 + おすすめ候補）</span>
      <div class="pills" id="mvrec_${teamName}_${idx}"></div>
      <div class="movesGrid">
        ${[0,1,2,3].map(i => `
          <label class="field"><span>わざ${i+1}</span>
            <input type="text" id="mv_${teamName}_${idx}_${i}" placeholder="技名" autocomplete="off">
          </label>
        `).join('')}
      </div>
    </div>
  `;
  body.appendChild(moves);

  const mvRecPills = moves.querySelector(`#mvrec_${teamName}_${idx}`);
  const mvInputs = [0,1,2,3].map(i => moves.querySelector(`#mv_${teamName}_${idx}_${i}`));

  // toggle open
  $(`#toggle_${teamName}_${idx}`, slot).addEventListener('click', () => {
    slot.classList.toggle('open');
  });

  // select
  const selCb = $(`#sel_${teamName}_${idx}`, slot);
  selCb.addEventListener('change', () => {
    state.select = selCb.checked;
  });

  // bind inputs
  itInput.addEventListener('input', () => state.item = itInput.value.trim());
  teraSel.addEventListener('change', () => state.teraType = teraSel.value);
  natSel.addEventListener('change', () => state.nature = natSel.value);
  abSel.addEventListener('change', () => state.ability = abSel.value);
  $(`#iv_${teamName}_${idx}_spe`, slot).addEventListener('change', (e) => {
    state.ivSpe = Number(e.target.value);
  });
  for (const s of ['hp','atk','def','spa','spd','spe']) {
    $(`#ev_${teamName}_${idx}_${s}`, slot).addEventListener('input', (e) => {
      const v = e.target.value;
      state.evs[s] = v;
    });
  }
  mvInputs.forEach((el, i) => {
    el.addEventListener('input', () => state.moves[i] = el.value.trim());
  });

  // autocomplete: items
  makeAutocomplete(itInput,
    (q) => {
      const qq = q.trim();
      if (!qq) return [];
      const list = ctx.jpItemList || [];
      const hits = [];
      for (const it of list) {
        if (!it.ja && !it.en) continue;
        const hay = `${it.ja||''} ${it.en||''}`;
        if (hay.includes(qq)) {
          hits.push({label: it.ja || it.en, sub: it.ja && it.en ? it.en : '' , value: it.ja || it.en});
        }
        if (hits.length >= 30) break;
      }
      return hits;
    },
    (pick) => {
      itInput.value = pick.value;
      state.item = pick.value;
    }
  );

  // autocomplete: pokemon
  makeAutocomplete(pkInput,
    (q) => {
      const qq = q.trim();
      const out = [];
      if (!qq) return out;
      for (const sp of (ctx.speciesList||[])) {
        const hay = `${sp.ja||''} ${sp.en||''} ${sp.id}`;
        if (hay.toLowerCase().includes(qq.toLowerCase())) {
          out.push({label: sp.ja || sp.en, sub: sp.ja && sp.en ? sp.en : sp.id, value: sp.id});
        }
      }
      return out;
    },
    (pick) => {
      applySpecies(pick.value);
    }
  );

  // autocomplete: moves
  function moveChoicesFactory(){
    return (q, speciesId) => {
      const qq = q.trim();
      if (!qq) return [];
      const filterMode = $('#moveFilterSelect').value;
      const allowed = (filterMode === 'learnset' && speciesId) ? ctx.learnsetBySpecies?.[speciesId] : null;
      const out = [];
      const qLower = qq.toLowerCase();
      for (const mv of (ctx.movesList||[])) {
        if (allowed && !allowed.has(mv.id)) continue;
        const hay = `${mv.ja||''} ${mv.en||''} ${mv.id}`.toLowerCase();
        if (hay.includes(qLower)) {
          out.push({label: mv.ja || mv.en, sub: mv.ja && mv.en ? mv.en : mv.id, value: mv.ja || mv.en});
        }
      }
      return out.slice(0, 20);
    };
  }

  const moveChoices = moveChoicesFactory();
  mvInputs.forEach((mvInput, i) => {
    makeAutocomplete(mvInput,
      (q) => moveChoices(q, state.speciesId),
      (pick) => {
        mvInput.value = pick.value;
        state.moves[i] = pick.value;
      }
    );
  });

  function setMonLabel(){
    const label = $(`#name_${teamName}_${idx}`);
    if (!state.speciesId) {
      label.textContent = '未選択';
      return;
    }
    const sp = ctx.speciesById[state.speciesId];
    label.textContent = sp?.ja ? sp.ja : (sp?.en || state.speciesId);
  }

  function fillAbilityOptions(){
    abSel.innerHTML = '<option value="">未選択</option>';
    if (!state.speciesId) return;
    const s = ctx.pokedex[state.speciesId];
    const abilities = s?.abilities || {};
    const entries = Object.entries(abilities);
    for (const [k, name] of entries) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      abSel.appendChild(opt);
    }
  }

  function clearRecommendations(){
    mvRecPills.innerHTML = '';
    itRecPills.innerHTML = '';
    $(`#sets_${teamName}_${idx}`, slot).innerHTML = '';
  }

  function setPills(container, labels, onClick){
    container.innerHTML = '';
    for (const text of labels) {
      const pill = document.createElement('button');
      pill.className = 'pill';
      pill.dataset.tone = 'rec';
      pill.type = 'button';
      pill.textContent = text;
      pill.addEventListener('click', () => onClick(text));
      container.appendChild(pill);
    }
  }

  function buildSetCandidates(){
    const box = $(`#sets_${teamName}_${idx}`, slot);
    box.innerHTML = '';
    if (!state.speciesId || !ctx.setsData) return;

    const sp = ctx.speciesById[state.speciesId];
    const candidates = [
      // try a few keys
      sp?.en,
      sp?.en?.replace(/\s\(.*\)$/,'') ,
      state.speciesId,
      sp?.ja,
    ].filter(Boolean);

    const sets = getSetsForSpecies(ctx.setsData, candidates);
    if (!sets.length) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = '候補なし';
      box.appendChild(span);
      return;
    }

    const top3 = sets.slice(0,3);
    top3.forEach((setObj, i) => {
      const pill = document.createElement('button');
      pill.className = 'pill';
      pill.dataset.tone = 'set';
      pill.type = 'button';
      pill.textContent = `候補${i+1}`;
      pill.title = summarizeSet(setObj);
      pill.addEventListener('click', () => {
        // apply
        if (setObj.ability) { state.ability = setObj.ability; abSel.value = setObj.ability; }
        if (setObj.item) { state.item = setObj.item; itInput.value = setObj.item; }
        if (setObj.nature) { state.nature = setObj.nature; natSel.value = setObj.nature; }
        if (setObj.teraType) { state.teraType = setObj.teraType; teraSel.value = setObj.teraType; }
        if (setObj.moves && Array.isArray(setObj.moves)) {
          for (let j=0; j<4; j++) {
            const mv = setObj.moves[j] || '';
            mvInputs[j].value = mv;
            state.moves[j] = mv;
          }
        }
        if (setObj.evs) {
          const evs = normalizeEvs(setObj.evs);
          for (const s of ['hp','atk','def','spa','spd','spe']) {
            const v = evs[s] || 0;
            const el = $(`#ev_${teamName}_${idx}_${s}`, slot);
            el.value = v ? String(v) : '';
            state.evs[s] = v ? String(v) : '';
          }
        }
      });
      box.appendChild(pill);
    });
  }

  function buildRecommendations(){
    clearRecommendations();
    if (!state.speciesId || !ctx.setsData) return;

    const sp = ctx.speciesById[state.speciesId];
    const candidates = [sp?.en, state.speciesId, sp?.ja].filter(Boolean);
    const sets = getSetsForSpecies(ctx.setsData, candidates);
    if (!sets.length) return;

    // moves
    const moveCounts = new Map();
    const itemCounts = new Map();
    for (const st of sets.slice(0, 12)) {
      for (const mv of (st.moves||[])) {
        moveCounts.set(mv, (moveCounts.get(mv)||0)+1);
      }
      if (st.item) itemCounts.set(st.item, (itemCounts.get(st.item)||0)+1);
    }
    const topMoves = Array.from(moveCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 12).map(([k])=>k);
    const topItems = Array.from(itemCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 8).map(([k])=>k);

    setPills(mvRecPills, topMoves, (mv) => {
      // fill first empty move slot, otherwise replace last
      let at = state.moves.findIndex(x=>!x);
      if (at === -1) at = 3;
      mvInputs[at].value = mv;
      state.moves[at] = mv;
    });
    setPills(itRecPills, topItems, (it) => {
      itInput.value = it;
      state.item = it;
    });

    buildSetCandidates();
  }

  function applySpecies(speciesId){
    state.speciesId = speciesId;
    pkInput.value = (ctx.speciesById[speciesId]?.ja) || (ctx.speciesById[speciesId]?.en) || speciesId;
    setMonLabel();
    fillAbilityOptions();
    buildRecommendations();
  }

  // expose for importer
  slot.__applySpecies = applySpecies;

  // initial
  setMonLabel();

  return slot;
}

function hydrateSlots(teamId, teamName, teamState, ctx){
  const root = document.getElementById(teamId);
  root.innerHTML = '';
  for (let i=0; i<teamState.length; i++) {
    root.appendChild(makeSlot(teamName, i, teamState[i], ctx));
  }
}

// --- Simulation
function natureMultiplier(natureEn, stat){
  const n = NATURES.find(x=>x.en===natureEn);
  if (!n || !n.plus || !n.minus) return 1;
  if (n.plus === stat) return 1.1;
  if (n.minus === stat) return 0.9;
  return 1;
}

function calcStat({base, iv, ev, level, natureMult, isHp}){
  // Gen 3+ formula
  if (isHp) {
    return Math.floor(((2*base + iv + Math.floor(ev/4)) * level) / 100) + level + 10;
  }
  const raw = Math.floor(((2*base + iv + Math.floor(ev/4)) * level) / 100) + 5;
  return Math.floor(raw * natureMult);
}

function getMonBattleData(mon, ctx, teraMode){
  const level = 50;
  const s = ctx.pokedex[mon.speciesId];
  if (!s) return null;
  const bs = s.baseStats;

  const ev = {};
  for (const k of ['hp','atk','def','spa','spd','spe']) {
    const v = Number(mon.evs[k]);
    ev[k] = Number.isFinite(v) ? clamp(v,0,252) : 0;
  }
  const iv = {hp:31, atk:31, def:31, spa:31, spd:31, spe: mon.ivSpe === 0 ? 0 : 31};

  const stats = {
    hp: calcStat({base:bs.hp, iv:iv.hp, ev:ev.hp, level, natureMult:1, isHp:true}),
    atk: calcStat({base:bs.atk, iv:iv.atk, ev:ev.atk, level, natureMult:natureMultiplier(mon.nature,'atk'), isHp:false}),
    def: calcStat({base:bs.def, iv:iv.def, ev:ev.def, level, natureMult:natureMultiplier(mon.nature,'def'), isHp:false}),
    spa: calcStat({base:bs.spa, iv:iv.spa, ev:ev.spa, level, natureMult:natureMultiplier(mon.nature,'spa'), isHp:false}),
    spd: calcStat({base:bs.spd, iv:iv.spd, ev:ev.spd, level, natureMult:natureMultiplier(mon.nature,'spd'), isHp:false}),
    spe: calcStat({base:bs.spe, iv:iv.spe, ev:ev.spe, level, natureMult:natureMultiplier(mon.nature,'spe'), isHp:false}),
  };

  const baseTypes = s.types;
  const teraType = mon.teraType || '';

  const moves = mon.moves.map(m => m.trim()).filter(Boolean);

  return {
    id: mon.speciesId,
    name: ctx.speciesById[mon.speciesId]?.ja || ctx.speciesById[mon.speciesId]?.en || mon.speciesId,
    baseTypes,
    teraType,
    stats,
    moves,
    teraUsed:false,
    hp: stats.hp,
    fainted:false,
  };
}

function moveToIdByName(movesList, name){
  const n = name.trim();
  if (!n) return '';
  // try direct id
  const id = toId(n);
  if (movesList.byId[id]) return id;
  // try match by ja/en
  const keyLower = n.toLowerCase();
  const hit = movesList.list.find(m => (m.ja && m.ja === n) || (m.en && m.en.toLowerCase() === keyLower));
  if (hit) return hit.id;
  return id; // last resort
}

function typeEffectMultiplier(attackType, defTypes){
  if (!attackType || !TYPE_CHART[attackType]) return 1;
  let mult = 1;
  for (const dt of defTypes) {
    mult *= (TYPE_CHART[attackType][dt] ?? 1);
  }
  return mult;
}

function chooseBestDamagingMove(attacker, defender, ctx){
  // returns {moveId, expected}
  let best = {moveId:'', expected: 0};

  const moves = attacker.moves.length ? attacker.moves : ['Struggle'];
  for (const mvName of moves) {
    const moveId = mvName === 'Struggle' ? 'struggle' : moveToIdByName(ctx.movesIndex, mvName);
    const m = ctx.moves[moveId];
    if (!m) continue;
    if (m.category === 'Status' || !m.basePower) continue;
    const expected = expectedDamage(attacker, defender, m);
    if (expected > best.expected) best = {moveId, expected};
  }

  if (!best.moveId) {
    // force struggle
    const m = ctx.moves['struggle'] || {type:'Normal', category:'Physical', basePower:50, accuracy:true};
    return {moveId:'struggle', expected: expectedDamage(attacker, defender, m)};
  }
  return best;
}

function expectedDamage(attacker, defender, move){
  const level = 50;
  const bp = move.basePower || 0;
  const aStat = (move.category === 'Special') ? attacker.stats.spa : attacker.stats.atk;
  const dStat = (move.category === 'Special') ? defender.stats.spd : defender.stats.def;

  const atkType = move.type;
  const atkTypes = attacker.teraUsed && attacker.teraType ? [attacker.teraType] : attacker.baseTypes;

  const stab = (atkTypes.includes(atkType)) ? 1.5 : 1.0;
  const eff = typeEffectMultiplier(atkType, defender.teraUsed && defender.teraType ? [defender.teraType] : defender.baseTypes);

  // simplified damage formula (no burn, no items, no crit, no other mods)
  const base = Math.floor(Math.floor(Math.floor((2*level/5 + 2) * bp * aStat / dStat) / 50) + 2);
  const avgRand = 0.925;
  return base * stab * eff * avgRand;
}

function maybeAutoTera(attacker, defender, ctx, mode){
  if (mode !== 'auto') return;
  if (attacker.teraUsed) return;
  if (!attacker.teraType) return;

  // if tera improves best expected damage by >= 20%, use it.
  const before = chooseBestDamagingMove(attacker, defender, ctx).expected;
  attacker.teraUsed = true;
  const after = chooseBestDamagingMove(attacker, defender, ctx).expected;
  // revert if not worth
  if (after < before * 1.2) attacker.teraUsed = false;
}

function simulateOnce(teamA, teamB, ctx, teraMode){
  // clones
  const a = teamA.map(x=>structuredClone(x));
  const b = teamB.map(x=>structuredClone(x));

  // pick lead: first
  let ai = 0, bi = 0;
  let activeA = a[ai];
  let activeB = b[bi];

  while (true) {
    if (!activeA || !activeB) break;

    // auto tera (simplified)
    maybeAutoTera(activeA, activeB, ctx, teraMode);
    maybeAutoTera(activeB, activeA, ctx, teraMode);

    const moveA = chooseBestDamagingMove(activeA, activeB, ctx);
    const moveB = chooseBestDamagingMove(activeB, activeA, ctx);

    // speed
    let aFirst = activeA.stats.spe > activeB.stats.spe;
    if (activeA.stats.spe === activeB.stats.spe) aFirst = Math.random() < 0.5;

    const step = (attacker, defender, mvId) => {
      const m = ctx.moves[mvId];
      if (!m || !m.basePower || m.category === 'Status') return;
      const dmg = Math.max(1, Math.floor(expectedDamage(attacker, defender, m) * (0.85 + Math.random()*0.15)));
      defender.hp -= dmg;
      if (defender.hp <= 0) { defender.hp = 0; defender.fainted = true; }
    };

    if (aFirst) {
      step(activeA, activeB, moveA.moveId);
      if (!activeB.fainted) step(activeB, activeA, moveB.moveId);
    } else {
      step(activeB, activeA, moveB.moveId);
      if (!activeA.fainted) step(activeA, activeB, moveA.moveId);
    }

    if (activeA.fainted) {
      ai++;
      activeA = a[ai];
      if (!activeA) return 'B';
    }
    if (activeB.fainted) {
      bi++;
      activeB = b[bi];
      if (!activeB) return 'A';
    }
  }
  return 'A';
}

function simulate(teamA, teamB, ctx, iters, teraMode){
  let winsA = 0;
  for (let i=0; i<iters; i++) {
    const w = simulateOnce(teamA, teamB, ctx, teraMode);
    if (w === 'A') winsA++;
  }
  return {winsA, iters, winRateA: winsA/iters};
}

function collectSelected(teamState){
  const picked = teamState.filter(m => m.speciesId && m.select);
  if (picked.length) return picked.slice(0,3);
  // fallback: first 3 filled
  return teamState.filter(m => m.speciesId).slice(0,3);
}

function makeMovesIndex(dexMoves, jpMovesMap){
  const list = [];
  const byId = {};
  for (const [id, m] of Object.entries(dexMoves)) {
    const en = m.name;
    // Japanese move names are not provided by PS in moves.json.
    // MVP: ja is empty. (後で text.js 等で補完可能)
    const ja = (jpMovesMap && jpMovesMap[id]) ? jpMovesMap[id] : '';
    const obj = {id, en, ja};
    list.push(obj);
    byId[id] = obj;
  }
  // add struggle if missing
  if (!byId['struggle']) {
    const obj = {id:'struggle', en:'Struggle', ja:'わるあがき'};
    list.push(obj);
    byId['struggle'] = obj;
  }
  return {list, byId};
}

function buildSpeciesList(pokedex, pokemonMap){
  const list = [];
  const byId = {};
  for (const [id, s] of Object.entries(pokedex)) {
    const en = s.name;
    const ja = pokemonMap?.[id]?.ja || '';
    const number = pokemonMap?.[id]?.number || null;
    const obj = {id, en, ja, number};
    byId[id] = obj;
    list.push(obj);
  }
  // sort: by national dex number if possible
  list.sort((a,b) => {
    const an = a.number ?? 99999;
    const bn = b.number ?? 99999;
    if (an !== bn) return an - bn;
    return a.en.localeCompare(b.en);
  });
  return {list, byId};
}

function buildLearnsetIndex(learnsets){
  const out = {};
  for (const [id, ls] of Object.entries(learnsets)) {
    const learnset = ls?.learnset ? Object.keys(ls.learnset) : [];
    out[id] = new Set(learnset);
  }
  return out;
}

// --- Export / Import
function exportState(stateA, stateB, settings){
  return {
    meta: {app:'Pick Lab', version:'mvp', exportedAt: new Date().toISOString()},
    settings,
    teamA: stateA,
    teamB: stateB,
  };
}

function applyImported(doc, teamA, teamB){
  if (!doc || !doc.teamA || !doc.teamB) throw new Error('形式が違います');
  for (let i=0; i<6; i++) {
    Object.assign(teamA[i], createMonState(), doc.teamA[i]||{});
    Object.assign(teamB[i], createMonState(), doc.teamB[i]||{});
  }
}

// --- App bootstrap
let APP = {
  cache: null,
  ctx: null,
  teamA: createTeamState(),
  teamB: createTeamState(),
};

function enableButtons(enabled){
  $('#btnSim').disabled = !enabled;
  $('#btnExport').disabled = !enabled;
}

function renderResult(html){
  $('#result').innerHTML = html;
}

function gatherSettings(){
  return {
    format: $('#formatSelect').value,
    moveFilter: $('#moveFilterSelect').value,
    iters: Number($('#iters').value),
    teraMode: $('#teraMode').value,
  };
}

async function onLoadDex(){
  const format = $('#formatSelect').value;
  setStatus('warn', '読込中…');
  enableButtons(false);

  try {
    const cache = await loadDex({format});
    APP.cache = cache;

    const {pokedex, moves, learnsets, setsData} = cache.dex;
    const {pokemonMap, itemMap} = cache.jp;

    const species = buildSpeciesList(pokedex, pokemonMap);
    const movesIndex = makeMovesIndex(moves);
    const learnsetBySpecies = buildLearnsetIndex(learnsets);

    APP.ctx = {
      pokedex,
      moves,
      learnsets,
      setsData,
      speciesList: species.list,
      speciesById: species.byId,
      learnsetBySpecies,
      movesList: movesIndex.list,
      movesIndex,
      jpItemList: itemMap.list,
    };

    hydrateSlots('slotsA', 'A', APP.teamA, APP.ctx);
    hydrateSlots('slotsB', 'B', APP.teamB, APP.ctx);

    setStatus('ok', 'データ読込OK');
    enableButtons(true);
    renderResult('<div class="muted">準備OK。各チームを作って「シミュレーション実行」を押してください。</div>');

  } catch (e) {
    console.error(e);
    setStatus('bad', '読込失敗');
    enableButtons(false);
    renderResult(`<div class="muted">図鑑データの読み込みに失敗しました。<br>ネットワーク制限がある場合は、READMEの「オフライン運用」手順で JSON を同梱してください。</div>`);
  }
}

async function onChangeFormat(){
  if (!APP.cache) return;
  const format = $('#formatSelect').value;
  setStatus('warn', 'おすすめ更新中…');
  try {
    await reloadSets(APP.cache, format);
    APP.ctx.setsData = APP.cache.dex.setsData;
    setStatus('ok', 'データ読込OK');
    // rebuild slots to refresh recommendations
    hydrateSlots('slotsA', 'A', APP.teamA, APP.ctx);
    hydrateSlots('slotsB', 'B', APP.teamB, APP.ctx);
  } catch {
    setStatus('warn', 'おすすめなし（format読込失敗）');
  }
}

function onSim(){
  if (!APP.ctx) return;
  const iters = clamp(Number($('#iters').value)||500, 50, 5000);
  const teraMode = $('#teraMode').value;

  const pickedA = collectSelected(APP.teamA);
  const pickedB = collectSelected(APP.teamB);

  if (pickedA.length < 1 || pickedB.length < 1) {
    renderResult('<div class="muted">両方のチームに最低1体は選んでください（選出チェック or 先頭から自動）。</div>');
    return;
  }

  // build battle data
  const teamA = pickedA.map(m => getMonBattleData(m, APP.ctx, teraMode)).filter(Boolean);
  const teamB = pickedB.map(m => getMonBattleData(m, APP.ctx, teraMode)).filter(Boolean);

  if (!teamA.length || !teamB.length) {
    renderResult('<div class="muted">図鑑に存在しないポケモンが入っています。</div>');
    return;
  }

  const res = simulate(teamA, teamB, APP.ctx, iters, teraMode);

  const listA = teamA.map(x=>x.name).join(' / ');
  const listB = teamB.map(x=>x.name).join(' / ');

  renderResult(`
    <div class="row" style="gap:10px; align-items:flex-start;">
      <div style="flex:1; min-width:260px">
        <div class="badge" data-tone="ok">A 勝率：${formatPct(res.winRateA)}</div>
        <div class="muted" style="margin-top:8px">反復：${res.iters}</div>
        <div class="hr"></div>
        <div class="muted"><strong>A</strong>：${htmlEscape(listA)}</div>
        <div class="muted"><strong>B</strong>：${htmlEscape(listB)}</div>
      </div>
      <div style="flex:1; min-width:260px">
        <div class="muted">メモ</div>
        <ul class="muted" style="margin-top:8px">
          <li>現状は「ダメージだけ」で殴り合う簡易モデルです。</li>
          <li>状態異常・積み技・交代読み・持ち物/特性の効果は未実装です。</li>
          <li>でも「選出の相性ざっくり」には使えます。</li>
        </ul>
      </div>
    </div>
  `);
}

function onExport(){
  const settings = gatherSettings();
  const doc = exportState(APP.teamA, APP.teamB, settings);
  const blob = new Blob([JSON.stringify(doc, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'picklab_build.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function onImport(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = JSON.parse(String(reader.result));
      applyImported(doc, APP.teamA, APP.teamB);
      if (!APP.ctx) {
        renderResult('<div class="muted">JSONは読み込みました。図鑑データも読み込むとUIに反映されます。</div>');
        return;
      }
      hydrateSlots('slotsA', 'A', APP.teamA, APP.ctx);
      hydrateSlots('slotsB', 'B', APP.teamB, APP.ctx);
      renderResult('<div class="muted">JSONを読み込みました。</div>');
    } catch (e) {
      console.error(e);
      renderResult('<div class="muted">JSONの形式が違います。</div>');
    }
  };
  reader.readAsText(file);
}

// wire
$('#btnLoad').addEventListener('click', onLoadDex);
$('#btnClearCache').addEventListener('click', () => {
  clearCache();
  setStatus('muted', 'キャッシュ削除');
  renderResult('<div class="muted">キャッシュを削除しました。必要なら再度「図鑑データ読み込み」を押してください。</div>');
});
$('#formatSelect').addEventListener('change', onChangeFormat);
$('#btnSim').addEventListener('click', onSim);
$('#btnExport').addEventListener('click', onExport);
$('#fileImport').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) onImport(file);
  e.target.value = '';
});

// initial
renderResult('<div class="muted">「図鑑データ読み込み」を押すと開始できます。</div>');
