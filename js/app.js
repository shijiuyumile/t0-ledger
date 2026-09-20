/**
 * 界面渲染与交互入口。
 */
'use strict';

Store.load();

let fullMatchResult = { lots: new Map(), sells: new Map() };
let matchResult = { lots: new Map(), sells: new Map() };
let timeMatchResult = { lots: new Map(), sells: new Map(), pendingCovers: [] };

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function addDaysISO(iso, delta) {
  const d = new Date(String(iso) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 根据设置算出做T起始日（含当天） */
function resolveTFromDate(settings) {
  const s = settings || Store.settings;
  const today = todayISO();
  const p = s.tWindowPreset || 'd5';
  if (p === 'custom') return s.tFromDate || today;
  if (p === 'today') return today;
  if (p === 'd2') return addDaysISO(today, -1);
  if (p === 'd3') return addDaysISO(today, -2);
  if (p === 'd4') return addDaysISO(today, -3);
  if (p === 'd5') return addDaysISO(today, -4);
  if (p === 'halfMonth') return addDaysISO(today, -14);
  if (p === 'month') return addDaysISO(today, -30);
  if (p === 'quarter') return addDaysISO(today, -90);
  if (p === 'halfYear') return addDaysISO(today, -182);
  if (p === 'year') return addDaysISO(today, -365);
  if (p === 'sinceOpen') return earliestTradeDate();
  return today;
}

function earliestTradeDate() {
  let min = '';
  for (const t of Store.trades) {
    if (t.date && (!min || t.date < min)) min = t.date;
  }
  return min || todayISO();
}

function isTWindowMode() {
  return Store.settings.ledgerMode === 'tWindow';
}

function currentMatchMode() {
  return Store.settings.matchMode === 'time' ? 'time' : 'closest';
}

function currentLedgerPanel() {
  const p = Store.settings.ledgerPanel;
  if (p === 'covers' || p === 'breakeven') return p;
  return 'lots';
}

function matchOpts(extra) {
  return Object.assign({ mode: currentMatchMode() }, extra || {});
}

function recompute() {
  fullMatchResult = computeMatches(Store.trades, matchOpts());
  const fromDate = isTWindowMode() ? resolveTFromDate(Store.settings) : '';
  if (isTWindowMode()) {
    matchResult = computeMatches(Store.trades, matchOpts({ fromDate }));
  } else {
    matchResult = fullMatchResult;
  }
  // 待回补子页始终按时间核销（与主列表口径可不同）
  timeMatchResult = computeMatches(Store.trades, {
    mode: 'time',
    fromDate: fromDate || undefined,
  });
}

/** 某标的历史累计做T已实现（始终用全历史配对口径） */
function codeFullRealized(code) {
  let realized = 0;
  for (const t of Store.trades) {
    if (t.code !== code || t.side !== 'sell') continue;
    const r = fullMatchResult.sells.get(t.id);
    if (r && r.matchedQty > 0) realized += r.netPnl;
  }
  return round2(realized);
}

function isUnprofitableCode(code) {
  return codeFullRealized(code) <= 0;
}

/** 做T时间模式下，该标的是否应按整体持仓显示（含底仓） */
function showFullLotsForCode(code) {
  return isTWindowMode()
    && Store.settings.unprofitableDisplay === 'full'
    && isUnprofitableCode(code);
}

/** 拉取线上 seed：空库全量载入；已有数据则按 key 增量合并，并刷新较新的账户快照 */
async function ensureSeed() {
  try {
    const res = await fetch('data/seed.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const seed = await res.json();
    if (!seed || !Array.isArray(seed.trades)) return;

    if (Store.trades.length === 0) {
      Store.data = seed;
      if (!Store.data.settings) Store.data.settings = {};
      if (!Store.data.settings.lotSort) Store.data.settings.lotSort = 'asc';
      if (!Store.data.settings.feeRules) Store.data.settings.feeRules = JSON.parse(JSON.stringify(DEFAULT_FEE_RULES));
      if (!Store.data.settings.sellFilter) Store.data.settings.sellFilter = 'loss';
      if (!Store.data.settings.quotes) Store.data.settings.quotes = {};
      if (Store.data.settings.showHiddenLots == null) Store.data.settings.showHiddenLots = false;
      if (!Store.data.settings.ledgerMode) Store.data.settings.ledgerMode = 'full';
      if (!Store.data.settings.tWindowPreset) Store.data.settings.tWindowPreset = 'd5';
      if (Store.data.settings.tFromDate == null) Store.data.settings.tFromDate = '';
      if (!Store.data.settings.unprofitableDisplay) Store.data.settings.unprofitableDisplay = 'tWindow';
      if (!Store.data.settings.matchMode) Store.data.settings.matchMode = 'closest';
      if (!Store.data.settings.ledgerPanel) Store.data.settings.ledgerPanel = 'lots';
      if (!Array.isArray(Store.data.settings.watchPrices)) Store.data.settings.watchPrices = [];
      Store.data.seedRevision = seed.seedRevision || 1;
      Store.save();
      console.log('已载入历史对账单', Store.trades.length, '笔');
      return;
    }

    // 增量合并成交
    const existing = new Set(Store.trades.map((t) => t.key));
    let added = 0;
    for (const t of seed.trades) {
      if (!t.key || existing.has(t.key)) continue;
      existing.add(t.key);
      Store.data.trades.push(t);
      added++;
    }

    // 账户快照：seed 更新日期不早于本地时覆盖持仓/资产，资金类取 seed（已是累计）
    const localAsOf = (Store.account && Store.account.asOf) || '';
    const seedAsOf = (seed.account && seed.account.asOf) || '';
    const localRev = Store.data.seedRevision || 0;
    const seedRev = seed.seedRevision || 0;
    if (seed.account && (seedRev > localRev || seedAsOf >= localAsOf)) {
      const keepQuotes = (Store.account && Store.account.quotes) || Store.settings.quotes || {};
      Store.data.account = Object.assign({}, seed.account, { quotes: keepQuotes });
      Store.data.seedRevision = seedRev;
    }

    if (added > 0 || seedRev > localRev) {
      Store.save();
      console.log('已增量合并', added, '笔，账户截至', Store.account && Store.account.asOf);
    }
  } catch (e) {
    console.error('载入历史数据失败（不影响手动导入）', e);
  }
}

/* ---------- 工具 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function fmt(n, digits) {
  return Number(n || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: digits == null ? 2 : digits,
    maximumFractionDigits: digits == null ? 2 : digits,
  });
}
function fmtSign(n) {
  return (n > 0 ? '+' : '') + fmt(n);
}
function pnlClass(n) {
  return n > 0 ? 'c-up' : n < 0 ? 'c-down' : '';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function feeText(fees) {
  const parts = [];
  if (fees.commission) parts.push('佣金' + fmt(fees.commission));
  if (fees.transfer) parts.push('过户' + fmt(fees.transfer));
  if (fees.stamp) parts.push('印花' + fmt(fees.stamp));
  if (fees.other) parts.push('其他' + fmt(fees.other));
  return parts.length ? parts.join(' ') : '费用0';
}
function displayName(code) {
  let name = '';
  for (const t of Store.trades) {
    if (t.code === code && t.name) name = t.name;
  }
  return name || code;
}

/** 会话内记住展开状态（刷新页面后默认折叠） */
const uiOpen = { ledger: new Set(), sells: new Set() };

/** 某标的：持仓、成本、浮动、做T盈利/亏损合计 */
function codeStats(code, mr) {
  mr = mr || matchResult;
  const includeBase = !isTWindowMode() || showFullLotsForCode(code);
  let buyQty = 0, sellQty = 0, sumQty = 0, sumCost = 0, sumFee = 0, lotCount = 0;
  let realized = 0, winSum = 0, lossSum = 0, win = 0, loss = 0;
  let secType = 'stock';

  for (const t of Store.trades) {
    if (t.code !== code) continue;
    secType = t.secType || secType;
    if (t.side === 'buy') {
      buyQty += t.qty;
      const lot = mr.lots.get(t.id);
      if (!lot || lot.remainingQty <= 0) continue;
      if (lot.isBase && !includeBase) continue;
      sumQty += lot.remainingQty;
      sumCost += t.price * lot.remainingQty;
      sumFee += totalFees(t.fees) * (lot.remainingQty / t.qty);
      lotCount++;
    } else {
      sellQty += t.qty;
      const r = mr.sells.get(t.id);
      if (r && r.matchedQty > 0) {
        realized += r.netPnl;
        if (r.netPnl > 0) { winSum += r.netPnl; win++; }
        else { lossSum += r.netPnl; loss++; }
      }
    }
  }

  const holdQty = Math.max(0, buyQty - sellQty);
  const avgCost = sumQty > 0 ? (sumCost + sumFee) / sumQty : 0;
  const h = ((Store.account && Store.account.holdings) || []).find((x) => x.code === code);
  const quote = Number(Store.settings.quotes[code]) || (h && h.lastPrice) || 0;
  const costPrice = (h && h.costPrice) || avgCost;
  const qtyForFloat = (h && h.qty) || holdQty;
  let floatPnl = null;
  if (qtyForFloat > 0 && quote > 0 && costPrice > 0) {
    floatPnl = round2((quote - costPrice) * qtyForFloat);
  } else if (h && h.holdPnl != null) {
    floatPnl = round2(h.holdPnl);
  }

  return {
    holdQty: (h && h.qty) || holdQty,
    tQty: sumQty,
    lotCount,
    avgCost: costPrice || avgCost,
    costAmt: round2(sumCost + sumFee),
    floatPnl,
    realized: round2(realized),
    winSum: round2(winSum),
    lossSum: round2(lossSum),
    win, loss, secType, quote,
    fullRealized: codeFullRealized(code),
  };
}

function accountPnl() {
  const acc = Store.account ? Object.assign({}, Store.account, { quotes: Store.settings.quotes }) : { holdings: [], quotes: Store.settings.quotes };
  // 账户已实现随当前核销口径；浮动/股息仍用对账单
  return computeAccountPnl(Store.trades, fullMatchResult, acc);
}

function pendingCoversForView() {
  return (timeMatchResult && timeMatchResult.pendingCovers) || [];
}

/** 参考价：手填 > 账单持仓 lastPrice > 最近成交价 */
function refPriceForCode(code) {
  const manual = Number(Store.settings.quotes[code]);
  if (manual > 0) return { price: manual, source: 'hand' };
  const h = ((Store.account && Store.account.holdings) || []).find((x) => x.code === code);
  if (h && Number(h.lastPrice) > 0) return { price: Number(h.lastPrice), source: 'statement' };
  let latest = null;
  for (const t of Store.trades) {
    if (t.code !== code) continue;
    if (!latest || tradeTimeKey(t) >= tradeTimeKey(latest)) latest = t;
  }
  if (latest && latest.price > 0) return { price: latest.price, source: 'trade' };
  return { price: 0, source: 'none' };
}

function refPriceSourceLabel(source) {
  if (source === 'hand') return '手填';
  if (source === 'statement') return '账单';
  if (source === 'trade') return '最近成交';
  return '';
}

/** 全历史下该代码是否还有剩余多头（含底仓） */
function codeHasRemainingLongs(code) {
  for (const t of Store.trades) {
    if (t.code !== code || t.side !== 'buy') continue;
    const lot = fullMatchResult.lots.get(t.id);
    if (lot && lot.remainingQty > 0) return true;
  }
  return false;
}

/** 当前窗口核销里是否有底仓买单（待回补提示用时间核销结果） */
function codeHasBaseLots(code) {
  const lots = (timeMatchResult && timeMatchResult.lots) || matchResult.lots;
  for (const t of Store.trades) {
    if (t.code !== code || t.side !== 'buy') continue;
    const lot = lots.get(t.id);
    if (lot && lot.isBase) return true;
  }
  return false;
}

/** 按参考价回补一笔待回补的倒T预估净利 */
function estimateCoverAtRef(cover, refPrice) {
  if (!(refPrice > 0) || !(cover.qty > 0)) return null;
  const secType = cover.secType || guessSecType(cover.code);
  const rules = Store.settings.feeRules;
  const buyFee = totalFees(calcFees(secType, 'buy', refPrice * cover.qty, rules));
  const sell = Store.trades.find((t) => t.id === cover.sellId);
  const sellFeeShare = sell
    ? totalFees(sell.fees) * (cover.qty / sell.qty)
    : totalFees(calcFees(secType, 'sell', cover.price * cover.qty, rules));
  const gross = (cover.price - refPrice) * cover.qty;
  return {
    gross: round2(gross),
    net: round2(gross - buyFee - sellFeeShare),
    buyFee: round2(buyFee),
    sellFeeShare: round2(sellFeeShare),
  };
}

/**
 * 卖亏后再买：估算扳本卖出价。
 * 使 (卖价−再买价)×数量 − 买费 − 卖费 ≈ |已实现亏损|
 */
function estimateBreakevenSellPrice(absLoss, qty, buyPrice, secType) {
  if (!(qty > 0) || !(buyPrice > 0) || !(absLoss > 0)) return null;
  const rules = Store.settings.feeRules;
  const type = secType || 'stock';
  let sellPrice = buyPrice + absLoss / qty;
  for (let i = 0; i < 6; i++) {
    const buyFee = totalFees(calcFees(type, 'buy', buyPrice * qty, rules));
    const sellFee = totalFees(calcFees(type, 'sell', sellPrice * qty, rules));
    sellPrice = buyPrice + (absLoss + buyFee + sellFee) / qty;
  }
  return Math.round(sellPrice * 1000) / 1000;
}

function breakevenHelpHtml(sellTrade, realizedNetPnl) {
  if (!sellTrade || !(realizedNetPnl < 0)) return '';
  const absLoss = Math.abs(realizedNetPnl);
  const qty = sellTrade.qty;
  const ref = refPriceForCode(sellTrade.code);
  const secType = sellTrade.secType || guessSecType(sellTrade.code);
  const r = matchResult.sells.get(sellTrade.id) || fullMatchResult.sells.get(sellTrade.id);
  const pairHint = r && r.pairs && r.pairs.length
    ? `配对买价 ${r.pairs.map((p) => fmt(p.buyPrice, 3)).join('/')}`
    : '';
  const quoteRow = `<div class="ref-quote-row">${refQuoteInputHtml(sellTrade.code)}</div>`;
  if (!(ref.price > 0)) {
    return `<div class="decision-card decision-card-be">
      <div class="decision-title"><span class="be-badge">扳本</span> 卖亏回本参考（估算）</div>
      <div>已实现亏损 <span class="c-down">${fmtSign(-absLoss)}</span>${pairHint ? ' · ' + pairHint : ''}</div>
      ${quoteRow}
      <div class="hint">填入最新价后，可估算「再买后要卖到多少才回本」</div>
    </div>`;
  }
  const be = estimateBreakevenSellPrice(absLoss, qty, ref.price, secType);
  if (be == null) return '';
  return `<div class="decision-card decision-card-be">
    <div class="decision-title"><span class="be-badge">扳本</span> 卖亏回本参考（估算）</div>
    <div>已实现亏损 <span class="c-down">${fmtSign(-absLoss)}</span>${pairHint ? ' · ' + pairHint : ''}</div>
    ${quoteRow}
    <div>若按最新价 <b>${fmt(ref.price, 3)}</b> 再买 ${fmt(qty, 0)} 股，
      卖到约 <b class="c-up">${fmt(be, 3)}</b> 以上可弥补上次亏损</div>
    <div class="hint">费用按当前费率估算；改最新价后全页联动刷新</div>
  </div>`;
}

/** 手填最新价（优先于账单价）；改价后全页相关试算一起更新 */
let quoteRefreshTimer = null;
function setRefQuote(code, raw, opts) {
  const v = parseFloat(raw);
  if (raw === '' || raw == null || isNaN(v) || v <= 0) {
    delete Store.settings.quotes[code];
  } else {
    Store.settings.quotes[code] = v;
  }
  Store.save();
  const active = document.activeElement;
  const keepCode = active && active.classList && active.classList.contains('ref-quote-input')
    ? active.dataset.code : null;
  const sel = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const run = () => {
    renderAll();
    if (!keepCode) return;
    const el = $('.ref-quote-input[data-code="' + keepCode + '"]');
    if (!el) return;
    el.focus();
    if (sel != null) {
      try { el.setSelectionRange(sel, sel); } catch (e) { /* ignore */ }
    }
  };
  if (opts && opts.immediate) {
    clearTimeout(quoteRefreshTimer);
    run();
    return;
  }
  clearTimeout(quoteRefreshTimer);
  quoteRefreshTimer = setTimeout(run, 180);
}

function refQuoteInputHtml(code) {
  const ref = refPriceForCode(code);
  const manual = Number(Store.settings.quotes[code]);
  const shown = manual > 0 ? manual : (ref.price > 0 ? ref.price : '');
  const src = manual > 0 ? '手填优先' : (ref.source === 'statement' ? '账单价可改' : (ref.source === 'trade' ? '最近成交可改' : '填最新价'));
  return `<label class="ref-quote-edit">最新价
    <input class="ref-quote-input" type="number" step="0.001" min="0" data-code="${esc(code)}"
      value="${shown === '' ? '' : shown}" placeholder="输入实时价">
    <span class="ref-quote-src">${src}</span>
  </label>`;
}

function bindRefQuoteInputs(root) {
  $$('.ref-quote-input', root || document).forEach((inp) => {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => setRefQuote(inp.dataset.code, inp.value));
    inp.addEventListener('change', () => setRefQuote(inp.dataset.code, inp.value, { immediate: true }));
  });
}

function coverSecType(code, list) {
  if (list && list[0] && list[0].secType) return list[0].secType;
  const t = Store.trades.find((x) => x.code === code);
  return (t && t.secType) || guessSecType(code);
}

function lossSellsForBreakeven() {
  const out = [];
  for (const t of Store.trades) {
    if (t.side !== 'sell') continue;
    const r = fullMatchResult.sells.get(t.id);
    if (r && r.matchedQty > 0 && r.netPnl < 0 && !r.isReverse) out.push(t);
  }
  out.sort((a, b) => tradeTimeKey(b).localeCompare(tradeTimeKey(a)));
  return out;
}

function countBreakevenItems() {
  return lossSellsForBreakeven().length + ((Store.settings.watchPrices || []).length);
}

function syncLedgerPanelUI() {
  const panel = currentLedgerPanel();
  $$('#ledgerPanelSeg button').forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
  const covers = pendingCoversForView();
  const coverN = covers.length;
  const beN = countBreakevenItems();
  // 待做T 数量在 renderLedger 里再写角标（依赖分组）
  const cEl = $('#panelCountCovers');
  if (cEl) cEl.textContent = coverN ? String(coverN) : '';
  const bEl = $('#panelCountBreakeven');
  if (bEl) bEl.textContent = beN ? String(beN) : '';

  const toolbar = $('#ledgerToolbarLots');
  const coverBox = $('#coverList');
  const beBox = $('#breakevenList');
  const lotBox = $('#ledgerList');
  if (toolbar) toolbar.hidden = panel !== 'lots';
  if (coverBox) coverBox.hidden = panel !== 'covers';
  if (beBox) beBox.hidden = panel !== 'breakeven';
  if (lotBox) lotBox.hidden = panel !== 'lots';
}

function renderCoverPanel() {
  const coverBox = $('#coverList');
  if (!coverBox) return;
  const asOf = (Store.account && Store.account.asOf) || '';
  const covers = pendingCoversForView();
  const timeNote = currentMatchMode() !== 'time'
    ? `<div class="hint cover-mode-note">本页按时间核销计算（与上方「价格匹配」主列表口径可不同）</div>`
    : '';

  if (!covers.length) {
    coverBox.innerHTML = `<div class="section-label">待回补（倒T·先卖后买）</div>
      ${timeNote}
      <div class="hint">当前没有待回补。整体持仓统计全历史；做T时间则从起始日起。有先卖未买回会出现在这里。</div>`;
    return;
  }

  const byCode = new Map();
  for (const c of covers) {
    if (!byCode.has(c.code)) byCode.set(c.code, []);
    byCode.get(c.code).push(c);
  }
  const codes = Array.from(byCode.keys()).sort();
  coverBox.innerHTML = `<div class="section-label">待回补（倒T·先卖后买）· ${covers.length} 笔${asOf ? ' · 账单截至 ' + esc(asOf) : ''}</div>
    ${timeNote}
    <div class="hint" style="margin-bottom:8px">每只标的一张卡；改「最新价」后倒T预估会全页更新。</div>` +
    codes.map((code, idx) => {
      const list = byCode.get(code);
      const ref = refPriceForCode(code);
      const secType = coverSecType(code, list);
      const typeCls = 'group-' + (secType || 'stock');
      const altCls = 'group-i' + (idx % 2);
      const baseTip = (codeHasBaseLots(code) || codeHasRemainingLongs(code))
        ? `<div class="cover-base-tip">窗口内无多头可配；你可能还有底仓/剩余多头，见整体持仓</div>`
        : `<div class="cover-base-tip">窗口内无多头可配（先卖腿）</div>`;
      return `<div class="group cover-card ${altCls} ${typeCls}" data-code="${esc(code)}">
        <div class="group-head cover-card-head">
          <div class="group-head-top">
            <span class="g-name">${esc(displayName(code))}</span>
            <span class="g-code">${esc(code)}</span>
            <span class="badge">${SEC_TYPE_LABEL[secType] || '股票'}</span>
            <div class="g-meta">${list.length}笔待回补</div>
          </div>
          <div class="group-quote cover-quote-bar">
            ${refQuoteInputHtml(code)}
          </div>
          ${baseTip}
        </div>
        <div class="cover-card-body">
        ${list.map((c) => {
          const est = ref.price > 0 ? estimateCoverAtRef(c, ref.price) : null;
          let advice = '';
          let adviceCls = 'cover-advice';
          if (!est) {
            advice = '请在上方填写最新价，查看倒T预估';
            adviceCls += ' cover-advice-muted';
          } else if (ref.price < c.price) {
            advice = `可考虑回补 · 按最新价回补预估倒T净利 ${fmtSign(est.net)}（毛利 ${fmtSign(est.gross)}，已扣费估算）`;
            adviceCls += ' cover-advice-ok';
          } else {
            advice = `不宜回补 · 按最新价回补预估倒T净利 ${fmtSign(est.net)}`;
            adviceCls += ' cover-advice-bad';
          }
          return `<div class="cover-row decision-row">
            <span class="tag tag-warn">待回补</span>
            <span class="lot-price">回补上限 ${fmt(c.price, 3)}</span>
            <span class="lot-qty">${fmt(c.qty, 0)}股</span>
            <span class="lot-date">${esc(c.date)} ${esc(c.time || '')}</span>
            <div class="hint-inline">买回须低于上限才倒T盈利（费用另计）</div>
            <div class="${adviceCls}">${advice}</div>
          </div>`;
        }).join('')}
        </div>
      </div>`;
    }).join('');
  bindRefQuoteInputs(coverBox);
}

function renderBreakevenPanel() {
  const beBox = $('#breakevenList');
  if (!beBox) return;
  const losses = lossSellsForBreakeven();
  const watches = Store.settings.watchPrices || [];

  if (!losses.length && !watches.length) {
    beBox.innerHTML = `<div class="section-label">待扳本</div>
      <div class="hint">暂无已配对亏损卖出，也没有钉住的关注价。卖出页亏损单上的「扳本」可钉到这里。</div>`;
    return;
  }

  const byCode = new Map();
  for (const sell of losses) {
    if (!byCode.has(sell.code)) byCode.set(sell.code, { sells: [], watches: [] });
    byCode.get(sell.code).sells.push(sell);
  }
  for (const w of watches) {
    if (!byCode.has(w.code)) byCode.set(w.code, { sells: [], watches: [] });
    byCode.get(w.code).watches.push(w);
  }
  const codes = Array.from(byCode.keys()).sort();

  beBox.innerHTML = `<div class="section-label">待扳本 · 亏损 ${losses.length} 笔${watches.length ? ' · 关注价 ' + watches.length : ''}</div>
    <div class="hint" style="margin-bottom:8px">按标的分卡；亏损卖出的扳本决策 + 已钉关注价。改最新价会联动更新。</div>` +
    codes.map((code, idx) => {
      const g = byCode.get(code);
      const secType = coverSecType(code, null);
      const typeCls = 'group-' + (secType || 'stock');
      const altCls = 'group-i' + (idx % 2);
      const sellHtml = g.sells.map((sell) => {
        const r = fullMatchResult.sells.get(sell.id);
        const net = r ? r.netPnl : 0;
        return `<div class="watch-row decision-row be-loss-row">
          <span class="tag tag-loss">卖亏</span>
          <span class="lot-price">${fmt(sell.price, 3)}</span>
          <span class="lot-qty">${fmt(sell.qty, 0)}股</span>
          <span class="lot-date">${esc(sell.date)} ${esc(sell.time || '')}</span>
          <span class="lot-pnl ${pnlClass(net)}">${fmtSign(net)}</span>
          ${breakevenHelpHtml(sell, net)}
        </div>`;
      }).join('');
      const watchHtml = g.watches.map((w) => {
        const sell = Store.trades.find((t) => t.id === w.fromSellId);
        const r = (sell && fullMatchResult.sells.get(sell.id)) || null;
        const net = r && r.matchedQty > 0 ? r.netPnl : (w.netPnl != null ? w.netPnl : null);
        const beHtml = sell && net < 0 ? breakevenHelpHtml(sell, net) : '';
        const ref = refPriceForCode(w.code);
        const tip = ref.price > 0
          ? (ref.price < w.price
            ? `<span class="cover-advice-ok">最新价 ${fmt(ref.price, 3)} 低于关注卖价</span>`
            : `<span class="cover-advice-bad">最新价 ${fmt(ref.price, 3)} 已不低于关注卖价</span>`)
          : '';
        return `<div class="watch-row" data-id="${esc(w.id)}">
          <span class="tag tag-loss">关注卖价</span>
          <span class="lot-price">${fmt(w.price, 3)}</span>
          <span class="lot-date">${esc(w.date || '')}</span>
          ${tip}
          <button type="button" class="btn btn-mini" data-act="del-watch" data-id="${esc(w.id)}">移除</button>
          ${beHtml}
        </div>`;
      }).join('');
      return `<div class="group cover-card watch-card ${altCls} ${typeCls}" data-code="${esc(code)}">
        <div class="group-head cover-card-head">
          <div class="group-head-top">
            <span class="g-name">${esc(displayName(code))}</span>
            <span class="g-code">${esc(code)}</span>
            <span class="badge">${SEC_TYPE_LABEL[secType] || '股票'}</span>
            <div class="g-meta">${g.sells.length}笔亏损${g.watches.length ? ' · ' + g.watches.length + '关注' : ''}</div>
          </div>
          <div class="group-quote cover-quote-bar">${refQuoteInputHtml(code)}</div>
        </div>
        <div class="cover-card-body">
          ${sellHtml}${watchHtml}
        </div>
      </div>`;
    }).join('');

  $$('#breakevenList [data-act="del-watch"]').forEach((b) => {
    b.addEventListener('click', () => {
      Store.settings.watchPrices = (Store.settings.watchPrices || []).filter((x) => x.id !== b.dataset.id);
      Store.save();
      renderAll();
    });
  });
  bindRefQuoteInputs(beBox);
}

function renderCoverAndWatch() {
  const helpBox = $('#matchHelpBox');
  const panel = currentLedgerPanel();
  if (helpBox) {
    if (panel === 'covers' || panel === 'breakeven') {
      helpBox.hidden = false;
      helpBox.innerHTML = `<details class="match-help">
        <summary>待回补 / 扳本怎么区分？</summary>
        <ul>
          <li><b>待回补</b>：先卖、当时没有可配多头，等买回（倒T）。看回补上限与预估倒T净利。</li>
          <li><b>卖亏扳本</b>：已经配对亏损的卖出。本页「待扳本」可直接看，也可钉关注价。</li>
          <li>两者不是同一张账；可以都看，但分开算。</li>
        </ul>
      </details>`;
    } else {
      helpBox.hidden = true;
      helpBox.innerHTML = '';
    }
  }
  syncLedgerPanelUI();
  if (panel === 'covers') renderCoverPanel();
  else if (panel === 'breakeven') renderBreakevenPanel();
}

function bindGroupToggle(listSel, openSet) {
  $$(listSel + ' .group-head').forEach((head) => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, input, a, label')) return;
      const group = head.closest('.group');
      const code = group.dataset.code;
      group.classList.toggle('open');
      if (group.classList.contains('open')) openSet.add(code); else openSet.delete(code);
    });
  });
}

