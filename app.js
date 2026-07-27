/* ============================================================
   イジンデン一人回し - app.js
   デッキ構築＆ソロプレイ卓上アシスタント
   ============================================================ */

const CARDS = window.IJINDEN_CARDS || [];
const CARDS_BY_ID = {};
CARDS.forEach(c => { CARDS_BY_ID[c.id] = c; });

const COLOR_HEX = { '赤': '#b6423a', '青': '#2f8fd6', '緑': '#4a7f4f', '黄': '#c99a2e', '紫': '#5c3d8a', '無': '#7d8394' };
const BASE_COLORS = ['赤', '青', '緑', '黄', '紫', '無'];
const PHASE_LABEL = { start: 'スタート', draw: 'ドロー', main: 'メイン', end: 'エンド' };

const UNLIMITED_RE = /デッキに何枚でも入れてよい/;

/* ---------------- Rule-text keyword highlighting ---------------- */
const OFFICIAL_KEYWORDS = [
  '即応', 'ダブルプレッシャー', 'トリプルプレッシャー', 'クアドラプルプレッシャー', 'スタンド',
  '反魂', 'モータル', '喪神', 'ウォッチャー', '木霊', '冥府発動', '魔力化', '復元', '装備', '冥装'
];
function extractCustomKeywords(cards) {
  const set = new Set();
  const re = /(?:^|\n)([^\s\n]{2,10}?)\s?[-‐]\s/g;
  cards.forEach(c => {
    const text = c.rule_text || '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      if (/^[ぁ-んァ-ヶ一-龠ー]+$/.test(token)) set.add(token);
    }
  });
  return set;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const KEYWORDS_ALL = new Set([...OFFICIAL_KEYWORDS, ...extractCustomKeywords(CARDS)]);
const KEYWORD_REGEX = new RegExp(
  ['(?:パワー|アタック|ブロック)\\+\\d+', ...[...KEYWORDS_ALL].sort((a, b) => b.length - a.length).map(escapeRegExp)].join('|'),
  'g'
);

function renderRuleTextNode(text) {
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  KEYWORD_REGEX.lastIndex = 0;
  let m;
  while ((m = KEYWORD_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
    const strong = document.createElement('strong');
    strong.textContent = m[0];
    frag.appendChild(strong);
    lastIndex = m.index + m[0].length;
    if (m[0].length === 0) KEYWORD_REGEX.lastIndex++;
  }
  if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
  return frag;
}

/* ---------------- Legacy ability (遺業能力) formatting ----------------
   Strips explanatory parentheticals like "（戦場から墓地に置かれたときに発動できる）"
   and any leading "遺業能力：" label, leaving just "遺業能力:キーワード" or
   "遺業能力:効果の要約". Returns null if there is no legacy ability. */
function formatLegacyAbility(raw) {
  if (!raw) return null;
  let t = raw.trim();
  if (t === '-' || t === '') return null;
  t = t.replace(/^遺業能力[:：]\s*/, '');
  t = t.replace(/[（(][^）)]*[）)]/g, '');
  t = t.replace(/\s+/g, '').trim();
  if (!t) return null;
  return `遺業能力:${t}`;
}

/* ---------------- Local storage helpers ---------------- */
function loadDecks() {
  try { return JSON.parse(localStorage.getItem('ijinden_decks_v1') || '{}'); }
  catch (e) { return {}; }
}
function saveDecks(obj) {
  localStorage.setItem('ijinden_decks_v1', JSON.stringify(obj));
}

/* ---------------- Global state ---------------- */
const state = {
  filters: {
    search: '',
    types: new Set(['イジン', 'マホウ', 'ハイケイ', 'マリョク']),
    colors: new Set(),
    sets: new Set(),
    rarities: new Set(),
    levelMin: null,
    levelMax: null
  },
  sort: 'set_asc',
  draft: {},        // cardId -> count (deck being built)
  decks: loadDecks() // name -> {cards:{cardId:count}}
};

let GAME = null;      // solo-play game state
let uidCounter = 1;
let FLOW = null;      // active guided flow (マリョク配置 / イジン召喚 / バトル)
let DRAW_PROMPT = false;  // draw step: board dimmed, deck pile highlighted
let UNDO_STACK = [];  // snapshots for the single-step undo button

/* ============================================================
   TAB SWITCHING
   ============================================================ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('is-active');
    // 対戦準備の画面ではヘッダーはそのまま。対戦が始まってから隠す。
    document.body.classList.toggle('solo-view', btn.dataset.tab === 'solo' && !!GAME);
    document.body.classList.remove('header-peek');
    if (btn.dataset.tab !== 'solo') { hideFlowBanner(); closeModal(); }
    if (btn.dataset.tab === 'solo') refreshSoloDeckSelect();
  });
});

/* ============================================================
   DECK BUILDER: FILTER UI SETUP
   ============================================================ */
function setUpChipGroup(containerEl, values, targetSet, labelFn, colorFn) {
  containerEl.innerHTML = '';
  values.forEach(v => {
    const b = document.createElement('button');
    b.className = 'chip-toggle';
    b.textContent = labelFn ? labelFn(v) : v;
    if (colorFn) b.style.borderColor = colorFn(v);
    b.dataset.val = v;
    b.addEventListener('click', () => {
      if (targetSet.has(v)) { targetSet.delete(v); b.classList.remove('is-active'); }
      else { targetSet.add(v); b.classList.add('is-active'); }
      renderCardGrid();
    });
    containerEl.appendChild(b);
  });
}

function initFilterUI() {
  // type chips already in HTML; wire them
  document.querySelectorAll('#fType .chip-toggle').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.val;
      if (state.filters.types.has(v)) { state.filters.types.delete(v); b.classList.remove('is-active'); }
      else { state.filters.types.add(v); b.classList.add('is-active'); }
      renderCardGrid();
    });
  });

  setUpChipGroup(document.getElementById('fColor'), BASE_COLORS, state.filters.colors, c => c, c => COLOR_HEX[c]);

  const sets = [...new Set(CARDS.map(c => c.set))];
  const setOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  sets.sort((a, b) => setOrder.indexOf(a) - setOrder.indexOf(b));
  setUpChipGroup(document.getElementById('fSet'), sets, state.filters.sets, s => s);

  const rarities = [...new Set(CARDS.map(c => c.rarity || 'ー'))];
  setUpChipGroup(document.getElementById('fRarity'), rarities, state.filters.rarities, r => r);

  document.getElementById('fSearch').addEventListener('input', e => {
    state.filters.search = e.target.value.trim();
    renderCardGrid();
  });
  document.getElementById('fLevelMin').addEventListener('input', e => {
    state.filters.levelMin = e.target.value === '' ? null : Number(e.target.value);
    renderCardGrid();
  });
  document.getElementById('fLevelMax').addEventListener('input', e => {
    state.filters.levelMax = e.target.value === '' ? null : Number(e.target.value);
    renderCardGrid();
  });
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    renderCardGrid();
  });
  document.getElementById('btnResetFilters').addEventListener('click', () => {
    state.filters.search = '';
    state.filters.colors.clear();
    state.filters.sets.clear();
    state.filters.rarities.clear();
    state.filters.levelMin = null;
    state.filters.levelMax = null;
    document.getElementById('fSearch').value = '';
    document.getElementById('fLevelMin').value = '';
    document.getElementById('fLevelMax').value = '';
    document.querySelectorAll('#fColor .chip-toggle, #fSet .chip-toggle, #fRarity .chip-toggle')
      .forEach(b => b.classList.remove('is-active'));
    renderCardGrid();
  });
}

/* ============================================================
   DECK BUILDER: FILTER / SORT LOGIC
   ============================================================ */
function matchesSearch(card, q) {
  if (!q) return true;
  const hay = [card.name, card.rule_text, card.legacy_ability, card.trait].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filterCards() {
  const f = state.filters;
  return CARDS.filter(c => {
    if (f.types.size > 0 && !f.types.has(c.type)) return false;
    if (f.colors.size > 0) {
      let ok = false;
      f.colors.forEach(col => {
        if (col === '無') { if (c.color === '無') ok = true; }
        else if (c.color && c.color.includes(col)) ok = true;
      });
      if (!ok) return false;
    }
    if (f.sets.size > 0 && !f.sets.has(c.set)) return false;
    if (f.rarities.size > 0 && !f.rarities.has(c.rarity || 'ー')) return false;
    if (f.levelMin !== null && c.level < f.levelMin) return false;
    if (f.levelMax !== null && c.level > f.levelMax) return false;
    if (!matchesSearch(c, f.search)) return false;
    return true;
  });
}

function sortCards(list) {
  const setOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const arr = list.slice();
  const bySetAsc = (a, b) => {
    const si = setOrder.indexOf(a.set) - setOrder.indexOf(b.set);
    if (si !== 0) return si;
    return Number(a.no) - Number(b.no) || String(a.no).localeCompare(String(b.no));
  };
  switch (state.sort) {
    case 'set_desc':
      arr.sort((a, b) => -bySetAsc(a, b)); break;
    case 'level_asc':
      arr.sort((a, b) => (a.level || 0) - (b.level || 0)); break;
    case 'level_desc':
      arr.sort((a, b) => (b.level || 0) - (a.level || 0)); break;
    case 'power_asc':
      arr.sort((a, b) => (typeof a.power === 'number' ? a.power : -1) - (typeof b.power === 'number' ? b.power : -1)); break;
    case 'power_desc':
      arr.sort((a, b) => (typeof b.power === 'number' ? b.power : -1) - (typeof a.power === 'number' ? a.power : -1)); break;
    case 'set_asc':
    default:
      arr.sort(bySetAsc);
  }
  return arr;
}

/* ============================================================
   DECK BUILDER: RENDERING CARD GRID
   ============================================================ */
/* Every colour a card shows, in order. Multi-colour cards (RYマーブルストーン,
   ヒエロスガモス など) return two entries and are drawn split down the middle. */
function cardColorHexes(card) {
  const out = [];
  for (const ch of (card.color || '無')) if (COLOR_HEX[ch]) out.push(COLOR_HEX[ch]);
  return out.length ? out : [COLOR_HEX['無']];
}
function cardPrimaryColorHex(card) {
  return cardColorHexes(card)[0];
}
/* Hard split down the vertical centre — no blending, so each colour stays readable. */
function cardBadgeBackground(card) {
  const cols = cardColorHexes(card);
  if (cols.length === 1) return cols[0];
  const step = 100 / cols.length;
  const stops = cols.map((c, i) => `${c} ${i * step}%, ${c} ${(i + 1) * step}%`).join(', ');
  return `linear-gradient(90deg, ${stops})`;
}
/* Same split, but softly blended and translucent, for the rule-text panel. */
function cardTextBackground(card, alpha) {
  const cols = cardColorHexes(card).map(c => hexToRgba(c, alpha));
  if (cols.length === 1) return cols[0];
  return `linear-gradient(90deg, ${cols[0]} 0%, ${cols[0]} 30%, ${cols[1]} 70%, ${cols[1]} 100%)`;
}
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ============================================================
   UNIFIED CARD BADGE — used everywhere a card's type/level icon
   is shown (search grid, deck list, card detail view):
     - background/text color = the card's own color
     - label = type letter (イ/マ/ハ), or for マリョク, its level number
     - shape = rounded square for イジン/マホウ/ハイケイ, circle for マリョク
   ============================================================ */
const CARD_TYPE_LETTER = { 'イジン': 'イ', 'マホウ': 'マ', 'ハイケイ': 'ハ' };

function cardBadge(card) {
  const span = document.createElement('span');
  span.className = 'card-type-badge';
  if (card.type !== 'マリョク') span.classList.add('badge-square');
  span.style.background = cardBadgeBackground(card);
  if (card.type === 'マリョク') {
    span.textContent = card.level;
    span.title = `マリョク（レベル${card.level}）・色:${card.color}`;
  } else {
    span.textContent = CARD_TYPE_LETTER[card.type] || '?';
    span.title = `${card.type}・色:${card.color}`;
  }
  return span;
}

/* Right-slot badge: level number (not shown for マリョク, whose level is already on the left badge).
   Text color uses the card's own color for a quick visual match with the left badge. */
function tileLevelBadge(card) {
  const span = document.createElement('span');
  span.className = 'card-type-badge level-badge';
  span.style.color = cardPrimaryColorHex(card);
  span.textContent = card.level;
  span.title = `レベル${card.level}`;
  return span;
}

function cardStatText(card) {
  if (card.type === 'イジン') return `Lv${card.level} / パワー${card.power}`;
  if (card.type === 'マホウ') return `Lv${card.level} / コスト${card.magic_cost ?? 0}`;
  return `Lv${card.level}`;
}

/* Shared "card face" builder: header (badge/name/level) + trait + rule text (with bolded
   keywords) + sub row (legacy ability / power or cost). Appended directly into `container`,
   which may be a search-grid tile or the (larger) card detail view.
   Set includeSource=true to also append a set/rarity line (used in the detail view; the
   search-grid tile instead folds the set/rarity into its own footer, alongside the deck buttons). */
function appendCardFace(container, card, { includeSource = false } = {}) {
  const header = document.createElement('div');
  header.className = 'card-header-row';
  header.appendChild(cardBadge(card));
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = card.name;
  header.appendChild(nameEl);
  if (card.type === 'マホウ' && (card.magic_cost || 0) > 0) {
    const costEl = document.createElement('span');
    costEl.className = 'card-cost-pips';
    costEl.textContent = '○'.repeat(card.magic_cost);
    costEl.title = `魔力コスト${card.magic_cost}`;
    header.appendChild(costEl);
  }
  if (card.type !== 'マリョク') header.appendChild(tileLevelBadge(card));
  container.appendChild(header);

  const trait = (card.trait || '').trim();
  if (trait && trait !== '（空欄）') {
    const traitEl = document.createElement('div');
    traitEl.className = 'card-trait';
    traitEl.textContent = trait;
    container.appendChild(traitEl);
  }

  const ruleText = (card.rule_text || '').trim();
  if (ruleText && ruleText !== '（空欄）' && ruleText !== '-') {
    const ruleEl = document.createElement('div');
    ruleEl.className = 'card-rule-text';
    ruleEl.style.background = cardTextBackground(card, 0.14);
    ruleEl.appendChild(renderRuleTextNode(ruleText));
    container.appendChild(ruleEl);
  }

  const subRow = document.createElement('div');
  subRow.className = 'card-sub-row';
  const legacyEl = document.createElement('span');
  legacyEl.className = 'card-legacy';
  legacyEl.textContent = formatLegacyAbility(card.legacy_ability) || '';
  subRow.appendChild(legacyEl);

  const statEl = document.createElement('span');
  if (card.type === 'イジン') {
    statEl.className = 'card-power';
    statEl.style.color = cardPrimaryColorHex(card);
    statEl.textContent = card.power;
  }
  subRow.appendChild(statEl);
  container.appendChild(subRow);

  if (includeSource) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'card-source';
    sourceEl.textContent = `${card.set}　${card.rarity || ''}`;
    container.appendChild(sourceEl);
  }
}

