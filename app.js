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
    const onSolo = btn.dataset.tab === 'solo';
    document.body.classList.toggle('solo-view', onSolo && !!GAME);
    document.body.classList.remove('header-peek');
    if (!onSolo) { hideFlowBanner(); closeModal(); setOppBoardOpen(false); }
    // 相手の場タブは、対戦中でこのタブにいるときだけ見せる
    document.getElementById('oppTab').style.display =
      (onSolo && GAME && GAME.mode === 'versus') ? '' : 'none';
    if (onSolo) refreshSoloDeckSelect();
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
  ['soloDeckSelect', 'soloDeckSelect2', 'onlineDeckSelect'].forEach(idSel => {
    const sel = document.getElementById(idSel);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    Object.keys(state.decks).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name + ` (${totalCount(state.decks[name].cards)}枚)`;
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  });
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
  // （相手側のカードの装備は、相手の手番で行う）
  const srcZone = isOppZone(zoneKey) ? null : equipSourceZone(card);
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

  const zb = baseZoneKey(zoneKey);
  if (zb === 'field') {
    const inst = zoneArrayOf(zoneKey).find(x => x.uid === uid);
    addContextBtn(group, inst && inst.tapped ? '起こす' : '寝かせる', () => { toggleTapped(uid, zoneKey); closeModal(); });
    addContextBtn(group, inst && inst.faceUp ? '裏にする' : '表にする', () => { toggleFaceUp(uid, zoneKey); closeModal(); });

    // パワー修正（バトルの自動判定に反映される）
    if (inst && card.type === 'イジン') {
      const row = document.createElement('div');
      row.className = 'pow-adjust';
      const lbl = document.createElement('span');
      lbl.className = 'pow-adjust-label';
      const setLbl = () => {
        const m = inst.powerMod || 0;
        lbl.textContent = `パワー修正：${m > 0 ? '+' : ''}${m}（実効 ${(card.power || 0) + m}）`;
      };
      setLbl();
      const mk = (txt, fn) => {
        const b = document.createElement('button');
        b.className = 'adj-btn';
        b.textContent = txt;
        b.addEventListener('click', () => { pushUndo(); fn(); setLbl(); renderBoard(); renderOppBoard(); });
        return b;
      };
      row.appendChild(mk('−500', () => adjustPower(inst, -500)));
      row.appendChild(lbl);
      row.appendChild(mk('+500', () => adjustPower(inst, 500)));
      const reset = document.createElement('button');
      reset.className = 'btn-mini';
      reset.textContent = 'リセット';
      reset.addEventListener('click', () => { pushUndo(); inst.powerMod = 0; setLbl(); renderBoard(); renderOppBoard(); });
      row.appendChild(reset);
      wrap.appendChild(row);
    }
  } else if (zb === 'mana') {
    const inst = zoneArrayOf(zoneKey).find(x => x.uid === uid);
    addContextBtn(group, inst && inst.faceUp ? '裏にする' : '表にする', () => { toggleFaceUp(uid, zoneKey); closeModal(); });
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
document.querySelectorAll('#fFirstVs .chip-toggle').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#fFirstVs .chip-toggle').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
  });
});
/* 色（陣営）の選択。相手は自動でもう一方の色になる。 */
document.querySelectorAll('#fSide1 .chip-toggle').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#fSide1 .chip-toggle').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
    syncFirstChipLabels();
  });
});
function syncFirstChipLabels() {
  const sel = document.querySelector('#fSide1 .chip-toggle.is-active');
  const s1 = sel ? sel.dataset.val : 'gold';
  const s2 = s1 === 'gold' ? 'azure' : 'gold';
  const a = document.getElementById('fFirstVs1'), b = document.getElementById('fFirstVs2');
  if (a) a.textContent = SIDE_NAME[s1];
  if (b) b.textContent = SIDE_NAME[s2];
}

/* モード切替：対戦用の入力欄を出し入れする */
document.querySelectorAll('#fMode .chip-toggle').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#fMode .chip-toggle').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
    const mode = b.dataset.val;
    const vs = mode === 'versus', online = mode === 'online';
    document.querySelectorAll('.vs-only').forEach(el => { el.style.display = vs ? '' : 'none'; });
    document.querySelectorAll('.solo-only').forEach(el => { el.style.display = (vs || online) ? 'none' : ''; });
    document.querySelectorAll('.online-only').forEach(el => { el.style.display = online ? '' : 'none'; });
    document.querySelectorAll('.solo-vs-only').forEach(el => { el.style.display = online ? 'none' : ''; });
    // オンラインでは自分のデッキだけを選ぶので、上の選択欄は隠す
    const deckField = document.getElementById('soloDeckSelect').closest('.field');
    if (deckField) deckField.style.display = online ? 'none' : '';
    document.getElementById('deck1Label').textContent = vs ? 'プレイヤー1のデッキ' : '使用するデッキ';
    if (vs) syncFirstChipLabels();
    if (!online && NET.online) netTeardown();
  });
});
['fSideOnline', 'fFirstOnline'].forEach(groupId => {
  document.querySelectorAll(`#${groupId} .chip-toggle`).forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll(`#${groupId} .chip-toggle`).forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
    });
  });
});
document.getElementById('btnNetHost').addEventListener('click', () => netHostRoom());
document.getElementById('btnNetJoin').addEventListener('click', () => netJoinRoom());

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================
   VERSUS (2人対戦) : core
   GAME.players[0/1] にそれぞれの全ゾーンを持ち、GAME.hand などは
   「手番プレイヤーのゾーン」を指すアクセサにする。
   こうすることで、ソロ用に書かれた既存の処理がそのまま
   手番プレイヤーに対して働く。相手側は 'opp' 付きのゾーンキーで指す。
   ============================================================ */
/* 画面の下側に表示する席。
   同じ端末での2人対戦は手番プレイヤーの盤面を出すが、
   オンラインでは常に「自分の盤面」を下に置く。
   自分の手番でない間は操作を止めるので、この2つがずれても問題は起きない。 */
function viewSeat() {
  let seat = (NET.online && NET.seat !== null) ? NET.seat : (GAME ? GAME.active : 0);
  // 決着後の盤面確認では、下に出す側を切り替えられる
  if (GAME && GAME.over && INSPECT_SWAP) seat = 1 - seat;
  return seat;
}
function attachVersusAccessors(g) {
  const P = () => g.players[viewSeat()];
  const def = (k) => Object.defineProperty(g, k, {
    configurable: true, enumerable: false,
    get: () => P()[k], set: v => { P()[k] = v; }
  });
  ['hand', 'field', 'mana', 'graveyard', 'deck', 'resources', 'turn'].forEach(def);
  Object.defineProperty(g, 'isFirst', {
    configurable: true, enumerable: false,
    get: () => viewSeat() === g.first, set: () => {}
  });
  return g;
}
function activeP()   { return GAME.mode === 'versus' ? GAME.players[GAME.active] : null; }
function opponentP() { return GAME.mode === 'versus' ? GAME.players[1 - viewSeat()] : null; }

/* Undo・取り消しで JSON 復元した GAME にアクセサを付け直す */
function restoreGame(snap) {
  GAME = snap;
  if (GAME && GAME.mode === 'versus') attachVersusAccessors(GAME);
}

let OPP_HAND_REVEALED = false;   // 相手の手札・魔力ゾーンの裏を見せているか
let BATTLE = null;               // 対戦用バトル画面の状態

/* 陣営カラー。プレイヤーは名前ではなく色で区別する。
   金＝従来の黒基調、蒼＝グレー基調。手番の色が画面全体に反映される。 */
const SIDE_NAME = { gold: '金', azure: '蒼' };
const SIDE_CLS = { gold: 'side-gold', azure: 'side-azure' };
function sideClassOf(idx) { return SIDE_CLS[GAME.players[idx].sideKey] || 'side-gold'; }

/* クラスの入れ替えは「変わるときだけ」行う。
   毎回 remove→add すると、CSS変数に依存する背景（カードの裏面など）が
   作り直されてしまい、進行中のアニメーションが目に見えて荒れる。 */
function setSideClass(el, cls) {
  if (!el || !el.classList) return;
  const cur = el.classList.contains('side-gold') ? 'side-gold'
            : el.classList.contains('side-azure') ? 'side-azure' : null;
  if (cur === cls) return;
  if (cur) el.classList.remove(cur);
  if (cls) el.classList.add(cls);
}
/* 画面全体を、いま操作しているプレイヤーの色にする。
   ブロック宣言以降は防御側が操作するので、防御側の色にする。 */
/* カードの裏面の色は持ち主で決まる（手番では変わらない） */
function backClassOf(idx) {
  return (GAME.players[idx].sideKey === 'azure') ? 'back-azure' : 'back-gold';
}
function setBackClass(el, cls) {
  if (!el || !el.classList) return;
  const cur = el.classList.contains('back-gold') ? 'back-gold'
            : el.classList.contains('back-azure') ? 'back-azure' : null;
  if (cur === cls) return;
  if (cur) el.classList.remove(cur);
  if (cls) el.classList.add(cls);
}
function applySideTheme() {
  const body = document.body;
  const oppBoard = document.getElementById('oppBoard');
  const oppTab = document.getElementById('oppTab');
  const boardPanel = document.getElementById('boardPanel');
  if (!GAME || GAME.mode !== 'versus') {
    [body, oppBoard, oppTab].forEach(el => setSideClass(el, null));
    [boardPanel, oppBoard, document.getElementById('bsAtkSide'), document.getElementById('bsDefSide')]
      .forEach(el => setBackClass(el, null));
    return;
  }
  // 自分の盤面のカードの裏は自分の色、相手の場は相手の色
  setBackClass(boardPanel, backClassOf(viewSeat()));
  setBackClass(oppBoard, backClassOf(1 - viewSeat()));
  if (BATTLE) {
    setBackClass(document.getElementById('bsAtkSide'), backClassOf(BATTLE.atkIdx));
    setBackClass(document.getElementById('bsDefSide'), backClassOf(BATTLE.defIdx));
  }
  // 画面の色は「いま操作している側」。オンラインでは手番プレイヤーの色にして、
  // どちらの番かがひと目で分かるようにする。
  const operator = NET.online ? GAME.active : (isDefenderPhase() ? BATTLE.defIdx : GAME.active);
  setSideClass(body, sideClassOf(operator));
  const oppIdx = 1 - viewSeat();
  setSideClass(oppBoard, sideClassOf(oppIdx));
  setSideClass(oppTab, sideClassOf(oppIdx));
  if (BATTLE) {
    setSideClass(document.getElementById('bsAtkSide'), sideClassOf(BATTLE.atkIdx));
    setSideClass(document.getElementById('bsDefSide'), sideClassOf(BATTLE.defIdx));
  }
}
/* ============================================================
   オンライン対戦（PeerJS / WebRTC）

   考えかた：
     このアプリの状態は GAME ひとつにまとまっていて、そのまま JSON にできる。
     そこで「操作のたびに盤面をまるごと相手へ送り、受け取った側は
     restoreGame() で丸ごと差し替える」ことで同期する。
     差分を計算しないので、ズレようがないのが利点。

     部屋を作った側が席0、入った側が席1。
     行動できるのは手番プレイヤー（ブロックステップだけは防御側）で、
     それ以外の間は盤面を操作できないようにする。

   注意：
     盤面をまるごと送るので、相手の端末のメモリ上には
     こちらの手札や山札の順番も届いている（画面には出ないが、
     開発者ツールを開けば見える）。
     紙のカードを2人で操作する卓の再現なので、この方式を選んでいる。
   ============================================================ */
const NET = {
  online: false,     // オンライン対戦中か
  peer: null,        // PeerJS のインスタンス
  conn: null,        // 相手とのデータ接続
  seat: null,        // 自分の席（0＝部屋を作った側／1＝入った側）
  isHost: false,
  room: '',          // 部屋コード
  status: 'idle',    // idle | hosting | joining | connected | closed | error
  version: 0,        // 送った状態の通し番号
  lastSent: null,    // 直前に送った状態（同じなら送り直さない）
  applying: false,   // 受信した状態を反映している最中か（送り返さないための目印）
  pendingGuestDeck: null,
};
const PEER_PREFIX = 'ijinden-';

function netRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 紛らわしい文字は除く
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
function netSetStatus(status, message) {
  NET.status = status;
  const bar = document.getElementById('netStatus');
  if (!bar) return;
  const label = {
    idle: '', hosting: '相手を待っています', joining: '接続しています',
    connected: '接続中', closed: '接続が切れました', error: 'エラー',
  }[status] || '';
  bar.textContent = message || (NET.room ? `部屋 ${NET.room}｜${label}` : label);
  bar.classList.toggle('is-open', status !== 'idle');
  bar.classList.toggle('is-bad', status === 'closed' || status === 'error');
  const hint = document.getElementById('netRoomHint');
  if (hint) hint.textContent = NET.room ? `部屋コード：${NET.room}（相手に伝えてください）` : '';
}
function netSend(msg) {
  if (!NET.conn || !NET.conn.open) return false;
  try { NET.conn.send(msg); return true; } catch (e) { console.error(e); return false; }
}

/* ---- いま操作してよいのは誰か ----
   通常は手番プレイヤー。ブロックステップだけは防御側が操作する。
   バトルの結果表示は、メインフェイズを続ける攻撃側が閉じる。 */
