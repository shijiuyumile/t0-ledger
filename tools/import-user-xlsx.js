/* 解析用户对账单并导出为 seed JSON：node tools/import-user-xlsx.js <xlsx路径> */
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
const { headers, rows, mapping } = parseWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log('表头:', headers);
console.log('映射:', mapping);
console.log('数据行数:', rows.length);

const missing = ['date', 'code', 'side', 'price', 'qty'].filter((f) => mapping[f] == null);
if (missing.length) {
  console.error('缺少必填字段映射:', missing);
  process.exit(1);
}

const { trades, skippedRows } = rowsToTrades(rows, mapping, DEFAULT_FEE_RULES);
console.log('解析成交:', trades.length, '忽略行:', skippedRows);

// 统计买卖与代码
const bySide = { buy: 0, sell: 0 };
const codes = new Set();
for (const t of trades) { bySide[t.side]++; codes.add(t.code); }
console.log('买入', bySide.buy, '卖出', bySide.sell, '标的数', codes.size);
console.log('日期范围', trades[0] && trades[0].date, '~', trades[trades.length - 1] && trades[trades.length - 1].date);

// 赋 id/key（与 Store.addTrades 一致）
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
console.log('去重后:', unique.length);

const seed = {
  version: 1,
  trades: unique,
  settings: {
    lotSort: 'asc',
    sellFilter: 'loss',
    feeRules: DEFAULT_FEE_RULES,
  },
};

const out = path.join(__dirname, '..', 'data', 'seed.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(seed));
console.log('已写入', out, '大小', (fs.statSync(out).size / 1024).toFixed(1), 'KB');

// 顺便打印前3笔和后3笔核对
console.log('前3笔:', unique.slice(0, 3).map((t) => `${t.date} ${t.code} ${t.side} ${t.price}x${t.qty}`));
console.log('后3笔:', unique.slice(-3).map((t) => `${t.date} ${t.code} ${t.side} ${t.price}x${t.qty}`));
