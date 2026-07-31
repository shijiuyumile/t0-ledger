/**
 * 核销引擎："价格最相近"配对算法（纯函数，每次数据变化后全量重算，保证结果确定）。
 *
 * 规则（来自用户需求）：
 *  1. 卖单不按时间先后与买单配对，而是与"价格最相近"的剩余买单配对。
 *  2. 配对时优先找 卖价 >= 买价 的买单里价格最高的那笔（即卖单尽量高于买单一些）；
 *     若没有低于卖价的买单，则退而找高于卖价里最接近的那笔。
 *  3. 数量不相等时级联：消耗完一笔买单后继续找"次接近"的买单，直到卖单数量配完或无买单可配。
 *  4. 盈亏 = Σ(卖价 - 配对买价) × 配对数量 - 卖单全部费用 - 买单费用按数量比例分摊。
 *  5. 整笔卖单扣费后净赚 => "做T成功"；净亏 => "亏损卖出"。
 *
 * 卖单之间按成交时间先后依次处理；每笔卖单可配对同代码的任意剩余买单
 * （不限时间先后，兼容"先卖后买回"的做T场景）。
 */
'use strict';

function tradeTimeKey(t) {
  return (t.date || '') + ' ' + (t.time || '00:00:00');
}

/**
 * @param {Array} trades 全部成交记录
 * @returns {{lots: Map<string,object>, sells: Map<string,object>}}
 *   lots: buyTradeId -> { remainingQty, matchedQty, matches:[{sellId, qty, sellPrice}] }
 *   sells: sellTradeId -> { pairs:[{buyId, qty, buyPrice, buyDate}], matchedQty, unmatchedQty,
 *                           grossPnl, sellFee, buyFeeShare, netPnl, success }
 */
function computeMatches(trades) {
  const lots = new Map();
  const sells = new Map();

  const buysByCode = new Map();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    lots.set(t.id, { remainingQty: t.qty, matchedQty: 0, matches: [] });
    if (!buysByCode.has(t.code)) buysByCode.set(t.code, []);
    buysByCode.get(t.code).push(t);
  }

  const sellTrades = trades
    .filter((t) => t.side === 'sell')
    .sort((a, b) => tradeTimeKey(a).localeCompare(tradeTimeKey(b)) || (a.seq || 0) - (b.seq || 0));

  for (const sell of sellTrades) {
    const candidates = buysByCode.get(sell.code) || [];
    const pairs = [];
    let remaining = sell.qty;
    let grossPnl = 0;
    let buyFeeShare = 0;

    while (remaining > 0) {
      const pick = pickClosestBuy(sell.price, candidates, lots);
      if (!pick) break;
      const lot = lots.get(pick.id);
      const q = Math.min(remaining, lot.remainingQty);
      lot.remainingQty -= q;
      lot.matchedQty += q;
      lot.matches.push({ sellId: sell.id, qty: q, sellPrice: sell.price });
      const share = totalFees(pick.fees) * (q / pick.qty);
      buyFeeShare += share;
      grossPnl += (sell.price - pick.price) * q;
      pairs.push({ buyId: pick.id, qty: q, buyPrice: pick.price, buyDate: pick.date, buyFeeShare: round2(share) });
      remaining -= q;
    }

    // 卖单费用整笔计入；若有未配对数量（底仓卖出），费用按配对比例分摊，避免高估亏损
    const sellFeeAll = totalFees(sell.fees);
    const matchedQty = sell.qty - remaining;
    const sellFee = matchedQty === sell.qty ? sellFeeAll : round2(sellFeeAll * (matchedQty / sell.qty));
    const netPnl = round2(grossPnl - sellFee - buyFeeShare);
    sells.set(sell.id, {
      pairs,
      matchedQty,
      unmatchedQty: remaining,
      grossPnl: round2(grossPnl),
      sellFee: round2(sellFee),
      buyFeeShare: round2(buyFeeShare),
      netPnl,
      success: matchedQty > 0 && netPnl > 0,
    });
  }

  return { lots, sells };
}

/**
 * 在剩余买单中找与卖价"最相近"的一笔：
 * 优先 买价 <= 卖价 中买价最高者；否则 买价 > 卖价 中买价最低者。
 * 同价时取时间更早的一笔。
 */
function pickClosestBuy(sellPrice, candidates, lots) {
  let bestBelow = null;
  let bestAbove = null;
  for (const b of candidates) {
    const lot = lots.get(b.id);
    if (!lot || lot.remainingQty <= 0) continue;
    if (b.price <= sellPrice) {
      if (!bestBelow || b.price > bestBelow.price ||
          (b.price === bestBelow.price && tradeTimeKey(b) < tradeTimeKey(bestBelow))) {
        bestBelow = b;
      }
    } else {
      if (!bestAbove || b.price < bestAbove.price ||
          (b.price === bestAbove.price && tradeTimeKey(b) < tradeTimeKey(bestAbove))) {
        bestAbove = b;
      }
    }
  }
  return bestBelow || bestAbove;
}

/**
 * 待做T买单的"预计利润"：按预估卖价把剩余数量全部卖出的净利。
 * = (预估卖价 - 买价) × 剩余数量 - 预估卖出费用 - 买入费用按剩余数量分摊
 */
function estimateLotProfit(buyTrade, remainingQty, estPrice, feeRules) {
  if (!estPrice || estPrice <= 0 || remainingQty <= 0) return null;
  const sellAmount = estPrice * remainingQty;
  const sellFees = calcFees(buyTrade.secType, 'sell', sellAmount, feeRules);
  const sellFee = totalFees(sellFees);
  const buyFeeShare = totalFees(buyTrade.fees) * (remainingQty / buyTrade.qty);
  const gross = (estPrice - buyTrade.price) * remainingQty;
  return {
    gross: round2(gross),
    sellFee: round2(sellFee),
    sellFees,
    buyFeeShare: round2(buyFeeShare),
    net: round2(gross - sellFee - buyFeeShare),
  };
}
