/**
 * 费率计算模块
 * 默认按用户券商规则：
 *  - 股票：佣金万0.85（最低5元）+ 过户费万0.1（双向）+ 印花税万5（仅卖出）
 *  - ETF：佣金万0.5（最低0.1元），免过户费、免印花税
 *  - 债券：佣金万0.1，无最低，免过户费、免印花税
 * 费率可在"设置"中修改，存于 settings.feeRules。
 */
'use strict';

const DEFAULT_FEE_RULES = {
  stock: { commissionRate: 0.000085, commissionMin: 5, transferRate: 0.00001, stampRate: 0.0005 },
  etf: { commissionRate: 0.00005, commissionMin: 0.1, transferRate: 0, stampRate: 0 },
  bond: { commissionRate: 0.00001, commissionMin: 0, transferRate: 0, stampRate: 0 },
};

const SEC_TYPE_LABEL = { stock: '股票', etf: 'ETF', bond: '债券' };

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * 按证券代码猜测品种类型。识别不了时默认按股票（费率最高，宁可高估费用）。
 */
function guessSecType(code) {
  const c = String(code || '');
  // 沪市 ETF：51/52/56/58 开头；深市 ETF：159 开头
  if (/^(51|52|56|58)/.test(c) || /^159/.test(c)) return 'etf';
  // 可转债/国债等：沪 100/110/111/113/118/019/020，深 123/127/128/101
  if (/^(10|11|12|01|02)/.test(c)) return 'bond';
  return 'stock';
}

/**
 * 计算一笔成交的各项费用（按当前费率规则）。
 * @param {'stock'|'etf'|'bond'} secType
 * @param {'buy'|'sell'} side
 * @param {number} amount 成交金额
 * @param {object} rules 费率规则（缺省用 DEFAULT_FEE_RULES）
 * @returns {{commission:number, transfer:number, stamp:number, other:number}}
 */
function calcFees(secType, side, amount, rules) {
  const all = rules || DEFAULT_FEE_RULES;
  const r = all[secType] || all.stock;
  const commission = round2(Math.max(amount * r.commissionRate, r.commissionMin));
  const transfer = round2(amount * r.transferRate);
  const stamp = side === 'sell' ? round2(amount * r.stampRate) : 0;
  return { commission, transfer, stamp, other: 0 };
}

function totalFees(fees) {
  if (!fees) return 0;
  return round2((fees.commission || 0) + (fees.transfer || 0) + (fees.stamp || 0) + (fees.other || 0));
}
