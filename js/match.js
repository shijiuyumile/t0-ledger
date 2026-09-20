/**
 * 核销引擎：
 * - closest（默认）：价格最相近配对
 * - time：按成交时间 FIFO；先卖无多头 → 待回补，之后买入优先回补
 * 支持 fromDate 底仓切割（做T时间视图）。
 */
'use strict';

function tradeTimeKey(t) {
  return (t.date || '') + ' ' + (t.time || '00:00:00');
}

function emptySellResult() {
  return {
    pairs: [],
    matchedQty: 0,
    unmatchedQty: 0,
    grossPnl: 0,
    sellFee: 0,
    buyFeeShare: 0,
    netPnl: 0,
    success: false,
    isT: false,
    tNetPnl: 0,
    tMatchedQty: 0,
    posMatchedQty: 0,
    posNetPnl: 0,
    isPosOnly: false,
    isReverse: false,
  };
}

function finalizeSellResult(sell, r) {
  const sellFeeAll = totalFees(sell.fees);
  const matchedQty = r.matchedQty;
  r.unmatchedQty = Math.max(0, sell.qty - matchedQty);
  r.sellFee = matchedQty === 0
    ? 0
    : (matchedQty === sell.qty ? sellFeeAll : round2(sellFeeAll * (matchedQty / sell.qty)));
  r.grossPnl = round2(r.grossPnl);
  r.buyFeeShare = round2(r.buyFeeShare);
  r.netPnl = round2(r.grossPnl - r.sellFee - r.buyFeeShare);
  r.success = matchedQty > 0 && r.netPnl > 0;
  r.isT = matchedQty > 0;
  r.tNetPnl = r.netPnl;
  r.tMatchedQty = matchedQty;
  return r;
}

/**
 * @param {object[]} trades
 * @param {{ fromDate?: string, mode?: 'closest'|'time' }} [opts]
 */
function computeMatches(trades, opts) {
  const mode = opts && opts.mode === 'time' ? 'time' : 'closest';
  if (mode === 'time') return computeMatchesTime(trades, opts);
  return computeMatchesClosest(trades, opts);
}

function computeMatchesClosest(trades, opts) {
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
    const r = emptySellResult();
    let remaining = sell.qty;

    while (remaining > 0) {
      const pick = pickClosestBuy(sell.price, candidates, lots);
      if (!pick) break;
      const lot = lots.get(pick.id);
      const q = Math.min(remaining, lot.remainingQty);
      lot.remainingQty -= q;
      lot.matchedQty += q;
      lot.matches.push({ sellId: sell.id, qty: q, sellPrice: sell.price });
      const share = totalFees(pick.fees) * (q / pick.qty);
      r.buyFeeShare += share;
      r.grossPnl += (sell.price - pick.price) * q;
      r.pairs.push({
        buyId: pick.id, qty: q, buyPrice: pick.price, buyDate: pick.date,
        buyFeeShare: round2(share), kind: 'long',
      });
      r.matchedQty += q;
      remaining -= q;
    }

    sells.set(sell.id, finalizeSellResult(sell, r));
  }

  return { lots, sells, pendingCovers: [], mode: 'closest' };
}

/**
 * 时间序 FIFO：先买后卖配最早买单；先卖无多头进待回补，之后买入优先回补。
 */
