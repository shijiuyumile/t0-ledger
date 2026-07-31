/**
 * 界面渲染与交互入口。
 */
'use strict';

Store.load();

let matchResult = { lots: new Map(), sells: new Map() };

function recompute() {
  matchResult = computeMatches(Store.trades);
}

/** 首次打开且本地无数据时，自动拉取打包的历史对账单；已有成交但缺账户快照时补齐 */
async function ensureSeed() {
  try {
    if (Store.trades.length > 0 && Store.account) return;
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
      Store.save();
      console.log('已载入历史对账单', Store.trades.length, '笔');
    } else if (!Store.account && seed.account) {
      Store.data.account = seed.account;
      Store.save();
      console.log('已补齐账户快照');
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
function codeStats(code) {
  let buyQty = 0, sellQty = 0, sumQty = 0, sumCost = 0, sumFee = 0, lotCount = 0;
  let realized = 0, winSum = 0, lossSum = 0, win = 0, loss = 0;
  let secType = 'stock';

  for (const t of Store.trades) {
    if (t.code !== code) continue;
    secType = t.secType || secType;
    if (t.side === 'buy') {
      buyQty += t.qty;
      const lot = matchResult.lots.get(t.id);
      if (lot && lot.remainingQty > 0) {
        sumQty += lot.remainingQty;
        sumCost += t.price * lot.remainingQty;
        sumFee += totalFees(t.fees) * (lot.remainingQty / t.qty);
        lotCount++;
      }
    } else {
      sellQty += t.qty;
      const r = matchResult.sells.get(t.id);
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
  };
}

function accountPnl() {
  const acc = Store.account ? Object.assign({}, Store.account, { quotes: Store.settings.quotes }) : { holdings: [], quotes: Store.settings.quotes };
  return computeAccountPnl(Store.trades, matchResult, acc);
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
function renderLedger() {
  const groups = new Map();
  for (const t of Store.trades) {
    if (t.side !== 'buy') continue;
    const lot = matchResult.lots.get(t.id);
    if (!lot || lot.remainingQty <= 0) continue;
    if (!groups.has(t.code)) groups.set(t.code, []);
    groups.get(t.code).push({ trade: t, remainingQty: lot.remainingQty });
  }

  let totalCost = 0;
  let totalLots = 0;
  for (const arr of groups.values()) {
    for (const { trade, remainingQty } of arr) {
      totalCost += trade.price * remainingQty;
      totalLots++;
    }
  }
  const ap = accountPnl();
  $('#ledgerSummary').innerHTML = `
    <div class="sum-item"><div class="v ${pnlClass(ap.total)}">${fmtSign(ap.total)}</div><div class="k">账户总盈亏</div></div>
    <div class="sum-item"><div class="v">${groups.size}</div><div class="k">持仓标的</div></div>
    <div class="sum-item"><div class="v">${totalLots}</div><div class="k">待做T买单</div></div>`;

  $$('#lotSortSeg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === Store.settings.lotSort));

  const box = $('#ledgerList');
  if (!groups.size) {
    box.innerHTML = '<div class="empty">暂无待做T买单<br>去"我的"页导入交割单或手动录入</div>';
    return;
  }

  const dir = Store.settings.lotSort === 'desc' ? -1 : 1;
  const html = [];
  for (const code of Array.from(groups.keys()).sort()) {
    const arr = groups.get(code).sort((a, b) => (a.trade.price - b.trade.price) * dir);
    const st = codeStats(code);
    const open = uiOpen.ledger.has(code) ? ' open' : '';
    const floatText = st.floatPnl == null ? '--' : fmtSign(st.floatPnl);
    const floatCls = st.floatPnl == null ? '' : pnlClass(st.floatPnl);

    html.push(`<div class="group${open}" data-code="${esc(code)}">
      <div class="group-head">
        <div class="group-head-top">
          <span class="chev">▶</span>
          <span class="g-name">${esc(displayName(code))}</span>
          <span class="g-code">${esc(code)}</span>
          <button class="badge" data-act="cycle-type" data-code="${esc(code)}">${SEC_TYPE_LABEL[st.secType] || '股票'}</button>
          <div class="g-meta">${st.lotCount}笔待做T<br>点开查看明细</div>
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
          <label>现价</label>
          <input class="quote-input" type="number" step="0.001" min="0" data-code="${esc(code)}" value="${st.quote || ''}" placeholder="手填现价">
          <span class="hint-inline">成功${st.win}笔 · 亏损${st.loss}笔</span>
        </div>
      </div>
      <div class="group-body">
        ${arr.map(({ trade, remainingQty }) => renderLot(trade, remainingQty)).join('')}
      </div>
    </div>`);
  }
  box.innerHTML = html.join('');

  bindGroupToggle('#ledgerList', uiOpen.ledger);

  $$('#ledgerList .est-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.id;
      const price = parseFloat(inp.value) || null;
      Store.updateTrade(id, { estSell: price });
      const t = Store.trades.find((x) => x.id === id);
      const lot = matchResult.lots.get(id);
      updateEstOut(inp.closest('.lot-est'), t, lot ? lot.remainingQty : 0);
    });
  });
  $$('#ledgerList .quote-input').forEach((inp) => {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      const code = inp.dataset.code;
      const v = parseFloat(inp.value) || 0;
      Store.settings.quotes[code] = v;
      Store.save();
      const st = codeStats(code);
      const el = $(`.float-v[data-code="${code}"]`);
      if (!el) return;
      if (st.floatPnl == null) {
        el.textContent = '--';
        el.className = 'v float-v';
      } else {
        el.textContent = fmtSign(st.floatPnl);
        el.className = 'v float-v ' + pnlClass(st.floatPnl);
      }
    });
  });
  $$('#ledgerList [data-act="cycle-type"]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); cycleSecType(b.dataset.code); });
  });
  $$('#ledgerList [data-act="del-trade"]').forEach((b) => {
    b.addEventListener('click', () => deleteTrade(b.dataset.id));
  });
}