function controllerSeat() {
  if (!GAME) return 0;
  if (BATTLE) return BATTLE.step === 'block' ? BATTLE.defIdx : BATTLE.atkIdx;
  return GAME.active;
}
function canAct() {
  if (!NET.online) return true;
  if (!GAME) return false;
  if (GAME.over) return false;
  return controllerSeat() === NET.seat;
}
/* 決着後の盤面確認では、どちらの場も見られるように席を入れ替えられる */
let INSPECT_SWAP = false;
/* 自分の番でない間は盤面に触れないようにする */
function updateNetLock() {
  // 決着後は両者とも盤面を見返せるようにする
  const locked = NET.online && !!GAME && !GAME.over && !canAct();
  document.body.classList.toggle('net-locked', locked);
  const wait = document.getElementById('netWaiting');
  if (wait) {
    wait.classList.toggle('is-open', locked && NET.status === 'connected');
    if (locked && GAME) {
      wait.textContent = BATTLE
        ? '相手の操作を待っています…'
        : `${GAME.players[GAME.active].name} のターンです（相手の操作を待っています）`;
    }
  }
  // 相手の番の間は、相手の場を開いたままにして動きを追えるようにする
  if (locked && document.body.classList.contains('opp-open')) renderOppBoard(true);
}

/* ---- 送信する状態 ----
   BATTLE も送る（防御側の端末にブロック画面を出すため）。
   snapshot は中断用のローカル情報、_confirmBtn は DOM なので送らない。 */
function netBattlePayload() {
  if (!BATTLE) return null;
  const b = {};
  Object.keys(BATTLE).forEach(k => {
    if (k === 'snapshot' || k === '_confirmBtn') return;
    b[k] = BATTLE[k];
  });
  return b;
}
function netSyncState(force = false) {
  if (!NET.online || NET.applying || !GAME) return;
  if (NET.status !== 'connected') return;
  const payload = { game: GAME, battle: netBattlePayload() };
  const json = JSON.stringify(payload);
  if (!force && json === NET.lastSent) return;      // 変化がなければ送らない
  NET.lastSent = json;
  NET.version += 1;
  netSend({ type: 'state', version: NET.version, payload: JSON.parse(json) });
}

/* ---- 受信した状態を反映する ---- */
function netApplyState(msg) {
  if (!msg || !msg.payload) return;
  if (msg.version !== undefined && msg.version <= NET.remoteVersion) return;
  NET.remoteVersion = msg.version;
  NET.applying = true;
  try {
    const prevActive = GAME ? GAME.active : null;
    const localSnapshot = BATTLE ? BATTLE.snapshot : null;
    const firstState = !GAME;
    restoreGame(msg.payload.game);
    // 部屋に入った側は、最初の状態が届いた時点で盤面画面へ移る
    if (firstState) enterBoard();
    if (msg.payload.battle) {
      BATTLE = msg.payload.battle;
      BATTLE.snapshot = localSnapshot;              // 中断用のひかえは各自のものを使う
      document.getElementById('battleScreen').classList.add('is-open');
    } else {
      BATTLE = null;
      document.getElementById('battleScreen').classList.remove('is-open');
      document.getElementById('bsFrame').classList.remove('is-flipped');
    }
    // 相手の操作を巻き戻さないよう、受信のたびに自分の履歴は捨てる
    UNDO_STACK = [];
    FLOW = null;
    hideFlowBanner();
    NET.lastSent = JSON.stringify({ game: GAME, battle: netBattlePayload() });

    if (GAME.over) {
      const w = GAME.players[GAME.over.winner];
      document.getElementById('endWinner').textContent = `${w.name} の勝利！`;
      document.getElementById('endReason').textContent = GAME.over.reason;
      document.getElementById('endScreen').classList.add('is-open');
    }
    renderBoard();
    if (BATTLE) renderBattle();
    renderOppBoard();
    // 自分の手番になったら知らせる
    if (prevActive !== null && prevActive !== GAME.active && GAME.active === NET.seat && !GAME.over) {
      showTurnSplash(GAME.players[GAME.active].name);
    }
  } finally {
    NET.applying = false;
    updateNetLock();
  }
}
NET.remoteVersion = 0;

/* ---- PeerJS の接続まわり ---- */
function netTeardown() {
  try { if (NET.conn) NET.conn.close(); } catch (e) {}
  try { if (NET.peer) NET.peer.destroy(); } catch (e) {}
  NET.peer = null; NET.conn = null; NET.online = false; NET.seat = null;
  NET.isHost = false; NET.room = ''; NET.version = 0; NET.remoteVersion = 0;
  NET.lastSent = null; NET.pendingGuestDeck = null;
  netSetStatus('idle');
  updateNetLock();
}
function netPeerAvailable() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}
function netAttachConn(conn) {
  NET.conn = conn;
  conn.on('open', () => {
    netSetStatus('connected');
    updateNetLock();
    if (NET.isHost) {
      // 相手が入ってきた。デッキを受け取り次第ゲームを組み立てる
      netSend({ type: 'hello', role: 'host' });
      if (NET.pendingGuestDeck) netHostStartWithGuestDeck(NET.pendingGuestDeck);
    } else {
      // 自分のデッキ定義を送る（相手の端末には無いので中身ごと渡す）
      const name = document.getElementById('onlineDeckSelect').value;
      const deck = state.decks[name];
      netSend({ type: 'deck', deckName: name, cards: deck ? deck.cards : {} });
    }
  });
  conn.on('data', (msg) => { try { netHandleMessage(msg); } catch (e) { console.error(e); } });
  conn.on('close', () => { netSetStatus('closed', '相手との接続が切れました'); updateNetLock(); });
  conn.on('error', (e) => { console.error(e); netSetStatus('error', '通信エラーが起きました'); });
}
function netHandleMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'state') { netApplyState(msg); return; }
  if (msg.type === 'deck') {
    // 部屋の主が、入ってきた相手のデッキを受け取ってゲームを開始する
    if (!NET.isHost) return;
    NET.pendingGuestDeck = { deckName: msg.deckName, cards: msg.cards };
    netHostStartWithGuestDeck(NET.pendingGuestDeck);
    return;
  }
  if (msg.type === 'chatlog') { log(msg.text); renderLogBar(); return; }
}

function netHostRoom() {
  if (!netPeerAvailable()) { alert('通信ライブラリを読み込めませんでした。インターネット接続を確認してください。'); return; }
  const deckName = document.getElementById('onlineDeckSelect').value;
  if (!deckName || !state.decks[deckName]) { alert('自分のデッキを選択してください'); return; }
  netTeardown();
  NET.online = true; NET.isHost = true; NET.seat = 0;
  NET.room = netRoomCode();
  netSetStatus('hosting');
  const peer = new window.Peer(PEER_PREFIX + NET.room);
  NET.peer = peer;
  peer.on('open', () => netSetStatus('hosting'));
  peer.on('connection', (conn) => {
    if (NET.conn && NET.conn.open) { try { conn.close(); } catch (e) {} return; }  // 先着1名
    netAttachConn(conn);
  });
  peer.on('error', (e) => {
    console.error(e);
    if (e && e.type === 'unavailable-id') { NET.room = netRoomCode(); netSetStatus('error', '部屋コードが重複しました。もう一度お試しください'); }
    else netSetStatus('error', '接続に失敗しました（回線や広告ブロッカーをご確認ください）');
  });
}
function netJoinRoom() {
  if (!netPeerAvailable()) { alert('通信ライブラリを読み込めませんでした。インターネット接続を確認してください。'); return; }
  const code = (document.getElementById('netRoomInput').value || '').trim().toUpperCase();
  if (code.length < 4) { alert('部屋コードを入力してください'); return; }
  const deckName = document.getElementById('onlineDeckSelect').value;
  if (!deckName || !state.decks[deckName]) { alert('自分のデッキを選択してください'); return; }
  netTeardown();
  NET.online = true; NET.isHost = false; NET.seat = 1;
  NET.room = code;
  netSetStatus('joining');
  const peer = new window.Peer();
  NET.peer = peer;
  peer.on('open', () => netAttachConn(peer.connect(PEER_PREFIX + code, { reliable: true })));
  peer.on('error', (e) => {
    console.error(e);
    if (e && e.type === 'peer-unavailable') netSetStatus('error', 'その部屋は見つかりませんでした');
    else netSetStatus('error', '接続に失敗しました（回線や広告ブロッカーをご確認ください）');
  });
}

/* 部屋の主がゲームを組み立てて、初期状態を配る */
function netHostStartWithGuestDeck(guest) {
  const myDeckName = document.getElementById('onlineDeckSelect').value;
  if (!myDeckName || !state.decks[myDeckName]) return;
  const side0 = document.querySelector('#fSideOnline .chip-toggle.is-active').dataset.val;
  const side1 = side0 === 'gold' ? 'azure' : 'gold';
  const first = parseInt(document.querySelector('#fFirstOnline .chip-toggle.is-active').dataset.val, 10) || 0;

  // 相手のデッキ定義は一時的に取り込んで山札を組む（保存はしない）
  const guestPool = [];
  Object.keys(guest.cards || {}).forEach(id => {
    for (let i = 0; i < guest.cards[id]; i++) if (CARDS_BY_ID[id]) guestPool.push(id);
  });
  if (!guestPool.length) { netSetStatus('error', '相手のデッキを読み取れませんでした'); return; }

  UNDO_STACK = []; FLOW = null; DRAW_PROMPT = false;
  OPP_HAND_REVEALED = false; BATTLE = null;

  const mk = (sideKey, deckName, pool) => ({
    sideKey, name: SIDE_NAME[sideKey], deckName,
    deck: shuffle(pool), hand: [], field: [], mana: [], graveyard: [],
    resources: { manaPlace: 1, summon: 1, battle: 1 }, turn: 0,
  });
  GAME = attachVersusAccessors({
    mode: 'versus', online: true,
    players: [mk(side0, myDeckName, buildDeckPool(myDeckName)), mk(side1, guest.deckName || '相手のデッキ', guestPool)],
    active: first, first, phase: 'draw', over: null, log: [],
  });
  GAME.players.forEach(dealOpening);
  GAME.players[first].turn = 1;
  log(`オンライン対戦開始：${GAME.players[0].name} vs ${GAME.players[1].name}　先攻は ${GAME.players[first].name}`);
  enterBoard();
  netSyncState(true);
  updateNetLock();
  if (GAME.active === NET.seat) showTurnSplash(GAME.players[GAME.active].name);
}