/* ---------- 标签页切换 ---------- */
const VIEW_TITLES = { ledger: '买入成本台账', sells: '卖出记录', stats: '盈亏战绩', mine: '数据与设置' };

$$('.tabbar .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabbar .tab').forEach((b) => b.classList.toggle('active', b === btn));
    const v = btn.dataset.view;
    $$('.view').forEach((sec) => { sec.hidden = sec.id !== 'view-' + v; });
    $('#topTitle').textContent = VIEW_TITLES[v];
    renderAll();
    window.scrollTo(0, 0);
  });
});

/* ---------- 台账 ---------- */
function syncLedgerModeUI() {
  const mode = Store.settings.ledgerMode || 'full';
  $$('#ledgerModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const controls = $('#tWindowControls');
  if (controls) controls.hidden = mode !== 'tWindow';
  if (mode !== 'tWindow') return;

  const preset = Store.settings.tWindowPreset || 'd5';
  $$('#tWindowPresetSeg button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  const fromDate = resolveTFromDate(Store.settings);
  const dateInput = $('#tFromDateInput');
  if (dateInput && dateInput.value !== fromDate) dateInput.value = fromDate;
  const dateRow = $('#tFromDateRow');
  if (dateRow) dateRow.style.opacity = preset === 'custom' ? '1' : '0.85';

  const u = Store.settings.unprofitableDisplay || 'tWindow';
  $$('#unprofitableSeg button').forEach((b) => b.classList.toggle('active', b.dataset.u === u));

  const hint = $('#tWindowHint');
  if (hint) {
    hint.textContent = '做T起始日 ' + fromDate + '（此前为底仓，不参与配对/默认不显示）。未盈利=该标的历史累计做T净利≤0。';
  }
}

function matchForCode(code) {
  return showFullLotsForCode(code) ? fullMatchResult : matchResult;
}

function renderLedger() {
  syncLedgerModeUI();
  renderCoverAndWatch();
  const showHidden = !!Store.settings.showHiddenLots;
  const tMode = isTWindowMode();
  const fromDate = tMode ? resolveTFromDate(Store.settings) : '';
  const groups = new Map();
  let hiddenCount = 0;
  for (const t of Store.trades) {
    if (t.side !== 'buy') continue;
    const mr = matchForCode(t.code);
    const lot = mr.lots.get(t.id);
    if (!lot || lot.remainingQty <= 0) continue;
    if (tMode && !showFullLotsForCode(t.code)) {
      if (lot.isBase || t.date < fromDate) continue;
    }
    if (t.tHidden) {
      hiddenCount++;
      if (!showHidden) continue;
    }
    if (!groups.has(t.code)) groups.set(t.code, []);
    groups.get(t.code).push({ trade: t, remainingQty: lot.remainingQty });
  }

  let totalLots = 0;
  for (const arr of groups.values()) totalLots += arr.length;
  const lotsCountEl = $('#panelCountLots');
  if (lotsCountEl) lotsCountEl.textContent = totalLots ? String(totalLots) : '';
  const ap = accountPnl();
  const modeLabel = tMode ? '做T时间' : '整体持仓';
  $('#ledgerSummary').innerHTML = `
    <div class="sum-item"><div class="v ${pnlClass(ap.total)}">${fmtSign(ap.total)}</div><div class="k">账户总盈亏</div></div>
    <div class="sum-item"><div class="v">${groups.size}</div><div class="k">持仓标的</div></div>
    <div class="sum-item"><div class="v">${totalLots}${hiddenCount && !showHidden ? `<span style="font-size:11px;font-weight:500;color:var(--text2)">/${hiddenCount}隐</span>` : ''}</div><div class="k">待做T·${modeLabel}</div></div>`;

  const showHiddenEl = $('#showHiddenLots');
  if (showHiddenEl) showHiddenEl.checked = showHidden;

  $$('#lotSortSeg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === Store.settings.lotSort));

  const box = $('#ledgerList');
  if (currentLedgerPanel() !== 'lots') {
    // 子页非待做T时仍算好角标，列表由 syncLedgerPanelUI 隐藏
    return;
  }
  if (!groups.size) {
    box.innerHTML = hiddenCount && !showHidden
      ? `<div class="empty">待做T买单都已隐藏（${hiddenCount}笔）<br>打开上方「显示已隐藏」可查看或取消隐藏</div>`
      : (tMode
        ? `<div class="empty">做T时间（自 ${esc(fromDate)}）内暂无待做T买单<br>可切换「整体持仓」，或放宽时间 / 将未盈利标的设为「看整体」</div>`
        : '<div class="empty">暂无待做T买单<br>去"我的"页导入交割单或手动录入</div>');
    return;
  }

  const dir = Store.settings.lotSort === 'desc' ? -1 : 1;
  const html = [];
  const codes = Array.from(groups.keys()).sort();
  codes.forEach((code, idx) => {
    const arr = groups.get(code).sort((a, b) => (a.trade.price - b.trade.price) * dir);
    const st = codeStats(code, matchForCode(code));
    const open = uiOpen.ledger.has(code) ? ' open' : '';
    const floatText = st.floatPnl == null ? '--' : fmtSign(st.floatPnl);
    const floatCls = st.floatPnl == null ? '' : pnlClass(st.floatPnl);
    const hiddenInGroup = arr.filter((x) => x.trade.tHidden).length;
    const unprofTag = tMode && isUnprofitableCode(code)
      ? (showFullLotsForCode(code) ? ' · 未盈利看整体' : ' · 未盈利')
      : '';
    const typeCls = 'group-' + (st.secType || 'stock');
    const altCls = 'group-i' + (idx % 2);

    html.push(`<div class="group ${altCls} ${typeCls}${open}" data-code="${esc(code)}">
      <div class="group-head">
        <div class="group-head-top">
          <span class="chev">▶</span>
          <span class="g-name">${esc(displayName(code))}</span>
          <span class="g-code">${esc(code)}</span>
          <button class="badge" data-act="cycle-type" data-code="${esc(code)}">${SEC_TYPE_LABEL[st.secType] || '股票'}</button>
          <div class="g-meta">${arr.length}笔待做T${hiddenInGroup ? `（隐${hiddenInGroup}）` : ''}${unprofTag}<br>点开查看明细</div>
        </div>
        <div class="group-stats">
          <div class="gs"><div class="v">${fmt(st.holdQty, 0)}</div><div class="k">持仓总量</div></div>
          <div class="gs"><div class="v">${st.avgCost ? fmt(st.avgCost, 3) : '--'}</div><div class="k">成本价</div></div>
          <div class="gs"><div class="v float-v ${floatCls}" data-code="${esc(code)}">${floatText}</div><div class="k">目前盈亏</div></div>
        </div>
        <div class="group-stats" style="border-top:0;padding-top:0;margin-top:6px">
          <div class="gs"><div class="v c-up">${fmtSign(st.winSum)}</div><div class="k">做T盈利合计</div></div>
          <div class="gs"><div class="v c-down">${fmtSign(st.lossSum)}</div><div class="k">做T亏损合计</div></div>
          <div class="gs"><div class="v ${pnlClass(st.realized)}">${fmtSign(st.realized)}</div><div class="k">做T净利</div></div>
        </div>
        <div class="group-quote">
          <label>最新价</label>
          <input class="quote-input ref-quote-input" type="number" step="0.001" min="0" data-code="${esc(code)}" value="${st.quote || ''}" placeholder="输入实时价">
          <span class="hint-inline">成功${st.win}笔 · 亏损${st.loss}笔 · 改价全页联动</span>
        </div>
      </div>
      <div class="group-body">
        ${arr.map(({ trade, remainingQty }) => renderLot(trade, remainingQty)).join('')}
      </div>
    </div>`);
  });
  box.innerHTML = html.join('');

  bindGroupToggle('#ledgerList', uiOpen.ledger);

  $$('#ledgerList .est-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.id;
      const price = parseFloat(inp.value) || null;
      Store.updateTrade(id, { estSell: price });
      const t = Store.trades.find((x) => x.id === id);
      const lot = matchForCode(t.code).lots.get(id);
      updateEstOut(inp.closest('.lot-est'), t, lot ? lot.remainingQty : 0);
    });
  });
  $$('#ledgerList .quote-input').forEach((inp) => {
    inp.addEventListener('click', (e) => e.stopPropagation());
  });
  bindRefQuoteInputs($('#ledgerList'));
  $$('#ledgerList [data-act="cycle-type"]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); cycleSecType(b.dataset.code); });
  });
  $$('#ledgerList [data-act="del-trade"]').forEach((b) => {
    b.addEventListener('click', () => deleteTrade(b.dataset.id));
  });
  $$('#ledgerList [data-act="toggle-hide"]').forEach((b) => {
    b.addEventListener('click', () => toggleLotHidden(b.dataset.id));
  });
}

