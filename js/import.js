/**
 * Excel 交割单/对账单导入模块（基于 SheetJS）。
 * 流程：选文件 -> 自动识别表头 -> 用户确认/调整字段映射 -> 预览 -> 导入（自动去重）。
 */
'use strict';

/** 各字段可能出现的表头名称（覆盖常见券商导出格式） */
const HEADER_ALIASES = {
  date: ['成交日期', '交割日期', '发生日期', '委托日期', '交易日期', '日期'],
  time: ['成交时间', '委托时间', '交易时间', '时间'],
  code: ['证券代码', '股票代码', '基金代码', '代码'],
  name: ['证券名称', '股票名称', '基金名称', '证券简称', '名称'],
  side: ['操作', '买卖标志', '业务名称', '委托类别', '交易类别', '业务类型', '摘要', '买卖方向', '方向'],
  price: ['成交价格', '成交均价', '成交价', '价格', '委托价格'],
  qty: ['成交数量', '成交股数', '成交量', '数量', '发生数量'],
  // 注意：部分券商「发生金额」是含费用的资金流水（买入为负），不要映射到 amount
  amount: ['成交金额', '成交额'],
  commission: ['佣金', '净佣金', '手续费'],
  transfer: ['过户费'],
  stamp: ['印花税'],
  other: ['其他费', '其他杂费', '经手费', '规费', '结算费', '附加费'],
  seqNo: ['成交编号', '合同编号', '委托编号', '申请编号'],
};

const REQUIRED_FIELDS = ['date', 'code', 'side', 'price', 'qty'];
const FIELD_LABELS = {
  date: '成交日期', time: '成交时间', code: '证券代码', name: '证券名称', side: '买卖方向',
  price: '成交价格', qty: '成交数量', amount: '成交金额', commission: '佣金',
  transfer: '过户费', stamp: '印花税', other: '其他费用', seqNo: '成交编号',
};

/** 读取 Excel 文件 -> {headers, rows, mapping} */
function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!grid.length) throw new Error('文件是空的');

  // 在前 40 行中找表头行：命中别名最多的一行（券商对账单常有标题/资产汇总在前）
  let headerIdx = 0;
  let bestScore = -1;
  const allAliases = Object.values(HEADER_ALIASES).flat();
  for (let i = 0; i < Math.min(40, grid.length); i++) {
    const score = grid[i].filter((c) => allAliases.includes(String(c).trim())).length;
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  if (bestScore < 3) throw new Error('未能识别表头，请确认文件是交割单/对账单');
  const headers = grid[headerIdx].map((h) => String(h).trim());
  const rows = grid.slice(headerIdx + 1).filter((r) => r.some((c) => c !== '' && c != null));

  // 自动映射：按别名顺序精确匹配，其次包含匹配
  const mapping = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    let idx = -1;
    for (const a of aliases) {
      idx = headers.indexOf(a);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      idx = headers.findIndex((h) => h && aliases.some((a) => h.includes(a)));
    }
    if (idx >= 0) mapping[field] = idx;
  }
  return { headers, rows, mapping };
}

/** 把 Excel 的日期单元格统一为 YYYY-MM-DD */
function normalizeDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    if (v > 19000000) { // 形如 20260731
      const s = String(Math.round(v));
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    }
    // Excel 日期序列号
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim().replace(/[年月./]/g, '-').replace(/日/g, '');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
  return s;
}

/** 时间统一为 HH:MM:SS */
function normalizeTime(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    if (v < 1) { // Excel 时间小数
      const sec = Math.round(v * 86400);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
    }
    const s = String(Math.round(v)).padStart(6, '0'); // 形如 93005 -> 09:30:05
    return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) return [m[1], m[2], m[3] || '0'].map((x) => x.padStart(2, '0')).join(':');
  return s;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/[,，\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** 从"操作/摘要"文案判断买卖方向；非成交记录（分红、利息等）返回 null 跳过 */
function parseSide(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/(买入|证券买入|担保品买入|融资买入|买)/.test(s) && !/卖/.test(s)) return 'buy';
  if (/(卖出|证券卖出|担保品卖出|融券卖出|卖)/.test(s) && !/买/.test(s)) return 'sell';
  return null;
}

/**
 * 按映射把行数据转成成交记录数组。
 * @returns {{trades:Array, skippedRows:number}}
 */
function rowsToTrades(rows, mapping, feeRules) {
  const get = (row, field) => (mapping[field] != null ? row[mapping[field]] : '');
  const trades = [];
  let skippedRows = 0;
  for (const row of rows) {
    const side = parseSide(get(row, 'side'));
    const code = String(get(row, 'code') || '').trim().replace(/\.\w+$/, '').padStart(6, '0');
    const price = parseNum(get(row, 'price'));
    const qty = Math.abs(parseNum(get(row, 'qty')));
    if (!side || !/^\d{5,6}$/.test(code) || price <= 0 || qty <= 0) { skippedRows++; continue; }

    const amount = parseNum(get(row, 'amount')) || round2(price * qty);
    const secType = guessSecType(code);
    // 交割单里有实际费用就用实际值，否则按费率规则估算
    const hasFeeCols = mapping.commission != null || mapping.stamp != null;
    const fees = hasFeeCols
      ? {
          commission: parseNum(get(row, 'commission')),
          transfer: parseNum(get(row, 'transfer')),
          stamp: parseNum(get(row, 'stamp')),
          other: parseNum(get(row, 'other')),
        }
      : calcFees(secType, side, amount, feeRules);

    trades.push({
      date: normalizeDate(get(row, 'date')),
      time: normalizeTime(get(row, 'time')),
      code,
      name: String(get(row, 'name') || '').trim(),
      secType,
      side,
      price,
      qty,
      amount,
      fees,
      feeSource: hasFeeCols ? 'statement' : 'computed',
      seqNo: String(get(row, 'seqNo') || '').trim(),
      estSell: null,
      source: 'import',
    });
  }
  return { trades, skippedRows };
}
