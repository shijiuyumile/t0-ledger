'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
const xlsxPath = 'd:\\小龙虾的文件夹\\做T数据记录\\普通账户电子对账单(20241105-20260730).xlsx';
const grid = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(xlsxPath), { type: 'buffer' }).Sheets.Sheet1, { header: 1, raw: true, defval: '' });

console.log('总行数', grid.length);
for (let i = grid.length - 80; i < grid.length; i++) {
  const row = grid[i].map((c) => String(c).replace(/\n/g, ' ')).filter((c) => c !== '');
  if (row.length) console.log(i, JSON.stringify(row));
}

// 精确银证
let deposit = 0, withdraw = 0;
const headerIdx = 15;
for (let i = headerIdx + 1; i < grid.length; i++) {
  const summary = String(grid[i][5] || '').replace(/\n/g, '');
  const amt = Number(grid[i][11]) || 0;
  if (summary === '银行转存') deposit += amt;
  if (summary === '银行转取') withdraw += Math.abs(amt);
}
const assets = 118005.74;
console.log('\n银行转存', deposit, '银行转取', withdraw, '净入金', deposit - withdraw);
console.log('资产-净入金', assets - (deposit - withdraw));

// 资管上账
let zg = 0;
for (let i = headerIdx + 1; i < grid.length; i++) {
  const summary = String(grid[i][5] || '').replace(/\n/g, '');
  const amt = Number(grid[i][11]) || 0;
  if (summary.includes('资管转让')) zg += amt;
}
console.log('资管上账', zg, '净入金含资管', deposit - withdraw + zg, '盈亏', assets - (deposit - withdraw + zg));
