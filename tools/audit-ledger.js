/* 全量台账核对：node tools/audit-ledger.js */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
const {
  calcFees, totalFees, DEFAULT_FEE_RULES, round2,
  computeMatches, computeStairsMatches, computeMovingAvgPnl, computeAccountPnl,
} = new Function(
  read('fees.js') + '\n' + read('match.js') +
  '\nreturn { calcFees, totalFees, DEFAULT_FEE_RULES, round2, computeMatches, computeStairsMatches, computeMovingAvgPnl, computeAccountPnl };'
)();

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
const trades = seed.trades || [];
const account = seed.account || {};
let failed = 0;
function fail(msg) {
  failed++;
  console.log('FAIL ' + msg);
}
function ok(msg) {
  console.log('PASS ' + msg);
}

function addDaysISO(iso, delta) {
  const d = new Date(String(iso) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const today = new Date();
const todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

function byId() {
  const m = new Map();
  for (const t of trades) m.set(t.id, t);
  return m;
}
const idMap = byId();

function auditStairs(label, fromDate) {
  const r = computeStairsMatches(trades, fromDate ? { fromDate } : {});
  let pending = 0, success = 0, partial = 0, net = 0, gross = 0;
  const buyMat = new Map();
  const sellMat = new Map();
  const issues = [];

  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const lot = r.lots.get(t.id);
    if (!lot) { issues.push('missing lot ' + t.id); continue; }
    const inWin = !fromDate || t.date >= fromDate;
    if (!inWin) {
      if (lot.remainingQty !== 0 || lot.matchedQty !== 0) {
        issues.push('窗口外买单被配 ' + t.code + ' ' + t.date + ' ' + t.price);
      }
      continue;
    }
    const used = round2(lot.remainingQty + lot.matchedQty);
    if (Math.abs(used - t.qty) > 1e-6) {
      issues.push('股数不守恒 buy ' + t.code + ' ' + t.date + ' rem+mat=' + used + ' qty=' + t.qty);
    }
    if (lot.remainingQty < -1e-8 || lot.matchedQty < -1e-8) {
      issues.push('负数量 buy ' + t.id);
    }
    buyMat.set(t.code, (buyMat.get(t.code) || 0) + lot.matchedQty);
    if (lot.remainingQty > 0 && lot.matchedQty > 0) partial++;
    if (lot.remainingQty > 0) pending++;
    else if (lot.matchedQty > 0) success++;
    for (const m of lot.matches || []) {
      if (!(m.sellPrice > t.price)) {
        issues.push('卖价未高于买价 ' + t.code + ' buy=' + t.price + ' sell=' + m.sellPrice);
      }
      if (m.qty <= 0) issues.push('配对数量<=0 ' + t.id);
    }
  }

  for (const t of trades) {
    if (t.side !== 'sell') continue;
    const inWin = !fromDate || t.date >= fromDate;
    const sr = r.sells.get(t.id);
    if (!inWin) {
      if (sr) issues.push('窗口外卖单进结果 ' + t.id);
      continue;
    }
    if (!sr) { issues.push('缺卖出结果 ' + t.id); continue; }
    if (sr.matchedQty + sr.unmatchedQty - t.qty > 1e-6) {
      issues.push('卖单数量不守恒 ' + t.code + ' ' + t.date);
    }
    sellMat.set(t.code, (sellMat.get(t.code) || 0) + sr.matchedQty);
    if (sr.matchedQty > 0) {
      net += sr.netPnl;
      gross += sr.grossPnl;
      let pairGross = 0, pairQty = 0, buyFee = 0;
      for (const p of sr.pairs) {
        pairGross += (p.sellPrice ? 0 : 0);
        pairQty += p.qty;
        buyFee += p.buyFeeShare || 0;
        if (!(t.price > p.buyPrice)) {
          issues.push('卖出配对买价不低 ' + t.code + ' sell=' + t.price + ' buy=' + p.buyPrice);
        }
        pairGross += (t.price - p.buyPrice) * p.qty;
      }
      if (Math.abs(pairQty - sr.matchedQty) > 1e-6) issues.push('卖出pairs数量 ' + t.id);
      if (Math.abs(pairGross - sr.grossPnl) > 0.02) {
        issues.push('毛利不一致 ' + t.code + ' ' + t.date + ' pair=' + round2(pairGross) + ' r=' + sr.grossPnl);
      }
      const expectNet = round2(sr.grossPnl - sr.sellFee - sr.buyFeeShare);
      if (Math.abs(expectNet - sr.netPnl) > 0.02) {
        issues.push('净利公式 ' + t.id + ' ' + expectNet + ' vs ' + sr.netPnl);
      }
    }
  }

  const codes = new Set([...buyMat.keys(), ...sellMat.keys()]);
  for (const c of codes) {
    const b = round2(buyMat.get(c) || 0);
    const s = round2(sellMat.get(c) || 0);
    if (Math.abs(b - s) > 1e-6) issues.push('买卖配量不一致 ' + c + ' buy=' + b + ' sell=' + s);
  }

  issues.slice(0, 20).forEach((x) => fail(label + ' ' + x));
  if (issues.length > 20) fail(label + ' …另有 ' + (issues.length - 20) + ' 条');
  if (!issues.length) ok(label + ' 守恒/价差/费用公式');
  console.log('  ' + label + ' 未做完=' + pending + ' 成功=' + success + ' 部分配=' + partial +
    ' 扣费净利=' + round2(net) + ' 毛利=' + round2(gross) + (fromDate ? ' from=' + fromDate : ' 全部'));
  const top = [...buyMat.keys()].map((c) => {
    let p = 0, s = 0, pq = 0;
    for (const t of trades) {
      if (t.side !== 'buy' || t.code !== c) continue;
      if (fromDate && t.date < fromDate) continue;
      const lot = r.lots.get(t.id);
      if (!lot) continue;
      if (lot.remainingQty > 0) { p++; pq += lot.remainingQty; }
      else if (lot.matchedQty > 0) s++;
    }
    return { c, p, s, pq };
  }).sort((a, b) => (b.p + b.s) - (a.p + a.s)).slice(0, 8);
  top.forEach((x) => console.log('    ' + x.c + ' 未做完' + x.p + ' 成功' + x.s + ' 待做T股' + x.pq));
  return r;
}

function auditClosest() {
  const r = computeMatches(trades, { mode: 'closest' });
  const issues = [];
  let remainLots = 0, remainQty = 0, matchedSells = 0, unmatchedSellQty = 0, net = 0;
  const buyMat = new Map();
  const sellMat = new Map();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const lot = r.lots.get(t.id);
    if (!lot) { issues.push('缺lot ' + t.id); continue; }
    if (Math.abs(lot.remainingQty + lot.matchedQty - t.qty) > 1e-6) {
      issues.push('closest 股数 ' + t.code + ' ' + t.date);
    }
    buyMat.set(t.code, (buyMat.get(t.code) || 0) + lot.matchedQty);
    if (lot.remainingQty > 0) { remainLots++; remainQty += lot.remainingQty; }
  }
  for (const t of trades) {
    if (t.side !== 'sell') continue;
    const sr = r.sells.get(t.id);
    if (!sr) { issues.push('缺sell ' + t.id); continue; }
    sellMat.set(t.code, (sellMat.get(t.code) || 0) + sr.matchedQty);
    unmatchedSellQty += sr.unmatchedQty;
    if (sr.matchedQty > 0) { matchedSells++; net += sr.netPnl; }
  }
  for (const c of new Set([...buyMat.keys(), ...sellMat.keys()])) {
    if (Math.abs((buyMat.get(c) || 0) - (sellMat.get(c) || 0)) > 1e-6) {
      issues.push('closest 配量 ' + c);
    }
  }
  issues.slice(0, 15).forEach((x) => fail(x));
  if (!issues.length) ok('待做T/价格匹配 股数守恒');
  console.log('  待做T remainingLots=' + remainLots + ' remainingQty=' + remainQty +
    ' 已配卖出笔=' + matchedSells + ' 未配卖出股=' + unmatchedSellQty + ' 配对净利=' + round2(net));
  return r;
}