function renderLot(t, remainingQty) {
  const partly = remainingQty < t.qty ? `（原${fmt(t.qty, 0)}股，已配对${fmt(t.qty - remainingQty, 0)}）` : '';
  const hidden = !!t.tHidden;
  return `<div class="lot${hidden ? ' lot-hidden' : ''}">
    <div class="lot-top">
      <span class="lot-price">${fmt(t.price, 3)}</span>
      <span class="lot-qty">${fmt(remainingQty, 0)}股${partly}</span>
      <span class="lot-date">${esc(t.date)} ${esc(t.time || '')}</span>
    </div>
    <div class="lot-fees">买入费用：${feeText(t.fees)}${t.feeSource === 'statement' ? '（交割单）' : '（按费率估算）'}</div>
    <div class="lot-est">
      <label>预估卖价</label>
      <input class="est-input" type="number" step="0.001" min="0" data-id="${t.id}" value="${t.estSell || ''}" placeholder="输入卖价">
      <div class="est-out"></div>
    </div>
    <div class="lot-actions">
      <button class="btn btn-mini btn-hide" data-act="toggle-hide" data-id="${t.id}">${hidden ? '取消隐藏' : '已做T隐藏'}</button>
      <button class="btn btn-mini" data-act="del-trade" data-id="${t.id}">删除此笔</button>
    </div>
  </div>`;
}