document.getElementById('btnStartGame').addEventListener('click', () => {
  const mode = document.querySelector('#fMode .chip-toggle.is-active').dataset.val;
  if (mode === 'versus') { startVersusGame(); return; }

  const deckName = document.getElementById('soloDeckSelect').value;
  if (!deckName || !state.decks[deckName]) { alert('デッキを選択してください'); return; }
  const isFirst = document.querySelector('#fFirst .chip-toggle.is-active').dataset.val === 'first';

  const deck = shuffle(buildDeckPool(deckName));

  UNDO_STACK = [];
  FLOW = null;
  DRAW_PROMPT = false;

  GAME = {
    mode: 'solo',
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

  dealOpening(GAME);
  log(`対戦準備完了：${deckName}（${isFirst ? '先攻' : '後攻'}） 手札6枚・ガーディアン4枚を配置`);
  enterBoard();
});

/* ============================================================
   VERSUS: 相手の場（上部ホバータブで自分の場に重ねて表示）
   ============================================================ */
function setOppBoardOpen(open) {
  document.body.classList.toggle('opp-open', !!open);
  if (open) renderOppBoard(true);
}
(() => {
  const tab = document.getElementById('oppTab');
  const board = document.getElementById('oppBoard');
  if (!tab || !tab.addEventListener) return;
  tab.addEventListener('mouseenter', () => { if (GAME && GAME.mode === 'versus') setOppBoardOpen(true); });
  tab.addEventListener('click', () => { if (GAME && GAME.mode === 'versus') setOppBoardOpen(true); });
  if (board && board.addEventListener) {
    board.addEventListener('mouseleave', () => {
      // ドラッグ中・選択フロー中は閉じない。
      // 相手の番の間も開いたままにして、相手の操作を逐一見られるようにする。
      if (document.body.classList.contains('is-dragging') || FLOW) return;
      if (NET.online && !canAct() && !(GAME && GAME.over)) return;
      setOppBoardOpen(false);
    });
  }
})();
document.getElementById('btnOppReveal').addEventListener('click', (e) => {
  e.stopPropagation();
  OPP_HAND_REVEALED = !OPP_HAND_REVEALED;
  document.getElementById('btnOppReveal').textContent =
    OPP_HAND_REVEALED ? '相手の手札を伏せる' : '相手の手札を見る';
  log(OPP_HAND_REVEALED ? '相手の手札（と魔力ゾーンの裏）を確認しました' : '相手の手札を伏せ直しました');
  netSyncState();          // 覗いたことは相手のログにも残る
  renderOppBoard();
});

function renderOppBoard(force = false) {
  if (!GAME || GAME.mode !== 'versus') return;
  // 閉じている間は作り直さない（開くときに必ず描き直す）
  if (!force && !document.body.classList.contains('opp-open')) return;
  const opp = opponentP();
  document.getElementById('btnOppReveal').textContent =
    OPP_HAND_REVEALED ? '相手の手札を伏せる' : '相手の手札を見る';
  document.getElementById('oppTabName').textContent = opp.name;
  document.getElementById('oppBoardTitle').textContent = `${opp.name} の場（第${opp.turn}ターン）`;
  document.getElementById('oppDeckCount').textContent = opp.deck.length;
  document.getElementById('oppDeckTopCard').style.visibility = opp.deck.length ? 'visible' : 'hidden';
  document.getElementById('oppGraveCount').textContent = opp.graveyard.length;
  document.getElementById('oppManaSummary').textContent = manaSummaryTextFor(opp);
  renderZoneCards('oppField', 'oppZoneField');
  renderZoneCards('oppMana', 'oppZoneMana');
  renderZoneCards('oppHand', 'oppZoneHand');
}

/* ============================================================
   VERSUS: 相手の山札・墓地の操作
   ============================================================ */
/* 相手のドロー（効果「相手は1ドローする」など）。フェイズは動かさない。 */
function oppDrawOne() {
  const opp = opponentP();
  if (!opp.deck.length) { flashMessage('相手の山札が0枚です'); return; }
  pushUndo();
  const id = opp.deck.pop();
  opp.hand.push({ uid: uidCounter++, cardId: id });
  log('相手が山札から1枚ドローしました');
  renderOppBoard(); renderBoard();
}
function oppMillOne() {
  const opp = opponentP();
  if (!opp.deck.length) { flashMessage('相手の山札が0枚です'); return; }
  pushUndo();
  const id = opp.deck.pop();
  opp.graveyard.push({ uid: uidCounter++, cardId: id });
  log(`相手の山札の上から ${CARDS_BY_ID[id].name} を相手の墓地に置きました`);
  renderOppBoard(); renderBoard();
}
(() => {
  const slot = document.getElementById('oppDeckSlot');
  const top = document.getElementById('oppDeckTopCard');
  if (!slot || !slot.addEventListener) return;
  let t = null;
  slot.addEventListener('click', () => {
    if (!GAME || GAME.mode !== 'versus' || FLOW || SUPPRESS_CLICK) return;
    clearTimeout(t);
    t = setTimeout(oppDrawOne, 200);
  });
  slot.addEventListener('dblclick', () => {
    clearTimeout(t);
    if (!GAME || GAME.mode !== 'versus' || FLOW || SUPPRESS_CLICK) return;
    oppMillOne();
  });
  if (top && top.addEventListener) {
    top.addEventListener('pointerdown', (e) => {
      if (!GAME || GAME.mode !== 'versus' || GAME.phase !== 'main' || FLOW) return;
      if (DRAG || DECK_DRAG_PENDING) return;
      const opp = opponentP();
      if (!opp.deck.length) return;
      clearTimeout(t);
      const cardId = opp.deck[opp.deck.length - 1];
      const inst = { uid: uidCounter++, cardId, faceUp: false };
      if (startCardDrag(e, inst, 'oppDeckPile', top)) DECK_DRAG_PENDING = { inst, owner: opp };
      else uidCounter--;
    });
  }
})();
document.getElementById('btnOppDeckMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!GAME || GAME.mode !== 'versus' || FLOW) return;
  const opp = opponentP();
  beginFlow('opp-deck-menu');
  showFlowBanner(`相手の山札（${opp.deck.length}枚）の操作を選んでください`, [
    {
      label: 'サーチして相手の手札に加える',
      disabled: opp.deck.length === 0,
      onClick: () => { FLOW.type = 'opp-deck-search'; openDeckSearchFor(opp, 'oppHand'); }
    },
    {
      label: '1枚めくって確認する',
      disabled: opp.deck.length === 0,
      onClick: () => { FLOW.type = 'opp-deck-peek'; revealTopCardOf(opp, '相手の山札の一番上'); }
    },
    {
      label: 'シャッフル',
      disabled: opp.deck.length === 0,
      onClick: () => { opp.deck = shuffle(opp.deck); log('相手の山札をシャッフルしました'); commitFlow(); renderOppBoard(); }
    },
  ]);
  renderBoard();
});
/* 相手の墓地ポップオーバー */
document.getElementById('oppGraveSlot').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!GAME || GAME.mode !== 'versus' || SUPPRESS_CLICK || FLOW) return;
  const pop = document.getElementById('oppGravePopover');
  if (pop.classList.contains('is-open')) { pop.classList.remove('is-open'); return; }
  pop.innerHTML = '';
  if (opponentP().graveyard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'grave-empty';
    empty.textContent = '相手の墓地にカードはありません';
    pop.appendChild(empty);
  }
  opponentP().graveyard.forEach(inst => pop.appendChild(createMiniCard(inst, 'oppGraveyard')));
  pop.classList.add('is-open');
});

/* ============================================================
   VERSUS: バトル画面
   ルールブック準拠：
     アタックステップ   … 攻撃側がアタッカーを1体以上選んで寝かせる
     ブロックステップ   … 防御側が、起きているイジン／ガーディアンをブロッカーに選び、
                          どのアタッカーを防ぐか指定する（複数ブロッカー可）
     バトル解決ステップ … 防御側がアタッカーを1体ずつ選ぶ。
                          対応するブロッカーがいなければ攻撃側の勝利。
                          パワー比較：高い方が勝ち・同値は両方負け。
                          複数ブロッカー時、アタッカーはブロッカー合計と、
                          各ブロッカーは1体ずつアタッカーと比べる。
                          ガーディアンのブロッカーはアタッカーのパワーが0以下のときだけ勝つ。
   ============================================================ */
/* ブロック宣言〜解決〜結果は防御側主導の局面として扱う */
function isDefenderPhase() {
  return !!BATTLE && ['block', 'resolve', 'done'].includes(BATTLE.step);
}
/* バトル画面の上下を入れ替えるか（下に来る陣が「操作する側」になる）。
   オンラインでは常に自分の陣を下に置く。 */
function battleFlipped() {
  if (!BATTLE) return false;
  if (NET.online) return NET.seat === BATTLE.defIdx;
  return isDefenderPhase();
}
function battleBottomSeat() {
  return battleFlipped() ? BATTLE.defIdx : BATTLE.atkIdx;
}
function requiredBlockersOf(card) {
  const t = (card.rule_text || '');
  if (t.includes('クアドラプルプレッシャー')) return 4;
  if (t.includes('トリプルプレッシャー')) return 3;
  if (t.includes('ダブルプレッシャー')) return 2;
  return 1;
}

function openBattleScreen() {
  const atkIdx = GAME.active, defIdx = 1 - GAME.active;
  BATTLE = {
    step: 'attack',
    atkIdx, defIdx,
    attackers: [],            // uid の配列
    blocks: {},               // atkUid -> [blockerUid...]
    required: {},             // atkUid -> 必要ブロック数（プレッシャー。±で調整可）
    pending: null,            // 行き先のアタッカーを選んでいる途中のブロッカー
    defHandRevealed: false,   // 防御側の手札を確認したか
    resolving: false,         // バトル解決の演出中
    snapshot: snapshotGame(), // アタック確定前の中断用
    confirmed: false,         // アタック確定済みか（バトル権消費済みか）
  };
  document.getElementById('bsAtkLabel').textContent = `攻撃側：${GAME.players[atkIdx].name}`;
  document.getElementById('bsDefLabel').textContent = `防御側：${GAME.players[defIdx].name}`;
  document.getElementById('battleScreen').classList.add('is-open');
  renderBattle();
}
function closeBattleScreen() {
  BATTLE = null;
  document.getElementById('battleScreen').classList.remove('is-open');
  document.getElementById('bsFrame').classList.remove('is-flipped');
  renderBoard();          // 画面色も手番プレイヤーに戻る
  renderOppBoard();
}
/* 枠の外側をクリックするとバトルを中断する */
function abortBattle() {
  if (!BATTLE) return;
  if (BATTLE.resolving) return;                  // 解決の演出中は触れない
  if (BATTLE.step === 'done') {                  // 結果画面は「閉じる」と同じ扱い
    log('バトルを終了してメインフェイズを続けます');
    closeBattleScreen();
    return;
  }
  if (!BATTLE.confirmed) {
    // アタック確定前＝まだ何も起きていないので、選択を取り消して閉じる
    restoreGame(BATTLE.snapshot);
    closeBattleScreen();
    return;
  }
  // ルール「バトルを中断する」：残りのステップを行わず終了。
  // アタッカーとブロッカーはその状態でなくなる（寝かせたカードはそのまま）。
  log('バトルを中断しました（アタッカー・ブロッカーの状態は解除）');
  closeBattleScreen();
}
document.getElementById('battleScreen').addEventListener('click', (e) => {
  if (!BATTLE) return;
  if (e.target !== document.getElementById('battleScreen')) return;   // 枠の中は無視
  abortBattle();
});

/* 手札・魔力ゾーンを覗くための閲覧専用ストリップ。
   画面の上側／下側に表示されている陣のものを、それぞれの端に出す。
   防御側の手札は伏せておき、中央の「手札を確認する」で開ける。 */
function renderBattlePeeks() {
  const botIdx = battleBottomSeat();                // 下＝操作する側（オンラインでは自分）
  buildPeek('bsPeekTopBody', 'bsPeekTopTab', 1 - botIdx, '▼');
  buildPeek('bsPeekBottomBody', 'bsPeekBottomTab', botIdx, '▲');
}
function buildPeek(bodyId, tabId, idx, arrow) {
  const P = GAME.players[idx];
  const role = idx === BATTLE.atkIdx ? '攻撃側' : '防御側';
  // 自分の手札は見えていてよい。相手の手札は伏せ、確認したらログに残す。
  const mine = NET.online ? idx === NET.seat : idx === BATTLE.atkIdx;
  const hideHand = !mine && !BATTLE.defHandRevealed;
  document.getElementById(tabId).textContent = `${arrow} ${role}（${P.name}）の手札・魔力ゾーン`;

  const body = document.getElementById(bodyId);
  body.innerHTML = '';
  const cols = document.createElement('div');
  cols.className = 'bs-peek-cols';

  const handCol = document.createElement('div');
  handCol.className = 'bs-peek-hand-wrap';
  const hl = document.createElement('div');
  hl.className = 'bs-peek-label';
  hl.textContent = `手札（${P.hand.length}枚）`;
  handCol.appendChild(hl);
  const handRow = document.createElement('div');
  handRow.className = 'cards-row';
  P.hand.forEach(h => {
    const el = document.createElement('div');
    el.className = 'mini-card' + (hideHand ? ' is-facedown' : '');
    if (!hideHand) appendMiniCardFace(el, CARDS_BY_ID[h.cardId]);
    handRow.appendChild(el);
  });
  handCol.appendChild(handRow);
  if (hideHand) {
    const btn = document.createElement('button');
    btn.className = 'bs-peek-reveal';
    btn.textContent = '手札を確認する';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      BATTLE.defHandRevealed = true;
      log(`${P.name} の手札を確認しました`);
      renderBattlePeeks();
      netSyncState();
    });
    handCol.appendChild(btn);
  }
  cols.appendChild(handCol);

  const manaCol = document.createElement('div');
  const ml = document.createElement('div');
  ml.className = 'bs-peek-label';
  ml.textContent = `魔力ゾーン（${manaSummaryTextFor(P)}）`;
  manaCol.appendChild(ml);
  const manaRow = document.createElement('div');
  manaRow.className = 'cards-row';
  P.mana.forEach(m => {
    const el = document.createElement('div');
    // 自分の魔力ゾーンの裏は持ち主が確認できる。相手の裏は手札の公開に合わせる。
    const show = m.faceUp || mine || BATTLE.defHandRevealed;
    el.className = 'mini-card' + (show ? '' : ' is-facedown');
    if (show) appendMiniCardFace(el, CARDS_BY_ID[m.cardId], m);
    manaRow.appendChild(el);
  });
  manaCol.appendChild(manaRow);
  cols.appendChild(manaCol);

  body.appendChild(cols);
}

/* バトル用のカード表示（本体＋バッジ＋パワー調整） */
function makeBattleCard(inst, ownerIdx, opts = {}) {
  const card = CARDS_BY_ID[inst.cardId];
  const wrap = document.createElement('div');
  wrap.className = 'bs-card';

  const el = document.createElement('div');
  el.className = 'mini-card';
  el.dataset.uid = inst.uid;
  if (!inst.faceUp) el.classList.add('is-facedown');
  else appendMiniCardFace(el, card, inst);
  if (inst.tapped && opts.showTapped) el.classList.add('is-tapped');
  // 操作できるのはその局面の担当者だけ（アタッカー選択＝攻撃側、ブロック＝防御側）
  const mayOperate = canAct() && (opts.owner === undefined || opts.owner === controllerSeat());
  if (opts.selectable && mayOperate) el.classList.add('is-selectable');
  if (opts.selected) el.classList.add('is-selected');
  if (opts.dimmed) el.classList.add('is-dimmed');
  if (opts.onClick && mayOperate) el.addEventListener('click', opts.onClick);
  if (opts.onGrab && mayOperate) el.addEventListener('pointerdown', opts.onGrab);
  if (!mayOperate) el.classList.add('is-locked');
  wrap.appendChild(el);

  if (opts.badge) {
    const b = document.createElement('span');
    b.className = 'bs-badge' + (opts.badgeBlock ? ' is-block' : '');
    b.textContent = opts.badge;
    wrap.appendChild(b);
  }

  // パワー調整（表のイジン、またはガーディアン＝0扱い）
  if (opts.powerRow) {
    const row = document.createElement('div');
    row.className = 'bs-pow';
    const val = document.createElement('span');
    val.className = 'bs-pow-val';
    const base = inst.faceUp ? (card.power || 0) : 0;
    const setVal = () => {
      const eff = base + (inst.powerMod || 0);
      val.textContent = eff;
      val.style.color = (inst.powerMod || 0) > 0 ? '#3f9b52' : (inst.powerMod || 0) < 0 ? '#c0392b' : '';
      val.title = `基本${inst.faceUp ? (card.power || 0) : '0（ガーディアン）'} 修正${inst.powerMod ? ((inst.powerMod > 0 ? '+' : '') + inst.powerMod) : 'なし'}`;
    };
    setVal();
    const mk = (txt, d) => {
      const b = document.createElement('button');
      b.className = 'adj-btn';
      b.textContent = txt;
      b.title = 'カード能力によるパワーの増減を反映';
      b.disabled = !mayOperate;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation(); adjustPower(inst, d); setVal(); netSyncState();
      });
      return b;
    };
    row.appendChild(mk('−', -500));
    row.appendChild(val);
    row.appendChild(mk('＋', 500));
    wrap.appendChild(row);
  }
  return wrap;
}

