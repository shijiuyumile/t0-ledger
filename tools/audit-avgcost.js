'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
const feesSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'fees.js'), 'utf8');
const matchSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'match.js'), 'utf8');
// force load old cross-day? current is two-phase. Use avg-cost simulator instead.

const xlsxPath = 'd:\\小龙虾的文件夹\\做T数据记录\\普通账户电子对账单(20241105-20260730).xlsx';
const grid = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(xlsxPath), { type: 'buffer' }).Sheets.Sheet1, { header: 1, raw: true, defval: '' });

function feeOf(row) {
  return (Number(row[8])||0) + (Number(row[9])||0) + (Number(row[10])||0);
}

/** 券商常见：移动加权平均成本 */
const pos = new Map(); // code -> {qty, costAmt} costAmt含买入费用
let realized = 0;
let div = 0, interest = 0, otherIncome = 0;
const byCodeRealized = {};

for (let i = 16; i < grid.length; i++) {
  const row = grid[i];
  const summary = String(row[5] || '').replace(/\n/g, '');
  const code = String(row[3] || '').trim();
  const qty = Math.abs(Number(row[6]) || 0);
  const price = Number(row[7]) || 0;
  const amt = Number(row[11]) || 0; // 发生金额（买入负、卖出正，已扣费）
  const fees = feeOf(row);

  if (summary === '证券买入' && code && qty) {
    const p = pos.get(code) || { qty: 0, costAmt: 0 };
    // 成本增加：成交金额+费用 = -发生金额（发生金额已含费用）
    const costAdd = Math.abs(amt);
    p.costAmt += costAdd;
    p.qty += qty;
    pos.set(code, p);
  } else if (summary === '证券卖出' && code && qty) {
    const p = pos.get(code) || { qty: 0, costAmt: 0 };
    const avg = p.qty > 0 ? p.costAmt / p.qty : price;
    const costRelief = avg * qty;
    // 卖出净收款 = 发生金额（已扣卖出费用）
    const proceeds = amt;
    const pnl = proceeds - costRelief;
    realized += pnl;
    byCodeRealized[code] = (byCodeRealized[code] || 0) + pnl;
    p.costAmt -= costRelief;
    p.qty -= qty;
    if (p.qty < 1e-8) { p.qty = 0; p.costAmt = 0; }
    pos.set(code, p);
  } else if (summary.includes('股息') || summary.includes('红利') && amt > 0) {
    div += amt;
  } else if (summary.includes('利息')) {
    interest += amt;
  } else if (summary.includes('红股入帐') && code && qty) {
    // 红股：数量增加，成本不变 → 摊薄
    const p = pos.get(code) || { qty: 0, costAmt: 0 };
    p.qty += qty;
    pos.set(code, p);
  }
}

// 对账单持仓盈亏
const holdPnlStmt = -9083.75;
const cash = 622.47;
const fundPnl = 0.84 + 13.13;

console.log('移动均价已实现盈亏', round(realized));
console.log('股息等', round(div), '利息', round(interest));
console.log('已实现+持仓盈亏(账单)', round(realized + holdPnlStmt));
console.log('已实现+持仓+息红', round(realized + holdPnlStmt + div + interest + fundPnl));

// 用持仓节验算浮盈：需要现价。从持仓表读
let floatCalc = 0;
for (let i = 3661; i <= 3671; i++) {
  const row = grid[i];
  const code = String(row[2]);
  if (!/^\d+$/.test(code) || code === '888880') continue;
  const qty = Number(row[4]);
  const mv = Number(row[5]);
  const pnl = Number(row[8]);
  const p = pos.get(code) || { qty: 0, costAmt: 0 };
  const ourFloat = mv - (p.qty > 0 ? p.costAmt : 0);
  console.log(code, '账单持仓', qty, '我们持仓', p.qty, '账单盈亏', pnl, '我们浮盈', round(ourFloat), '成本差', round(p.costAmt - (mv - pnl)));
  floatCalc += pnl;
}
console.log('账单浮盈合计', floatCalc);

function round(n){return Math.round(n*100)/100}
