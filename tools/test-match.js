/* 核销算法命令行自测：node tools/test-match.js */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
const { calcFees, DEFAULT_FEE_RULES, computeMatches, estimateLotProfit } = new Function(
  read('fees.js') + '\n' + read('match.js') +
  '\nreturn { calcFees, DEFAULT_FEE_RULES, computeMatches, estimateLotProfit };'
)();

let failed = 0;
function expect(label, actual, want) {
  const ok = Math.abs(actual - want) < 0.005;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${actual}, want ${want}`);
}

function mk(side, price, qty, time, secType, code) {
  const amount = price * qty;
  return {
    id: side + price + '_' + time, code: code || '510300', secType: secType || 'etf',
    side, price, qty, amount, date: '2026-07-31', time,
    fees: calcFees(secType || 'etf', side, amount, DEFAULT_FEE_RULES),
  };
}

// 场景1：卖单优先配"低于卖价里最高"的买单，数量不足级联到次接近
const trades1 = [
  mk('buy', 3.5, 1000, '09:31:00'),
  mk('buy', 3.45, 1000, '09:45:00'),
  mk('buy', 3.52, 500, '10:00:00'),
  mk('sell', 3.51, 1500, '13:30:00'),
];
const r1 = computeMatches(trades1);
const s1 = r1.sells.get(trades1[3].id);
console.log('场景1 配对:', s1.pairs.map((p) => `${p.buyPrice}x${p.qty}`).join(', '));
expect('场景1 毛利', s1.grossPnl, 40);
// 卖费 max(5265*0.00005,0.1)=0.26；买费摊 0.18 + 0.17*0.5=0.085
expect('场景1 净利', s1.netPnl, 40 - 0.26 - 0.18 - 0.09);
expect('场景1 成功标记', s1.success ? 1 : 0, 1);
expect('场景1 剩余3.45买单', r1.lots.get(trades1[1].id).remainingQty, 500);
expect('场景1 剩余3.52买单', r1.lots.get(trades1[2].id).remainingQty, 500);

// 场景2：没有低于卖价的买单 -> 配高于卖价里最接近的，净亏 -> 亏损卖出
const trades2 = [
  mk('buy', 3.6, 1000, '09:31:00'),
  mk('buy', 3.7, 1000, '09:40:00'),
  mk('sell', 3.55, 500, '10:30:00'),
];
const r2 = computeMatches(trades2);
const s2 = r2.sells.get(trades2[2].id);
console.log('场景2 配对:', s2.pairs.map((p) => `${p.buyPrice}x${p.qty}`).join(', '));
expect('场景2 配对价3.6', s2.pairs[0].buyPrice, 3.6);
expect('场景2 失败标记', s2.success ? 1 : 0, 0);

// 场景3：股票费率（佣金最低5元 + 过户费双向 + 印花税卖出）
const t3buy = mk('buy', 10, 1000, '09:31:00', 'stock', '600000');
const t3sell = mk('sell', 10.1, 1000, '10:00:00', 'stock', '600000');
// 买：佣金 max(10000*0.000085,5)=5，过户 0.1；卖：佣金 max(10100*.000085,5)=5，过户 0.1，印花 5.05
expect('场景3 买佣金', t3buy.fees.commission, 5);
expect('场景3 买过户', t3buy.fees.transfer, 0.1);
expect('场景3 卖印花', t3sell.fees.stamp, 5.05);
const r3 = computeMatches([t3buy, t3sell]);
const s3 = r3.sells.get(t3sell.id);
expect('场景3 净利', s3.netPnl, 100 - 5 - 0.1 - (5 + 0.1 + 5.05));

// 场景4：先卖后买回（同日）仍可配对为做T
const trades4 = [
  mk('sell', 3.6, 1000, '09:35:00'),
  mk('buy', 3.5, 1000, '14:00:00'),
];
const r4 = computeMatches(trades4);
const s4 = r4.sells.get(trades4[0].id);
expect('场景4 配对数量', s4.matchedQty, 1000);
expect('场景4 毛利', s4.grossPnl, 100);

// 场景4b：跨日卖出也算做T（不限同日）
const trades4b = [
  Object.assign(mk('buy', 3.5, 1000, '09:31:00'), { date: '2026-07-30' }),
  Object.assign(mk('sell', 3.6, 1000, '10:00:00'), { date: '2026-07-31' }),
];
const r4b = computeMatches(trades4b);
const s4b = r4b.sells.get(trades4b[1].id);
expect('场景4b 跨日也配对', s4b.matchedQty, 1000);
expect('场景4b 做T成功', s4b.success ? 1 : 0, 1);

// 场景5：无买单可配 -> 未配对
const r5 = computeMatches([mk('sell', 3.6, 1000, '09:35:00')]);
const s5 = r5.sells.get('sell3.6_09:35:00');
expect('场景5 未配对数量', s5.unmatchedQty, 1000);

// 场景6：预估利润
const b6 = mk('buy', 3.5, 1000, '09:31:00');
const est = estimateLotProfit(b6, 1000, 3.55, DEFAULT_FEE_RULES);
// 毛利50，卖费 max(3550*0.00005,0.1)=0.18，买费摊 0.18
expect('场景6 预估净利', est.net, 50 - 0.18 - 0.18);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
