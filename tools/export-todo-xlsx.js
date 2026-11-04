/* 导出电脑勾选用台账：node tools/export-todo-xlsx.js [输出路径] */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const feesSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'fees.js'), 'utf8');
const matchSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'match.js'), 'utf8');
const { computeMatches, computeStairsMatches, computeAccountPnl, round2, totalFees } = new Function(
  feesSrc + '\n' + matchSrc +
  '\nreturn { computeMatches, computeStairsMatches, computeAccountPnl, round2, totalFees };'
)();

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
const trades = seed.trades || [];
const account = seed.account || {};
const asOf = account.asOf || '';
const holdings = account.holdings || [];
const holdByCode = new Map(holdings.map((h) => [h.code, h]));
const tradeById = new Map(trades.map((t) => [t.id, t]));

const closest = computeMatches(trades, { mode: 'closest' });
const timeMatch = computeMatches(trades, { mode: 'time' });
// 与 App「老太太扶楼梯 → 全部」一致：全历史窗口内，卖价高于买价按量拆单，不限买卖先后
const stairsAll = computeStairsMatches(trades, {});
const ap = computeAccountPnl(trades, closest, account);

function lotMatchedSummary(buyTrade, lot) {
  const matches = (lot && lot.matches) || [];
  if (!matches.length) {
    return { matchedQty: 0, avgSell: 0, net: 0, sellText: '', lines: [] };
  }
  let matchedQty = 0;
  let sellAmt = 0;
  let sellFee = 0;
  const lines = [];
  for (const m of matches) {
    matchedQty += m.qty;
    sellAmt += m.sellPrice * m.qty;
    const sell = tradeById.get(m.sellId);
    if (sell && sell.qty > 0) sellFee += totalFees(sell.fees) * (m.qty / sell.qty);
    lines.push({
      price: m.sellPrice,
      qty: m.qty,
      date: sell ? sell.date : '',
    });
  }
  const buyFee = totalFees(buyTrade.fees) * (matchedQty / buyTrade.qty);
  const gross = sellAmt - buyTrade.price * matchedQty;
  const sellText = lines.map((s) =>
    round3(s.price) + '×' + s.qty + '股' + (s.date ? '（' + s.date + '）' : '')
  ).join('，');
  return {
    matchedQty,
    avgSell: matchedQty > 0 ? sellAmt / matchedQty : 0,
    net: round2(gross - sellFee - buyFee),
    sellText,
    lines,
  };
}

function nameOf(code) {
  const h = holdByCode.get(code);
  if (h && h.name) return String(h.name).replace(/\n/g, '');
  let n = '';
  for (const t of trades) if (t.code === code && t.name) n = t.name;
  return n || code;
}

function lastPriceOf(code) {
  const h = holdByCode.get(code);
  return h && h.lastPrice > 0 ? h.lastPrice : '';
}

function round3(v) {
  return Math.round((Number(v) + Number.EPSILON) * 1000) / 1000;
}

function colWidths(headers, rows, extras) {
  return headers.map((h, i) => {
    let max = String(h).length;
    for (const r of rows) {
      const s = r[i] == null ? '' : String(r[i]);
      if (s.length > max) max = s.length;
    }
    const extra = extras && extras[i];
    const w = Math.min(36, Math.max(8, max + 2, extra || 0));
    return { wch: w };
  });
}