function toggleLotHidden(id) {
  const t = Store.trades.find((x) => x.id === id);
  if (!t || t.side !== 'buy') return;
  Store.updateTrade(id, { tHidden: !t.tHidden });
  renderLedger();
  $$('#ledgerList .est-input').forEach((inp) => {
    const tr = Store.trades.find((x) => x.id === inp.dataset.id);
    const lot = tr ? matchForCode(tr.code).lots.get(inp.dataset.id) : null;
    if (tr && lot) updateEstOut(inp.closest('.lot-est'), tr, lot.remainingQty);
  });
}

function updateEstOut(estBox, t, remainingQty) {
  const out = $('.est-out', estBox);
  const est = estimateLotProfit(t, remainingQty, t.estSell, Store.settings.feeRules);
  if (!est) { out.innerHTML = '<div class="detail">输入卖价试算利润</div>'; return; }
  out.innerHTML = `
    <div class="net ${pnlClass(est.net)}">${fmtSign(est.net)}</div>
    <div class="detail">价差${fmtSign(est.gross)} 卖费${fmt(est.sellFee)} 买费摊${fmt(est.buyFeeShare)}</div>`;
}

function cycleSecType(code) {
  const order = ['stock', 'etf', 'bond'];
  const cur = (Store.trades.find((t) => t.code === code) || {}).secType || 'stock';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  Store.setSecType(code, next);
  recompute();
  renderAll();
}