function renderCardGrid() {
  const list = sortCards(filterCards());
  document.getElementById('listCount').textContent = `カード一覧（${list.length}件）`;
  const grid = document.getElementById('cardGrid');
  grid.innerHTML = '';
  list.forEach(card => {
    const tile = document.createElement('div');
    tile.className = 'card-tile';

    appendCardFace(tile, card);

    // Footer: set / rarity on the left --- count, minus, add on the right
    const footer = document.createElement('div');
    footer.className = 'card-tile-footer';

    const sourceEl = document.createElement('span');
    sourceEl.className = 'card-source';
    sourceEl.textContent = `${card.set}　${card.rarity || ''}`;
    footer.appendChild(sourceEl);

    const rightWrap = document.createElement('span');
    rightWrap.className = 'card-tile-footer-right';
    const countBadge = document.createElement('span');
    const cur = state.draft[card.id] || 0;
    countBadge.className = 'count-badge';
    countBadge.textContent = cur > 0 ? ('x' + cur) : '';
    countBadge.style.visibility = cur > 0 ? 'visible' : 'hidden';
    rightWrap.appendChild(countBadge);

    const minusBtn = document.createElement('button');
    minusBtn.className = 'add-btn';
    minusBtn.textContent = '－';
    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); decCardFromDraft(card.id); });
    rightWrap.appendChild(minusBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '＋ 追加';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); addCardToDraft(card.id); });
    rightWrap.appendChild(addBtn);

    footer.appendChild(rightWrap);
    tile.appendChild(footer);

    grid.appendChild(tile);
  });
}

/* ============================================================
   DECK BUILDER: DRAFT MANAGEMENT
   ============================================================ */
function addCardToDraft(cardId) {
  const card = CARDS_BY_ID[cardId];
  const unlimited = UNLIMITED_RE.test(card.rule_text || '');
  const cur = state.draft[cardId] || 0;
  if (!unlimited && cur >= 4) {
    flashDeckStatus('同名カードは4枚までです（' + card.name + '）');
    return;
  }
  state.draft[cardId] = cur + 1;
  renderDeckPanel();
  renderCardGrid();
}

function decCardFromDraft(cardId) {
  const cur = state.draft[cardId] || 0;
  if (cur <= 1) delete state.draft[cardId];
  else state.draft[cardId] = cur - 1;
  renderDeckPanel();
  renderCardGrid();
}

function removeCardFromDraft(cardId) {
  delete state.draft[cardId];
  renderDeckPanel();
  renderCardGrid();
}

let statusFlashTimeout = null;
function flashDeckStatus(msg) {
  const el = document.getElementById('deckStatus');
  const prevHTML = el.innerHTML;
  el.textContent = msg;
  el.classList.add('warn');
  clearTimeout(statusFlashTimeout);
  statusFlashTimeout = setTimeout(() => { renderDeckPanel(); }, 1800);
}

const DECK_TYPE_ORDER = ['イジン', 'ハイケイ', 'マホウ', 'マリョク'];

/* Sort a deck's card ids in a fixed, always-consistent order:
   イジン → ハイケイ → マホウ → マリョク, then by name within each group.
   Used by both the deck panel display and the text export, so the two always match. */
function sortDeckIds(draft) {
  return Object.keys(draft).sort((a, b) => {
    const ca = CARDS_BY_ID[a], cb = CARDS_BY_ID[b];
    const ta = DECK_TYPE_ORDER.indexOf(ca.type), tb = DECK_TYPE_ORDER.indexOf(cb.type);
    if (ta !== tb) return ta - tb;
    return ca.name.localeCompare(cb.name, 'ja');
  });
}

function renderDeckPanel() {
  const el = document.getElementById('deckStatus');
  const total = Object.values(state.draft).reduce((a, b) => a + b, 0);
  el.classList.remove('warn', 'ok');
  if (total >= 40) {
    el.textContent = `合計 ${total} 枚 ・ 構築OK（40枚以上）`;
    el.classList.add('ok');
  } else {
    el.textContent = `合計 ${total} 枚 ・ あと ${40 - total} 枚必要です`;
    el.classList.add('warn');
  }

  const listEl = document.getElementById('deckList');
  listEl.innerHTML = '';
  const ids = sortDeckIds(state.draft);
  let lastType = null;
  ids.forEach(id => {
    const card = CARDS_BY_ID[id];
    const count = state.draft[id];

    if (card.type !== lastType) {
      lastType = card.type;
      const heading = document.createElement('div');
      heading.className = 'deck-group-heading';
      heading.textContent = card.type;
      listEl.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'deck-row';

    row.appendChild(cardBadge(card));

    const nameEl = document.createElement('span');
    nameEl.className = 'dr-name';
    nameEl.textContent = `${card.name} ×${count}`;
    nameEl.addEventListener('click', () => openCardDetail(id));
    row.appendChild(nameEl);

    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.addEventListener('click', () => decCardFromDraft(id));
    row.appendChild(minus);

    const plus = document.createElement('button');
    plus.textContent = '＋';
    plus.addEventListener('click', () => addCardToDraft(id));
    row.appendChild(plus);

    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => removeCardFromDraft(id));
    row.appendChild(del);

    listEl.appendChild(row);
  });
}

/* ============================================================
   DECK BUILDER: SAVE / LOAD / EXPORT / IMPORT
   ============================================================ */
function refreshSavedDeckSelect() {
  const sel = document.getElementById('savedDeckSelect');
  sel.innerHTML = '';
  Object.keys(state.decks).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
  refreshSoloDeckSelect();
}

