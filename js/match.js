/**
 * 核销引擎："价格最相近"配对（不限是否同日）。
 * 卖单与同代码剩余买单配对：优先卖价之上最接近的买价，级联直至配完。
 * 整笔卖单扣双边费用后净赚 => 做T成功；净亏 => 亏损卖出。
 * 兼容同日先卖后买回。
 */
'use strict';

function tradeTimeKey(t) {
  return (t.date || '') + ' ' + (t.time || '00:00:00');
}

/**
 * @param {object[]} trades
 * @param {{ fromDate?: string }} [opts] 若设 fromDate(YYYY-MM-DD)：
 *   - 该日之前的买单视为底仓，不参与配对
 *   - 该日之前的卖单不参与本口径核销（仅做T时间视图用）
 */
function computeMatches(trades, opts) {
  const fromDate = opts && opts.fromDate ? String(opts.fromDate) : '';
  const lots = new Map();
  const sells = new Map();
  const buysByCode = new Map();

  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const isBase = !!(fromDate && t.date < fromDate);
    lots.set(t.id, { remainingQty: t.qty, matchedQty: 0, matches: [], isBase });
    if (isBase) continue;
    if (!buysByCode.has(t.code)) buysByCode.set(t.code, []);
    buysByCode.get(t.code).push(t);
  }

  const sellTrades = trades
    .filter((t) => t.side === 'sell' && (!fromDate || t.date >= fromDate))
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
      isT: matchedQty > 0,
      tNetPnl: netPnl,
      tMatchedQty: matchedQty,
      posMatchedQty: 0,
      posNetPnl: 0,
      isPosOnly: false,
    });
  }

  return { lots, sells };
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

/**
 * 账户总盈亏（对齐券商常见口径）：
 * 总盈亏 = 已实现盈亏(卖出配对净利) + 持仓浮动盈亏 + 股息 + 利息
 * 浮动盈亏优先用对账单持仓盈亏；若用户填了现价则按现价重算。
 */
function computeAccountPnl(trades, matchResult, account) {
  let realized = 0;
  let realizedWin = 0;
  let realizedLoss = 0;
  for (const t of trades) {
    if (t.side !== 'sell') continue;
    const r = matchResult.sells.get(t.id);
    if (!r || r.matchedQty === 0) continue;
    realized += r.netPnl;
    if (r.netPnl > 0) realizedWin += r.netPnl;
    else realizedLoss += r.netPnl;
  }

  let floatPnl = 0;
  const holdings = (account && account.holdings) || [];
  // 优先用对账单「持仓盈亏合计」（含已清仓但仍挂账的盈亏）
  if (account && account.holdPnlTotal != null && !Number.isNaN(Number(account.holdPnlTotal))) {
    floatPnl = Number(account.holdPnlTotal);
  } else {
    for (const h of holdings) {
      const quote = (account.quotes && account.quotes[h.code]) || h.lastPrice;
      if (quote > 0 && h.qty > 0 && h.costPrice > 0) {
        floatPnl += (quote - h.costPrice) * h.qty;
      } else {
        floatPnl += h.holdPnl || 0;
      }
    }
  }
  floatPnl = round2(floatPnl);
  const dividends = (account && account.dividends) || 0;
  const interest = (account && account.interest) || 0;
  const total = round2(realized + floatPnl + dividends + interest);
  const netDeposit = account ? account.netDeposit : null;
  const totalAssets = account ? account.totalAssets : null;
  const assetStyle = (totalAssets != null && netDeposit != null)
    ? round2(totalAssets - netDeposit) : null;

  return {
    realized: round2(realized),
    realizedWin: round2(realizedWin),
    realizedLoss: round2(realizedLoss),
    floatPnl,
    dividends: round2(dividends),
    interest: round2(interest),
    total,
    assetStyle,
    totalAssets,
    netDeposit,
  };
}