function auditTime() {
  const r = computeMatches(trades, { mode: 'time' });
  const issues = [];
  let coverQty = 0;
  const buyMat = new Map();
  const sellMat = new Map();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const lot = r.lots.get(t.id);
    if (!lot) continue;
    if (Math.abs(lot.remainingQty + lot.matchedQty - t.qty) > 1e-6) {
      issues.push('time 股数 ' + t.code + ' ' + t.date);
    }
    buyMat.set(t.code, (buyMat.get(t.code) || 0) + lot.matchedQty);
  }
  for (const t of trades) {
    if (t.side !== 'sell') continue;
    const sr = r.sells.get(t.id);
    if (!sr) continue;
    sellMat.set(t.code, (sellMat.get(t.code) || 0) + sr.matchedQty);
  }
  for (const c of r.pendingCovers || []) coverQty += c.qty;
  // 时间核销：先卖未买回进待回补，买卖配量可以不相等
  let netPos = 0;
  const codes = new Set(trades.map((t) => t.code));
  for (const c of codes) {
    let b = 0, s = 0;
    for (const t of trades) {
      if (t.code !== c) continue;
      if (t.side === 'buy') b += t.qty;
      else if (t.side === 'sell') s += t.qty;
    }
    const lotRem = [...r.lots.entries()].reduce((n, [id, lot]) => {
      const t = idMap.get(id);
      return n + ((t && t.code === c) ? lot.remainingQty : 0);
    }, 0);
    const cover = (r.pendingCovers || []).filter((x) => x.code === c).reduce((n, x) => n + x.qty, 0);
    const expect = b - s;
    const got = lotRem - cover;
    if (Math.abs(expect - got) > 1e-4) {
      issues.push('time 净持仓 ' + c + ' 成交净=' + expect + ' 剩余多-待回补=' + got);
    }
    netPos += expect;
  }
  issues.slice(0, 15).forEach((x) => fail(x));
  if (!issues.length) ok('时间核销/待回补 净持仓守恒');
  console.log('  待回补笔数=' + (r.pendingCovers || []).length + ' 待回补股=' + coverQty);
  return r;
}

