'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
const xlsxPath = process.argv[2];
const buf = fs.readFileSync(xlsxPath);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
console.log('sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  console.log('\n=== sheet', name, 'rows', grid.length, '===');
  for (let i = 0; i < Math.min(25, grid.length); i++) {
    const row = grid[i].map((c) => String(c).slice(0, 20));
    if (row.some((c) => c)) console.log(i, JSON.stringify(row));
  }
}
