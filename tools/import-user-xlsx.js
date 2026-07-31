/* 解析用户对账单 → seed.json（成交 + 账户快照） */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const feesSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'fees.js'), 'utf8');
const importSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'import.js'), 'utf8');
const { DEFAULT_FEE_RULES, parseWorkbook, rowsToTrades } = new Function(
  'XLSX',
  feesSrc + '\n' + importSrc +
  '\nreturn { DEFAULT_FEE_RULES, parseWorkbook, rowsToTrades };'
)(XLSX);

const xlsxPath = process.argv[2];
if (!xlsxPath || !fs.existsSync(xlsxPath)) {
  console.error('用法: node tools/import-user-xlsx.js <xlsx路径>');
  process.exit(1);
}

const buf = fs.readFileSync(xlsxPath);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const { headers, rows, mapping } = parseWorkbook(ab);
console.log('成交表头映射', mapping);
const { trades, skippedRows } = rowsToTrades(rows, mapping, DEFAULT_FEE_RULES);
console.log('成交', trades.length, '忽略', skippedRows);

const seen = new Map();
function dedupKey(t, occ) {
  const base = t.seqNo
    ? [t.date, t.code, t.side, t.seqNo].join('|')
    : [t.date, t.time || '', t.code, t.side, t.price, t.qty].join('|');
  return occ > 0 ? base + '#' + occ : base;
}
const unique = [];
const keySet = new Set();
for (const t of trades) {
  const base = dedupKey(t, 0);
  const occ = seen.get(base) || 0;
  seen.set(base, occ + 1);
  const key = dedupKey(t, occ);
  if (keySet.has(key)) continue;
  keySet.add(key);
  t.key = key;
  t.id = 't' + unique.length.toString(36) + Math.random().toString(36).slice(2, 6);
  t.seq = unique.length;
  unique.push(t);
}

// ---- 账户快照：资金、持仓、银证、股息 ----
let cash = 0, totalAssets = 0;
for (let i = 0; i < 20; i++) {
  if (String(grid[i][0]).includes('资金余额')) cash = Number(grid[i][3]) || cash;
  if (String(grid[i][0]).includes('资产总值')) totalAssets = Number(grid[i][3]) || totalAssets;
}

let deposit = 0, withdraw = 0, dividends = 0, interest = 0;
for (let i = 0; i < grid.length; i++) {
  const summary = String(grid[i][5] || '').replace(/\n/g, '');
  const amt = Number(grid[i][11]) || 0;
  if (summary === '银行转存') deposit += amt;
  if (summary === '银行转取') withdraw += Math.abs(amt);
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
    const marketValue = Number(r[7]) || 0;
    const costPrice = Number(r[9]) || 0;
    const lastPrice = Number(r[10]) || 0;
    const holdPnl = Number(r[11]) || 0;
    const name = String(r[4] || '').replace(/\n/g, '');
    if (qty <= 0) continue;
    holdings.push({ code, name, qty, marketValue, costPrice, lastPrice, holdPnl });
  }
}

const netDeposit = Math.round((deposit - withdraw) * 100) / 100;
const account = {
  asOf: '2026-07-30',
  cash,
  totalAssets,
  deposit: Math.round(deposit * 100) / 100,
  withdraw: Math.round(withdraw * 100) / 100,
  netDeposit,
  dividends: Math.round(dividends * 100) / 100,
  interest: Math.round(interest * 100) / 100,
  holdings,
  quotes: {},
};

console.log('资产', totalAssets, '资金', cash, '净入金', netDeposit);
console.log('持仓', holdings.length, '股息', dividends, '利息', interest);
console.log('资产口径盈亏', Math.round((totalAssets - netDeposit) * 100) / 100);
console.log('账单持仓盈亏合计', holdings.reduce((s, h) => s + h.holdPnl, 0));

const seed = {
  version: 1,
  trades: unique,
  account,
  settings: {
    lotSort: 'asc',
    sellFilter: 'loss',
    feeRules: DEFAULT_FEE_RULES,
    quotes: {},
  },
};

const out = path.join(__dirname, '..', 'data', 'seed.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(seed));
console.log('已写入', out, (fs.statSync(out).size / 1024).toFixed(1), 'KB', '成交', unique.length);