function refreshSoloDeckSelect() {
  const sel = document.getElementById('soloDeckSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  Object.keys(state.decks).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name + ` (${totalCount(state.decks[name].cards)}枚)`;
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function totalCount(cardsObj) {
  return Object.values(cardsObj).reduce((a, b) => a + b, 0);
}

document.getElementById('btnSaveDeck').addEventListener('click', () => {
  const name = document.getElementById('deckNameInput').value.trim();
  if (!name) { alert('デッキ名を入力してください'); return; }
  if (Object.keys(state.draft).length === 0) { alert('デッキが空です'); return; }
  state.decks[name] = { cards: { ...state.draft } };
  saveDecks(state.decks);
  refreshSavedDeckSelect();
  flashDeckStatus(`「${name}」として保存しました`);
});

document.getElementById('btnNewDeck').addEventListener('click', () => {
  state.draft = {};
  document.getElementById('deckNameInput').value = '';
  renderDeckPanel();
  renderCardGrid();
});

document.getElementById('btnLoadDeck').addEventListener('click', () => {
  const name = document.getElementById('savedDeckSelect').value;
  if (!name || !state.decks[name]) return;
  state.draft = { ...state.decks[name].cards };
  document.getElementById('deckNameInput').value = name;
  renderDeckPanel();
  renderCardGrid();
});

document.getElementById('btnDeleteDeck').addEventListener('click', () => {
  const name = document.getElementById('savedDeckSelect').value;
  if (!name || !state.decks[name]) return;
  if (!confirm(`「${name}」を削除しますか？`)) return;
  delete state.decks[name];
  saveDecks(state.decks);
  refreshSavedDeckSelect();
});

document.getElementById('btnExportDeck').addEventListener('click', () => {
  const ids = sortDeckIds(state.draft);
  const lines = [];
  let lastType = null;
  ids.forEach(id => {
    const c = CARDS_BY_ID[id];
    if (c.type !== lastType) {
      lastType = c.type;
      lines.push(`▼ ${c.type}`);
    }
    lines.push(`${state.draft[id]}\t${id}\t${c.name}`);
  });
  openTextModal('デッキ書出（コピーして保存してください）', lines.join('\n'), null);
});

document.getElementById('btnImportDeck').addEventListener('click', () => {
  openTextModal('デッキ読込（1行ごとに「枚数 カードID」を貼り付け）', '', (text) => {
    const newDraft = {};
    text.split('\n').forEach(line => {
      const m = line.trim().match(/^(\d+)\s+([^\s\t]+)/);
      if (m) {
        const count = Number(m[1]);
        const id = m[2];
        if (CARDS_BY_ID[id]) newDraft[id] = (newDraft[id] || 0) + count;
      }
    });
    state.draft = newDraft;
    renderDeckPanel();
    renderCardGrid();
  });
});

/* ============================================================
   MODALS: card detail + text import/export
   ============================================================ */
const modalOverlay = document.getElementById('cardModal');
const modalContent = document.getElementById('cardModalContent');

function closeModal() {
  // めくって確認する画面を閉じたら、山札の操作メニューごと終了する
  if (DECK_PEEK_OPEN) {
    DECK_PEEK_OPEN = false;
    if (FLOW) commitFlow();
  }
  modalOverlay.classList.remove('is-open', 'with-equip');
  modalContent.innerHTML = '';
  modalContent.classList.remove('detail-face', 'help-panel');
  // 装備表示のために入れ替えたDOMを元に戻す
  const pair = modalOverlay.querySelector ? modalOverlay.querySelector('.detail-pair') : null;
  if (pair) { modalOverlay.removeChild(pair); modalOverlay.appendChild(modalContent); }
}
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

function openCardDetail(cardId, context = null) {
  const c = CARDS_BY_ID[cardId];
  modalContent.innerHTML = '';
  modalContent.classList.add('detail-face');

  appendCardFace(modalContent, c, { includeSource: true });

  if (context) appendContextActions(modalContent, c, context);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost m-close btn-block';
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', closeModal);
  modalContent.appendChild(closeBtn);

  // 装備しているカードがあれば、その詳細を横に並べて表示する
  const host = (context && context.zoneKey === 'field' && GAME)
    ? GAME.field.find(f => f.uid === context.uid) : null;
  const gear = equippedOn(host);
  modalOverlay.classList.toggle('with-equip', gear.length > 0);
  if (gear.length) {
    const pair = document.createElement('div');
    pair.className = 'detail-pair';
    modalOverlay.removeChild(modalContent);
    pair.appendChild(modalContent);

    const col = document.createElement('div');
    col.className = 'detail-equip-col';
    gear.forEach(e => {
      const box = document.createElement('div');
      box.className = 'detail-equip-card';
      const tag = document.createElement('div');
      tag.className = 'equip-tag';
      tag.textContent = '装備しているカード';
      box.appendChild(tag);
      appendCardFace(box, CARDS_BY_ID[e.cardId], { includeSource: true });
      const off = document.createElement('button');
      off.className = 'btn btn-ghost btn-block';
      off.textContent = '外して元の場所へ';
      off.addEventListener('click', () => {
        pushUndo();
        host.equipped = host.equipped.filter(x => x.uid !== e.uid);
        const back = e.from === 'mana' ? GAME.mana : e.from === 'graveyard' ? GAME.graveyard : GAME.field;
        back.push(e.from === 'mana' ? { uid: e.uid, cardId: e.cardId, faceUp: true }
                 : e.from === 'field' ? { uid: e.uid, cardId: e.cardId, faceUp: true, tapped: false, summonedTurn: GAME.turn }
                 : { uid: e.uid, cardId: e.cardId });
        log(`${CARDS_BY_ID[e.cardId].name} の装備を外しました`);
        closeModal();
        renderBoard();
      });
      box.appendChild(off);
      col.appendChild(box);
    });
    pair.appendChild(col);
    modalOverlay.appendChild(pair);
  }

  modalOverlay.classList.add('is-open');
}

/* Solo-play extras in the detail view.
   Anything the mouse can already do (ゾーン間の移動 = ドラッグ、墓地へ = ダブルタップ)
   is deliberately NOT repeated here. Only these remain:
     ・マホウ使用（魔力コストの支払いカードを選ぶ必要がある）
     ・戦場のカードの 寝かせる/起こす と 表裏の反転（ドラッグでは表現できない） */
function appendContextActions(container, card, { uid, zoneKey }) {
  const wrap = document.createElement('div');
  wrap.className = 'm-context-actions';

  if (zoneKey === 'hand' && card.type === 'マホウ') {
    const check = checkPlayCondition(card);
    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-primary btn-block';
    useBtn.textContent = 'マホウを使用する';
    // 効果で条件を無視できることがあるので、ボタンは常に押せるままにし、
    // 満たしていない条件は注意書きとして示すだけにする。
    useBtn.addEventListener('click', () => { closeModal(); doMahouUse(uid); });
    if (!check.ok) {
      const req = document.createElement('div');
      req.className = 'm-requirement';
      req.textContent = `※${check.reasons.join('・')}を満たしていません`;
      wrap.appendChild(req);
    }
    wrap.appendChild(useBtn);
  }

  // 装備 / 冥装：正しい場所にあるときだけ押せる。押せない理由も示す。
  const srcZone = equipSourceZone(card);
  if (srcZone) {
    const meisou = hasMeisou(card);
    const zoneLabel = { mana: '魔力ゾーン', field: '戦場', graveyard: '墓地' }[srcZone];
    const inRightZone = zoneKey === srcZone;
    const hosts = GAME ? equipHosts().length : 0;

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = meisou ? '冥装させる' : '装備させる';
    if (!inRightZone || hosts === 0) {
      btn.disabled = true;
      const why = document.createElement('div');
      why.className = 'm-requirement';
      why.textContent = !inRightZone
        ? `${zoneLabel}にあるときだけ${meisou ? '冥装' : '装備'}させられます`
        : '装備できるイジンが戦場にいません';
      wrap.appendChild(why);
    } else {
      btn.addEventListener('click', () => { pushUndo(); beginEquip(uid, zoneKey, meisou); });
    }
    wrap.appendChild(btn);
  }

  const group = document.createElement('div');
  group.className = 'm-context-group';

  if (zoneKey === 'field') {
    const inst = GAME.field.find(x => x.uid === uid);
    addContextBtn(group, inst && inst.tapped ? '起こす' : '寝かせる', () => { toggleTapped(uid); closeModal(); });
    addContextBtn(group, inst && inst.faceUp ? '裏にする' : '表にする', () => { toggleFaceUp(uid, 'field'); closeModal(); });
  } else if (zoneKey === 'mana') {
    const inst = GAME.mana.find(x => x.uid === uid);
    addContextBtn(group, inst && inst.faceUp ? '裏にする' : '表にする', () => { toggleFaceUp(uid, 'mana'); closeModal(); });
  }

  if (group.children.length) wrap.appendChild(group);
  if (wrap.children.length) container.appendChild(wrap);
}
function addContextBtn(container, label, fn) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost';
  b.textContent = label;
  b.addEventListener('click', () => { pushUndo(); fn(); });
  container.appendChild(b);
}

function openTextModal(title, initialText, onSubmit) {
  modalContent.classList.remove('detail-face');
  modalContent.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = title; modalContent.appendChild(h);
  const ta = document.createElement('textarea');
  ta.style.width = '100%'; ta.style.height = '260px'; ta.style.fontFamily = 'monospace';
  ta.style.fontSize = '12px'; ta.style.padding = '8px'; ta.style.boxSizing = 'border-box';
  ta.value = initialText;
  modalContent.appendChild(ta);

  const row = document.createElement('div'); row.className = 'btn-row';
  if (onSubmit) {
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary'; okBtn.textContent = '読み込む';
    okBtn.addEventListener('click', () => { onSubmit(ta.value); closeModal(); });
    row.appendChild(okBtn);
  } else {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-primary'; copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      ta.select();
      try { document.execCommand('copy'); copyBtn.textContent = 'コピーしました！'; }
      catch (e) { navigator.clipboard && navigator.clipboard.writeText(ta.value); }
    });
    row.appendChild(copyBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost'; closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', closeModal);
  row.appendChild(closeBtn);
  modalContent.appendChild(row);

  modalOverlay.classList.add('is-open');
}

/* ============================================================
   SOLO PLAY: SETUP
   ============================================================ */
const RESOURCE_LABEL = { manaPlace: 'マリョク配置権', summon: 'イジン召喚権', battle: 'バトル権' };

document.querySelectorAll('#fFirst .chip-toggle').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#fFirst .chip-toggle').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
  });
});

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

document.getElementById('btnStartGame').addEventListener('click', () => {
  const deckName = document.getElementById('soloDeckSelect').value;
  if (!deckName || !state.decks[deckName]) { alert('デッキを選択してください'); return; }
  const isFirst = document.querySelector('#fFirst .chip-toggle.is-active').dataset.val === 'first';

  const pool = [];
  const deckDef = state.decks[deckName].cards;
  Object.keys(deckDef).forEach(id => { for (let i = 0; i < deckDef[id]; i++) pool.push(id); });

  const deck = shuffle(pool);

  UNDO_STACK = [];
  FLOW = null;
  DRAW_PROMPT = false;

  GAME = {
    deckName, isFirst,
    turn: 1, phase: 'draw',
    deck: [],
    hand: [],
    graveyard: [],
    mana: [],
    field: [],
    resources: { manaPlace: 1, summon: 1, battle: 1 },
    log: []
  };
  GAME.deck = deck; // top = end of array

  for (let i = 0; i < 6 && GAME.deck.length; i++) {
    const id = GAME.deck.pop();
    GAME.hand.push({ uid: uidCounter++, cardId: id });
  }
  for (let i = 0; i < 4 && GAME.deck.length; i++) {
    const id = GAME.deck.pop();
    GAME.field.push({ uid: uidCounter++, cardId: id, faceUp: false, tapped: false, summonedTurn: 0 });
  }

  log(`対戦準備完了：${deckName}（${isFirst ? '先攻' : '後攻'}） 手札6枚・ガーディアン4枚を配置`);

  document.getElementById('setupPanel').style.display = 'none';
  document.getElementById('boardPanel').style.display = 'block';
  document.body.classList.add('solo-view');
  renderBoard();
});

document.getElementById('btnEndGame').addEventListener('click', () => {
  if (!confirm('対戦を終了して準備画面に戻りますか？')) return;
  GAME = null; FLOW = null; UNDO_STACK = []; DRAW_PROMPT = false; hideFlowBanner();
  document.getElementById('setupPanel').style.display = 'block';
  document.getElementById('boardPanel').style.display = 'none';
  document.body.classList.remove('solo-view', 'header-peek');
});

/* ============================================================
   SOLO PLAY: UNDO
   ============================================================ */
function snapshotGame() { return JSON.parse(JSON.stringify(GAME)); }
function pushUndo() {
  if (!GAME) return;
  UNDO_STACK.push(snapshotGame());
  if (UNDO_STACK.length > 50) UNDO_STACK.shift();
}
document.getElementById('btnUndo').addEventListener('click', () => {
  if (!GAME || UNDO_STACK.length === 0) return;
  GAME = UNDO_STACK.pop();
  FLOW = null;
  hideFlowBanner();
  log('一手戻しました');
  renderBoard();
});

/* ============================================================
   SOLO PLAY: LOG (shown at the top; latest entry always visible)
   ============================================================ */
function log(msg) {
  if (!GAME) return;
  GAME.log.push(msg);
  renderLogBar();
}
/* Newest entry first, and the whole history stays scrollable. */
function renderLogBar() {
  const box = document.getElementById('logLines');
  box.innerHTML = '';
  for (let i = GAME.log.length - 1; i >= 0; i--) {
    const d = document.createElement('div');
    d.textContent = GAME.log[i];
    if (i === GAME.log.length - 1) d.className = 'log-latest';
    box.appendChild(d);
  }
  box.scrollTop = 0;   // always show the newest
}

/* ============================================================
   SOLO PLAY: PHASE PROGRESSION
   スタートフェイズは完全自動。ドローボタンでメインフェイズへ。ターンエンドボタンで手番終了。
   操作が必要なのはメインフェイズのみ。
   ============================================================ */
function runStartPhase() {
  GAME.field.forEach(c => c.tapped = false);
  GAME.resources.manaPlace = 1;
  GAME.resources.summon = 1;
  GAME.resources.battle = 1;
  log(`── ターン${GAME.turn} スタートフェイズ：戦場を起こし、各権利をリセット ──`);
}

/* ドローフェイズは、山札以外を薄暗くして「山札をクリック」だけを促す。
   フローと違い取り消す対象が無いので、暗い部分をクリックしても解除しない。 */
function showDrawPrompt() {
  if (DRAW_PROMPT) return;
  DRAW_PROMPT = true;
  document.getElementById('deckSlot').classList.add('is-draw-target');
  const first = GAME.turn === 1 && GAME.isFirst;
  showFlowBanner(
    first ? '山札をクリックしてメインフェイズへ進んでください（先攻1ターン目はドローしません）'
          : '山札をクリックしてドローしてください',
    [], 'deckSlot'
  );
}
function hideDrawPrompt() {
  if (!DRAW_PROMPT) return;
  DRAW_PROMPT = false;
  document.getElementById('deckSlot').classList.remove('is-draw-target');
  hideFlowBanner();
}

/* 山札をワンクリックで1枚ドロー。
   メインフェイズへ移行するのはドローフェイズのドローだけで、
   それ以外（カード効果によるドロー）はフェイズを変えない。 */
