/**
 * 核销引擎：两阶段配对
 *
 * 阶段1（做T）：卖单只与「同一天」的剩余买单按价格最相近配对 → 计入做T战绩。
 * 阶段2（平仓）：同日配完后仍剩余的卖量，再与跨日买单核销 → 只扣减台账库存，
 *               盈亏记为「平仓兑现」，不计入做T成功/亏损（避免把底仓涨跌算成做T利润）。
 *
 * 同日价格最相近规则：
 *  优先 买价 <= 卖价 中买价最高者；否则 买价 > 卖价 中买价最低者；数量不等则级联。
 *  盈亏 = Σ(卖价−买价)×数量 − 卖费按比例 − 买费按比例。
 */
'use strict';

function tradeTimeKey(t) {
  return (t.date || '') + ' ' + (t.time || '00:00:00');
}

/**
 * @param {Array} trades
 * @returns {{lots: Map, sells: Map}}
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
    const allBuys = buysByCode.get(sell.code) || [];
    const sameDayBuys = allBuys.filter((b) => b.date === sell.date);

    const tPart = allocateSell(sell, sameDayBuys, lots, sell.qty, 't');
    const posPart = allocateSell(sell, allBuys, lots, tPart.leftover, 'pos');

    const sellFeeAll = totalFees(sell.fees);
    const tMatched = tPart.matchedQty;
    const posMatched = posPart.matchedQty;
    const matchedQty = tMatched + posMatched;
    const unmatchedQty = sell.qty - matchedQty;

    const tSellFee = matchedQty ? round2(sellFeeAll * (tMatched / sell.qty)) : 0;
    const posSellFee = matchedQty ? round2(sellFeeAll * (posMatched / sell.qty)) : 0;
    // 未配对部分费用不计入盈亏（底仓卖出无对应买单）

    const tNetPnl = round2(tPart.grossPnl - tSellFee - tPart.buyFeeShare);
    const posNetPnl = round2(posPart.grossPnl - posSellFee - posPart.buyFeeShare);

    sells.set(sell.id, {
      pairs: tPart.pairs.concat(posPart.pairs),
      tPairs: tPart.pairs,
      posPairs: posPart.pairs,
      matchedQty,
      tMatchedQty: tMatched,
      posMatchedQty: posMatched,
      unmatchedQty,
      grossPnl: round2(tPart.grossPnl + posPart.grossPnl),
      tGrossPnl: round2(tPart.grossPnl),
      posGrossPnl: round2(posPart.grossPnl),
      sellFee: round2(tSellFee + posSellFee),
      buyFeeShare: round2(tPart.buyFeeShare + posPart.buyFeeShare),
      // 战绩/筛选默认只用「同日做T」净利
      netPnl: tNetPnl,
      tNetPnl,
      posNetPnl,
      success: tMatched > 0 && tNetPnl > 0,
      isT: tMatched > 0,
      isPosOnly: tMatched === 0 && posMatched > 0,
    });
  }

  return { lots, sells };
}

function allocateSell(sell, candidates, lots, qtyLimit, kind) {
  const pairs = [];
  let remaining = qtyLimit;
  let grossPnl = 0;
  let buyFeeShare = 0;
  if (remaining <= 0) {
    return { pairs, matchedQty: 0, leftover: 0, grossPnl: 0, buyFeeShare: 0 };
  }

  while (remaining > 0) {
    const pick = pickClosestBuy(sell.price, candidates, lots);
    if (!pick) break;
    const lot = lots.get(pick.id);
    const q = Math.min(remaining, lot.remainingQty);
    lot.remainingQty -= q;
    lot.matchedQty += q;
    lot.matches.push({ sellId: sell.id, qty: q, sellPrice: sell.price, kind });
    const share = totalFees(pick.fees) * (q / pick.qty);
    buyFeeShare += share;
    grossPnl += (sell.price - pick.price) * q;
    pairs.push({
      buyId: pick.id, qty: q, buyPrice: pick.price, buyDate: pick.date,
      buyFeeShare: round2(share), kind,
    });
    remaining -= q;
  }

  return {
    pairs,
    matchedQty: qtyLimit - remaining,
    leftover: remaining,
    grossPnl,
    buyFeeShare,
  };
}

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