function sheetFrom(headers, rows, opts) {
  const aoa = [headers].concat(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = colWidths(headers, rows, opts && opts.widths);
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!views'] = [{ state: 'frozen', ySplit: 1, activeCell: 'A2' }];
  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  const lastRow = Math.max(2, aoa.length);
  if (opts && opts.dropdowns) {
    ws['!dataValidation'] = opts.dropdowns.map((d) => ({
      sqref: d.col + '2:' + d.col + lastRow,
      type: 'list',
      formula1: '"' + d.list + '"',
      allowBlank: true,
      showDropDown: false,
    }));
  }
  ws['!autofilter'] = { ref: 'A1:' + lastCol + lastRow };
  return ws;
}

/* ---------- 待做T：价格匹配剩余买单 ---------- */
const lotRows = [];
for (const t of trades) {
  if (t.side !== 'buy') continue;
  const lot = closest.lots.get(t.id);
  if (!lot || lot.remainingQty <= 0) continue;
  const last = lastPriceOf(t.code);
  const gap = last ? round3(last - t.price) : '';
  lotRows.push([
    '否',
    '',
    '',
    '',
    t.code,
    nameOf(t.code),
    t.secType === 'etf' ? 'ETF' : (t.secType === 'bond' ? '债券' : '股票'),
    t.date,
    t.time || '',
    round3(t.price),
    lot.remainingQty,
    t.qty,
    t.qty - lot.remainingQty,
    last,
    gap,
    t.tHidden ? '是' : '否',
    t.id,
    '',
  ]);
}
lotRows.sort((a, b) => String(a[4]).localeCompare(String(b[4])) || String(a[7]).localeCompare(String(b[7])) || (a[9] - b[9]));

const lotHeaders = [
  '已处理', '我怎么处理了', '处理日期', '处理价格',
  '代码', '名称', '品种', '买入日期', '买入时间',
  '买入价', '待做T股数', '原买入股数', '已配对股数',
  '账单最新价', '相对成本价差', 'App已隐藏', '内部编号', '备注',
];

/* ---------- 待回补：时间核销 ---------- */
const covers = (timeMatch.pendingCovers || []).slice().sort((a, b) =>
  String(a.code).localeCompare(String(b.code)) || String(a.date).localeCompare(String(b.date)));
const coverRows = covers.map((c) => {
  const last = lastPriceOf(c.code);
  const vs = last ? round3(last - c.price) : '';
  const hint = last === '' ? '' : (last < c.price ? '最新价低于上限，可考虑回补' : '最新价不低于上限，不宜回补');
  return [
    '否', '', '', '',
    c.code, nameOf(c.code),
    c.secType === 'etf' ? 'ETF' : '股票',
    c.date, c.time || '',
    round3(c.price), c.qty, last, vs, hint, c.sellId || '', '',
  ];
});
const coverHeaders = [
  '已处理', '我怎么处理了', '处理日期', '处理价格',
  '代码', '名称', '品种', '卖出日期', '卖出时间',
  '回补上限', '待回补股数', '账单最新价', '相对上限价差', '提示', '内部编号', '备注',
];

/* ---------- 待扳本：已配对亏损卖出 ---------- */
const beRows = [];
for (const t of trades) {
  if (t.side !== 'sell') continue;
  const r = closest.sells.get(t.id);
  if (!r || r.matchedQty <= 0 || !(r.netPnl < 0) || r.isReverse) continue;
  const last = lastPriceOf(t.code);
  beRows.push([
    '否', '', '', '',
    t.code, nameOf(t.code),
    t.secType === 'etf' ? 'ETF' : (t.secType === 'bond' ? '债券' : '股票'),
    t.date, t.time || '',
    round3(t.price), t.qty, round2(r.netPnl), last,
    last ? round3(last - t.price) : '',
    t.id, '',
  ]);
}
beRows.sort((a, b) => String(a[4]).localeCompare(String(b[4])) || String(b[7]).localeCompare(String(a[7])));
const beHeaders = [
  '已处理', '我怎么处理了', '处理日期', '处理价格',
  '代码', '名称', '品种', '卖出日期', '卖出时间',
  '卖出价', '股数', '已实现净利', '账单最新价', '相对卖出价差', '内部编号', '备注',
];

/* ---------- 老太太扶楼梯（全部）：未做完 + 做T成功 ---------- */
const stairsPendingRows = [];
const stairsDoneRows = [];
let stairsWindowNet = 0;
for (const r of stairsAll.sells.values()) {
  if (r && r.matchedQty > 0) stairsWindowNet += r.netPnl;
}
stairsWindowNet = round2(stairsWindowNet);

for (const t of trades) {
  if (t.side !== 'buy') continue;
  const lot = stairsAll.lots.get(t.id);
  if (!lot) continue;
  const pending = lot.remainingQty > 0;
  const done = lot.matchedQty > 0 && lot.remainingQty <= 0;
  if (!pending && !done) continue;
  const last = lastPriceOf(t.code);
  const secLabel = t.secType === 'etf' ? 'ETF' : (t.secType === 'bond' ? '债券' : '股票');
  if (pending) {
    const gap = last ? round3(last - t.price) : '';
    stairsPendingRows.push([
      '否',
      '',
      '',
      '',
      t.code,
      nameOf(t.code),
      secLabel,
      t.date,
      t.time || '',
      round3(t.price),
      lot.remainingQty,
      t.qty,
      lot.matchedQty,
      last,
      gap,
      t.id,
      '',
    ]);
  } else {
    const sum = lotMatchedSummary(t, lot);
    stairsDoneRows.push([
      t.code,
      nameOf(t.code),
      secLabel,
      t.date,
      t.time || '',
      round3(t.price),
      sum.matchedQty,
      sum.sellText,
      sum.lines.length > 1 ? round3(sum.avgSell) : '',
      sum.net,
      t.id,
      '',
    ]);
  }
}
stairsPendingRows.sort((a, b) =>
  String(a[4]).localeCompare(String(b[4])) || String(a[7]).localeCompare(String(b[7])) || (a[9] - b[9]));
stairsDoneRows.sort((a, b) =>
  String(a[0]).localeCompare(String(b[0])) || String(b[3]).localeCompare(String(a[3])) || (a[5] - b[5]));

const stairsPendingHeaders = [
  '已处理', '我怎么处理了', '处理日期', '处理价格',
  '代码', '名称', '品种', '买入日期', '买入时间',
  '买入价', '未做完股数', '原买入股数', '已配对股数',
  '账单最新价', '相对成本价差', '内部编号', '备注',
];
const stairsDoneHeaders = [
  '代码', '名称', '品种', '买入日期', '买入时间',
  '买入价', '已配股数', '卖出明细', '卖出均价', '扣费后净利', '内部编号', '备注',
];

/* ---------- 当前持仓 ---------- */
const holdRows = holdings
  .filter((h) => h.qty > 0 || Math.abs(h.holdPnl || 0) >= 0.005)
  .map((h) => [
    h.code, String(h.name || '').replace(/\n/g, ''),
    h.qty, h.costPrice, h.lastPrice, h.marketValue, h.holdPnl,
    h.qty > 0 ? '持仓中' : '已清仓(账单仍挂盈亏)',
  ]);
const holdHeaders = ['代码', '名称', '股数', '成本价', '最新价', '市值', '持仓盈亏', '状态'];

/* ---------- 账户摘要 ---------- */
const summaryRows = [
  ['数据截至', asOf],
  ['总资产', account.totalAssets],
  ['银证净入金', account.netDeposit],
  ['账户总盈亏(资产−净入金，对齐涨乐)', ap.total],
  ['证券估算(移动均价+股票浮动+息红)', ap.componentsTotal],
  ['已实现·移动均价', ap.realized],
  ['股票持仓浮动', ap.floatPnl],
  ['股息+利息', round2((ap.dividends || 0) + (ap.interest || 0))],
  ['做T配对净利(价格相近·分析用)', ap.matchRealized],
  ['待做T笔数(价格匹配)', lotRows.length],
  ['扶楼梯未做完笔数(全部)', stairsPendingRows.length],
  ['扶楼梯做T成功笔数(全部)', stairsDoneRows.length],
  ['扶楼梯窗口扣费净利(全部)', stairsWindowNet],
  ['待回补笔数', coverRows.length],
  ['待扳本笔数', beRows.length],
  ['持仓标的数', holdRows.filter((r) => r[2] > 0).length],
];

const helpRows = [
  ['怎么用这张表'],
  [''],
  ['这是从做T App 按当前账单导出的电脑勾选台账，方便在 Excel 里记「这一单我处理了没有」。'],
  ['App 仍是手机工作台；这张表不会自动回写 App，只给你在电脑上打钩、记备注。下次导入新对账单后可让我重新导出。'],
  [''],
  ['工作表说明'],
  ['待做T', '全历史「价格最相近」核销后，还没卖完的买入仓。卖出优先配买价最接近卖价的买单（先低价再高价），不要求卖价一定高于买价。'],
  ['扶楼梯未做完', '与 App「老太太扶楼梯→全部」一致：只在全部成交里，卖价严格高于买价才配，按股数拆单，不限买卖先后；本页是还没配完的买入。'],
  ['扶楼梯做T成功', '同上口径下已经配完的买入，列出买价、卖出明细、扣费后净利。'],
  ['待回补', '时间核销下的先卖未买回（倒T）。买回来后打钩。'],
  ['待扳本', '价格匹配下已经配对且亏损的卖出。用来盯扳本。'],
  ['当前持仓', '对账单股票持仓快照（含 qty=0 但仍挂盈亏的行）。'],
  ['账户摘要', '总资产−净入金 等汇总，和涨乐「我的收益」同一口径。'],
  [''],
  ['建议你这样填'],
  ['已处理', '下拉选 是 / 否。处理完一单就改成「是」，再用筛选看还没做的。'],
  ['我怎么处理了', '待做T/扶楼梯未做完建议：卖出 / 部分卖出 / 先不动；待回补建议：已回补 / 先不回补。'],
  ['处理日期、处理价格', '可选，方便你事后对照交割单。'],
  ['备注', '随便写，例如「等回5.12再卖」。'],
  [''],
  ['口径提醒'],
  ['待做T按价格最相近；扶楼梯按「卖价>买价拆单」；待回补按时间核销。三套账不要混着加减。'],
  ['扶楼梯页导出的是 App「全部」周期；手机上再选近N天，只是换窗口重算，规则不变。'],
  ['账单最新价截至 ' + (asOf || '未知') + '，不是实时行情。'],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheetFrom(['说明'], helpRows.map((r) => [Array.isArray(r) ? r.join('　') : r])), '使用说明');
XLSX.utils.book_append_sheet(wb, sheetFrom(lotHeaders, lotRows, {
  dropdowns: [
    { col: 'A', list: '是,否' },
    { col: 'B', list: '卖出,部分卖出,先不动,其他' },
  ],
}), '待做T');
XLSX.utils.book_append_sheet(wb, sheetFrom(stairsPendingHeaders, stairsPendingRows, {
  dropdowns: [
    { col: 'A', list: '是,否' },
    { col: 'B', list: '卖出,部分卖出,先不动,其他' },
  ],
}), '扶楼梯未做完');
XLSX.utils.book_append_sheet(wb, sheetFrom(stairsDoneHeaders, stairsDoneRows), '扶楼梯做T成功');
XLSX.utils.book_append_sheet(wb, sheetFrom(coverHeaders, coverRows, {
  dropdowns: [
    { col: 'A', list: '是,否' },
    { col: 'B', list: '已回补,先不回补,其他' },
  ],
}), '待回补');
XLSX.utils.book_append_sheet(wb, sheetFrom(beHeaders, beRows, {
  dropdowns: [
    { col: 'A', list: '是,否' },
    { col: 'B', list: '已扳本,继续盯,放弃,其他' },
  ],
}), '待扳本');
XLSX.utils.book_append_sheet(wb, sheetFrom(holdHeaders, holdRows), '当前持仓');
XLSX.utils.book_append_sheet(wb, sheetFrom(['项目', '数值'], summaryRows), '账户摘要');

const defaultOut = path.join(
  'D:/小龙虾的文件夹/做T数据记录',
  '做T待办台账_截至' + String(asOf).replace(/-/g, '') + '.xlsx'
);
const outPath = process.argv[2] || defaultOut;
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);
console.log('已写出', outPath);
console.log(
  '待做T', lotRows.length,
  '扶楼梯未做完', stairsPendingRows.length,
  '扶楼梯做T成功', stairsDoneRows.length,
  '扶楼梯净利', stairsWindowNet,
  '待回补', coverRows.length,
  '待扳本', beRows.length,
  '持仓行', holdRows.length
);
console.log('账户总盈亏', ap.total, '截至', asOf);