function battleAttackerInsts() {
  return BATTLE.attackers
    .map(uid => GAME.players[BATTLE.atkIdx].field.find(f => f.uid === uid))
    .filter(Boolean);
}

function renderBattle() {
  renderBattleInner();
  updateNetLock();
  netSyncState();
}
function renderBattleInner() {
  if (!BATTLE) return;
  const atkP = GAME.players[BATTLE.atkIdx];
  const defP = GAME.players[BATTLE.defIdx];
  const stepLabel = { attack: 'アタックステップ', block: 'ブロックステップ', resolve: 'バトル解決ステップ' };
  document.getElementById('bsStep').textContent = stepLabel[BATTLE.step];
  // ブロック宣言以降は防御側主導の局面なので、上下を入れ替えたまま進める
  // （解決の途中でレイアウトが跳ねないように、結果表示まで維持する）
  document.getElementById('bsFrame').classList.toggle('is-flipped', battleFlipped());
  applySideTheme();

  const atkBox = document.getElementById('bsAtkField');
  const defBox = document.getElementById('bsDefField');
  const actions = document.getElementById('bsActions');
  const msg = document.getElementById('bsMsg');
  atkBox.innerHTML = ''; defBox.innerHTML = ''; actions.innerHTML = '';
  renderBattlePeeks();

  const addAction = (label, onClick, opts = {}) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (opts.sub ? 'btn-ghost' : 'btn-primary');
    b.textContent = label;
    b.disabled = !!opts.disabled || !canAct();
    b.addEventListener('click', onClick);
    actions.appendChild(b);
    return b;
  };

  /* ---------- アタックステップ ---------- */
  if (BATTLE.step === 'attack') {
    // ハイケイは表のままアタッカーになれないので、選択画面には並べない
    atkP.field.filter(inst => !(inst.faceUp && CARDS_BY_ID[inst.cardId].type === 'ハイケイ'))
      .forEach(inst => {
        const card = CARDS_BY_ID[inst.cardId];
        const selected = BATTLE.attackers.includes(inst.uid);
        // すでに寝ているカードは選べない（選択して寝かせたものは選び直せる）
        const pickable = selected || !inst.tapped;
        const lit = card.type === 'イジン' && inst.faceUp &&
          (inst.summonedTurn !== GAME.turn || cardHasKeyword(card, '即応'));
        atkBox.appendChild(makeBattleCard(inst, BATTLE.atkIdx, {
          owner: BATTLE.atkIdx,             // アタッカーを選べるのは攻撃側だけ
          selectable: lit && !selected, selected, dimmed: !pickable,
          showTapped: true,
          onClick: () => {
            const nowSelected = !BATTLE.attackers.includes(inst.uid);
            if (nowSelected && !pickable) return;
            if (nowSelected) BATTLE.attackers.push(inst.uid);
            else BATTLE.attackers = BATTLE.attackers.filter(u => u !== inst.uid);
            inst.tapped = nowSelected;                 // 選んだ時点で寝かせる
            // カードを作り直さずクラスだけ差し替えるので、回転が滑らかに見える
            const el = battleCardEl(inst.uid);
            if (el && el.classList) {
              el.classList.toggle('is-tapped', nowSelected);
              el.classList.toggle('is-selected', nowSelected);
              el.classList.toggle('is-selectable', !nowSelected && lit);
            }
            refreshAttackStep();
          },
        }));
      });
    defP.field.forEach(inst => defBox.appendChild(makeBattleCard(inst, BATTLE.defIdx, { dimmed: true, showTapped: true })));

    BATTLE._confirmBtn = addAction('ブロックステップへ', () => {
      pushUndo();                         // ↩ でバトル宣言前に戻せるようにする
      BATTLE.confirmed = true;
      GAME.resources.battle -= 1;
      battleAttackerInsts().forEach(i => { i.tapped = true; });
      BATTLE.attackers.forEach(uid => {
        BATTLE.blocks[uid] = [];
        const inst = atkP.field.find(f => f.uid === uid);
        BATTLE.required[uid] = inst.faceUp ? requiredBlockersOf(CARDS_BY_ID[inst.cardId]) : 1;
      });
      const names = battleAttackerInsts().map(i => inst2name(i));
      log(`バトル宣言：アタッカー［${names.join('、')}］`);
      BATTLE.step = 'block';
      BATTLE.pending = null;
      renderBattle();
    }, { disabled: BATTLE.attackers.length === 0 });
    refreshAttackStep();
    return;
  }

  /* ---------- ブロックステップ ----------
     防御側が、ブロッカーを「防ぎたいアタッカーの前までスライド」させて割り当てる。
     もう一度そのブロッカーを引き下げれば解除。攻撃側は操作できない。 */
  if (BATTLE.step === 'block') {
    battleAttackerInsts().forEach(inst => {
      const uid = inst.uid;
      const wrap = makeBattleCard(inst, BATTLE.atkIdx, {
        owner: BATTLE.atkIdx,               // 攻撃側のカード（防御側は押せない）
        showTapped: true, powerRow: true,
        badge: `${attackerNo(uid)}｜ブロック ${BATTLE.blocks[uid].length}/${BATTLE.required[uid]}`,
      });
      wrap.dataset.atkUid = uid;            // スライドの受け皿
      wrap.classList.add('bs-drop');
      // 必要ブロック数（プレッシャー）の調整
      const req = document.createElement('div');
      req.className = 'bs-req';
      const mk = (txt, d) => {
        const b = document.createElement('button');
        b.className = 'adj-btn';
        b.textContent = txt;
        b.disabled = !canAct();
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          BATTLE.required[uid] = Math.max(1, BATTLE.required[uid] + d);
          renderBattle();
        });
        return b;
      };
      req.appendChild(mk('−', -1));
      const lbl = document.createElement('span');
      lbl.textContent = `必要ブロック数 ${BATTLE.required[uid]}`;
      lbl.title = 'ダブルプレッシャー等。能力で変わる場合は±で調整';
      req.appendChild(lbl);
      req.appendChild(mk('＋', 1));
      wrap.appendChild(req);
      atkBox.appendChild(wrap);
    });

    defP.field.forEach(inst => {
      const card = CARDS_BY_ID[inst.cardId];
      // ブロッカーになれるのは、起きているイジンか起きているガーディアン
      const eligible = !inst.tapped && (inst.faceUp ? card.type === 'イジン' : true);
      const cur = assignedAttackerOf(inst.uid);
      const wrap = makeBattleCard(inst, BATTLE.defIdx, {
        owner: BATTLE.defIdx,               // 防御側のカードだけが動かせる
        selectable: eligible, selected: cur !== null,
        dimmed: !eligible, showTapped: true, powerRow: eligible || cur !== null,
        badge: cur !== null ? `→ アタッカー${attackerNo(cur)}` : null, badgeBlock: true,
        onGrab: eligible ? (ev) => startBlockerDrag(ev, inst.uid) : null,
      });
      wrap.dataset.blockerUid = inst.uid;
      if (cur !== null) wrap.classList.add('is-assigned');
      defBox.appendChild(wrap);
    });

    const assigned = Object.values(BATTLE.blocks).reduce((a, b) => a + b.length, 0);
    msg.textContent = canAct()
      ? `ブロッカーを、防ぎたいアタッカーの前までスライドさせてください（割り当て済み ${assigned}体）\n引き下げると解除できます`
      : '相手がブロッカーを選んでいます…';

    addAction('ブロック確定', () => confirmBlocks());
    addAction('スタンドでブロッカーを出す', () => openStandPicker(), { sub: true });
    return;
  }

  /* ---------- バトル解決ステップ（自動進行）／結果 ---------- */
  if (BATTLE.step === 'resolve' || BATTLE.step === 'done') {
    battleAttackerInsts().forEach(inst => {
      const uid = inst.uid;
      atkBox.appendChild(makeBattleCard(inst, BATTLE.atkIdx, {
        dimmed: true, showTapped: true, powerRow: false,
        badge: `${attackerNo(uid)}｜ブロック ${BATTLE.blocks[uid].length}`,
      }));
    });
    const blockedBy = new Set(Object.values(BATTLE.blocks).flat());
    defP.field.forEach(inst => {
      const cur = assignedAttackerOf(inst.uid);
      defBox.appendChild(makeBattleCard(inst, BATTLE.defIdx, {
        dimmed: true, showTapped: true,
        badge: cur !== null ? `→ アタッカー${attackerNo(cur)}` : null, badgeBlock: true,
      }));
    });

    if (BATTLE.step === 'resolve') {
      msg.textContent = 'バトルを解決しています…';
    } else {
      msg.textContent = 'バトル結果\n' + (BATTLE.results || []).join('\n');
      addAction('閉じる（メインフェイズを続ける）', () => {
        log('バトルを終了してメインフェイズを続けます');
        closeBattleScreen();
      });
    }
    return;
  }
}

/* アタックステップの案内文と「ブロックステップへ」の有効・無効だけを更新する。
   カードを作り直さないので、寝かせる回転のアニメーションが途切れない。 */
function refreshAttackStep() {
  if (!BATTLE || BATTLE.step !== 'attack') return;
  const notes = [];
  battleAttackerInsts().forEach(inst => {
    const card = CARDS_BY_ID[inst.cardId];
    if (!inst.faceUp) return;
    if (inst.summonedTurn === GAME.turn && !cardHasKeyword(card, '即応')) {
      notes.push(`※${card.name}は即応アタッカーではありません`);
    }
  });
  if (battleAttackerInsts().some(i => !i.faceUp)) notes.push('※ガーディアンがアタッカーに選ばれています');
  document.getElementById('bsMsg').textContent = (BATTLE.attackers.length
    ? `アタッカー ${BATTLE.attackers.length}体を選択中（選んだカードは寝かせます）`
    : 'アタッカーにするカードを選んでください') + (notes.length ? '\n' + notes.join('\n') : '');
  if (BATTLE._confirmBtn) BATTLE._confirmBtn.disabled = BATTLE.attackers.length === 0;
}

/* ---- ブロッカーをアタッカーの前までスライドさせて割り当てる ----
   指やマウスでブロッカーを掴み、防ぎたいアタッカーの上で離すと確定。
   自分の列（下段）へ引き下げて離すと解除。 */
