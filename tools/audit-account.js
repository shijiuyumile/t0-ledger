'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

const xlsxPath = process.argv[2] || 'd:\\小龙虾的文件夹\\做T数据记录\\普通账户电子对账单(20241105-20260730).xlsx';
const buf = fs.readFileSync(xlsxPath);
const wb = XLSX.read(buf, { type: 'buffer' });
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

// 找资产总值、资金余额
for (let i = 0; i < 20; i++) {
  const row = grid[i].map(String);
  if (row.some((c) => c.includes('资产') || c.includes('资金') || c.includes('客户'))) {
    console.log('row', i, JSON.stringify(row.filter((c) => c).slice(0, 12)));
  }
}

const headerIdx = grid.findIndex((r) => String(r[0]).trim() === '日期' && String(r[5]).includes('摘要'));
console.log('headerIdx', headerIdx, grid[headerIdx].slice(0, 13));

const summaries = new Map();
let cashIn = 0, cashOut = 0;
const samples = {};
for (let i = headerIdx + 1; i < grid.length; i++) {
  const row = grid[i];
  const summary = String(row[5] || '').trim();
  const amt = Number(String(row[11]).replace(/,/g, '')) || 0; // 发生金额
  if (!summary) continue;
  summaries.set(summary, (summaries.get(summary) || 0) + 1);
  if (!samples[summary]) samples[summary] = { amt, row: [row[0], row[3], row[4], row[5], row[6], row[7], row[11]] };
  if (/银行转存|银证转入|转入/.test(summary) && !/转出|转取/.test(summary)) cashIn += amt;
  if (/银行转取|银证转出|转出/.test(summary) && !/转入|转存/.test(summary)) cashOut += Math.abs(amt);
}
console.log('\n摘要种类:');
[...summaries.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  console.log(v, k, '样例发生金额', samples[k].amt, samples[k].row);
});
console.log('\n粗算转入', cashIn, '转出', cashOut, '净入金', cashIn - cashOut);
