/* 增量合并对账单到 seed.json：node tools/merge-xlsx.js <xlsx路径> */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const feesSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'fees.js'), 'utf8');
const importSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'import.js'), 'utf8');
const { DEFAULT_FEE_RULES, parseWorkbook, rowsToTrades } = new Function(
  'XLSX',
  feesSrc + '\n' + importSrc + '\nreturn { DEFAULT_FEE_RULES, parseWorkbook, rowsToTrades };'
)(XLSX);

const xlsxPath = process.argv[2];
if (!xlsxPath || !fs.existsSync(xlsxPath)) {
  console.error('用法: node tools/merge-xlsx.js <xlsx路径>');
  process.exit(1);
}

function extractAccount(grid) {
  let cash = 0, totalAssets = 0, asOf = '';
  for (let i = 0; i < 20; i++) {
    if (String(grid[i][0]).includes('资金余额')) cash = Number(grid[i][3]) || cash;
    if (String(grid[i][0]).includes('资产总值')) totalAssets = Number(grid[i][3]) || totalAssets;
    const cycle = String(grid[i][5] || '');
    const m = cycle.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*-\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) {
      asOf = m[4] + '-' + m[5].padStart(2, '0') + '-' + m[6].padStart(2, '0');
    }
  }
  let deposit = 0, withdraw = 0, dividends = 0, interest = 0;
  const transferKeys = [];
  const transferOcc = new Map(); // date|type|amt -> count for stable keys
  for (let i = 0; i < grid.length; i++) {
    const summary = String(grid[i][5] || '').replace(/\n/g, '');
    const amt = Number(grid[i][11]) || 0;
    const date = String(grid[i][0] || '').replace(/\D/g, '').slice(0, 8);
    if (summary === '银行转存') {
      deposit += amt;
      const base = date + '|in|' + amt;
      const occ = transferOcc.get(base) || 0;
      transferOcc.set(base, occ + 1);
      transferKeys.push(base + '#' + occ);
    }
    if (summary === '银行转取') {
      withdraw += Math.abs(amt);
      const base = date + '|out|' + Math.abs(amt);
      const occ = transferOcc.get(base) || 0;
      transferOcc.set(base, occ + 1);
      transferKeys.push(base + '#' + occ);
    }
    if (summary === '股息入帐') dividends += amt;
    if (summary === '利息归本') interest += amt;
  }
  const holdings = [];
  const holdHead = grid.findIndex((r) => String(r[0]).includes('股票持仓'));
  if (holdHead >= 0) {
    for (let i = holdHead + 1; i < grid.length; i++) {
      const r = grid[i];
      const code = String(r[3] || '').trim();
      if (String(r[0]).includes('基金持仓') || String(r[0]).includes('配号')) break;
      if (!/^\d{6}$/.test(code) || code === '888880') continue;
      const qty = Number(r[6]) || 0;
      const holdPnl = Number(r[11]) || 0;
      // 已清仓但仍有「持仓盈亏」的行（qty=0）也要保留，否则总盈亏少扣一块
      if (qty <= 0 && Math.abs(holdPnl) < 0.005) continue;
      holdings.push({
        code,
        name: String(r[4] || '').replace(/\n/g, ''),
        qty,
        marketValue: Number(r[7]) || 0,
        costPrice: Number(r[9]) || 0,
        lastPrice: Number(r[10]) || 0,
        holdPnl,
      });
    }
  }
  // 账单「合计」行的持仓盈亏（最权威）
  let holdPnlTotal = null;
  for (let i = 0; i < grid.length; i++) {
    if (String(grid[i][0]).includes('合计') && String(grid[i][1]).includes('人民币')) {
      const v = Number(grid[i][11]);
      if (!isNaN(v) && grid[i][11] !== '' && grid[i][11] != null) {
        // 流水合计行也有「合计」，持仓合计通常市值在列7且较大
        const mv = Number(grid[i][7]);
        if (!isNaN(mv) && mv > 100) holdPnlTotal = v;
      }
    }
  }
  return {
    asOf: asOf || new Date().toISOString().slice(0, 10),
    cash,
    totalAssets,
    deposit: round2(deposit),
    withdraw: round2(withdraw),
    netDeposit: round2(deposit - withdraw),
    dividends: round2(dividends),
    interest: round2(interest),
    holdings,
    holdPnlTotal: holdPnlTotal == null ? null : round2(holdPnlTotal),
    transferKeys,
    quotes: {},
  };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function dedupKey(t, occ) {
  const base = t.seqNo
    ? [t.date, t.code, t.side, t.seqNo].join('|')
    : [t.date, t.time || '', t.code, t.side, t.price, t.qty].join('|');
  return occ > 0 ? base + '#' + occ : base;
}