function computeMatchesTime(trades, opts) {
  const fromDate = opts && opts.fromDate ? String(opts.fromDate) : '';
  const lots = new Map();
  const sells = new Map();
  const pendingCovers = []; // 最终仍未回补的空头
  const longsByCode = new Map(); // code -> [{ trade, lot }] queue FIFO
  const shortsByCode = new Map(); // code -> [{ sell, remaining, sellFeeLeft }] queue FIFO

  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const isBase = !!(fromDate && t.date < fromDate);
    lots.set(t.id, { remainingQty: t.qty, matchedQty: 0, matches: [], isBase });
  }

  const events = trades
    .filter((t) => !fromDate || t.date >= fromDate)
    .slice()
    .sort((a, b) => tradeTimeKey(a).localeCompare(tradeTimeKey(b)) || (a.seq || 0) - (b.seq || 0));

  function ensureSell(sell) {
    if (!sells.has(sell.id)) {
      const r = emptySellResult();
      r.unmatchedQty = sell.qty;
      sells.set(sell.id, r);
    }
    return sells.get(sell.id);
  }

  for (const t of events) {
    if (t.side === 'buy') {
      const lot = lots.get(t.id);
      if (!lot || lot.isBase) continue;

      let buyLeft = t.qty;
      if (!shortsByCode.has(t.code)) shortsByCode.set(t.code, []);
      const shorts = shortsByCode.get(t.code);

      while (buyLeft > 0 && shorts.length) {
        const sh = shorts[0];
        const q = Math.min(buyLeft, sh.remaining);
        const sell = sh.sell;
        const r = ensureSell(sell);
        const buyShare = totalFees(t.fees) * (q / t.qty);
        const sellShare = totalFees(sell.fees) * (q / sell.qty);
        // 倒T：卖高买低为正
        r.grossPnl += (sell.price - t.price) * q;
        r.buyFeeShare += buyShare;
        r.matchedQty += q;
        r.isReverse = true;
        r.pairs.push({
          buyId: t.id, qty: q, buyPrice: t.price, buyDate: t.date,
          buyFeeShare: round2(buyShare), kind: 'cover',
        });
        lot.matchedQty += q;
        lot.matches.push({ sellId: sell.id, qty: q, sellPrice: sell.price, kind: 'cover' });
        sh.remaining -= q;
        buyLeft -= q;
        if (sh.remaining <= 0) shorts.shift();
      }

      lot.remainingQty = buyLeft;
      if (buyLeft > 0) {
        if (!longsByCode.has(t.code)) longsByCode.set(t.code, []);
        longsByCode.get(t.code).push({ trade: t, lot });
      }
      continue;
    }

    if (t.side !== 'sell') continue;
    const r = ensureSell(t);
    let sellLeft = t.qty;

    if (!longsByCode.has(t.code)) longsByCode.set(t.code, []);
    const longs = longsByCode.get(t.code);

    while (sellLeft > 0 && longs.length) {
      const entry = longs[0];
      const buy = entry.trade;
      const lot = entry.lot;
      if (lot.remainingQty <= 0) { longs.shift(); continue; }
      const q = Math.min(sellLeft, lot.remainingQty);
      const share = totalFees(buy.fees) * (q / buy.qty);
      r.grossPnl += (t.price - buy.price) * q;
      r.buyFeeShare += share;
      r.matchedQty += q;
      r.pairs.push({
        buyId: buy.id, qty: q, buyPrice: buy.price, buyDate: buy.date,
        buyFeeShare: round2(share), kind: 'long',
      });
      lot.remainingQty -= q;
      lot.matchedQty += q;
      lot.matches.push({ sellId: t.id, qty: q, sellPrice: t.price, kind: 'long' });
      sellLeft -= q;
      if (lot.remainingQty <= 0) longs.shift();
    }

    if (sellLeft > 0) {
      if (!shortsByCode.has(t.code)) shortsByCode.set(t.code, []);
      shortsByCode.get(t.code).push({ sell: t, remaining: sellLeft });
    }
  }

  for (const sell of trades) {
    if (sell.side !== 'sell') continue;
    if (fromDate && sell.date < fromDate) continue;
    const r = ensureSell(sell);
    finalizeSellResult(sell, r);
  }

  for (const [, shorts] of shortsByCode) {
    for (const sh of shorts) {
      if (sh.remaining <= 0) continue;
      pendingCovers.push({
        sellId: sh.sell.id,
        code: sh.sell.code,
        name: sh.sell.name || '',
        secType: sh.sell.secType || 'stock',
        price: sh.sell.price,
        qty: sh.remaining,
        date: sh.sell.date,
        time: sh.sell.time || '',
        fees: sh.sell.fees,
      });
    }
  }

  return { lots, sells, pendingCovers, mode: 'time' };
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