function deleteTrade(id) {
  const t = Store.trades.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`删除这笔${t.side === 'buy' ? '买入' : '卖出'}？\n${t.code} ${t.date} ${fmt(t.price, 3)}×${t.qty}`)) return;
  Store.removeTrade(id);
  recompute();
  renderAll();
}

/* ---------- 卖出记录 ---------- */
function renderSells() {
  const filter = Store.settings.sellFilter;
  $$('#sellFilterSeg button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));

  const all = Store.trades
    .filter((t) => t.side === 'sell')
    .sort((a, b) => tradeTimeKey(b).localeCompare(tradeTimeKey(a)));

  const ap = accountPnl();
  let windowNet = 0, windowWin = 0, windowLoss = 0;
  for (const s of all) {
    const r = matchResult.sells.get(s.id);
    if (!r || r.matchedQty === 0) continue;
    windowNet += r.netPnl;
    if (r.netPnl > 0) windowWin += r.netPnl; else windowLoss += r.netPnl;
  }
  windowNet = round2(windowNet);
  windowWin = round2(windowWin);
  windowLoss = round2(windowLoss);

  const tMode = isTWindowMode();
  const fromDate = tMode ? resolveTFromDate(Store.settings) : '';
  $('#sellSummary').innerHTML = tMode ? `
    <div class="sum-item"><div class="v ${pnlClass(windowNet)}">${fmtSign(windowNet)}</div><div class="k">做T时间净利(自${esc(fromDate)})</div></div>
    <div class="sum-item"><div class="v c-up">${fmtSign(windowWin)}</div><div class="k">盈利合计</div></div>
    <div class="sum-item"><div class="v c-down">${fmtSign(windowLoss)}</div><div class="k">亏损合计</div></div>` : `
    <div class="sum-item"><div class="v ${pnlClass(ap.realized)}">${fmtSign(ap.realized)}</div><div class="k">做T已实现净利</div></div>
    <div class="sum-item"><div class="v c-up">${fmtSign(ap.realizedWin)}</div><div class="k">盈利合计</div></div>
    <div class="sum-item"><div class="v c-down">${fmtSign(ap.realizedLoss)}</div><div class="k">亏损合计</div></div>`;

  const shown = all.filter((s) => {
    if (tMode && s.date < fromDate) return false;
    const r = matchResult.sells.get(s.id);
    if (!r || r.matchedQty === 0) return filter === 'all';
    if (filter === 'win') return r.success;
    if (filter === 'loss') return !r.success;
    return true;
  });

  const box = $('#sellList');
  if (!shown.length) {
    box.innerHTML = `<div class="empty">${filter === 'loss' ? '没有亏损卖出，干得漂亮！' : '暂无记录'}</div>`;
    return;
  }

  const byCode = new Map();
  for (const s of shown) {
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s);
  }

  const html = [];
  const codes = Array.from(byCode.keys()).sort();
  codes.forEach((code, idx) => {
    const list = byCode.get(code);
    const st = codeStats(code, matchForCode(code));
    const open = uiOpen.sells.has(code) ? ' open' : '';
    const filterLabel = filter === 'win' ? '做T成功' : filter === 'loss' ? '亏损卖出' : '卖出';
    const typeCls = 'group-' + (st.secType || 'stock');
    const altCls = 'group-i' + (idx % 2);

    html.push(`<div class="group ${altCls} ${typeCls}${open}" data-code="${esc(code)}">
      <div class="group-head">
        <div class="group-head-top">
          <span class="chev">▶</span>
          <span class="g-name">${esc(displayName(code))}</span>
          <span class="g-code">${esc(code)}</span>
          <div class="g-meta">${list.length}笔${filterLabel}<br>点开查看明细</div>
        </div>
        <div class="group-stats">
          <div class="gs"><div class="v">${fmt(st.holdQty, 0)}</div><div class="k">持仓总量</div></div>
          <div class="gs"><div class="v">${st.avgCost ? fmt(st.avgCost, 3) : '--'}</div><div class="k">成本价</div></div>
          <div class="gs"><div class="v ${st.floatPnl == null ? '' : pnlClass(st.floatPnl)}">${st.floatPnl == null ? '--' : fmtSign(st.floatPnl)}</div><div class="k">目前盈亏</div></div>
        </div>
        <div class="group-stats" style="border-top:0;padding-top:0;margin-top:6px">
          <div class="gs"><div class="v c-up">${fmtSign(st.winSum)}</div><div class="k">做T盈利合计</div></div>
          <div class="gs"><div class="v c-down">${fmtSign(st.lossSum)}</div><div class="k">做T亏损合计</div></div>
          <div class="gs"><div class="v ${pnlClass(st.realized)}">${fmtSign(st.realized)}</div><div class="k">做T净利</div></div>
        </div>
      </div>
      <div class="group-body">
        ${list.map((s) => renderSellCard(s)).join('')}
      </div>
    </div>`);
  });
  box.innerHTML = html.join('');

  bindGroupToggle('#sellList', uiOpen.sells);
  $$('#sellList [data-act="del-trade"]').forEach((b) => {
    b.addEventListener('click', () => deleteTrade(b.dataset.id));
  });
  $$('#sellList [data-act="pin-watch"]').forEach((b) => {
    b.addEventListener('click', () => pinWatchFromSell(b.dataset.id));
  });
  bindRefQuoteInputs($('#sellList'));
}