let BLOCK_DRAG = null;
function startBlockerDrag(e, blockerUid) {
  if (!BATTLE || BATTLE.step !== 'block' || !canAct()) return;
  if (BLOCK_DRAG) return;
  if (e.isPrimary === false) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (e.preventDefault) e.preventDefault();
  const el = battleCardEl(blockerUid);
  if (!el) return;
  const r = el.getBoundingClientRect();
  BLOCK_DRAG = {
    uid: blockerUid, el,
    sx: e.clientX, sy: e.clientY,
    ox: r.left + r.width / 2, oy: r.top + r.height / 2,
    moved: false, target: null,
  };
  if (el.setPointerCapture && e.pointerId !== undefined) {
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
  }
  window.addEventListener('pointermove', onBlockerDragMove);
  window.addEventListener('pointerup', onBlockerDragEnd);
  window.addEventListener('pointercancel', onBlockerDragCancel);
}
function blockDropTargetAt(x, y) {
  const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
  const wrap = el && el.closest ? el.closest('.bs-drop') : null;
  return wrap && wrap.dataset ? wrap.dataset.atkUid : null;
}
function onBlockerDragMove(e) {
  if (!BLOCK_DRAG) return;
  if (!BLOCK_DRAG.moved) {
    if (Math.hypot(e.clientX - BLOCK_DRAG.sx, e.clientY - BLOCK_DRAG.sy) < 6) return;
    BLOCK_DRAG.moved = true;
    BLOCK_DRAG.el.classList.add('is-lifted');
    document.body.classList.add('is-dragging');
  }
  // カードそのものを指に追従させる（合成のみで動くので滑らか）
  const dx = e.clientX - BLOCK_DRAG.sx, dy = e.clientY - BLOCK_DRAG.sy;
  BLOCK_DRAG.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.04)`;

  const targetUid = blockDropTargetAt(e.clientX, e.clientY);
  if (targetUid !== BLOCK_DRAG.target) {
    document.querySelectorAll('.bs-drop').forEach(w => w.classList.remove('is-drop-target'));
    if (targetUid) {
      const w = Array.from(document.getElementById('bsAtkField').children)
        .find(x => x.dataset && String(x.dataset.atkUid) === String(targetUid));
      if (w) w.classList.add('is-drop-target');
    }
    BLOCK_DRAG.target = targetUid;
  }
}
function endBlockerDrag() {
  window.removeEventListener('pointermove', onBlockerDragMove);
  window.removeEventListener('pointerup', onBlockerDragEnd);
  window.removeEventListener('pointercancel', onBlockerDragCancel);
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.bs-drop').forEach(w => w.classList.remove('is-drop-target'));
  if (BLOCK_DRAG && BLOCK_DRAG.el && BLOCK_DRAG.el.style) {
    BLOCK_DRAG.el.style.transform = '';
    BLOCK_DRAG.el.classList.remove('is-lifted');
  }
}
function onBlockerDragCancel() { endBlockerDrag(); BLOCK_DRAG = null; renderBattle(); }
function onBlockerDragEnd(e) {
  if (!BLOCK_DRAG) return;
  const d = BLOCK_DRAG;
  const targetUid = d.moved ? blockDropTargetAt(e.clientX, e.clientY) : null;
  endBlockerDrag();
  BLOCK_DRAG = null;

  const prev = assignedAttackerOf(d.uid);
  if (targetUid !== null && targetUid !== undefined) {
    const atkUid = BATTLE.attackers.find(u => String(u) === String(targetUid));
    if (atkUid !== undefined) {
      assignBlocker(d.uid, atkUid);
      log(`${inst2name(GAME.players[BATTLE.defIdx].field.find(f => f.uid === d.uid))} を アタッカー${attackerNo(atkUid)} のブロッカーにしました`);
    }
  } else if (d.moved && prev !== null) {
    // アタッカーの上ではないところで離した＝割り当てを外す
    BATTLE.blocks[prev] = BATTLE.blocks[prev].filter(u => u !== d.uid);
    log('ブロッカーの割り当てを外しました');
  }
  renderBattle();
}

/* アタッカーの通し番号（1始まり）。キーが文字列になっていても正しく引く。 */
function attackerNo(uid) {
  return BATTLE.attackers.findIndex(u => String(u) === String(uid)) + 1;
}
/* そのブロッカーが割り当てられているアタッカーの uid（未割当なら null） */
function assignedAttackerOf(blockerUid) {
  const key = Object.keys(BATTLE.blocks).find(a => BATTLE.blocks[a].some(u => String(u) === String(blockerUid)));
  if (key === undefined) return null;
  const found = BATTLE.attackers.find(u => String(u) === String(key));
  return found === undefined ? null : found;
}
function assignBlocker(blockerUid, attackerUid) {
  const prev = assignedAttackerOf(blockerUid);
  if (prev !== null) BATTLE.blocks[prev] = BATTLE.blocks[prev].filter(u => u !== blockerUid);
  BATTLE.blocks[attackerUid].push(blockerUid);
}

function inst2name(inst) {
  return inst.faceUp ? CARDS_BY_ID[inst.cardId].name : 'ガーディアン';
}

/* ブロック確定：必要数に満たないアタッカーが1体でもいれば攻撃側の勝利 */
function confirmBlocks() {
  const atkP = GAME.players[BATTLE.atkIdx];
  const unblocked = BATTLE.attackers.filter(uid => BATTLE.blocks[uid].length < BATTLE.required[uid]);
  const summary = BATTLE.attackers.map(uid => {
    const inst = atkP.field.find(f => f.uid === uid);
    return `${inst2name(inst)}：ブロック${BATTLE.blocks[uid].length}/${BATTLE.required[uid]}`;
  });
  log(`ブロック指定：${summary.join('　')}`);
  if (unblocked.length) {
    const names = unblocked.map(uid => inst2name(atkP.field.find(f => f.uid === uid)));
    log(`防がれなかったアタッカー：［${names.join('、')}］`);
    declareWinner(BATTLE.atkIdx, `アタッカー［${names.join('、')}］の攻撃が防がれなかったため`);
    return;
  }
  BATTLE.step = 'resolve';
  BATTLE.pending = null;
  BATTLE.results = [];
  renderBattle();
  resolveNextBattle();          // 以降は宣言順に自動で解決する
}

/* 残っているアタッカーを順に解決し、全部終わったら結果画面にする */
function resolveNextBattle() {
  if (!BATTLE) return;
  if (BATTLE.attackers.length === 0) { showBattleSummary(); return; }
  resolveOneBattle(BATTLE.attackers[0]);
}
function showBattleSummary() {
  if (!BATTLE) return;
  BATTLE.step = 'done';
  log('すべてのバトル解決が終了しました');
  renderBattle();
}

/* スタンド：防御側の魔力ゾーンの裏のカードを、表にして戦場に出しブロッカーにする */
function openStandPicker() {
  const defP = GAME.players[BATTLE.defIdx];
  const candidates = defP.mana.filter(m => !m.faceUp);
  if (!candidates.length) { flashMessage('防御側の魔力ゾーンに裏のカードがありません'); return; }
  const msg = document.getElementById('bsMsg');
  const defBox = document.getElementById('bsDefField');
  defBox.innerHTML = '';
  candidates.forEach(m => {
    const card = CARDS_BY_ID[m.cardId];
    const el = document.createElement('div');
    el.className = 'mini-card';
    appendMiniCardFace(el, card);           // 防御側は自分の魔力ゾーンの裏を確認できる
    el.classList.add('is-selectable');
    el.addEventListener('click', () => {
      const hasStand = (card.rule_text || '').includes('スタンド');
      const colorOk = defP.mana.some(x => x.faceUp && x.uid !== m.uid &&
        CARDS_BY_ID[x.cardId].type === 'マリョク' &&
        [...(card.color || '')].some(ch => (CARDS_BY_ID[x.cardId].color || '').includes(ch)));
      const notes = [];
      if (!hasStand) notes.push(`※${card.name}は「スタンド」を持ちません`);
      if (!colorOk) notes.push('※同じ色のマリョクが防御側の魔力ゾーンにありません');
      if (notes.length) log(notes.join('　'));
      defP.mana = defP.mana.filter(x => x.uid !== m.uid);
      defP.field.push({ uid: m.uid, cardId: m.cardId, faceUp: true, tapped: false, summonedTurn: GAME.turn, powerMod: 0 });
      log(`スタンド：${card.name} を表にして防御側の戦場に置きました（イジン召喚権は使いません）`);
      // アタッカーが1体ならそのまま割り当て、複数ならスライドで指定してもらう
      if (BATTLE.attackers.length === 1) assignBlocker(m.uid, BATTLE.attackers[0]);
      renderBattle();
    });
    defBox.appendChild(el);
  });
  msg.textContent = 'スタンドで出すカードを選んでください（魔力ゾーンの裏のカード）\n※「スタンド」持ちで、同色のマリョクが必要です';
  document.getElementById('bsActions').innerHTML = '';
  const back = document.createElement('button');
  back.className = 'btn btn-ghost';
  back.textContent = 'やめる';
  back.addEventListener('click', () => renderBattle());
  document.getElementById('bsActions').appendChild(back);
}

/* 戦場のカードを破壊して持ち主の墓地へ（装備も随伴） */
function destroyToGrave(ownerIdx, uid) {
  const P = GAME.players[ownerIdx];
  const i = P.field.findIndex(f => f.uid === uid);
  if (i === -1) return null;
  const inst = P.field.splice(i, 1)[0];
  const card = CARDS_BY_ID[inst.cardId];
  (inst.equipped || []).forEach(e => {
    P.graveyard.push({ uid: e.uid, cardId: e.cardId });
    log(`装備していた ${CARDS_BY_ID[e.cardId].name} も墓地に置かれました`);
  });
  P.graveyard.push({ uid: inst.uid, cardId: inst.cardId });
  // 墓地に置かれると公開されるので、ここでは名前を出す
  let m = `${inst.faceUp ? '' : '裏向きだった '}${card.name} が破壊され、${P.name} の墓地に置かれました`;
  const hasLegacy = card.legacy_ability && !['-', '（空欄）', ''].includes((card.legacy_ability || '').trim());
  if (hasLegacy) m += '　※遺業能力の発動を確認してください';
  log(m);
  return inst;
}

/* バトル画面に並んでいるカードの要素を uid から引く */
function battleCardEl(uid) {
  // children は HTMLCollection なので、配列メソッドを使う前に Array.from する
  for (const boxId of ['bsAtkField', 'bsDefField']) {
    const box = document.getElementById(boxId);
    if (!box || !box.children) continue;
    for (const wrap of Array.from(box.children)) {
      const hit = Array.from(wrap.children || [])
        .find(x => x.dataset && String(x.dataset.uid) === String(uid));
      if (hit) return hit;
    }
  }
  return null;
}
/* 破壊されたカードが、持ち主の墓地の方向へ飛んでいく演出。
   手番側（画面下）の墓地は実際のスロットへ、相手側（画面上）は画面の上へ抜ける。 */
function flyDestroyed(doomed, done) {
  const pending = { n: 0 };
  let started = false;
  const finish = () => { if (started && pending.n === 0) done(); };

  doomed.forEach(d => {
    const el = battleCardEl(d.uid);
    const from = (el && el.getBoundingClientRect) ? elementCentre(el) : null;
    if (!from) return;
    if (el.style) el.style.visibility = 'hidden';
    const to = (d.ownerIdx === GAME.active)
      ? (zoneCentre('graveSlot') || { x: from.x, y: (window.innerHeight || 800) + 160 })
      : { x: from.x, y: -180 };
    pending.n += 1;
    const g = makeGhost(d.cardId, !d.faceUp);
    g.classList.add('is-destroyed');
    if (GAME.mode === 'versus') g.classList.add(backClassOf(d.ownerIdx));   // 裏面は持ち主の色
    flyGhostFromTo(g, from, to, () => { pending.n -= 1; finish(); });
  });
  started = true;
  finish();                        // 飛ばすものが無ければそのまま進む
}
/* 既製のゴースト要素を from から to へ飛ばす（flyCard の見た目を使い回す） */
function flyGhostFromTo(g, from, to, done) {
  if (typeof document.createElement !== 'function') { done(); return; }
  const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(document.documentElement) : null;
  const w = cs ? (parseInt(cs.getPropertyValue('--card-w')) || 104) : 104;
  const h = cs ? (parseInt(cs.getPropertyValue('--card-h')) || 146) : 146;
  g.style.left = (from.x - w / 2) + 'px';
  g.style.top = (from.y - h / 2) + 'px';
  g.style.transform = 'translate3d(0,0,0)';
  document.body.appendChild(g);
  const dx = to.x - from.x, dy = to.y - from.y;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      g.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(14deg) scale(.82)`;
      g.classList.add('is-fading');
    });
  });
  setTimeout(() => { g.remove(); done(); }, 520);
}

/* バトル解決（1体ぶん） */
function resolveOneBattle(atkUid) {
  if (BATTLE.resolving) return;
  const atkP = GAME.players[BATTLE.atkIdx];
  const defP = GAME.players[BATTLE.defIdx];
  const atkInst = atkP.field.find(f => f.uid === atkUid);
  if (!atkInst) return;
  const blockerUids = BATTLE.blocks[atkUid] || [];
  const blockers = blockerUids.map(u => defP.field.find(f => f.uid === u)).filter(Boolean);

  // 対応するブロッカーがいない → 攻撃側の勝利（通常はブロック確定時に判定済み）
  if (!blockers.length) {
    declareWinner(BATTLE.atkIdx, `${inst2name(atkInst)} の攻撃が防がれなかったため`);
    return;
  }

  const atkPow = (atkInst.faceUp ? (CARDS_BY_ID[atkInst.cardId].power || 0) : 0) + (atkInst.powerMod || 0);
  // ガーディアンのブロッカーはパワーを持たない（合計には修正のみ寄与）
  const bPow = b => (b.faceUp ? (CARDS_BY_ID[b.cardId].power || 0) : 0) + (b.powerMod || 0);
  const total = blockers.reduce((a, b) => a + bPow(b), 0);

  // アタッカー：ブロッカー合計と比較（同値は負け）
  const atkWins = atkPow > total;
  // 各ブロッカー：1体ずつアタッカーと比較。ガーディアンはアタッカーのパワーが0以下のときだけ勝つ
  const results = blockers.map(b => ({
    inst: b,
    wins: b.faceUp ? bPow(b) > atkPow : atkPow <= 0,
  }));

  const headline = `${inst2name(atkInst)}（${atkPow}） vs ブロッカー合計（${total}）`;
  const verdict = atkWins ? '→ アタッカーの勝ち'
    : (atkPow === total ? '→ 同値のためアタッカーも負け' : '→ アタッカーの負け');
  log(`バトル解決：${headline} ${verdict}`);

  const destroyed = results.filter(r => !r.wins).map(r => inst2name(r.inst));
  const survivors = results.filter(r => r.wins).map(r => inst2name(r.inst));
  document.getElementById('bsMsg').textContent =
    `${headline}\n${verdict}` +
    (destroyed.length ? `　破壊：${destroyed.join('、')}` : '') +
    (survivors.length ? `　残存：${survivors.join('、')}` : '');

  // 負けたカードを、飛ばしてから同時に墓地へ
  const doomed = [];
  if (!atkWins) doomed.push({ ownerIdx: BATTLE.atkIdx, uid: atkUid, cardId: atkInst.cardId, faceUp: atkInst.faceUp });
  results.filter(r => !r.wins).forEach(r =>
    doomed.push({ ownerIdx: BATTLE.defIdx, uid: r.inst.uid, cardId: r.inst.cardId, faceUp: r.inst.faceUp }));

  BATTLE.resolving = true;
  const applyResult = () => {
    doomed.forEach(d => destroyToGrave(d.ownerIdx, d.uid));

    // このバトル解決を終えたアタッカー・ブロッカーは、その状態でなくなる
    BATTLE.attackers = BATTLE.attackers.filter(u => u !== atkUid);
    delete BATTLE.blocks[atkUid];
    delete BATTLE.required[atkUid];
    BATTLE.resolving = false;

    (BATTLE.results = BATTLE.results || []).push(
      `${headline} ${verdict}` +
      (destroyed.length ? `／破壊：${destroyed.join('、')}` : '') +
      (survivors.length ? `／残存：${survivors.join('、')}` : '')
    );
    resolveNextBattle();          // 次のアタッカーへ（無ければ結果画面）
  };
  // 演出でつまずいても盤面は必ず進める
  try {
    flyDestroyed(doomed, () => { try { applyResult(); } catch (err) { console.error(err); safeRecover(); } });
  } catch (err) {
    console.error(err);
    applyResult();
  }
}
/* 万一の例外でバトル画面が固まらないようにする最後の砦 */
function safeRecover() {
  if (BATTLE) BATTLE.resolving = false;
  renderBoard();
}

