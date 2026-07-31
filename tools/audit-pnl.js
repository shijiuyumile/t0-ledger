'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const feesSrc = fs.readFileSync(path.join(root, 'js', 'fees.js'), 'utf8');
const matchSrc = fs.readFileSync(path.join(root, 'js', 'match.js'), 'utf8');
const { computeMatches, DEFAULT_FEE_RULES } = new Function(
  feesSrc + '\n' + matchSrc + '\nreturn { computeMatches, DEFAULT_FEE_RULES };'
)();

const seed = JSON.parse(fs.readFileSync(path.join(root, 'data', 'seed.json'), 'utf8'));
const trades = seed.trades;
const { sells } = computeMatches(trades);

let allNet = 0, win = 0, loss = 0, matchedSells = 0;
let sameDayNet = 0, sameDayWin = 0, sameDayLoss = 0, sameDayN = 0;
let crossDayNet = 0, crossDayN = 0;
const byCode = {};

for (const s of trades) {
  if (s.side !== 'sell') continue;
  const r = sells.get(s.id);
  if (!r || r.matchedQty === 0) continue;
  matchedSells++;
  allNet += r.netPnl;
  r.success ? win++ : loss++;
  byCode[s.code] = (byCode[s.code] || 0) + r.netPnl;

  // 若只计「买卖同一天」的配对数量对应盈亏（近似做T）
  let sameQty = 0, sameGross = 0, sameBuyFee = 0;
  let crossQty = 0, crossGross = 0, crossBuyFee = 0;
  for (const p of r.pairs) {
    const buy = trades.find((t) => t.id === p.buyId);
    const same = buy && buy.date === s.date;
    if (same) {
      sameQty += p.qty;
      sameGross += (s.price - p.buyPrice) * p.qty;
      sameBuyFee += p.buyFeeShare;
    } else {
      crossQty += p.qty;
      crossGross += (s.price - p.buyPrice) * p.qty;
      crossBuyFee += p.buyFeeShare;
    }
  }
  const sellFeeAll = r.sellFee;
  if (sameQty > 0) {
    const fee = sellFeeAll * (sameQty / r.matchedQty);
    const net = sameGross - fee - sameBuyFee;
    sameDayNet += net;
    sameDayN++;
    net > 0 ? sameDayWin++ : sameDayLoss++;
  }
  if (crossQty > 0) {
    const fee = sellFeeAll * (crossQty / r.matchedQty);
    crossDayNet += crossGross - fee - crossBuyFee;
    crossDayN++;
  }
}

console.log('全部配对净利', round(allNet), '成功', win, '亏损', loss, '卖单数', matchedSells);
console.log('仅同日配对净利', round(sameDayNet), '笔', sameDayN, '成功', sameDayWin, '亏损', sameDayLoss);
console.log('跨日配对净利', round(crossDayNet), '涉及卖单', crossDayN);
console.log('按标的全部配对:');
Object.entries(byCode).sort((a,b)=>b[1]-a[1]).forEach(([c,n]) => console.log(' ', c, round(n)));

// 交割单资金流水粗算：买入发生额 vs 卖出（用 amount 字段）
let buyAmt = 0, sellAmt = 0, buyFee = 0, sellFee = 0;
for (const t of trades) {
  const f = (t.fees.commission||0)+(t.fees.transfer||0)+(t.fees.stamp||0)+(t.fees.other||0);
  if (t.side === 'buy') { buyAmt += t.amount; buyFee += f; }
  else { sellAmt += t.amount; sellFee += f; }
}
console.log('买入成交额', round(buyAmt), '卖出成交额', round(sellAmt), '差额(卖-买)', round(sellAmt - buyAmt));
console.log('买入费用', round(buyFee), '卖出费用', round(sellFee), '总费用', round(buyFee+sellFee));
console.log('粗算已实现(卖-买-费用，含未平仓偏差)', round(sellAmt - buyAmt - buyFee - sellFee));

function round(n){ return Math.round(n*100)/100; }