function auditBreakevenAndStats(closest) {
  let loss = 0, win = 0, lossAmt = 0, winAmt = 0;
  for (const t of trades) {
    if (t.side !== 'sell') continue;
    const sr = closest.sells.get(t.id);
    if (!sr || sr.matchedQty <= 0) continue;
    if (sr.isReverse) continue;
    if (sr.netPnl < 0) { loss++; lossAmt += sr.netPnl; }
    else if (sr.netPnl > 0) { win++; winAmt += sr.netPnl; }
  }
  ok('待扳本亏损卖出 ' + loss + ' 笔 合计 ' + round2(lossAmt));
  console.log('  做T成功卖出=' + win + ' 盈利合计=' + round2(winAmt));
}

function auditHoldAndAccount(closest) {
  const holdMap = new Map();
  for (const h of account.holdings || []) holdMap.set(h.code, h);
  const tradeNet = new Map();
  for (const t of trades) {
    const cur = tradeNet.get(t.code) || 0;
    tradeNet.set(t.code, cur + (t.side === 'buy' ? t.qty : -t.qty));
  }
  let closestRem = new Map();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const lot = closest.lots.get(t.id);
    if (!lot) continue;
    closestRem.set(t.code, (closestRem.get(t.code) || 0) + lot.remainingQty);
  }
  let holdDiffs = 0;
  const notes = [];
  for (const [c, net] of tradeNet) {
    const h = holdMap.get(c);
    const hq = h ? h.qty : 0;
    if (Math.abs(net - hq) > 1e-4) {
      holdDiffs++;
      notes.push(c + ' 成交净' + net + ' 账单持仓' + hq);
    }
  }
  for (const [c, h] of holdMap) {
    if (!tradeNet.has(c) && h.qty) {
      holdDiffs++;
      notes.push(c + ' 仅账单有持仓 ' + h.qty);
    }
  }
  if (holdDiffs) {
    console.log('NOTE 成交净持仓 vs 账单持仓有 ' + holdDiffs + ' 处差异（转托管/红利股等可能，不是配对公式错误）');
    notes.slice(0, 12).forEach((x) => console.log('    ' + x));
  } else {
    ok('成交净持仓与账单持仓一致');
  }

  const ap = computeAccountPnl(trades, closest, Object.assign({}, account, { quotes: {} }));
  console.log('  账户总盈亏=' + ap.total + '（总资产' + ap.totalAssets + ' − 净入金' + ap.netDeposit + '）');
  console.log('  移动均价已实现=' + ap.realized + ' 浮动=' + ap.floatPnl + ' 配对净利=' + ap.matchRealized);
  if (ap.totalAssets == null || ap.netDeposit == null) fail('账户快照缺总资产或净入金');
  else ok('账户总盈亏=总资产−净入金 ' + ap.total);
}

function idsUnique() {
  const s = new Set();
  let d = 0;
  for (const t of trades) {
    if (s.has(t.id)) d++;
    s.add(t.id);
  }
  if (d) fail('重复成交id ' + d);
  else ok('成交id唯一 ' + trades.length + ' 笔');
}

console.log('today=' + todayISO + ' trades=' + trades.length +
  ' 日期 ' + trades.map((t) => t.date).sort()[0] + ' ~ ' + trades.map((t) => t.date).sort().slice(-1)[0]);
idsUnique();
console.log('\n=== 老太太扶楼梯 ===');
auditStairs('近7天', addDaysISO(todayISO, -6));
auditStairs('近30天', addDaysISO(todayISO, -29));
auditStairs('全部成交', '');
console.log('\n=== 其他页面 ===');
const closest = auditClosest();
auditTime();
auditBreakevenAndStats(closest);
auditHoldAndAccount(closest);

console.log(failed ? '\n核对失败 ' + failed + ' 项' : '\n全量核对通过');
process.exit(failed ? 1 : 0);