/* ============================================================
   VERSUS: 勝敗と終了画面
   ============================================================ */
function declareWinner(winnerIdx, reason) {
  if (!GAME || GAME.mode !== 'versus') return;
  GAME.over = { winner: winnerIdx, reason };
  BATTLE = null;
  document.getElementById('battleScreen').classList.remove('is-open');
  FLOW = null; hideFlowBanner();
  const name = GAME.players[winnerIdx].name;
  log(`◆ ゲーム終了：${name} の勝利（${reason}）`);
  document.getElementById('endWinner').textContent = `${name} の勝利！`;
  document.getElementById('endReason').textContent = reason;
  document.getElementById('endScreen').classList.add('is-open');
  renderBoard();
}
function closeEndScreen() {
  document.getElementById('endScreen').classList.remove('is-open');
}
/* 新しい対戦・一手戻しなどで決着が解けたら、確認用の切り替えも畳む */
function clearInspectMode() {
  INSPECT_SWAP = false;
  const btn = document.getElementById('btnInspectSwap');
  if (btn) btn.classList.remove('is-open');
}
document.getElementById('btnEndToSetup').addEventListener('click', () => {
  closeEndScreen();
  leaveToSetup();
});
document.getElementById('btnEndInspect').addEventListener('click', () => {
  closeEndScreen();   // 盤面は残る。↩で直前まで戻すこともできる
  INSPECT_SWAP = false;
  const btn = document.getElementById('btnInspectSwap');
  if (btn) btn.classList.add('is-open');
  updateNetLock();
  renderBoard();
});
/* 決着後、下に表示する側を入れ替えて両者の場を見返す */
document.getElementById('btnInspectSwap').addEventListener('click', () => {
  if (!GAME || !GAME.over) return;
  INSPECT_SWAP = !INSPECT_SWAP;
  document.getElementById('btnInspectSwap').textContent =
    `${GAME.players[viewSeat()].name} の場を表示中（切り替える）`;
  renderBoard();
  renderOppBoard(true);
});
function leaveToSetup() {
  if (NET.online) netTeardown();
  INSPECT_SWAP = false;
  document.getElementById('btnInspectSwap').classList.remove('is-open');
  GAME = null; FLOW = null; UNDO_STACK = []; DRAW_PROMPT = false; BATTLE = null;
  OPP_HAND_REVEALED = false;
  hideFlowBanner();
  closeEndScreen();
  document.getElementById('battleScreen').classList.remove('is-open');
  setOppBoardOpen(false);
  applySideTheme();               // 準備画面は既定の配色に戻す
  document.getElementById('oppTab').style.display = 'none';
  document.getElementById('setupPanel').style.display = 'block';
  document.getElementById('boardPanel').style.display = 'none';
  document.body.classList.remove('solo-view', 'header-peek');
}

/* デッキ定義 → カードIDの束 */
function buildDeckPool(deckName) {
  const pool = [];
  const deckDef = state.decks[deckName].cards;
  Object.keys(deckDef).forEach(id => { for (let i = 0; i < deckDef[id]; i++) pool.push(id); });
  return pool;
}
/* 手札6枚・ガーディアン4枚の初期配置（owner は GAME か players[i]） */
function dealOpening(owner) {
  for (let i = 0; i < 6 && owner.deck.length; i++) {
    const id = owner.deck.pop();
    owner.hand.push({ uid: uidCounter++, cardId: id });
  }
  for (let i = 0; i < 4 && owner.deck.length; i++) {
    const id = owner.deck.pop();
    owner.field.push({ uid: uidCounter++, cardId: id, faceUp: false, tapped: false, summonedTurn: 0 });
  }
}
function enterBoard() {
  applySideTheme();               // 1人回しに戻ったときは陣営カラーを外す
  document.getElementById('setupPanel').style.display = 'none';
  document.getElementById('boardPanel').style.display = 'block';
  document.body.classList.add('solo-view');
  document.getElementById('oppTab').style.display = GAME.mode === 'versus' ? '' : 'none';
  renderBoard();
}

function startVersusGame() {
  const d1 = document.getElementById('soloDeckSelect').value;
  const d2 = document.getElementById('soloDeckSelect2').value;
  if (!d1 || !state.decks[d1] || !d2 || !state.decks[d2]) { alert('両プレイヤーのデッキを選択してください'); return; }
  const side1 = document.querySelector('#fSide1 .chip-toggle.is-active').dataset.val;
  const side2 = side1 === 'gold' ? 'azure' : 'gold';
  const first = parseInt(document.querySelector('#fFirstVs .chip-toggle.is-active').dataset.val, 10) || 0;

  UNDO_STACK = [];
  FLOW = null;
  DRAW_PROMPT = false;
  OPP_HAND_REVEALED = false;
  BATTLE = null;

  const mkPlayer = (sideKey, deckName) => ({
    sideKey, name: SIDE_NAME[sideKey], deckName,
    deck: shuffle(buildDeckPool(deckName)),
    hand: [], field: [], mana: [], graveyard: [],
    resources: { manaPlace: 1, summon: 1, battle: 1 },
    turn: 0,
  });

  GAME = attachVersusAccessors({
    mode: 'versus',
    players: [mkPlayer(side1, d1), mkPlayer(side2, d2)],
    active: first,
    first,
    phase: 'draw',
    over: null,
    log: [],
  });
  GAME.players.forEach(dealOpening);
  GAME.players[first].turn = 1;
  clearInspectMode();

  log(`対戦開始：${SIDE_NAME[side1]}（${d1}） vs ${SIDE_NAME[side2]}（${d2}）　先攻は ${GAME.players[first].name}`);
  enterBoard();
  showTurnSplash(GAME.players[GAME.active].name);
}

document.getElementById('btnEndGame').addEventListener('click', () => {
  if (!GAME) return;
  if (GAME.mode === 'versus') {
    // 効果による勝利（大日本沿海輿地全図など）も、ここから宣言できる
    beginFlow('end-menu');
    showFlowBanner('対戦をどのように終了しますか？', [
      { label: `${GAME.players[0].name} の勝利`, onClick: () => { commitFlow(); declareWinner(0, '宣言による勝利'); } },
      { label: `${GAME.players[1].name} の勝利`, onClick: () => { commitFlow(); declareWinner(1, '宣言による勝利'); } },
      { label: '勝敗をつけずに終了', sub: true, onClick: () => { commitFlow(); leaveToSetup(); } },
    ]);
    renderBoard();
    return;
  }
  if (!confirm('対戦を終了して準備画面に戻りますか？')) return;
  leaveToSetup();
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
  if (BATTLE) return;                       // バトル画面中は「中断」で戻る
  if (NET.online && !canAct()) return;      // 相手の操作は巻き戻さない
  restoreGame(UNDO_STACK.pop());            // 対戦では手番をまたいでも戻せる
  FLOW = null;
  hideFlowBanner();
  closeEndScreen();
  clearInspectMode();
  log('一手戻しました');
  renderBoard();
});

/* ============================================================
   SOLO PLAY: LOG (shown at the top; latest entry always visible)
   ============================================================ */
function log(msg) {
  if (!GAME) return;
  const prefix = GAME.mode === 'versus' ? `【${GAME.players[GAME.active].name}】` : '';
  GAME.log.push(prefix + msg);
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
  if (!GAME || GAME.phase !== 'main' || BATTLE) return;
  pushUndo();
  log(`ターン${GAME.turn} エンドフェイズ：未使用の権利が消滅`);

  if (GAME.mode === 'versus') {
    // 手番交代
    GAME.active = 1 - GAME.active;
    GAME.players[GAME.active].turn += 1;
    OPP_HAND_REVEALED = false;                       // 手札の公開は手番ごとにリセット
    setOppBoardOpen(false);

    // ルール：自分のターンが始まるときに山札が0枚なら、そのプレイヤーの敗北
    if (GAME.players[GAME.active].deck.length === 0) {
      log(`${GAME.players[GAME.active].name} のターン開始時に山札が0枚`);
      declareWinner(1 - GAME.active, `${GAME.players[GAME.active].name} のターン開始時に山札が0枚のため`);
      return;
    }
    runStartPhase();
    GAME.phase = 'draw';
    renderBoard();
    showTurnSplash(GAME.players[GAME.active].name);
    return;
  }

  GAME.turn += 1;
  runStartPhase();
  GAME.phase = 'draw';
  renderBoard();
});

/* 手番交代のスプラッシュ。クリックか少し待つと消える。 */
function showTurnSplash(name) {
  const el = document.getElementById('turnSplash');
  document.getElementById('turnSplashName').textContent = name;
  el.classList.add('is-open');
  const close = () => { el.classList.remove('is-open'); renderBoard(); };
  el.onclick = close;
  setTimeout(() => { if (el.classList.contains('is-open')) close(); }, 1400);
}

/* ============================================================
   SOLO PLAY: ZONE MOVEMENT (generic — used by guided flows, the hand-card
   quick-action menu, and the detail-view context actions)
   ============================================================ */