function drawOne() {
  if (!GAME) return;
  pushUndo();
  const isDrawPhase = GAME.phase === 'draw';
  const skip = isDrawPhase && GAME.turn === 1 && GAME.isFirst;

  if (skip) {
    flashMessage('先攻1ターン目のためドローをスキップします');
    log('先攻1ターン目のためドローをスキップします');
  } else if (GAME.deck.length === 0) {
    log('山札が0枚のためドローできません');
    flashMessage('山札が0枚です');
  } else {
    const id = GAME.deck.pop();
    const pile = document.getElementById('deckTopCard');
    const from = pile ? elementCentre(pile) : null;
    const uid = uidCounter++;
    if (isDrawPhase) GAME.phase = 'main';
    flyInto(from, uid, id, true, () => {
      GAME.hand.push({ uid, cardId: id });
      log(`${isDrawPhase ? 'ドロー' : '効果によるドロー'}：${CARDS_BY_ID[id].name}`);
    });
    return;
  }

  if (isDrawPhase) GAME.phase = 'main';
  renderBoard();
}

/* 山札の上から1枚を墓地に置く（山札のダブルタップ） */
function millOne() {
  if (!GAME) return;
  if (GAME.deck.length === 0) { flashMessage('山札が0枚です'); return; }
  pushUndo();
  const id = GAME.deck.pop();
  const pile = document.getElementById('deckTopCard');
  const from = pile ? elementCentre(pile) : null;
  renderBoard();                       // 山札の枚数表示を先に更新
  flyToGraveyard(from, id, true, () => {
    GAME.graveyard.push({ uid: uidCounter++, cardId: id });
    log(`山札の上から ${CARDS_BY_ID[id].name} を墓地に置きました`);
    renderBoard();
  });
}

document.getElementById('btnEndTurn').addEventListener('click', () => {
  if (!GAME || GAME.phase !== 'main') return;
  pushUndo();
  log(`ターン${GAME.turn} エンドフェイズ：未使用の権利が消滅`);
  GAME.turn += 1;
  runStartPhase();
  GAME.phase = 'draw';
  renderBoard();
});

/* ============================================================
   SOLO PLAY: ZONE MOVEMENT (generic — used by guided flows, the hand-card
   quick-action menu, and the detail-view context actions)
   ============================================================ */
function findAndRemove(zoneArr, uid) {
  // 山札からのドラッグは、実際には山札の一番上を取り除く
  if (DECK_DRAG_PENDING && DECK_DRAG_PENDING.uid === uid && zoneArr.length === 1 && zoneArr[0] === DECK_DRAG_PENDING) {
    const inst = DECK_DRAG_PENDING;
    DECK_DRAG_PENDING = null;
    if (GAME.deck.length && GAME.deck[GAME.deck.length - 1] === inst.cardId) GAME.deck.pop();
    return inst;
  }
  const idx = zoneArr.findIndex(x => x.uid === uid);
  if (idx === -1) return null;
  return zoneArr.splice(idx, 1)[0];
}

/* Cards attached to a field card, if any. */
function equippedOn(inst) {
  return (inst && inst.equipped) ? inst.equipped : [];
}
function zoneArrayOf(zoneKey) {
  // 'deckPile' は山札からドラッグ中の1枚だけを持つ仮想ゾーン
  if (zoneKey === 'deckPile') return DECK_DRAG_PENDING ? [DECK_DRAG_PENDING] : [];
  return { hand: GAME.hand, mana: GAME.mana, field: GAME.field, graveyard: GAME.graveyard }[zoneKey];
}
function moveInstance(uid, fromZone, toZone, opts = {}) {
  const fromArr = zoneArrayOf(fromZone);
  const inst = findAndRemove(fromArr, uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  // 装備しているイジンが戦場を離れるときは、装備カードも一緒に墓地へ
  if (fromZone === 'field' && toZone !== 'graveyard') detachEquipmentToGraveyard(inst);

  const src = fromZone === 'deckPile' ? '山札の上から ' : '';
  if (toZone === 'hand') {
    GAME.hand.push({ uid: inst.uid, cardId: inst.cardId });
    log(`${src}${card.name} を手札に${src ? '加え' : '戻し'}ました`);
  } else if (toZone === 'mana') {
    GAME.mana.push({ uid: inst.uid, cardId: inst.cardId, faceUp: !!opts.faceUp });
    log(`${src}${card.name} を魔力ゾーンに${opts.faceUp ? '表向きで' : '裏向きで'}置きました`);
  } else if (toZone === 'field') {
    GAME.field.push({ uid: inst.uid, cardId: inst.cardId, faceUp: opts.faceUp !== false, tapped: false, summonedTurn: GAME.turn });
    log(`${src}${card.name} を戦場に${opts.faceUp !== false ? '表向きで' : '裏向き（ガーディアン）で'}置きました`);
  } else if (toZone === 'graveyard') {
    if (fromZone === 'field') detachEquipmentToGraveyard(inst);
    GAME.graveyard.push({ uid: inst.uid, cardId: inst.cardId });
    let msg = `${src}${card.name} を墓地に置きました`;
    // 遺業能力は「戦場から墓地に置かれたとき」だけ発動する。
    const hasLegacy = card.legacy_ability && !['-', '（空欄）', ''].includes(card.legacy_ability.trim());
    if (fromZone === 'field' && hasLegacy) msg += '　※遺業能力の発動を確認してください';
    log(msg);
  } else if (toZone === 'deckTop') {
    GAME.deck.push(inst.cardId);
    log(`${card.name} を山札の上に戻しました`);
  } else if (toZone === 'deckBottom') {
    GAME.deck.unshift(inst.cardId);
    log(`${card.name} を山札の下に戻しました`);
  }
  renderBoard();
}
/* マホウ使用：魔力コストぶんのカードを魔力ゾーンから選んで墓地に置いてから解決する。
   どのカードを支払うかは色を残す上で重要なので、プレイヤーに選ばせる。 */
function doMahouUse(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  const cost = card.magic_cost || 0;
  if (cost <= 0) { pushUndo(); finishMahou(uid); renderBoard(); return; }
  beginFlow('mahou-cost', { mahouUid: uid, picked: [], cost });
  refreshMahouCostBanner();
  renderBoard();
}
function refreshMahouCostBanner() {
  showFlowBanner(
    `魔力コストとして墓地に置くカードを魔力ゾーンから選んでください（${FLOW.picked.length}/${FLOW.cost}）`,
    [{
      label: '無視する', sub: true,
      title: 'カードの効果で魔力コストを支払わない場合',
      onClick: () => {
        const spell = FLOW.mahouUid;
        log('（効果により魔力コストの支払いを無視しました）');
        finishMahou(spell);
        commitFlow();
      }
    }],
    'zoneMana'
  );
}
function onManaCostPick(uid) {
  if (FLOW.picked.includes(uid)) FLOW.picked = FLOW.picked.filter(x => x !== uid);
  else if (FLOW.picked.length < FLOW.cost) FLOW.picked.push(uid);

  if (FLOW.picked.length === FLOW.cost) {
    const mahouUid = FLOW.mahouUid;
    FLOW.picked.forEach(u => moveInstance(u, 'mana', 'graveyard'));
    finishMahou(mahouUid);
    commitFlow();
    return;
  }
  refreshMahouCostBanner();
  renderBoard();
}
function finishMahou(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  log(`マホウ使用：${CARDS_BY_ID[inst.cardId].name}　※効果はルールテキストに従って手動で処理してください`);
  moveInstance(uid, 'hand', 'graveyard', {});
}
function toggleFaceUp(uid, zoneKey) {
  const arr = zoneArrayOf(zoneKey);
  const inst = arr.find(x => x.uid === uid);
  if (!inst) return;
  inst.faceUp = !inst.faceUp;
  log(`${CARDS_BY_ID[inst.cardId].name} を${inst.faceUp ? '表' : '裏'}にしました`);
  renderBoard();
}
/* 寝かせる／起こす。回転そのものは .mini-card の transition が受け持つので、
   カードを作り直さずにクラスだけ差し替えて滑らかに回す。 */
function toggleTapped(uid) {
  const inst = GAME.field.find(x => x.uid === uid);
  if (!inst) return;
  inst.tapped = !inst.tapped;
  log(`${CARDS_BY_ID[inst.cardId].name} を${inst.tapped ? '寝かせ' : '起こし'}ました`);

  const el = cardElement(uid);
  if (el && el.classList) {
    el.classList.toggle('is-tapped', inst.tapped);
    REFLOW_BEFORE = captureCardPositions();   // 隣のカードのずれも滑らかに
  }
  renderBoard();
}

/* ============================================================
   SOLO PLAY: PLAY-CONDITION CHECKS (色条件・レベル条件・魔力コスト)
   ============================================================ */
function cardHasKeyword(card, kw) { return (card.rule_text || '').includes(kw); }
function manaColors() {
  const colors = new Set();
  GAME.mana.forEach(m => {
    if (m.faceUp) {
      const c = CARDS_BY_ID[m.cardId];
      if (c.color && c.color !== '無') [...c.color].forEach(ch => COLOR_HEX[ch] && colors.add(ch));
    }
  });
  return colors;
}
function manaLevelCap() {
  let levelTotal = 0, faceDownCount = 0;
  GAME.mana.forEach(m => {
    if (m.faceUp) levelTotal += (CARDS_BY_ID[m.cardId].level || 0);
    else faceDownCount += 1;
  });
  return levelTotal + faceDownCount;
}
function checkPlayCondition(card) {
  const reasons = [];
  if (card.color && card.color !== '無') {
    const colors = manaColors();
    if (![...card.color].some(ch => colors.has(ch))) reasons.push('色条件');
  }
  if (manaLevelCap() < (card.level || 0)) reasons.push('レベル条件');
  if (card.type === 'マホウ' && GAME.mana.length < (card.magic_cost || 0)) reasons.push('魔力コスト');
  return { ok: reasons.length === 0, reasons };
}
function manaSummaryText() {
  const colors = manaColors();
  const cap = manaLevelCap();
  return `使用可能な色:${colors.size ? [...colors].join('') : 'なし'} ／ レベル上限:${cap}`;
}

/* ============================================================
   SOLO PLAY: GUIDED FLOWS (マリョク配置 / イジン召喚 / バトル)
   ============================================================ */
function beginFlow(type, extra = {}) {
  FLOW = { type, snapshot: snapshotGame(), ...extra };
}
function cancelFlow() {
  closeGravePopover();
  if (FLOW && FLOW.snapshot) GAME = FLOW.snapshot;
  FLOW = null;
  hideFlowBanner();
  renderBoard();
}
function commitFlow() {
  closeGravePopover();
  if (FLOW && FLOW.snapshot) {
    UNDO_STACK.push(FLOW.snapshot);
    if (UNDO_STACK.length > 50) UNDO_STACK.shift();
  }
  FLOW = null;
  hideFlowBanner();
  renderBoard();
}
let lastFlowButtons = [];   // exposed for automated testing
/* Centre-screen prompt. The rest of the board is dimmed; cards marked
   .is-selectable stay bright and clickable above the dimming layer. */
function showFlowBanner(message, buttons, avoidZoneId = null) {
  lastFlowButtons = buttons;
  document.getElementById('stageMessage').textContent = message;
  const actionsEl = document.getElementById('stageActions');
  actionsEl.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'stage-btn' + (b.sub ? ' stage-btn-sub' : '');
    btn.textContent = b.label;
    if (b.disabled) btn.disabled = true;
    if (b.title) btn.title = b.title;
    btn.addEventListener('click', b.onClick);
    actionsEl.appendChild(btn);
  });
  const prompt = document.getElementById('stagePrompt');
  // ドロー段階は取り消す対象が無いので、取り消しの案内は出さない
  const hint = document.querySelector('.stage-hint');
  if (hint) hint.style.display = DRAW_PROMPT ? 'none' : '';
  prompt.classList.add('is-open');
  document.getElementById('stageDim').classList.add('is-open');
  document.body.classList.add('is-staged');
  positionPrompt(avoidZoneId);
}

/* Prompts sit in the centre of the screen. If the centre would cover the zone the
   player has to pick from, slide the prompt vertically only (never sideways) until
   it clears that zone. `avoid` is a zone container id, or null for a plain message. */