function pinWatchFromSell(sellId) {
  const s = Store.trades.find((t) => t.id === sellId);
  if (!s) return;
  const list = Store.settings.watchPrices || [];
  if (list.some((w) => w.fromSellId === sellId)) {
    Store.settings.watchPrices = list.filter((w) => w.fromSellId !== sellId);
  } else {
    const r = matchResult.sells.get(s.id) || fullMatchResult.sells.get(s.id);
    list.push({
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      code: s.code,
      price: s.price,
      date: s.date,
      fromSellId: s.id,
      netPnl: r && r.matchedQty > 0 ? r.netPnl : null,
    });
    Store.settings.watchPrices = list;
  }
  Store.save();
  renderSells();
  renderCoverAndWatch();
}

function renderSellCard(s) {
  const r = matchResult.sells.get(s.id) || {
    pairs: [], matchedQty: 0, unmatchedQty: s.qty, netPnl: 0, sellFee: 0, buyFeeShare: 0, success: false,
  };
  let tag;
  if (r.matchedQty === 0 && r.unmatchedQty > 0) {
    tag = currentMatchMode() === 'time'
      ? '<span class="tag tag-warn">待回补</span>'
      : '<span class="tag tag-warn">无买单可配</span>';
  } else if (r.isReverse && r.matchedQty > 0) {
    tag = r.success
      ? '<span class="tag tag-win">倒T成功</span>'
      : '<span class="tag tag-loss">倒T亏损</span>';
  } else if (r.matchedQty === 0) {
    tag = '<span class="tag tag-warn">无买单可配</span>';
  } else {
    tag = r.success ? '<span class="tag tag-win">做T成功</span>' : '<span class="tag tag-loss">亏损卖出</span>';
  }
  const unmatched = r.unmatchedQty > 0 && r.matchedQty > 0
    ? `<span class="tag tag-warn">${fmt(r.unmatchedQty, 0)}股待回补/未配</span>` : '';
  const watched = (Store.settings.watchPrices || []).some((w) => w.fromSellId === s.id);
  const pinBtn = (!r.success && r.matchedQty > 0) || (r.matchedQty === 0)
    ? `<button type="button" class="btn btn-mini btn-hide" data-act="pin-watch" data-id="${s.id}">${watched ? '已钉关注价' : '钉扳本关注价'}</button>`
    : '';
  const beHtml = r.matchedQty > 0 && r.netPnl < 0 && !r.isReverse
    ? breakevenHelpHtml(s, r.netPnl)
    : '';

  return `<div class="sell-card">
    <div class="sell-head">
      ${tag}${unmatched}
      <span class="s-date">${esc(s.date)} ${esc(s.time || '')}</span>
    </div>
    <div class="sell-main">
      <span class="s-price">卖 ${fmt(s.price, 3)}</span>
      <span class="lot-qty">× ${fmt(s.qty, 0)}股</span>
      <span class="s-net ${pnlClass(r.netPnl)}">${r.matchedQty ? fmtSign(r.netPnl) : '--'}</span>
    </div>
    ${r.pairs.length ? `<div class="pairs">${r.pairs.map((p) => `
      <div class="pair-row">
        <span>${p.kind === 'cover' ? '回补买入' : '配对买单'} ${fmt(p.buyPrice, 3)} × ${fmt(p.qty, 0)}股（${esc(p.buyDate)}）</span>
        <span class="p-pnl ${pnlClass((s.price - p.buyPrice) * p.qty)}">${fmtSign(round2((s.price - p.buyPrice) * p.qty))}</span>
      </div>`).join('')}</div>` : ''}
    <div class="sell-fees">卖出费用 ${feeText(s.fees)}，买入费用分摊 ${fmt(r.buyFeeShare)}</div>
    ${beHtml}
    <div class="lot-actions">
      ${pinBtn}
      <button class="btn btn-mini" data-act="del-trade" data-id="${s.id}">删除此笔</button>
    </div>
  </div>`;
}