function normalizeTrades(trades) {
  const seen = new Map();
  const out = [];
  const keySet = new Set();
  for (const t of trades) {
    const base = dedupKey(t, 0);
    const occ = seen.get(base) || 0;
    seen.set(base, occ + 1);
    const key = dedupKey(t, occ);
    if (keySet.has(key)) continue;
    keySet.add(key);
    t.key = key;
    out.push(t);
  }
  return out;
}

const seedPath = path.join(__dirname, '..', 'data', 'seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const existingKeys = new Set(seed.trades.map((t) => t.key));

const buf = fs.readFileSync(xlsxPath);
const wb = XLSX.read(buf, { type: 'buffer' });
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const { rows, mapping } = parseWorkbook(ab);
const { trades, skippedRows } = rowsToTrades(rows, mapping, seed.settings.feeRules || DEFAULT_FEE_RULES);
const fresh = normalizeTrades(trades);

let added = 0, skipped = 0;
for (const t of fresh) {
  if (existingKeys.has(t.key)) { skipped++; continue; }
  existingKeys.add(t.key);
  t.id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + added;
  t.seq = seed.trades.length;
  seed.trades.push(t);
  added++;
}

const periodAccount = extractAccount(grid);
const oldAcc = seed.account || {};
// 银证转入/转出按 key 去重，避免重叠账单重复累加（历史上曾因此多计约 7000）
let depositAdd = 0;
let withdrawAdd = 0;
let transferSkipped = 0;
const seenNow = new Set(oldAcc.seenTransfers || []);
for (const key of periodAccount.transferKeys || []) {
  if (seenNow.has(key)) {
    transferSkipped++;
    continue;
  }
  seenNow.add(key);
  const parts = key.split('|');
  const type = parts[1];
  const amt = Number(String(parts[2] || '').split('#')[0]) || 0;
  if (type === 'in') depositAdd += amt;
  else withdrawAdd += amt;
}
depositAdd = round2(depositAdd);
withdrawAdd = round2(withdrawAdd);

// 新账单的银证/股息是「本期」增量，要累加到历史快照；持仓/资产以最新账单为准
seed.account = {
  asOf: periodAccount.asOf,
  cash: periodAccount.cash,
  totalAssets: periodAccount.totalAssets,
  deposit: round2((oldAcc.deposit || 0) + depositAdd),
  withdraw: round2((oldAcc.withdraw || 0) + withdrawAdd),
  netDeposit: round2((oldAcc.netDeposit || 0) + depositAdd - withdrawAdd),
  dividends: round2((oldAcc.dividends || 0) + periodAccount.dividends),
  interest: round2((oldAcc.interest || 0) + periodAccount.interest),
  holdings: periodAccount.holdings,
  holdPnlTotal: periodAccount.holdPnlTotal,
  seenTransfers: Array.from(seenNow),
  quotes: oldAcc.quotes || {},
};
seed.seedRevision = (seed.seedRevision || 1) + 1;

fs.writeFileSync(seedPath, JSON.stringify(seed));
console.log('新增成交', added, '跳过重复', skipped, '忽略非成交', skippedRows);
console.log('总成交', seed.trades.length, 'seedRevision', seed.seedRevision);
console.log('账户截至', seed.account.asOf, '总资产', seed.account.totalAssets, '资金', seed.account.cash);
console.log('持仓数', seed.account.holdings.length, '账单持仓盈亏合计', seed.account.holdPnlTotal, '累计净入金', seed.account.netDeposit);
console.log('本期银证新增 转入', depositAdd, '转出', withdrawAdd, '跳过重复银证', transferSkipped);
console.log('账户总盈亏(资产−净入金)', round2(seed.account.totalAssets - seed.account.netDeposit));