function positionPrompt(avoid) {
  const prompt = document.getElementById('stagePrompt');
  prompt.style.top = '50%';
  if (!avoid) return;
  const zoneEl = document.getElementById(avoid);
  if (!zoneEl || !zoneEl.getBoundingClientRect) return;

  const z = zoneEl.getBoundingClientRect();
  const p = prompt.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  const gap = 14;
  if (p.bottom < z.top - gap || p.top > z.bottom + gap) return;   // already clear

  const h = p.height;
  const aboveCentre = z.top - gap - h / 2;      // centre-y that puts it above the zone
  const belowCentre = z.bottom + gap + h / 2;   // centre-y that puts it below the zone
  const fitsAbove = aboveCentre - h / 2 > 8;
  const fitsBelow = belowCentre + h / 2 < vh - 8;

  let centreY;
  if (fitsAbove && fitsBelow) centreY = (z.top > vh - z.bottom) ? aboveCentre : belowCentre;
  else if (fitsAbove) centreY = aboveCentre;
  else if (fitsBelow) centreY = belowCentre;
  else return;

  prompt.style.top = `${Math.round((centreY / vh) * 100)}%`;
}
function hideFlowBanner() {
  document.getElementById('stagePrompt').classList.remove('is-open');
  document.getElementById('stageDim').classList.remove('is-open');
  document.body.classList.remove('is-staged');
  lastFlowButtons = [];
}

/* 光っていない場所（暗い部分）をクリックすると操作を取り消す */
document.getElementById('stageDim').addEventListener('click', () => {
  if (FLOW) { cancelFlow(); return; }
  if (DRAW_PROMPT) return;   // ドローするまで解除しない
  hideFlowBanner();
});

/* --- マリョク配置：毎回「表で配置」「裏で配置」の2択 --- */
document.getElementById('btnActionMana').addEventListener('click', () => {
  if (!GAME || GAME.phase !== 'main' || FLOW || GAME.resources.manaPlace < 1) return;
  const hasMaryoku = GAME.hand.some(h => CARDS_BY_ID[h.cardId].type === 'マリョク');
  beginFlow('mana-choice');
  showFlowBanner('どちらで配置しますか？', [
    {
      label: '表',
      disabled: !hasMaryoku,
      title: hasMaryoku ? 'マリョクを表向きで置く' : '手札にマリョクが無いため表向きでは配置できません',
      onClick: () => {
        FLOW.type = 'mana-pick'; FLOW.faceUp = true;
        showFlowBanner('表向きにするマリョクを手札から選んでください', [], 'zoneHand');
        renderBoard();
      }
    },
    {
      label: '裏', sub: true,
      title: '手札のどのカードでも裏向きで置ける',
      onClick: () => {
        FLOW.type = 'mana-pick'; FLOW.faceUp = false;
        showFlowBanner('裏向きで置くカードを手札から選んでください', [], 'zoneHand');
        renderBoard();
      }
    },
  ]);
  renderBoard();
});

function onManaPick(uid) {
  const faceUp = FLOW.faceUp;
  GAME.resources.manaPlace -= 1;
  const el = cardElement(uid);
  const from = el ? elementCentre(el) : null;
  const inst = GAME.hand.find(h => h.uid === uid);
  const cardId = inst ? inst.cardId : null;
  flyInto(from, uid, cardId, !faceUp, () => {
    moveInstance(uid, 'hand', 'mana', { faceUp });
    commitFlow();
  });
}

/* --- イジン召喚：条件を満たすイジンのみ選択可 --- */
document.getElementById('btnActionSummon').addEventListener('click', () => {
  if (!GAME || GAME.phase !== 'main' || FLOW || GAME.resources.summon < 1) return;
  const eligible = GAME.hand.some(h => { const c = CARDS_BY_ID[h.cardId]; return c.type === 'イジン' && checkPlayCondition(c).ok; });
  if (!eligible) return;
  beginFlow('summon-pick');
  showFlowBanner('召喚するイジンを手札から選んでください', [], 'zoneHand');
  renderBoard();
});
function onSummonPick(uid) {
  GAME.resources.summon -= 1;
  const inst = GAME.hand.find(h => h.uid === uid);
  const el = cardElement(uid);
  const from = el ? elementCentre(el) : null;
  const cardId = inst ? inst.cardId : null;
  flyInto(from, uid, cardId, false, () => {
    moveInstance(uid, 'hand', 'field', { faceUp: true });
    commitFlow();
  });
}

/* --- バトル：アタッカーを選んで「攻撃」で確定（対戦相手側は未実装） --- */
document.getElementById('btnActionBattle').addEventListener('click', () => {
  if (!GAME || GAME.phase !== 'main' || FLOW || GAME.resources.battle < 1) return;
  beginFlow('battle-pick', { attackers: [] });
  refreshBattleBanner();
  renderBoard();
});
function refreshBattleBanner() {
  // カードの効果で例外が起きうるので選択そのものは止めず、注意書きで知らせる。
  const notes = [];
  const freshly = FLOW.attackers.filter(uid => {
    const f = GAME.field.find(x => x.uid === uid);
    if (!f || !f.faceUp) return false;
    const c = CARDS_BY_ID[f.cardId];
    return f.summonedTurn === GAME.turn && !cardHasKeyword(c, '即応');
  });
  freshly.forEach(uid => {
    const c = CARDS_BY_ID[GAME.field.find(x => x.uid === uid).cardId];
    notes.push(`※${c.name}は即応アタッカーではありません`);
  });
  if (FLOW.attackers.some(uid => {
    const f = GAME.field.find(x => x.uid === uid);
    return f && !f.faceUp;
  })) {
    notes.push('※ガーディアンがアタッカーに選ばれています');
  }

  const msg = (FLOW.attackers.length ? `アタッカー ${FLOW.attackers.length}体を選択中` : 'アタッカーを選んでください')
    + (notes.length ? '\n' + notes.join('\n') : '');

  showFlowBanner(
    msg,
    [{ label: '攻撃', onClick: confirmBattle, disabled: FLOW.attackers.length === 0 }],
    'zoneField'
  );
}
function onBattlePick(uid) {
  const inst = GAME.field.find(x => x.uid === uid);
  const card = CARDS_BY_ID[inst.cardId];
  if (FLOW.attackers.includes(uid)) {
    inst.tapped = false;
    FLOW.attackers = FLOW.attackers.filter(x => x !== uid);
  } else {
    // 戦場のカードは原則すべてアタッカーに選べる（注意書きで知らせる）。
    // 表向きのハイケイなど、イジンでないカードだけは選べない。
    if (inst.tapped) return;
    if (inst.faceUp && card.type !== 'イジン') return;   // 表のイジン以外は不可（裏＝ガーディアンは可）
    inst.tapped = true;
    FLOW.attackers.push(uid);
  }
  refreshBattleBanner();
  renderBoard();
}
function confirmBattle() {
  const names = FLOW.attackers.map(uid => CARDS_BY_ID[GAME.field.find(f => f.uid === uid).cardId].name);
  GAME.resources.battle -= 1;
  log(`バトル宣言：アタッカー［${names.join('、')}］`);
  commitFlow();
}

/* --- resource +/- adjustment (card effects can grant extra 配置権/召喚権/バトル権) --- */
document.querySelectorAll('.adj-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (!GAME) return;
    pushUndo();
    const key = b.dataset.adjust, delta = Number(b.dataset.delta);
    GAME.resources[key] = Math.max(0, (GAME.resources[key] || 0) + delta);
    log(`${RESOURCE_LABEL[key]}を${delta > 0 ? '+1' : '-1'}`);
    renderBoard();
  });
});

/* ============================================================
   SOLO PLAY: TRANSIENT CENTER MESSAGE / FLY ANIMATIONS
   ============================================================ */
let flashTimer = null;
function flashMessage(text) {
  let el = document.getElementById('flashMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flashMsg';
    el.className = 'flash-msg';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-open');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('is-open'), 1400);
}

/* ============================================================
   SOLO PLAY: DRAG & DROP BETWEEN ZONES
   メインフェイズ中、ガイド付きフローを使っていないときは、カードを
   つかんで別のスペースへ運ぶことで移動できる。
   ============================================================ */
let DRAG = null;
let SUPPRESS_CLICK = false;

function initDropZones() {
  // 当たり判定は枠（zone-box）全体。カードの帯だけでなく段の高さいっぱいが対象になる。
  const map = { zoneField: 'field', zoneMana: 'mana', zoneHand: 'hand' };
  Object.keys(map).forEach(id => {
    const strip = document.getElementById(id);
    const box = strip && strip.closest('.zone-box');
    if (box) box.dataset.dropzone = map[id];
  });
  const grave = document.getElementById('graveSlot');
  if (grave) grave.dataset.dropzone = 'graveyard';
  const deck = document.getElementById('deckSlot');
  if (deck) deck.dataset.dropzone = 'deck';
}

function dropZoneAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('[data-dropzone]') : null;
}

/* 山札の上に重ねている間は、上半分／下半分のどちらに居るかで
   「山札の上に戻す」「山札の下に戻す」を選ぶ。 */
function deckHalfAt(y) {
  const slot = document.getElementById('deckSlot');
  if (!slot || !slot.getBoundingClientRect) return 'deckTop';
  const r = slot.getBoundingClientRect();
  return y < r.top + r.height / 2 ? 'deckTop' : 'deckBottom';
}
function updateDeckHalfHint(zone, y) {
  const slot = document.getElementById('deckSlot');
  if (!slot) return;
  const over = zone && zone.dataset && zone.dataset.dropzone === 'deck';
  slot.classList.toggle('half-top', !!over && deckHalfAt(y) === 'deckTop');
  slot.classList.toggle('half-bottom', !!over && deckHalfAt(y) === 'deckBottom');
}
function clearDeckHalfHint() {
  const slot = document.getElementById('deckSlot');
  if (slot) slot.classList.remove('half-top', 'half-bottom');
}

function startCardDrag(e, inst, zoneKey, el) {
  if (!GAME || GAME.phase !== 'main' || FLOW) return;
  if (e.button !== 0) return;
  if (e.preventDefault) e.preventDefault();   // 文字列選択が始まるのを防ぐ
  const r = el.getBoundingClientRect();
  DRAG = {
    uid: inst.uid, from: zoneKey, cardId: inst.cardId,
    faceDown: (zoneKey === 'field' || zoneKey === 'mana') && !inst.faceUp,
    sx: e.clientX, sy: e.clientY,
    offX: e.clientX - r.left, offY: e.clientY - r.top,
    moved: false, ghost: null
  };
  document.body.classList.add('is-dragging');
  window.addEventListener('pointermove', onCardDragMove);
  window.addEventListener('pointerup', onCardDragEnd);
}

function onCardDragMove(e) {
  if (DRAG && DRAG.from === 'graveyard' && !DRAG.moved) closeGravePopover();
  if (!DRAG) return;
  if (!DRAG.moved) {
    if (Math.hypot(e.clientX - DRAG.sx, e.clientY - DRAG.sy) < 7) return;
    DRAG.moved = true;
    const g = document.createElement('div');
    g.className = 'mini-card drag-ghost' + (DRAG.faceDown ? ' is-facedown' : '');
    if (!DRAG.faceDown) appendMiniCardFace(g, CARDS_BY_ID[DRAG.cardId]);
    document.body.appendChild(g);
    DRAG.ghost = g;
  }
  DRAG.ghost.style.left = (e.clientX - DRAG.offX) + 'px';
  DRAG.ghost.style.top = (e.clientY - DRAG.offY) + 'px';
  const zone = dropZoneAt(e.clientX, e.clientY);
  document.querySelectorAll('[data-dropzone]').forEach(z => z.classList.toggle('is-drop-target', z === zone));
  updateDeckHalfHint(zone, e.clientY);
}