$$('#sellFilterSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.sellFilter = b.dataset.filter;
    Store.save();
    renderSells();
  });
});
$$('#lotSortSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.lotSort = b.dataset.sort;
    Store.save();
    renderLedger();
  });
});

$$('#ledgerModeSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.ledgerMode = b.dataset.mode;
    Store.save();
    recompute();
    renderAll();
  });
});
$$('#tWindowPresetSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.tWindowPreset = b.dataset.preset;
    if (b.dataset.preset === 'custom' && !Store.settings.tFromDate) {
      Store.settings.tFromDate = todayISO();
    }
    Store.save();
    recompute();
    renderAll();
  });
});
$$('#unprofitableSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.unprofitableDisplay = b.dataset.u;
    Store.save();
    renderAll();
  });
});
$$('#matchModeSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.matchMode = b.dataset.mode;
    Store.save();
    recompute();
    renderAll();
    syncMatchModeUI();
  });
});
$$('#ledgerMatchModeSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.matchMode = b.dataset.mode;
    Store.save();
    recompute();
    renderAll();
    syncMatchModeUI();
  });
});
$$('#ledgerPanelSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    Store.settings.ledgerPanel = b.dataset.panel;
    Store.save();
    renderAll();
  });
});
function syncMatchModeUI() {
  const mode = currentMatchMode();
  $$('#matchModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('#ledgerMatchModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const hint = $('#matchModeHint');
  if (hint) {
    hint.textContent = mode === 'time'
      ? '当前：时间顺序。待回补见台账「待回补」子页；对照账单参考价判断是否可回补。默认可随时切回价格最相近。'
      : '当前：价格最相近（与 v1.0 稳定版习惯一致）。待回补仍可在台账「待回补」子页按时间核销查看。';
  }
  const ledgerHint = $('#ledgerMatchHint');
  if (ledgerHint) {
    ledgerHint.textContent = mode === 'time'
      ? '已开「时间+待回补」：卖出配对按时间顺序。待回补/待扳本用上方子页切换，不必堆在列表顶。'
      : '默认价格匹配。待回补请点「待回补」子页（本页按时间核销，与主列表可不同）。';
  }
}
const tFromDateInput = $('#tFromDateInput');
if (tFromDateInput) {
  tFromDateInput.addEventListener('change', () => {
    Store.settings.tFromDate = tFromDateInput.value || todayISO();
    Store.settings.tWindowPreset = 'custom';
    Store.save();
    recompute();
    renderAll();
  });
}

const showHiddenEl = $('#showHiddenLots');
if (showHiddenEl) {
  showHiddenEl.addEventListener('change', () => {
    Store.settings.showHiddenLots = !!showHiddenEl.checked;
    Store.save();
    renderLedger();
    $$('#ledgerList .est-input').forEach((inp) => {
      const tr = Store.trades.find((x) => x.id === inp.dataset.id);
      const lot = tr ? matchForCode(tr.code).lots.get(inp.dataset.id) : null;
      if (tr && lot) updateEstOut(inp.closest('.lot-est'), tr, lot.remainingQty);
    });
  });
}

/* ---------- 战绩 ---------- */
function renderStats() {
  const byDay = new Map();
  const byCode = new Map();
  let win = 0, loss = 0, feeSum = 0;
  const today = new Date().toISOString().slice(0, 10);
  let todayNet = 0;

  for (const t of Store.trades) feeSum += totalFees(t.fees);

  for (const s of Store.trades) {
    if (s.side !== 'sell') continue;
    const r = matchResult.sells.get(s.id);
    if (!r || r.matchedQty === 0) continue;
    r.success ? win++ : loss++;
    if (s.date === today) todayNet += r.netPnl;

    const d = byDay.get(s.date) || { win: 0, loss: 0, net: 0, winSum: 0, lossSum: 0 };
    if (r.success) { d.win++; d.winSum += r.netPnl; } else { d.loss++; d.lossSum += r.netPnl; }
    d.net += r.netPnl;
    byDay.set(s.date, d);

    const c = byCode.get(s.code) || { win: 0, loss: 0, net: 0, winSum: 0, lossSum: 0 };
    if (r.success) { c.win++; c.winSum += r.netPnl; } else { c.loss++; c.lossSum += r.netPnl; }
    c.net += r.netPnl;
    byCode.set(s.code, c);
  }

  const ap = accountPnl();
  const total = win + loss;
  const rate = total ? Math.round((win / total) * 100) : 0;
  const asOf = (Store.account && Store.account.asOf) || '';
  const tMode = isTWindowMode();
  const fromDate = tMode ? resolveTFromDate(Store.settings) : '';

  const dayRows = Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, v]) => `<tr><td>${esc(d)}</td><td class="c-up">${fmtSign(round2(v.winSum))}</td>
      <td class="c-down">${fmtSign(round2(v.lossSum))}</td>
      <td class="${pnlClass(v.net)}">${fmtSign(round2(v.net))}</td></tr>`).join('');
  const codeRows = Array.from(byCode.entries()).sort((a, b) => b[1].net - a[1].net)
    .map(([c, v]) => `<tr><td>${esc(displayName(c))}<br><span class="g-code">${esc(c)}</span></td>
      <td class="c-up">${fmtSign(round2(v.winSum))}</td><td class="c-down">${fmtSign(round2(v.lossSum))}</td>
      <td class="${pnlClass(v.net)}">${fmtSign(round2(v.net))}</td></tr>`).join('');

  $('#statsBody').innerHTML = `
    <div class="stats-hero">
      <div class="sum-item big"><div class="v ${pnlClass(ap.total)}">${fmtSign(ap.total)}</div>
        <div class="k">账户总盈亏 = 已实现 + 持仓浮动 + 股息利息${asOf ? '（数据截至 ' + asOf + '，不含今日）' : ''}（始终全历史）</div></div>
      ${tMode ? `<div class="sum-item big"><div class="v">${esc(fromDate)}</div>
        <div class="k">当前台账为「做T时间」口径：下方做T表按起始日起配对；切回「整体持仓」看全貌</div></div>` : ''}
      <div class="sum-item"><div class="v">${currentMatchMode() === 'time' ? '时间顺序' : '价格最相近'}</div>
        <div class="k">核销口径（在「我的」切换）</div></div>
      <div class="sum-item"><div class="v ${pnlClass(ap.realized)}">${fmtSign(ap.realized)}</div><div class="k">已实现(当前核销·全历史)</div></div>
      <div class="sum-item"><div class="v ${pnlClass(ap.floatPnl)}">${fmtSign(ap.floatPnl)}</div><div class="k">持仓浮动盈亏</div></div>
      <div class="sum-item"><div class="v c-up">${fmtSign(ap.realizedWin)}</div><div class="k">做T盈利合计</div></div>
      <div class="sum-item"><div class="v c-down">${fmtSign(ap.realizedLoss)}</div><div class="k">做T亏损合计</div></div>
      <div class="sum-item"><div class="v">${fmtSign(ap.dividends + ap.interest)}</div><div class="k">股息+利息</div></div>
      <div class="sum-item"><div class="v">${rate}%</div><div class="k">做T成功率${tMode ? '(时间窗)' : ''}</div></div>
      <div class="sum-item"><div class="v ${pnlClass(todayNet)}">${fmtSign(round2(todayNet))}</div><div class="k">今日做T(若有)</div></div>
      ${ap.assetStyle != null ? `<div class="sum-item big"><div class="v ${pnlClass(ap.assetStyle)}">${fmtSign(ap.assetStyle)}</div>
        <div class="k">对照：总资产 ${fmt(ap.totalAssets)} − 银证净入金 ${fmt(ap.netDeposit)}（部分券商APP用此口径）</div></div>` : ''}
    </div>
    ${total ? `
    <div class="card"><h2>按日做T（盈利/亏损金额）${tMode ? '·自 ' + esc(fromDate) : ''}</h2>
      <table class="stat-table"><tr><th>日期</th><th>盈利</th><th>亏损</th><th>净利</th></tr>${dayRows}</table>
    </div>
    <div class="card"><h2>按标的做T（盈利/亏损金额）${tMode ? '·自 ' + esc(fromDate) : ''}</h2>
      <table class="stat-table"><tr><th>标的</th><th>盈利</th><th>亏损</th><th>净利</th></tr>${codeRows}</table>
    </div>` : '<div class="empty">还没有已配对的卖出记录</div>'}`;
}

