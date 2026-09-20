/**
 * 数据存储模块：localStorage 持久化（数据只存在本机/本手机，支持 JSON 备份导出导入）。
 */
'use strict';

const STORE_KEY = 't0ledger.v1';

const Store = {
  data: null,

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      this.data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('读取本地数据失败，使用空数据启动', e);
      alert('读取本地数据失败：' + e.message + '\n如反复出现请在"我的"页导出备份后清空数据。');
      this.data = null;
    }
    if (!this.data || !Array.isArray(this.data.trades)) {
      this.data = { version: 1, trades: [], settings: {}, account: null };
    }
    if (!this.data.account) this.data.account = null;
    const s = this.data.settings;
    if (!s.lotSort) s.lotSort = 'asc';
    if (!s.feeRules) s.feeRules = JSON.parse(JSON.stringify(DEFAULT_FEE_RULES));
    if (!s.sellFilter) s.sellFilter = 'loss';
    if (!s.quotes) s.quotes = {};
    if (s.showHiddenLots == null) s.showHiddenLots = false;
    if (!s.ledgerMode) s.ledgerMode = 'full'; // full | tWindow
    if (!s.tWindowPreset) s.tWindowPreset = 'd5';
    if (s.tFromDate == null) s.tFromDate = '';
    if (!s.unprofitableDisplay) s.unprofitableDisplay = 'tWindow'; // tWindow | full
    return this.data;
  },

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('保存本地数据失败', e);
      alert('保存失败（可能是存储空间已满）：' + e.message + '\n请先在"我的"页导出 JSON 备份！');
    }
  },

  get trades() { return this.data.trades; },
  get settings() { return this.data.settings; },
  get account() { return this.data.account; },

  /** 生成去重键：有成交编号用成交编号，否则用 日期+时间+代码+方向+价格+数量 */
  dedupKey(t, occurrence) {
    const base = t.seqNo
      ? [t.date, t.code, t.side, t.seqNo].join('|')
      : [t.date, t.time || '', t.code, t.side, t.price, t.qty].join('|');
    return occurrence > 0 ? base + '#' + occurrence : base;
  },

  existingKeys() {
    return new Set(this.data.trades.map((t) => t.key));
  },

  /**
   * 批量追加成交（增量导入）。同一批文件内完全相同的行按出现次数编号（视为多笔真实成交），
   * 与库中已有记录重复的自动跳过。
   * @returns {{added:number, skipped:number}}
   */
  addTrades(newTrades) {
    const existing = this.existingKeys();
    const seenInBatch = new Map();
    let added = 0;
    let skipped = 0;
    for (const t of newTrades) {
      const baseKey = this.dedupKey(t, 0);
      const occ = seenInBatch.get(baseKey) || 0;
      seenInBatch.set(baseKey, occ + 1);
      const key = this.dedupKey(t, occ);
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      t.key = key;
      t.id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      t.seq = this.data.trades.length;
      this.data.trades.push(t);
      added++;
    }
    if (added > 0) this.save();
    return { added, skipped };
  },

  removeTrade(id) {
    const i = this.data.trades.findIndex((t) => t.id === id);
    if (i >= 0) {
      this.data.trades.splice(i, 1);
      this.save();
    }
  },

  updateTrade(id, patch) {
    const t = this.data.trades.find((x) => x.id === id);
    if (t) {
      Object.assign(t, patch);
      this.save();
    }
  },

  /** 修改某代码全部记录的品种类型，并按新费率重算"非交割单来源"的费用 */
  setSecType(code, secType) {
    for (const t of this.data.trades) {
      if (t.code !== code) continue;
      t.secType = secType;
      if (t.feeSource !== 'statement') {
        t.fees = calcFees(secType, t.side, t.amount, this.settings.feeRules);
      }
    }
    this.save();
  },

  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  },

  importJSON(text) {
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.trades)) throw new Error('不是有效的备份文件');
    this.data = obj;
    this.save();
    this.load();
  },

  clearAll() {
    this.data = { version: 1, trades: [], settings: this.data.settings };
    this.save();
    this.load();
  },
};