function onCardDragEnd(e) {
  document.body.classList.remove('is-dragging');
  window.removeEventListener('pointermove', onCardDragMove);
  window.removeEventListener('pointerup', onCardDragEnd);
  if (!DRAG) return;
  const d = DRAG; DRAG = null;
  document.querySelectorAll('[data-dropzone]').forEach(z => z.classList.remove('is-drop-target'));
  clearDeckHalfHint();
  if (d.ghost) d.ghost.remove();
  if (!d.moved) { DECK_DRAG_PENDING = null; return; }   // 動いていなければ通常のクリック扱い
  SUPPRESS_CLICK = true;
  setTimeout(() => { SUPPRESS_CLICK = false; }, 60);
  const zone = dropZoneAt(e.clientX, e.clientY);
  if (!zone) { DECK_DRAG_PENDING = null; return; }
  const to = zone.dataset.dropzone;
  if (to === d.from) { DECK_DRAG_PENDING = null; return; }
  // 山札から引き抜いた1枚を山札に戻しただけなら、何もせず元に戻す
  if (to === 'deck' && d.from === 'deckPile') { DECK_DRAG_PENDING = null; renderBoard(); return; }
  // 山札は落とした位置（上半分／下半分）でそのまま行き先が決まる
  if (to === 'deck') { handleCardDrop(d.uid, d.from, deckHalfAt(e.clientY)); return; }
  handleCardDrop(d.uid, d.from, to);
}

/* 手動ドラッグによる移動は「効果による移動」として扱い、
   マリョク配置権・イジン召喚権は消費しない。 */
function handleCardDrop(uid, from, to) {
  const inst = zoneArrayOf(from).find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  // 裏向きのまま運んでいるカードは、確認画面でも名前を伏せる
  const hidden = from === 'deckPile' || ((from === 'field' || from === 'mana') && !inst.faceUp);
  const label = hidden ? '??' : card.name;

  // 山札は落とした半分で行き先が決まっているので、そのまま実行
  if (to === 'deckTop' || to === 'deckBottom') {
    pushUndo();
    moveInstance(uid, from, to);
    return;
  }

  if (to === 'mana') {
    beginFlow('mana-drop');
    showFlowBanner(`${label} を魔力ゾーンにどちらで置きますか？（配置権は消費しません）`, [
      { label: '表', onClick: () => { moveInstance(uid, from, 'mana', { faceUp: true }); commitFlow(); } },
      { label: '裏', sub: true, onClick: () => { moveInstance(uid, from, 'mana', { faceUp: false }); commitFlow(); } },
    ]);
    renderBoard();
    return;
  }

  if (to === 'field') {
    // 効果による移動なので条件は満たしていなくても置ける。
    // ただし満たしていない場合は確認画面にその旨を添える。
    const canFaceUp = card.type === 'イジン' || card.type === 'ハイケイ';
    const chk = checkPlayCondition(card);
    const notes = [];
    if (!canFaceUp) notes.push(`※${card.type}は戦場に裏向きでのみ置けます`);
    else if (!chk.ok) notes.push(`※${chk.reasons.join('・')}を満たしていません`);

    const buttons = [];
    if (canFaceUp) {
      buttons.push({
        label: '表',
        onClick: () => {
          moveInstance(uid, from, 'field', { faceUp: true });
          if (from === 'hand' && card.type === 'イジン') log('（効果による配置のため、イジン召喚権は消費していません）');
          commitFlow();
        }
      });
    }
    buttons.push({
      label: '裏', sub: canFaceUp,
      onClick: () => { moveInstance(uid, from, 'field', { faceUp: false }); commitFlow(); }
    });

    beginFlow('field-drop');
    showFlowBanner(
      `${label} を戦場にどちらで置きますか？` + (notes.length ? '\n' + notes.join('\n') : ''),
      buttons
    );
    renderBoard();
    return;
  }

  pushUndo();
  moveInstance(uid, from, to);
}

/* ============================================================
   GUARDIAN = any face-down card on the field.
   ルール上「戦場に裏向きで置かれているカード」がガーディアンなので、
   置かれ方を問わず faceUp === false であればガーディアンとして扱う。
   （メロウやリヴァイアサンのように、表のカードを裏返してガーディアンに
     する効果もそのまま再現できる）
   ============================================================ */
function isGuardianInst(inst, zoneKey) {
  return zoneKey === 'field' && inst && !inst.faceUp;
}

/* ============================================================
   EQUIPMENT (装備 / 冥装)
   An equipped card is stored on its host: host.equipped = [{uid, cardId, from}].
   ・「装備」を持つマリョク → 魔力ゾーンにあるときだけ装備させられる
   ・「装備」を持つハイケイ → 戦場にあるときだけ
   ・「冥装」を持つカード   → 墓地にあるときだけ
   Equipment follows its host to the graveyard.
   ============================================================ */
function hasEquipText(card) {
  const t = (card.rule_text || '') + '\n' + (card.legacy_ability || '');
  return /装備\s*[:：]/.test(t) || /装備（/.test(t);
}
function hasMeisou(card) {
  const t = (card.rule_text || '') + '\n' + (card.legacy_ability || '');
  return t.includes('冥装');
}

/* Which zone must this card sit in to be attached? null = cannot be attached. */
function equipSourceZone(card) {
  if (hasMeisou(card)) return 'graveyard';
  if (!hasEquipText(card)) return null;
  if (card.type === 'マリョク') return 'mana';
  if (card.type === 'ハイケイ') return 'field';
  return null;
}

/* Any face-up イジン on the field can be a host. */
function equipHosts() {
  return GAME.field.filter(f => f.faceUp && CARDS_BY_ID[f.cardId].type === 'イジン');
}

function beginEquip(uid, zoneKey, meisou) {
  const inst = zoneArrayOf(zoneKey).find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  if (!equipHosts().length) { flashMessage('装備できるイジンが戦場にいません'); return; }
  closeModal();
  closeGravePopover();
  beginFlow('equip-pick', { equipUid: uid, equipFrom: zoneKey, meisou: !!meisou });
  showFlowBanner(`${card.name} を装備させるイジンを選んでください`, [], 'zoneField');
  renderBoard();
}

function onEquipPick(hostUid) {
  const host = GAME.field.find(f => f.uid === hostUid);
  if (!host) return;
  const from = FLOW.equipFrom;
  const uid = FLOW.equipUid;
  const meisou = FLOW.meisou;
  const srcArr = zoneArrayOf(from);
  const idx = srcArr.findIndex(x => x.uid === uid);
  if (idx === -1) return;

  const el = cardElement(uid);
  const origin = el ? elementCentre(el) : null;
  const inst = srcArr[idx];
  const card = CARDS_BY_ID[inst.cardId];

  srcArr.splice(idx, 1);
  host.equipped = host.equipped || [];
  host.equipped.push({ uid: inst.uid, cardId: inst.cardId, from });
  log(`${CARDS_BY_ID[host.cardId].name} に ${card.name} を${meisou ? '冥装' : '装備'}させました`);
  commitFlow();

  // 元の場所から装備先のイジンへ飛ばす
  const target = cardElement(hostUid);
  if (origin && target && target.getBoundingClientRect) {
    flyCard(origin, elementCentre(target), inst.cardId, false, null);
  }
}

/* Equipment goes to the graveyard with its host. */
function detachEquipmentToGraveyard(host) {
  if (!host.equipped || !host.equipped.length) return;
  host.equipped.forEach(e => {
    GAME.graveyard.push({ uid: e.uid, cardId: e.cardId });
    log(`装備していた ${CARDS_BY_ID[e.cardId].name} も墓地に置かれました`);
  });
  host.equipped = [];
}

/* ============================================================
   SOLO PLAY: CONDITION FEEDBACK
   ============================================================ */
/* 条件を満たさないときは中央に短い警告を出す */
/* ------------------------------------------------------------
   Re-flow animation (FLIP). Zones re-sort when cards are added or removed
   (ガーディアン → イジン → ハイケイ など), so cards can jump to a new slot.
   We record every card's position before the re-render, then let each card
   slide from where it was to where it now is.
   ------------------------------------------------------------ */
let REFLOW_BEFORE = null;
let SUPPRESS_REFLOW = false;        // 飛行アニメーション中は整列アニメを止める
let DECK_DRAG_PENDING = null;   // 山札からドラッグ中の1枚
let DECK_PEEK_OPEN = false;     // 「1枚めくって確認する」の表示中