/* ---------- 我的：导入 ---------- */
let pendingImport = null;

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    pendingImport = parseWorkbook(buf);
    showImportModal();
  } catch (err) {
    console.error('解析文件失败', err);
    alert('解析文件失败：' + err.message);
  }
});

function showImportModal() {
  const { headers, rows, mapping } = pendingImport;
  const grid = $('#mappingGrid');
  grid.innerHTML = Object.keys(FIELD_LABELS).map((field) => `
    <label>${FIELD_LABELS[field]}${REQUIRED_FIELDS.includes(field) ? ' *' : ''}
      <select data-field="${field}">
        <option value="">（无）</option>
        ${headers.map((h, i) => `<option value="${i}" ${mapping[field] === i ? 'selected' : ''}>${esc(h || '列' + (i + 1))}</option>`).join('')}
      </select>
    </label>`).join('');
  $('#importPreview').innerHTML = `
    <p class="hint">共 ${rows.length} 行数据，预览前 5 行：</p>
    <table><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
    ${rows.slice(0, 5).map((r) => `<tr>${headers.map((_, i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`).join('')}</table>`;
  $('#importModal').hidden = false;
}

$('#btnCancelImport').addEventListener('click', () => {
  $('#importModal').hidden = true;
  pendingImport = null;
});

$('#btnConfirmImport').addEventListener('click', () => {
  const mapping = {};
  $$('#mappingGrid select').forEach((sel) => {
    if (sel.value !== '') mapping[sel.dataset.field] = Number(sel.value);
  });
  const missing = REQUIRED_FIELDS.filter((f) => mapping[f] == null);
  if (missing.length) {
    alert('缺少必填字段：' + missing.map((f) => FIELD_LABELS[f]).join('、'));
    return;
  }
  const { trades, skippedRows } = rowsToTrades(pendingImport.rows, mapping, Store.settings.feeRules);
  const { added, skipped } = Store.addTrades(trades);
  $('#importModal').hidden = true;
  pendingImport = null;
  recompute();
  renderAll();
  $('#importResult').textContent =
    `导入完成：新增 ${added} 笔，跳过重复 ${skipped} 笔` +
    (skippedRows ? `，忽略非成交行 ${skippedRows} 行` : '');
});

/* ---------- 我的：手动录入 ---------- */
$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const code = String(f.get('code')).trim().padStart(6, '0');
  const price = parseFloat(f.get('price'));
  const qty = parseInt(f.get('qty'), 10);
  const side = f.get('side');
  const secType = f.get('secType') || guessSecType(code);
  const amount = round2(price * qty);
  const trade = {
    date: f.get('date'),
    time: f.get('time') || '',
    code,
    name: String(f.get('name') || '').trim(),
    secType, side, price, qty, amount,
    fees: calcFees(secType, side, amount, Store.settings.feeRules),
    feeSource: 'computed',
    seqNo: '',
    estSell: null,
    source: 'manual',
  };
  const { added, skipped } = Store.addTrades([trade]);
  recompute();
  renderAll();
  alert(added ? '已保存' : '这笔记录已存在（重复），未保存' + (skipped ? '' : ''));
  if (added) e.target.reset();
});

/* ---------- 我的：费率设置 ---------- */
const FEE_FIELD_DEFS = [
  ['commissionRate', '佣金(万分之)', 10000],
  ['commissionMin', '佣金最低(元)', 1],
  ['transferRate', '过户费(万分之)', 10000],
  ['stampRate', '印花税卖出(万分之)', 10000],
];

function renderFeeRules() {
  const rules = Store.settings.feeRules;
  $('#feeRulesBox').innerHTML = Object.keys(SEC_TYPE_LABEL).map((type) => `
    <div class="fee-sec"><h3>${SEC_TYPE_LABEL[type]}</h3>
      <div class="fee-grid">
        ${FEE_FIELD_DEFS.map(([key, label, mul]) => `
          <label>${label}
            <input type="number" step="any" min="0" data-type="${type}" data-key="${key}" data-mul="${mul}"
              value="${round6(rules[type][key] * mul)}">
          </label>`).join('')}
      </div>
    </div>`).join('') +
    '<p class="hint">改费率只影响之后的估算；交割单里带的实际费用不受影响。</p>';

  $$('#feeRulesBox input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (isNaN(v) || v < 0) return;
      Store.settings.feeRules[inp.dataset.type][inp.dataset.key] = v / Number(inp.dataset.mul);
      Store.save();
      recompute();
    });
  });
}
function round6(v) { return Math.round(v * 1e6) / 1e6; }

/* ---------- 我的：备份 ---------- */
$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '做T台账备份_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#restoreInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('恢复备份会覆盖当前全部数据，确定吗？')) return;
  try {
    Store.importJSON(await file.text());
    recompute();
    renderAll();
    renderFeeRules();
    alert('恢复完成，共 ' + Store.trades.length + ' 笔记录');
  } catch (err) {
    console.error('恢复备份失败', err);
    alert('恢复失败：' + err.message);
  }
});

$('#btnClear').addEventListener('click', () => {
  if (!confirm('确定清空全部成交记录？此操作不可恢复，建议先导出备份。')) return;
  if (!confirm('再次确认：真的要清空吗？')) return;
  Store.clearAll();
  recompute();
  renderAll();
});

/* ---------- 总渲染 ---------- */
function renderAll() {
  syncMatchModeUI();
  renderLedger();
  // 台账渲染后填充各笔预计利润
  $$('#ledgerList .est-input').forEach((inp) => {
    const t = Store.trades.find((x) => x.id === inp.dataset.id);
    const lot = t ? matchForCode(t.code).lots.get(inp.dataset.id) : null;
    if (t && lot) updateEstOut(inp.closest('.lot-est'), t, lot.remainingQty);
  });
  renderSells();
  renderStats();
}

renderFeeRules();

(async function boot() {
  await ensureSeed();
  recompute();
  renderAll();
})();

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.error('ServiceWorker 注册失败（不影响使用，仅离线能力不可用）', err);
  });
}