function findAndRemove(zoneArr, uid) {
  // 山札からのドラッグは、実際には持ち主の山札の一番上を取り除く
  if (DECK_DRAG_PENDING && DECK_DRAG_PENDING.inst.uid === uid &&
      zoneArr.length === 1 && zoneArr[0] === DECK_DRAG_PENDING.inst) {
    const { inst, owner } = DECK_DRAG_PENDING;
    DECK_DRAG_PENDING = null;
    const deck = owner.deck;
    if (deck.length && deck[deck.length - 1] === inst.cardId) deck.pop();
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
/* ---------------- zone-key resolution ----------------
   対戦モードでは 'opp' で始まるゾーンキー（oppHand / oppField / oppMana /
   oppGraveyard / oppDeckTop / oppDeckBottom / oppDeckPile）で
   相手側のゾーンを指す。ソロでは 'opp' キーは使われない。 */
function isOppZone(zoneKey) { return typeof zoneKey === 'string' && zoneKey.startsWith('opp'); }
function baseZoneKey(zoneKey) {
  if (!isOppZone(zoneKey)) return zoneKey;
  const b = zoneKey.slice(3);
  return b.charAt(0).toLowerCase() + b.slice(1);
}
/* そのゾーンの持ち主（ゾーン配列を持つオブジェクト）。
   ソロ: GAME 自身。対戦: 手番プレイヤー（GAME のアクセサ経由）か相手。 */
function zoneOwner(zoneKey) {
  if (GAME.mode === 'versus' && isOppZone(zoneKey)) return GAME.players[1 - viewSeat()];
  return GAME;
}
function zoneArrayOf(zoneKey) {
  // 'deckPile' / 'oppDeckPile' は山札からドラッグ中の1枚だけを持つ仮想ゾーン
  if (baseZoneKey(zoneKey) === 'deckPile') return DECK_DRAG_PENDING ? [DECK_DRAG_PENDING.inst] : [];
  const o = zoneOwner(zoneKey);
  return { hand: o.hand, mana: o.mana, field: o.field, graveyard: o.graveyard }[baseZoneKey(zoneKey)];
}
function moveInstance(uid, fromZone, toZone, opts = {}) {
  const fromArr = zoneArrayOf(fromZone);
  const inst = findAndRemove(fromArr, uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  const fromOwner = zoneOwner(fromZone);
  const toOwner = zoneOwner(toZone);
  const fromBase = baseZoneKey(fromZone);
  const toBase = baseZoneKey(toZone);

  // 装備しているイジンが戦場を離れるときは、装備カードも持ち主の墓地へ
  if (fromBase === 'field' && toBase !== 'graveyard') detachEquipmentToGraveyard(inst, fromOwner);

  const src = fromBase === 'deckPile' ? (isOppZone(fromZone) ? '相手の山札の上から ' : '山札の上から ') : '';
  const dst = isOppZone(toZone) ? '相手の' : '';

  // 表が分からないままのカードは、ログでも名前を明かさない。
  // 　・戦場の裏向きから運び出すとき（墓地＝公開される場所は除く）
  // 　・戦場に裏向き（ガーディアン）として置くとき
  const wasSecret = fromBase === 'field' && !inst.faceUp;
  const becomesSecret = toBase === 'field' && opts.faceUp === false;
  const name = (toBase !== 'graveyard' && (wasSecret || becomesSecret)) ? SECRET_LABEL : card.name;

  if (toBase === 'hand') {
    toOwner.hand.push({ uid: inst.uid, cardId: inst.cardId });
    log(`${src}${name} を${dst}手札に${src ? '加え' : '戻し'}ました`);
  } else if (toBase === 'mana') {
    toOwner.mana.push({ uid: inst.uid, cardId: inst.cardId, faceUp: !!opts.faceUp });
    log(`${src}${name} を${dst}魔力ゾーンに${opts.faceUp ? '表向きで' : '裏向きで'}置きました`);
  } else if (toBase === 'field') {
    toOwner.field.push({
      uid: inst.uid, cardId: inst.cardId, faceUp: opts.faceUp !== false, tapped: false,
      summonedTurn: toOwner.turn, powerMod: inst.powerMod || 0    // 持ち主のターン数で記録
    });
    log(`${src}${name} を${dst}戦場に${opts.faceUp !== false ? '表向きで' : '裏向き（ガーディアン）で'}置きました`);
  } else if (toBase === 'graveyard') {
    if (fromBase === 'field') detachEquipmentToGraveyard(inst, fromOwner);
    toOwner.graveyard.push({ uid: inst.uid, cardId: inst.cardId });
    // 墓地のカードは公開されるので、ここでは名前を出してよい
    let msg = `${src}${card.name} を${dst}墓地に置きました`;
    if (wasSecret) msg = `${src}裏向きだった ${card.name} を${dst}墓地に置きました`;
    // 遺業能力は「戦場から墓地に置かれたとき」だけ発動する。
    const hasLegacy = card.legacy_ability && !['-', '（空欄）', ''].includes(card.legacy_ability.trim());
    if (fromBase === 'field' && hasLegacy) msg += '　※遺業能力の発動を確認してください';
    log(msg);
  } else if (toBase === 'deckTop') {
    toOwner.deck.push(inst.cardId);
    log(`${name} を${dst}山札の上に戻しました`);
  } else if (toBase === 'deckBottom') {
    toOwner.deck.unshift(inst.cardId);
    log(`${name} を${dst}山札の下に戻しました`);
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
  const wasHidden = baseZoneKey(zoneKey) === 'field' && !inst.faceUp;
  inst.faceUp = !inst.faceUp;
  // 裏→表は公開されるので名前を出す。表→裏はもともと見えていたので名前を出してよい。
  log(`${CARDS_BY_ID[inst.cardId].name} を${inst.faceUp ? '表' : '裏'}にしました`
      + (wasHidden ? '（裏向きだったカードを公開）' : ''));
  renderBoard();
  renderOppBoard();
}
/* 寝かせる／起こす。回転そのものは .mini-card の transition が受け持つので、
   カードを作り直さずにクラスだけ差し替えて滑らかに回す。 */
function toggleTapped(uid, zoneKey = 'field') {
  const inst = zoneArrayOf(zoneKey).find(x => x.uid === uid);
  if (!inst) return;
  inst.tapped = !inst.tapped;
  log(`${logNameOf(inst, zoneKey)} を${inst.tapped ? '寝かせ' : '起こし'}ました`);

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
/* 任意のプレイヤーの魔力ゾーン要約（相手の場の表示用） */
function manaSummaryTextFor(owner) {
  const colors = new Set();
  let cap = 0;
  owner.mana.forEach(m => {
    cap += 1;
    if (m.faceUp) [...(CARDS_BY_ID[m.cardId].color || '')].forEach(ch => colors.add(ch));
  });
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
  if (FLOW && FLOW.snapshot) restoreGame(FLOW.snapshot);
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

/* --- バトル ---
   ソロ：アタッカーを選んで「攻撃」で確定するだけの簡易フロー。
   対戦：専用のバトル画面（アタック→ブロック→解決）を開く。 */
document.getElementById('btnActionBattle').addEventListener('click', () => {
  if (!GAME || GAME.phase !== 'main' || FLOW || GAME.resources.battle < 1) return;
  if (GAME.mode === 'versus') { openBattleScreen(); return; }
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
  const map = {
    zoneField: 'field', zoneMana: 'mana', zoneHand: 'hand',
    oppZoneField: 'oppField', oppZoneMana: 'oppMana', oppZoneHand: 'oppHand',
  };
  Object.keys(map).forEach(id => {
    const strip = document.getElementById(id);
    const box = strip && strip.closest('.zone-box');
    if (box) box.dataset.dropzone = map[id];
  });
  const grave = document.getElementById('graveSlot');
  if (grave) grave.dataset.dropzone = 'graveyard';
  const deck = document.getElementById('deckSlot');
  if (deck) deck.dataset.dropzone = 'deck';
  const og = document.getElementById('oppGraveSlot');
  if (og) og.dataset.dropzone = 'oppGraveyard';
  const od = document.getElementById('oppDeckSlot');
  if (od) od.dataset.dropzone = 'oppDeck';
}

function dropZoneAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('[data-dropzone]') : null;
}

/* 山札の上に重ねている間は、上半分／下半分のどちらに居るかで
   「山札の上に戻す」「山札の下に戻す」を選ぶ。 */
function deckHalfAt(y, slotId = 'deckSlot') {
  const slot = document.getElementById(slotId);
  if (!slot || !slot.getBoundingClientRect) return 'deckTop';
  const r = slot.getBoundingClientRect();
  return y < r.top + r.height / 2 ? 'deckTop' : 'deckBottom';
}
function updateDeckHalfHint(zone, y) {
  const dz = zone && zone.dataset ? zone.dataset.dropzone : null;
  [['deckSlot', 'deck'], ['oppDeckSlot', 'oppDeck']].forEach(([slotId, key]) => {
    const slot = document.getElementById(slotId);
    if (!slot) return;
    const over = dz === key;
    const half = over ? deckHalfAt(y, slotId) : null;    // 測定は重ねている1枚だけ
    slot.classList.toggle('half-top', half === 'deckTop');
    slot.classList.toggle('half-bottom', half === 'deckBottom');
  });
}
function clearDeckHalfHint() {
  ['deckSlot', 'oppDeckSlot'].forEach(id => {
    const slot = document.getElementById(id);
    if (slot) slot.classList.remove('half-top', 'half-bottom');
  });
}

function startCardDrag(e, inst, zoneKey, el) {
  if (!GAME || GAME.phase !== 'main' || FLOW) return false;
  if (DRAG) return false;                      // すでに1本つかんでいる
  if (e.isPrimary === false) return false;     // 2本目以降の指は無視
  if (e.button !== undefined && e.button !== 0) return false;
  if (e.preventDefault) e.preventDefault();    // 文字列選択とスクロールの割り込みを防ぐ
  const r = el.getBoundingClientRect();
  DRAG = {
    uid: inst.uid, from: zoneKey, cardId: inst.cardId,
    faceDown: baseZoneKey(zoneKey) !== 'hand' && baseZoneKey(zoneKey) !== 'graveyard' && !inst.faceUp,
    sx: e.clientX, sy: e.clientY,
    offX: e.clientX - r.left, offY: e.clientY - r.top,
    moved: false, ghost: null, pointerId: e.pointerId,
  };
  // 指が要素の外へ出ても、この要素にイベントが届き続けるようにする
  if (el.setPointerCapture && e.pointerId !== undefined) {
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
  }
  document.body.classList.add('is-dragging');
  window.addEventListener('pointermove', onCardDragMove);
  window.addEventListener('pointerup', onCardDragEnd);
  window.addEventListener('pointercancel', onCardDragCancel);
  return true;
}
/* 画面外へ抜ける・別アプリに切り替わるなどで指が失われたとき。
   後始末をしないと、掴んだままの見えないカードが残って増えたように見える。 */
function onCardDragCancel() {
  window.removeEventListener('pointermove', onCardDragMove);
  window.removeEventListener('pointerup', onCardDragEnd);
  window.removeEventListener('pointercancel', onCardDragCancel);
  document.body.classList.remove('is-dragging');
  if (DRAG && DRAG.ghost) DRAG.ghost.remove();
  DRAG = null;
  DECK_DRAG_PENDING = null;
  document.querySelectorAll('[data-dropzone]').forEach(z => z.classList.remove('is-drop-target'));
  clearDeckHalfHint();
  renderBoard();
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
  // left/top を毎回書き換えるとレイアウトが走るので、transform で動かす
  DRAG.ghost.style.transform =
    `translate3d(${e.clientX - DRAG.offX}px, ${e.clientY - DRAG.offY}px, 0)`;

  const zone = dropZoneAt(e.clientX, e.clientY);
  if (zone !== DRAG.zone) {                    // 変わったときだけクラスを触る
    if (DRAG.zone && DRAG.zone.classList) DRAG.zone.classList.remove('is-drop-target');
    if (zone && zone.classList) zone.classList.add('is-drop-target');
    DRAG.zone = zone;
  }
  updateDeckHalfHint(zone, e.clientY);
}

function onCardDragEnd(e) {
  document.body.classList.remove('is-dragging');
  window.removeEventListener('pointermove', onCardDragMove);
  window.removeEventListener('pointerup', onCardDragEnd);
  window.removeEventListener('pointercancel', onCardDragCancel);
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
  // 山札から引き抜いた1枚を同じ山札に戻しただけなら、何もせず元に戻す
  if ((to === 'deck' && d.from === 'deckPile') || (to === 'oppDeck' && d.from === 'oppDeckPile')) {
    DECK_DRAG_PENDING = null; renderBoard(); renderOppBoard(); return;
  }
  // 山札は落とした位置（上半分／下半分）でそのまま行き先が決まる
  if (to === 'deck') { handleCardDrop(d.uid, d.from, deckHalfAt(e.clientY)); return; }
  if (to === 'oppDeck') {
    handleCardDrop(d.uid, d.from, deckHalfAt(e.clientY, 'oppDeckSlot') === 'deckTop' ? 'oppDeckTop' : 'oppDeckBottom');
    return;
  }
  handleCardDrop(d.uid, d.from, to);
}

/* 手動ドラッグによる移動は「効果による移動」として扱い、
   マリョク配置権・イジン召喚権は消費しない。 */
function handleCardDrop(uid, from, to) {
  const inst = zoneArrayOf(from).find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  const fromBase = baseZoneKey(from);
  const toBase = baseZoneKey(to);
  const toOppSide = isOppZone(to);
  // 裏向きのまま運んでいるカードは、確認画面でも名前を伏せる
  const hidden = fromBase === 'deckPile'
    || ((fromBase === 'field' || fromBase === 'mana') && !inst.faceUp)
    || (from === 'oppHand' && !OPP_HAND_REVEALED);
  const label = hidden ? '??' : card.name;
  const side = toOppSide ? '相手の' : '';

  // 山札は落とした半分で行き先が決まっているので、そのまま実行
  if (toBase === 'deckTop' || toBase === 'deckBottom') {
    pushUndo();
    moveInstance(uid, from, to);
    renderOppBoard();
    return;
  }

  if (toBase === 'mana') {
    beginFlow('mana-drop');
    showFlowBanner(`${label} を${side}魔力ゾーンにどちらで置きますか？（配置権は消費しません）`, [
      { label: '表', onClick: () => { moveInstance(uid, from, to, { faceUp: true }); commitFlow(); renderOppBoard(); } },
      { label: '裏', sub: true, onClick: () => { moveInstance(uid, from, to, { faceUp: false }); commitFlow(); renderOppBoard(); } },
    ]);
    renderBoard();
    return;
  }

  if (toBase === 'field') {
    // 効果による移動なので条件は満たしていなくても置ける。
    // ただし満たしていない場合は確認画面にその旨を添える。
    const canFaceUp = card.type === 'イジン' || card.type === 'ハイケイ';
    const chk = checkPlayCondition(card);
    const notes = [];
    if (!canFaceUp) notes.push(`※${card.type}は戦場に裏向きでのみ置けます`);
    else if (!toOppSide && !chk.ok) notes.push(`※${chk.reasons.join('・')}を満たしていません`);

    const buttons = [];
    if (canFaceUp) {
      buttons.push({
        label: '表',
        onClick: () => {
          moveInstance(uid, from, to, { faceUp: true });
          if (fromBase === 'hand' && card.type === 'イジン' && !toOppSide) log('（効果による配置のため、イジン召喚権は消費していません）');
          commitFlow();
          renderOppBoard();
        }
      });
    }
    buttons.push({
      label: '裏', sub: canFaceUp,
      onClick: () => { moveInstance(uid, from, to, { faceUp: false }); commitFlow(); renderOppBoard(); }
    });

    beginFlow('field-drop');
    showFlowBanner(
      `${label} を${side}戦場にどちらで置きますか？` + (notes.length ? '\n' + notes.join('\n') : ''),
      buttons
    );
    renderBoard();
    return;
  }

  pushUndo();
  moveInstance(uid, from, to);
  renderOppBoard();
}

/* ログでの呼び名。
   「戦場に裏向きで置かれていて表が分からないカード」は、ログでも名前を出さない。
   墓地に置かれたときは表向きで公開されるので、そこでは名前を出す。 */
const SECRET_LABEL = '裏向きのカード';
function logNameOf(inst, zoneKey) {
  const hidden = baseZoneKey(zoneKey) === 'field' && !inst.faceUp;
  return hidden ? SECRET_LABEL : CARDS_BY_ID[inst.cardId].name;
}

/* ============================================================
   パワー修正（バトルの自動判定用）
   カード能力によるパワーの増減は inst.powerMod に 500 刻みで保持し、
   実効パワー＝基本パワー＋修正 で比較・表示する。
   ガーディアンはパワーを持たないため基本 0 として扱う。
   ============================================================ */
function effectivePower(inst, zoneKey) {
  const card = CARDS_BY_ID[inst.cardId];
  const base = isGuardianInst(inst, baseZoneKey(zoneKey) === 'field' ? 'field' : zoneKey)
    ? 0 : (card.power || 0);
  return base + (inst.powerMod || 0);
}
function adjustPower(inst, delta) {
  inst.powerMod = (inst.powerMod || 0) + delta;
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
function detachEquipmentToGraveyard(host, owner = GAME) {
  if (!host.equipped || !host.equipped.length) return;
  host.equipped.forEach(e => {
    owner.graveyard.push({ uid: e.uid, cardId: e.cardId });
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
function flyToGraveyard(from, cardId, faceDown, applyMove, slotId = 'graveSlot') {
  const to = zoneCentre(slotId);
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
    const mod = inst ? (inst.powerMod || 0) : 0;
    pw.textContent = (card.power || 0) + mod;
    if (mod > 0) pw.classList.add('is-buffed');
    if (mod < 0) pw.classList.add('is-debuffed');
    if (mod !== 0) pw.title = `基本${card.power} 修正${mod > 0 ? '+' : ''}${mod}`;
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

  const base = baseZoneKey(zoneKey);
  const opp = isOppZone(zoneKey);
  const inHiddenZone = (base === 'mana' || base === 'field');
  // 相手の手札は「公開」しない限り裏向き表示
  const handHidden = zoneKey === 'oppHand' && !OPP_HAND_REVEALED;
  const faceUp = handHidden ? false : (inHiddenZone ? inst.faceUp : true);
  // 表を見てはいけない／見えないカード：
  //  ・戦場の裏向き（ガーディアン）…ルールで禁止
  //  ・相手の魔力ゾーンの裏向き…「非公開情報を表示」中のみ確認できる
  //  ・相手の手札…同上
  const secret = (base === 'field' && !faceUp)
              || (zoneKey === 'oppMana' && !inst.faceUp && !OPP_HAND_REVEALED)
              || handHidden;

  if (!faceUp) el.classList.add('is-facedown');
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
      if (zoneKey === 'oppHand' && !OPP_HAND_REVEALED) {
        flashMessage('相手の手札は非公開です（「非公開情報を表示」で確認できます）');
      } else if (secret) {
        openFaceDownOps(inst, zoneKey);                // 表は見せず操作だけ
      } else {
        openCardDetail(card.id, { uid: inst.uid, zoneKey });
      }
    }, 200);
  });

  el.addEventListener('dblclick', () => {
    clearTimeout(tapTimer);
    if (SUPPRESS_CLICK || FLOW) return;
    if (base === 'graveyard') return;                  // すでに墓地にある
    pushUndo();
    const from = elementCentre(el);
    const faceDown = inHiddenZone && !inst.faceUp;
    el.style.visibility = 'hidden';
    // 相手側のカードは相手の墓地へ
    flyToGraveyard(from, inst.cardId, faceDown, () => {
      moveInstance(inst.uid, zoneKey, opp ? 'oppGraveyard' : 'graveyard');
    }, opp ? 'oppGraveSlot' : 'graveSlot');
  });

  el.addEventListener('pointerdown', (e) => startCardDrag(e, inst, zoneKey, el));

  return el;
}

/* 戦場の裏向きカード（ガーディアン）は表を見てはいけないので、
   カード情報を一切出さず、マウス操作では代替できない操作だけを並べる。 */
function openFaceDownOps(inst, zoneKey) {
  const uid = inst.uid;
  const act = fn => () => { pushUndo(); fn(); commitFlow(); renderOppBoard(); };
  const rows = [];
  if (baseZoneKey(zoneKey) === 'field') {
    rows.push({ label: inst.tapped ? '起こす' : '寝かせる', onClick: act(() => toggleTapped(uid, zoneKey)) });
  }
  rows.push({ label: '表にする', sub: true, onClick: act(() => toggleFaceUp(uid, zoneKey)) });
  beginFlow('facedown-ops');
  showFlowBanner(isOppZone(zoneKey) ? '相手の裏向きのカード（表は確認できません）' : '裏向きのカード（表は確認できません）', rows);
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
  if (GAME.mode === 'versus') {
    applySideTheme();
    const tp = GAME.players[GAME.active];
    document.getElementById('stampTurn').textContent =
      `${tp.name}・第${tp.turn}ターン` + (NET.online ? (GAME.active === NET.seat ? '（あなた）' : '（相手）') : '');
    document.getElementById('oppTabName').textContent = opponentP().name;
    if (document.body.classList.contains('opp-open')) renderOppBoard();
  } else {
    document.getElementById('stampTurn').textContent = `第${GAME.turn}ターン`;
  }
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

  const overlayBusy = BATTLE
    || document.getElementById('turnSplash').classList.contains('is-open')
    || document.getElementById('endScreen').classList.contains('is-open');
  if (GAME.phase === 'draw' && !FLOW && !overlayBusy) showDrawPrompt();
  else hideDrawPrompt();

  if (!SUPPRESS_REFLOW) playReflow(before);

  updateNetLock();
  netSyncState();          // 変化があれば相手へ送る（受信の反映中は送らない）
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
    title: 'オンライン対戦',
    rows: [
      ['はじめかた', '対戦準備で「オンライン対戦」を選び、自分のデッキを決めます。片方が「部屋を作る」を押すと6文字の部屋コードが出るので、それを相手に伝えてください。相手は同じ画面でコードを入力して「部屋に入る」を押します。'],
      ['決めごと', '部屋を作った側が色と先攻を決めます。入った側は自動でもう一方の色になります。デッキはそれぞれの端末に保存されているものを使い、対戦開始時に相手へ渡されます（保存はされません）。'],
      ['進めかた', '自分の番の間だけ盤面を操作できます。相手の番は盤面が暗くなり、画面下に待機中の表示が出ます。操作するとその結果が自動で相手の画面にも反映されるので、特別な送信操作は要りません。'],
      ['相手の動きを見る', '相手の番のあいだに「▲ 相手の場」を開いておくと、開いたままになり相手の操作が逐一反映されます。相手が何をしているかを追いながら待てます。'],
      ['バトル', 'アタッカーの選択は攻撃側、ブロックの割り当ては防御側と、それぞれの端末で操作します。どちらの画面でも自分の陣が下に表示されます。'],
      ['見えかた', '相手の手札は伏せて表示されます。「相手の手札を見る」で確認できますが、確認したことはログに残り相手にも伝わります。'],
      ['一手戻す', '↩は自分が操作できるときだけ使えます。相手の操作が届くと、それより前には戻せなくなります。'],
      ['つながらないとき', '広告ブロッカーや職場・学校のネットワークが通信を遮る場合があります。うまくいかないときは、回線を変える（携帯回線にするなど）とつながることがあります。接続が切れたら、同じ手順で部屋を作り直してください。'],
      ['ご注意', '端末どうしが直接つながる仕組みのため、相手の端末にはこちらの手札や山札の順番も届いています（画面には出ません）。紙のカードを2人で扱う卓の再現なので、気心の知れた相手との対戦にお使いください。'],
    ]
  },
  {
    title: '2人対戦',
    rows: [
      ['はじめかた', '対戦準備で「2人対戦」を選び、両者のデッキ・色・先攻を決めて開始します。1台の端末を2人で操作します（同じデッキも選べます）。'],
      ['色で見分ける', 'プレイヤーは「金」と「蒼」の色で区別します。手番のプレイヤーの色が画面全体（金＝黒基調／蒼＝明るいグレー基調）に反映され、カードの裏面もその陣営の色になるので、どちらの手番か・どちらのカードかがひと目で分かります。'],
      ['画面の見かた', '常に「手番プレイヤーの場」が表示されます。画面上部の「▲ ○○ の場」にマウスを重ねると、相手の場が上から重なって開きます。相手の場は卓の向かい側から見た配置（上下・左右が反転）で表示されます。'],
      ['相手の場の操作', '相手の場でも、ドラッグ・ダブルクリック・山札や墓地の操作がそのまま使えます。カードの効果で相手のカードを動かすときに使ってください。'],
      ['相手の手札', '相手の手札は伏せて表示されます。枚数はいつでも見えます。手札の上の「相手の手札を見る」で中身（と魔力ゾーンの裏）を確認できます。手番交代で自動的に伏せ直します。'],
      ['バトル', 'バトルボタンで専用画面が開きます。アタッカー選択 → ブロック割当 → 「ブロック確定」でルール通りにパワーを自動比較し、結果まで一気に進みます。枠の外側をクリックするとバトルを中断できます。'],
      ['ブロックの割り当て', 'ブロック宣言以降は防御側主導なので、画面の上下が入れ替わり（上＝アタッカー／下＝ブロッカー）、画面色も防御側の色になります。ブロッカーを、防ぎたいアタッカーの前までスライドさせると割り当てられます。引き下げて離すと解除です。アタッカーの選択は攻撃側、ブロックの割り当ては防御側しか操作できません。'],
      ['カードの裏の色', 'カードの裏面は「持ち主」の色です。手番が移っても自分のカードの裏の色は変わりません。画面全体の背景の色が、いまどちらの手番かを表します。'],
      ['バトル解決', 'ブロック確定を押すと、宣言した順に自動で解決します。負けたカードは墓地へ飛ぶ演出のあとに置かれ、最後に全ペアの結果がまとめて表示されます。「閉じる」でメインフェイズに戻ります。'],
      ['防御側の手札', 'バトル中は画面下端の覗き見タブから、防御側の手札と魔力ゾーンを確認できます。手札は伏せてあり、中央の「手札を確認する」で開けます。'],
      ['パワーの増減', 'カード能力によるパワー修正は、カードの詳細画面かバトル画面の「＋／−」で500刻みで反映できます。修正込みの実効パワーが自動判定に使われます。'],
      ['プレッシャー', 'ダブルプレッシャーなどの必要ブロック数は自動で設定されます。能力で変わる場合はバトル画面の±で調整してください。必要数に満たないアタッカーが1体でもいれば、攻撃側の勝利です。'],
      ['スタンド', 'ブロックステップの「スタンドでブロッカーを出す」から、防御側の魔力ゾーンの裏のカードを表にして戦場に出せます（同色マリョクが必要。イジン召喚権は使いません）。'],
      ['勝敗', '攻撃が防がれなかったとき、またはターン開始時に山札が0枚のとき、自動で勝敗が決まり終了画面が出ます。カード効果による勝利は「終了」ボタンから宣言できます。'],
      ['決着後の確認', '終了画面の「盤面を確認する」を押すと盤面を見返せます。画面下の「場を切り替える」で、どちらの側を下に表示するか入れ替えられます。'],
      ['一手戻す', '↩は手番をまたいで戻せます。直前の相手の操作も取り消せます。'],
    ]
  },
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
      if (DRAG || DECK_DRAG_PENDING) return;
      clearTimeout(deckTapTimer);
      const cardId = GAME.deck[GAME.deck.length - 1];
      // 山札から引き抜いた1枚を、一時的な実体としてドラッグする。
      // ドラッグが始められたときだけ作る（作ってから失敗すると行き場を失うため）
      const inst = { uid: uidCounter++, cardId, faceUp: false };
      if (startCardDrag(e, inst, 'deckPile', topCard)) DECK_DRAG_PENDING = { inst, owner: GAME };
      else uidCounter--;
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
function revealTopCard() { revealTopCardOf(GAME, '山札の一番上'); }
function revealTopCardOf(owner, label) {
  const cardId = owner.deck[owner.deck.length - 1];
  if (!cardId) { commitFlow(); return; }
  const card = CARDS_BY_ID[cardId];
  log(`${label}（${card.name}）を確認しました　※シャッフルしなければ次のドローで引きます`);

  hideFlowBanner();
  modalContent.classList.remove('help-panel');
  modalContent.classList.add('detail-face');
  modalContent.innerHTML = '';

  const tag = document.createElement('div');
  tag.className = 'equip-tag';
  tag.textContent = label;
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
function openDeckSearch() { openDeckSearchFor(GAME, 'hand'); }
/* 任意のプレイヤーの山札をサーチする。destKey='hand'|'oppHand' */
function openDeckSearchFor(owner, destKey) {
  const pop = document.getElementById('gravePopover');
  pop.innerHTML = '';
  pop.classList.add('deck-list-popover');
  const oppSide = destKey === 'oppHand';

  const sorted = owner.deck
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
      owner.deck.splice(idx, 1);
      owner.hand.push({ uid: uidCounter++, cardId });
      log(`${oppSide ? '相手の' : ''}山札から ${card.name} を${oppSide ? '相手の' : ''}手札に加えました`);
      closeGravePopover();
      commitFlow();
      if (oppSide) renderOppBoard();
    });
    pop.appendChild(el);
  });

  pop.classList.add('is-open');
  showFlowBanner(`${oppSide ? '相手の' : ''}手札に加えるカードを選んでください`, [], 'gravePopover');
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