function renderLot(t, remainingQty) {
  const partly = remainingQty < t.qty ? `（原${fmt(t.qty, 0)}股，已配对${fmt(t.qty - remainingQty, 0)}）` : '';
  return `<div class="lot">
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
    <div class="lot-actions"><button class="btn btn-mini" data-act="del-trade" data-id="${t.id}">删除此笔</button></div>
  </div>`;
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
  $('#sellSummary').innerHTML = `
    <div class="sum-item"><div class="v ${pnlClass(ap.realized)}">${fmtSign(ap.realized)}</div><div class="k">做T已实现净利</div></div>
    <div class="sum-item"><div class="v c-up">${fmtSign(ap.realizedWin)}</div><div class="k">盈利合计</div></div>
    <div class="sum-item"><div class="v c-down">${fmtSign(ap.realizedLoss)}</div><div class="k">亏损合计</div></div>`;

  const shown = all.filter((s) => {
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
  for (const code of Array.from(byCode.keys()).sort()) {
    const list = byCode.get(code);
    const st = codeStats(code);
    const open = uiOpen.sells.has(code) ? ' open' : '';
    const filterLabel = filter === 'win' ? '做T成功' : filter === 'loss' ? '亏损卖出' : '卖出';

    html.push(`<div class="group${open}" data-code="${esc(code)}">
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
  }
  box.innerHTML = html.join('');

  bindGroupToggle('#sellList', uiOpen.sells);
  $$('#sellList [data-act="del-trade"]').forEach((b) => {
    b.addEventListener('click', () => deleteTrade(b.dataset.id));
  });
}

function renderSellCard(s) {
  const r = matchResult.sells.get(s.id) || {
    pairs: [], matchedQty: 0, unmatchedQty: s.qty, netPnl: 0, sellFee: 0, buyFeeShare: 0, success: false,
  };
  const tag = r.matchedQty === 0
    ? '<span class="tag tag-warn">无买单可配</span>'
    : r.success ? '<span class="tag tag-win">做T成功</span>' : '<span class="tag tag-loss">亏损卖出</span>';
  const unmatched = r.unmatchedQty > 0 && r.matchedQty > 0
    ? `<span class="tag tag-warn">${fmt(r.unmatchedQty, 0)}股未配对</span>` : '';

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
        <span>配对买单 ${fmt(p.buyPrice, 3)} × ${fmt(p.qty, 0)}股（${esc(p.buyDate)}）</span>
        <span class="p-pnl ${pnlClass((s.price - p.buyPrice) * p.qty)}">${fmtSign(round2((s.price - p.buyPrice) * p.qty))}</span>
      </div>`).join('')}</div>` : ''}
    <div class="sell-fees">卖出费用 ${feeText(s.fees)}，买入费用分摊 ${fmt(r.buyFeeShare)}</div>
    <div class="lot-actions"><button class="btn btn-mini" data-act="del-trade" data-id="${s.id}">删除此笔</button></div>
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
        <div class="k">账户总盈亏 = 已实现 + 持仓浮动 + 股息利息${asOf ? '（数据截至 ' + asOf + '，不含今日）' : ''}</div></div>
      <div class="sum-item"><div class="v ${pnlClass(ap.realized)}">${fmtSign(ap.realized)}</div><div class="k">已实现(做T配对)</div></div>
      <div class="sum-item"><div class="v ${pnlClass(ap.floatPnl)}">${fmtSign(ap.floatPnl)}</div><div class="k">持仓浮动盈亏</div></div>
      <div class="sum-item"><div class="v c-up">${fmtSign(ap.realizedWin)}</div><div class="k">做T盈利合计</div></div>
      <div class="sum-item"><div class="v c-down">${fmtSign(ap.realizedLoss)}</div><div class="k">做T亏损合计</div></div>
      <div class="sum-item"><div class="v">${fmtSign(ap.dividends + ap.interest)}</div><div class="k">股息+利息</div></div>
      <div class="sum-item"><div class="v">${rate}%</div><div class="k">做T成功率</div></div>
      <div class="sum-item"><div class="v ${pnlClass(todayNet)}">${fmtSign(round2(todayNet))}</div><div class="k">今日做T(若有)</div></div>
      ${ap.assetStyle != null ? `<div class="sum-item big"><div class="v ${pnlClass(ap.assetStyle)}">${fmtSign(ap.assetStyle)}</div>
        <div class="k">对照：总资产 ${fmt(ap.totalAssets)} − 银证净入金 ${fmt(ap.netDeposit)}（部分券商APP用此口径）</div></div>` : ''}
    </div>
    ${total ? `
    <div class="card"><h2>按日做T（盈利/亏损金额）</h2>
      <table class="stat-table"><tr><th>日期</th><th>盈利</th><th>亏损</th><th>净利</th></tr>${dayRows}</table>
    </div>
    <div class="card"><h2>按标的做T（盈利/亏损金额）</h2>
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
  renderLedger();
  // 台账渲染后填充各笔预计利润
  $$('#ledgerList .est-input').forEach((inp) => {
    const t = Store.trades.find((x) => x.id === inp.dataset.id);
    const lot = matchResult.lots.get(inp.dataset.id);
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