function captureCardPositions() {
  if (typeof document.querySelectorAll !== 'function') return null;
  const map = new Map();
  ['zoneField', 'zoneMana', 'zoneHand'].forEach(id => {
    const c = document.getElementById(id);
    if (!c || !c.children) return;
    Array.from(c.children).forEach(el => {
      if (!el.dataset || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      map.set(String(el.dataset.uid), { x: r.left, y: r.top });
    });
  });
  return map;
}

function playReflow(before) {
  if (!before || typeof requestAnimationFrame !== 'function') return;
  ['zoneField', 'zoneMana', 'zoneHand'].forEach(id => {
    const c = document.getElementById(id);
    if (!c || !c.children) return;
    Array.from(c.children).forEach(el => {
      if (!el.dataset || !el.getBoundingClientRect) return;
      const prev = before.get(String(el.dataset.uid));
      if (!prev) return;                       // newly arrived: handled by flyInto
      const r = el.getBoundingClientRect();
      const dx = prev.x - r.left, dy = prev.y - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

      const tapped = el.classList.contains('is-tapped');
      const rot = tapped ? ' rotate(90deg)' : '';
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)${rot}`;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.classList.add('is-reflowing');
        el.style.transform = rot ? 'rotate(90deg)' : '';
        setTimeout(() => { el.classList.remove('is-reflowing'); el.style.transform = ''; }, 320);
      });
    });
  });
}

/* ------------------------------------------------------------
   Card-flight animation. Used in ONLY five places:
     ① 山札ワンクリックのドロー      ② ダブルクリックで墓地へ
     ③ ボタン操作のマリョク配置      ④ ボタン操作のイジン召喚
     ⑤ 山札から墓地へ
   Everything else updates instantly.

   The destination is the card's REAL resting place: the move is applied and the
   board re-rendered first, then the newly placed card is measured, hidden, and a
   clone is flown into that exact spot. So when a zone re-sorts (ガーディアン →
   イジン → ハイケイ など), the card flies to where it actually ends up.

   Movement uses `transform` rather than left/top so the browser can animate it on
   the compositor — no layout work per frame, so the motion stays smooth.
   ------------------------------------------------------------ */
const FLY_MS = 380;

function elementCentre(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function zoneCentre(id) {
  const el = document.getElementById(id);
  return el ? elementCentre(el) : null;
}
function cardElement(uid) {
  return document.querySelector(`.mini-card[data-uid="${uid}"]`);
}

function makeGhost(cardId, faceDown) {
  const g = document.createElement('div');
  g.className = 'mini-card fly-ghost' + (faceDown ? ' is-facedown' : '');
  if (!faceDown && cardId && CARDS_BY_ID[cardId]) appendMiniCardFace(g, CARDS_BY_ID[cardId]);
  return g;
}

/* Fly a clone from `from` to `to`, then run done(). */
function flyCard(from, to, cardId, faceDown, done, opts = {}) {
  const finish = () => { if (done) done(); };
  if (!from || !to || typeof document.createElement !== 'function') { finish(); return; }

  const g = makeGhost(cardId, faceDown);
  const cs = (typeof getComputedStyle === 'function')
    ? getComputedStyle(document.documentElement) : null;
  const w = cs ? (parseInt(cs.getPropertyValue('--card-w')) || 104) : 104;
  const h = cs ? (parseInt(cs.getPropertyValue('--card-h')) || 146) : 146;

  g.style.left = (from.x - w / 2) + 'px';
  g.style.top = (from.y - h / 2) + 'px';
  g.style.transform = 'translate3d(0,0,0)';
  document.body.appendChild(g);

  const dx = to.x - from.x, dy = to.y - from.y;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      g.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      if (opts.fade) g.classList.add('is-fading');
    });
  });
  setTimeout(() => { g.remove(); finish(); }, FLY_MS);
}

/* Apply `applyMove`, re-render, then fly a clone from `from` into the position the
   card genuinely occupies afterwards. `uid` identifies the card after the move. */
function flyInto(from, uid, cardId, faceDown, applyMove, opts = {}) {
  // 飛ばすカード自身がアニメーションするので、この描画では
  // 他のカードの整列アニメーションを走らせない（動きが競合して荒く見えるため）
  SUPPRESS_REFLOW = true;
  applyMove();          // commitFlow などが内部で描画することもある
  renderBoard();        // 最終状態を確実に反映（整列アニメは止めたまま）
  SUPPRESS_REFLOW = false;

  const landed = cardElement(uid);
  if (!from || !landed || !landed.getBoundingClientRect) return;

  const to = elementCentre(landed);
  landed.style.visibility = 'hidden';
  flyCard(from, to, cardId, faceDown, () => {
    const el = cardElement(uid);
    if (el) el.style.visibility = '';
  }, opts);
}

/* Fly a clone out to the graveyard slot, fading as it goes, then apply the move. */
function flyToGraveyard(from, cardId, faceDown, applyMove) {
  const to = zoneCentre('graveSlot');
  flyCard(from, to, cardId, faceDown, applyMove, { fade: true });
}

function requireCondition(card) {
  const chk = checkPlayCondition(card);
  if (chk.ok) return true;
  flashMessage(`${chk.reasons.join('・')}を満たしていません`);
  return false;
}

/* ============================================================
   SOLO PLAY: RENDERING
   ============================================================ */
/* Face-up mini card, laid out like the deck-builder tile:
   type/colour badge top-left, level circle top-right (black text),
   name centred, and for イジン the power bottom-right. */
function appendMiniCardFace(el, card, inst) {
  const badge = cardBadge(card);
  badge.classList.add('mc-badge');
  el.appendChild(badge);

  if (card.type !== 'マリョク') {
    const lvl = document.createElement('span');
    lvl.className = 'mc-level';
    lvl.textContent = card.level;
    lvl.title = `レベル${card.level}`;
    el.appendChild(lvl);
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'mc-name';
  nameEl.textContent = card.name;
  el.appendChild(nameEl);

  if (card.type === 'イジン') {
    const pw = document.createElement('span');
    pw.className = 'mc-power';
    pw.style.color = cardPrimaryColorHex(card);
    pw.textContent = card.power;
    el.appendChild(pw);
  }
  // 装備しているカードは、その色の剣マークで示す
  if (inst && inst.equipped && inst.equipped.length) {
    el.classList.add('has-equip');
    const wrap = document.createElement('span');
    wrap.className = 'mc-equip';
    inst.equipped.forEach(e => {
      const c = CARDS_BY_ID[e.cardId];
      const sw = document.createElement('span');
      sw.textContent = '\u2694';
      sw.style.color = cardPrimaryColorHex(c);
      sw.title = `装備：${c.name}`;
      wrap.appendChild(sw);
    });
    el.appendChild(wrap);
  } else if (card.type === 'マホウ' && (card.magic_cost || 0) > 0) {
    const cost = document.createElement('span');
    cost.className = 'mc-cost';
    cost.textContent = '○'.repeat(card.magic_cost);
    cost.title = `魔力コスト${card.magic_cost}`;
    el.appendChild(cost);
  }
}

function createMiniCard(inst, zoneKey) {
  const card = CARDS_BY_ID[inst.cardId];
  const el = document.createElement('div');
  el.className = 'mini-card';
  el.dataset.uid = inst.uid;

  const inHiddenZone = (zoneKey === 'mana' || zoneKey === 'field');
  const faceUp = inHiddenZone ? inst.faceUp : true;
  // 戦場の裏向きカード（ガーディアン）だけは表を見てはいけない。
  // 魔力ゾーンの裏向きカードは自分だけ確認できるので詳細を開いてよい。
  const secret = zoneKey === 'field' && !faceUp;

  if (inHiddenZone && !faceUp) el.classList.add('is-facedown');
  else appendMiniCardFace(el, card, inst);

  if (zoneKey === 'field' && inst.tapped) el.classList.add('is-tapped');

  // --- ガイド付きフロー中のハイライト ---
  if (zoneKey === 'hand' && FLOW && (FLOW.type === 'mana-pick' || FLOW.type === 'summon-pick')) {
    const selectable = FLOW.type === 'mana-pick'
      ? (FLOW.faceUp ? card.type === 'マリョク' : true)
      : (card.type === 'イジン' && checkPlayCondition(card).ok);
    el.classList.add(selectable ? 'is-selectable' : 'is-dimmed');
  }
  if (zoneKey === 'field' && FLOW && FLOW.type === 'battle-pick') {
    const selected = FLOW.attackers.includes(inst.uid);
    // 戦場のカードは原則すべてアタッカーに選べる。
    // 光らせるのは「正規にアタッカーになれるイジン」だけで、
    // ガーディアンや召喚したてのイジンは光らせずに選べるようにし、
    // 選ばれたときに注意書きで知らせる。
    const lit = card.type === 'イジン' && inst.faceUp && !inst.tapped &&
      (inst.summonedTurn !== GAME.turn || cardHasKeyword(card, '即応'));
    if (selected) el.classList.add('is-selected');
    else if (lit) el.classList.add('is-selectable');
    else el.classList.add('is-pickable');   // 暗転より前面に出し、クリックできるようにする
  }
  if (zoneKey === 'mana' && FLOW && FLOW.type === 'mahou-cost') {
    el.classList.add(FLOW.picked.includes(inst.uid) ? 'is-selected' : 'is-selectable');
  }
  if (zoneKey === 'field' && FLOW && FLOW.type === 'equip-pick') {
    const canHost = inst.faceUp && card.type === 'イジン';
    el.classList.add(canHost ? 'is-selectable' : 'is-dimmed');
  }

  // --- 操作：ワンタップ＝詳細 / ダブルタップ＝墓地へ / ドラッグ＝移動 ---
  let tapTimer = null;
  el.addEventListener('click', () => {
    if (SUPPRESS_CLICK) return;
    if (FLOW) {
      if (zoneKey === 'hand' && FLOW.type === 'mana-pick') {
        if (FLOW.faceUp ? card.type === 'マリョク' : true) onManaPick(inst.uid);
      } else if (zoneKey === 'hand' && FLOW.type === 'summon-pick') {
        if (card.type === 'イジン' && checkPlayCondition(card).ok) onSummonPick(inst.uid);
      } else if (zoneKey === 'field' && FLOW.type === 'battle-pick') {
        onBattlePick(inst.uid);
      } else if (zoneKey === 'mana' && FLOW.type === 'mahou-cost') {
        onManaCostPick(inst.uid);
      } else if (zoneKey === 'field' && FLOW.type === 'equip-pick') {
        if (inst.faceUp && card.type === 'イジン') onEquipPick(inst.uid);
      }
      return;
    }
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (secret) openFaceDownOps(inst, zoneKey);      // 表は見せず操作だけ
      else openCardDetail(card.id, { uid: inst.uid, zoneKey });
    }, 200);
  });

  el.addEventListener('dblclick', () => {
    clearTimeout(tapTimer);
    if (SUPPRESS_CLICK || FLOW) return;
    if (zoneKey === 'graveyard') return;               // すでに墓地にある
    pushUndo();
    const from = elementCentre(el);
    const faceDown = (zoneKey === 'field' || zoneKey === 'mana') && !inst.faceUp;
    el.style.visibility = 'hidden';
    flyToGraveyard(from, inst.cardId, faceDown, () => {
      moveInstance(inst.uid, zoneKey, 'graveyard');
    });
  });

  el.addEventListener('pointerdown', (e) => startCardDrag(e, inst, zoneKey, el));

  return el;
}

/* 戦場の裏向きカード（ガーディアン）は表を見てはいけないので、
   カード情報を一切出さず、マウス操作では代替できない操作だけを並べる。 */
function openFaceDownOps(inst, zoneKey) {
  const uid = inst.uid;
  const act = fn => () => { pushUndo(); fn(); commitFlow(); };
  beginFlow('facedown-ops');
  showFlowBanner('裏向きのカード（表は確認できません）', [
    { label: inst.tapped ? '起こす' : '寝かせる', onClick: act(() => toggleTapped(uid)) },
    { label: '表にする', sub: true, onClick: act(() => toggleFaceUp(uid, zoneKey)) },
  ]);
}

function renderZoneCards(zoneKey, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  let arr = zoneArrayOf(zoneKey);
  if (zoneKey === 'field') {
    // 左から順に：ガーディアン → イジンなど → 表向きのハイケイ
    const rank = inst => {
      if (!inst.faceUp) return 0;                                        // ガーディアン
      if (CARDS_BY_ID[inst.cardId].type === 'ハイケイ') return 2;
      return 1;
    };
    arr = arr.slice().sort((a, b) => rank(a) - rank(b));
  }
  let firstHaikei = true;
  arr.forEach(inst => {
    const el = createMiniCard(inst, zoneKey);
    if (zoneKey === 'field' && inst.faceUp &&
        CARDS_BY_ID[inst.cardId].type === 'ハイケイ' && firstHaikei) {
      el.classList.add('is-haikei');   // 他のカードと少し距離をとる
      firstHaikei = false;
    }
    container.appendChild(el);
  });
}

function updateMainActionButtons() {
  document.getElementById('cntManaAction').textContent = GAME.resources.manaPlace;
  document.getElementById('cntSummonAction').textContent = GAME.resources.summon;
  document.getElementById('cntBattleAction').textContent = GAME.resources.battle;

  const inMain = GAME.phase === 'main' && !FLOW;
  const summonEligible = GAME.hand.some(h => {
    const c = CARDS_BY_ID[h.cardId];
    return c.type === 'イジン' && checkPlayCondition(c).ok;
  });

  // 戦場に起きているカードが1枚でもあればバトルを宣言できる。
  // ガーディアン（裏向き）も、そのターンに出したイジンもアタッカーに選べるため、
  // 正規に攻撃できるかどうかは選択時の注意書きで知らせる。
  const battleEligible = GAME.field.some(f => !f.tapped);

  document.getElementById('btnActionMana').disabled =
    !inMain || GAME.resources.manaPlace < 1 || GAME.hand.length === 0;
  document.getElementById('btnActionSummon').disabled = !inMain || GAME.resources.summon < 1 || !summonEligible;
  document.getElementById('btnActionBattle').disabled = !inMain || GAME.resources.battle < 1 || !battleEligible;
}

function renderBoard() {
  if (!GAME) return;
  const before = REFLOW_BEFORE || captureCardPositions();
  REFLOW_BEFORE = null;
  document.getElementById('stampTurn').textContent = `第${GAME.turn}ターン`;
  document.getElementById('stampPhase').textContent = GAME.phase === 'draw' ? 'ドロー' : 'メイン';

  document.getElementById('btnEndTurn').disabled = GAME.phase !== 'main';

  // 山札は裏向きのカード1枚だけを表示する
  document.getElementById('deckTopCard').style.visibility = GAME.deck.length ? 'visible' : 'hidden';
  document.getElementById('deckCount').textContent = GAME.deck.length;

  // 墓地は「墓地」と書かれた1枚分のスロット。中身はタップで確認する
  const graveSlot = document.getElementById('graveSlot');
  graveSlot.classList.toggle('is-empty', true);
  document.getElementById('graveCount').textContent = GAME.graveyard.length;

  document.getElementById('manaSummary').textContent = manaSummaryText();

  renderZoneCards('field', 'zoneField');
  renderZoneCards('mana', 'zoneMana');
  renderZoneCards('hand', 'zoneHand');

  updateMainActionButtons();
  renderLogBar();

  if (GAME.phase === 'draw' && !FLOW) showDrawPrompt();
  else hideDrawPrompt();

  if (!SUPPRESS_REFLOW) playReflow(before);
}

/* 墓地はスロットをタップすると中身を一覧できる */
document.getElementById('graveSlot').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!GAME || SUPPRESS_CLICK || FLOW) return;
  const pop = document.getElementById('gravePopover');
  if (pop.classList.contains('is-open')) { closeGravePopover(); return; }
  pop.innerHTML = '';
  pop.classList.remove('deck-list-popover');
  if (GAME.graveyard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'grave-empty';
    empty.textContent = '墓地にカードはありません';
    pop.appendChild(empty);
  }
  // 墓地のカードもドラッグで手札・魔力ゾーン・戦場へ運べる
  GAME.graveyard.forEach(inst => {
    pop.appendChild(createMiniCard(inst, 'graveyard'));
  });
  pop.classList.add('is-open');
});

document.addEventListener('click', (e) => {
  const pop = document.getElementById('gravePopover');
  if (!pop || !pop.classList.contains('is-open')) return;
  if (FLOW) return;                                  // サーチ中は閉じない
  if (pop.contains(e.target)) return;
  closeGravePopover();
});

/* ============================================================
   HEADER REVEAL (solo view) + HOW TO PLAY
   ============================================================ */
(() => {
  const handle = document.getElementById('headerHandle');
  const header = document.querySelector('.app-header');
  if (!handle) return;
  const open = () => document.body.classList.add('header-peek');
  const close = () => document.body.classList.remove('header-peek');
  handle.addEventListener('mouseenter', open);
  handle.addEventListener('click', open);
  if (header) header.addEventListener('mouseleave', close);
})();

const HELP_SECTIONS = [
  {
    title: 'ターンの進め方',
    rows: [
      ['ドロー', '盤面が暗くなり山札が光ります。山札をクリックすると1枚引き、メインフェイズに進みます。先攻1ターン目は引かずに進みます。'],
      ['メインフェイズ', '操作が必要なのはこのフェイズだけです。カードを使い、バトルを宣言します。'],
      ['ターンエンド', '「ターンエンド」で手番を終えます。次のターンのスタートフェイズ（戦場を起こし、各権利をリセット）は自動で行われます。'],
    ]
  },
  {
    title: '権利を使う操作（右下のボタン）',
    rows: [
      ['マリョク配置', '「表」（手札のマリョク）か「裏」（手札のどのカードでも）を選び、光ったカードをクリックします。手札にマリョクが無いときは「表」を選べません。'],
      ['イジン召喚', '色条件とレベル条件を満たすイジンだけが光ります。条件を満たすイジンが無いときはボタンを押せません。'],
      ['バトル', '戦場に起きているカードが1枚でもあれば宣言できます。ガーディアンも、そのターンに出したイジンも選べます（効果で攻撃できる場合があるため）。正規に攻撃できないカードを選んだときは注意書きが出ます。アタッカーを選ぶと寝かせられ、「攻撃」で確定します。'],
      ['権利の増減', '各ボタンの下の「−」「＋」で残り回数を調整できます。カードの効果で権利が増えたときに使います。'],
    ]
  },
  {
    title: 'カードの操作',
    rows: [
      ['シングルクリック', 'カードの詳細を表示します。山札だけは例外で、クリックすると1枚引きます。'],
      ['ダブルクリック', 'そのカードを墓地に置きます。山札をダブルクリックすると、上から1枚を墓地に置きます。'],
      ['ドラッグ', 'カードをつかんで別のゾーンへ運びます。カードの効果による移動はこちらで行ってください。条件を満たしていない場合も置けますが、確認画面に注意書きが出ます。'],
      ['山札に戻す', 'カードを山札の上半分に落とすと山札の上へ、下半分に落とすと山札の下に戻ります。どちらに入るかは重ねている間に表示されます。'],
      ['山札からの持ち出し', '山札の一番上のカードは、そのままつかんで他のゾーンへ運べます。動かさずに離せば通常どおり1枚引きます。'],
      ['マホウの使用', '手札のマホウをシングルクリックし、詳細画面の「マホウを使用する」から発動します。魔力コストとして墓地に置くカードは、魔力ゾーンから自分で選びます。'],
      ['墓地の中身', '墓地のスロットをクリックすると一覧が開きます。ここからドラッグで他のゾーンへ戻せます。'],
      ['山札の操作', '山札の「⋯」ボタンから、サーチして手札に加える／1枚めくって確認する／シャッフルが行えます。めくって確認したカードは山札に残るので、シャッフルしなければ次のドローで引きます。'],
      ['手札の操作', '手札の「⋯」ボタンから、手札すべてを山札に戻してシャッフルできます。'],
    ]
  },
  {
    title: '覚えておきたい点',
    rows: [
      ['権利の消費', '右下のボタンから行った配置・召喚だけが権利を消費します。ドラッグでの移動は「効果による配置」の扱いで、権利を消費しません。'],
      ['ガーディアン', '戦場に裏向きで置かれているカードは、置かれ方を問わずすべてガーディアンです。表向きのカードを裏返せばガーディアンになります。ルール上その表を見てはいけないので、クリックしても内容は表示されず「寝かせる／起こす」「表にする」だけが選べます。魔力ゾーンの裏向きカードは自分だけ確認できるので、詳細が開きます。'],
      ['条件の扱い', '色条件・レベル条件・魔力コストを見るのは、右下のボタンから行う配置・召喚と、マホウ使用だけです。効果でこれらを無視できることがあるため、ドラッグでの移動やマホウ使用ボタンは条件を満たしていなくても実行できます（注意書きは出ます）。'],
      ['取り消し', '選択中は、暗くなった部分をクリックすると操作を取り消せます。確定した操作は「↩」で一手戻せます。'],
      ['カードの効果', 'カード固有の効果は自動では処理されません。詳細画面のルールテキストを読みながら、上記の操作で盤面に反映してください。'],
    ]
  },
];

function openHelp() {
  if (FLOW || DRAW_PROMPT) return;
  modalContent.classList.remove('detail-face');
  modalContent.classList.add('help-panel');
  modalContent.innerHTML = '';

  HELP_SECTIONS.forEach(sec => {
    const h = document.createElement('h3');
    h.textContent = sec.title;
    modalContent.appendChild(h);
    const table = document.createElement('table');
    table.className = 'help-table';
    sec.rows.forEach(([label, text]) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      const td2 = document.createElement('td');
      td2.textContent = text;
      tr.appendChild(td1); tr.appendChild(td2);
      table.appendChild(tr);
    });
    modalContent.appendChild(table);
  });

  const note = document.createElement('div');
  note.className = 'help-note';
  note.textContent = 'この画面の外側をクリックすると閉じます。';
  modalContent.appendChild(note);

  modalOverlay.classList.add('is-open');
}

document.getElementById('btnHelp').addEventListener('click', openHelp);

/* ============================================================
   SOLO PLAY: DECK MENU (山札の操作)
   ・山札の一番上のカードを墓地に置く
   ・山札をサーチして好きなカードを手札に加える
   ============================================================ */
/* 山札の山：ワンタップでドロー、ダブルタップで上から1枚を墓地へ */
(() => {
  const pile = document.querySelector('#deckSlot .slot-frame');
  if (!pile) return;
  let deckTapTimer = null;

  /* 山札の一番上のカードをドラッグで運び出せる。
     動かさずに離せば通常どおりクリック＝ドローになる。 */
  const topCard = document.getElementById('deckTopCard');
  if (topCard) {
    topCard.addEventListener('pointerdown', (e) => {
      if (!GAME || GAME.phase !== 'main' || FLOW || !GAME.deck.length) return;
      clearTimeout(deckTapTimer);
      const cardId = GAME.deck[GAME.deck.length - 1];
      // 山札から引き抜いた1枚を、一時的な実体としてドラッグする
      const inst = { uid: uidCounter++, cardId, faceUp: false };
      DECK_DRAG_PENDING = inst;
      startCardDrag(e, inst, 'deckPile', topCard);
    });
  }

  pile.addEventListener('click', () => {
    if (!GAME || FLOW || SUPPRESS_CLICK) return;
    clearTimeout(deckTapTimer);
    // ドロー段階では二度押しの取り違えが起きないよう即座に引く
    if (DRAW_PROMPT) { drawOne(); return; }
    deckTapTimer = setTimeout(drawOne, 200);
  });
  pile.addEventListener('dblclick', () => {
    clearTimeout(deckTapTimer);
    if (!GAME || FLOW || SUPPRESS_CLICK) return;
    millOne();
  });
})();

document.getElementById('btnDeckMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!GAME) return;
  closeGravePopover();
  beginFlow('deck-menu');
  showFlowBanner(`山札（${GAME.deck.length}枚）の操作を選んでください`, [
    {
      label: 'サーチして手札に加える',
      disabled: GAME.deck.length === 0,
      onClick: () => { FLOW.type = 'deck-search'; openDeckSearch(); }
    },
    {
      label: '1枚めくって確認する',
      disabled: GAME.deck.length === 0,
      onClick: () => { FLOW.type = 'deck-peek'; revealTopCard(); }
    },
    {
      label: 'シャッフル',
      disabled: GAME.deck.length === 0,
      onClick: () => { GAME.deck = shuffle(GAME.deck); log('山札をシャッフルしました'); commitFlow(); }
    },
  ]);
  renderBoard();
});

/* 山札の一番上を確認する。カードは山札に残ったままなので、
   シャッフルしない限り次のドローでこのカードを引くことになる。 */
function revealTopCard() {
  const cardId = GAME.deck[GAME.deck.length - 1];
  if (!cardId) { commitFlow(); return; }
  const card = CARDS_BY_ID[cardId];
  log(`山札の一番上（${card.name}）を確認しました　※シャッフルしなければ次のドローで引きます`);

  hideFlowBanner();
  modalContent.classList.remove('help-panel');
  modalContent.classList.add('detail-face');
  modalContent.innerHTML = '';

  const tag = document.createElement('div');
  tag.className = 'equip-tag';
  tag.textContent = '山札の一番上';
  modalContent.appendChild(tag);

  appendCardFace(modalContent, card, { includeSource: true });

  const note = document.createElement('div');
  note.className = 'help-note';
  note.textContent = 'このカードは山札に残ります。シャッフルしなければ、次のドローでこのカードを引きます。';
  modalContent.appendChild(note);

  modalOverlay.classList.add('is-open');
  DECK_PEEK_OPEN = true;
}

/* 手札の「⋯」メニュー */
document.getElementById('btnHandMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!GAME || FLOW) return;
  closeGravePopover();
  beginFlow('hand-menu');
  showFlowBanner(`手札（${GAME.hand.length}枚）の操作を選んでください`, [
    {
      label: '手札すべてを山札に戻してシャッフル',
      disabled: GAME.hand.length === 0,
      onClick: () => {
        const n = GAME.hand.length;
        GAME.hand.forEach(h => GAME.deck.push(h.cardId));
        GAME.hand = [];
        GAME.deck = shuffle(GAME.deck);
        log(`手札${n}枚を山札に戻してシャッフルしました`);
        commitFlow();
      }
    },
  ]);
  renderBoard();
});

/* Deck search: list every card still in the deck; picking one moves it to the hand. */
function openDeckSearch() {
  const pop = document.getElementById('gravePopover');
  pop.innerHTML = '';
  pop.classList.add('deck-list-popover');

  const sorted = GAME.deck
    .map((cardId, idx) => ({ cardId, idx }))
    .sort((a, b) => {
      const ca = CARDS_BY_ID[a.cardId], cb = CARDS_BY_ID[b.cardId];
      const ta = DECK_TYPE_ORDER.indexOf(ca.type) - DECK_TYPE_ORDER.indexOf(cb.type);
      return ta !== 0 ? ta : ca.name.localeCompare(cb.name, 'ja');
    });

  sorted.forEach(({ cardId, idx }) => {
    const card = CARDS_BY_ID[cardId];
    const el = document.createElement('div');
    el.className = 'mini-card';
    appendMiniCardFace(el, card);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      GAME.deck.splice(idx, 1);
      GAME.hand.push({ uid: uidCounter++, cardId });
      log(`山札から ${card.name} を手札に加えました`);
      closeGravePopover();
      commitFlow();
    });
    pop.appendChild(el);
  });

  pop.classList.add('is-open');
  showFlowBanner('手札に加えるカードを選んでください', [], 'gravePopover');
}

function closeGravePopover() {
  const pop = document.getElementById('gravePopover');
  pop.classList.remove('is-open');
  pop.classList.remove('deck-list-popover');
}

/* ============================================================
   INIT
   ============================================================ */
initDropZones();
initFilterUI();
renderCardGrid();
renderDeckPanel();
refreshSavedDeckSelect();
