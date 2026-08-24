# 做T台账

> **给其他 AI / 换助手时**：请先阅读 [`AI-HANDOFF.md`](./AI-HANDOFF.md)。  
> 日常「更新对账单数据」的完整步骤、仓库地址、手机同步原理都写在那里。

A 股散户做 T+0 的「买入成本台账」手机应用（PWA）。

- **线上地址（固定，无需重装）**：https://shijiuyumile.github.io/t0-ledger/
- **GitHub 仓库**：https://github.com/shijiuyumile/t0-ledger

## 最快：更新最新对账单

```bash
cd "D:\我的cursor项目文件\t0-ledger"
node tools/merge-xlsx.js "对账单.xlsx的完整路径"
# 然后把 sw.js 中 CACHE_VERSION +1，git add/commit/push origin main
```

详见 [AI-HANDOFF.md](./AI-HANDOFF.md) 第 4 节。

---

## 功能概要

- **买入成本台账**：按标的分组（可折叠）展示待做T买单；可「已做T隐藏」+「显示已隐藏」开关；每笔可填预估卖价试算利润。
- **价格最相近核销**：卖单与剩余买单按价格最相近配对（不限同日），级联数量；净利>0 为做T成功。
- **战绩**：账户总盈亏 = 已实现 + 持仓浮动 + 股息利息；按标的分列盈利合计/亏损合计。
- **交割单**：Excel 增量导入/合并，自动去重；也可 APP 内手动导入。
- **费率**：股票万0.85最低5 + 过户万0.1双向 + 印花万5仅卖；ETF万0.5最低0.1；债券万0.1。
- 亮色、红涨绿跌、iPhone PWA。

## iPhone 使用

Safari 打开线上地址 → 分享 → **添加到主屏幕**。数据在手机本地；打开 APP 会从 `data/seed.json` 增量同步云端成交。请定期在「我的」导出 JSON 备份。

## 本地预览

```bash
node tools/serve.js 8765
```

## 改代码后

`sw.js` 的 `CACHE_VERSION` 必须 +1，否则手机可能继续用旧缓存。

## 算法自测

```bash
node tools/test-match.js
```
