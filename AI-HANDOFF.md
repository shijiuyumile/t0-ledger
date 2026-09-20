# 做T台账 — AI / 开发者交接手册

> **给后续 AI 助手**：本文是本项目的权威操作说明。用户若说「更新做T数据」「合并对账单」「改台账功能」，请先读完本文再动手。  
> **给用户**：把本文件（或整个 `t0-ledger` 文件夹 / GitHub 仓库）交给任何 AI，并说「按 AI-HANDOFF.md 操作」即可。

---

## 1. 项目是什么

| 项 | 内容 |
|----|------|
| 名称 | 做T台账（PWA） |
| 本地路径 | `D:\我的cursor项目文件\t0-ledger` |
| GitHub | https://github.com/shijiuyumile/t0-ledger |
| 线上地址 | https://shijiuyumile.github.io/t0-ledger/ |
| 形态 | 纯静态前端（HTML/CSS/JS），无后端 |
| 用户设备 | iPhone Safari「添加到主屏幕」使用 |
| 数据位置 | ① 仓库内 `data/seed.json`（云端种子）② 手机 localStorage（用户本地） |

**手机主屏幕图标永远指向同一 URL，不必每天重新安装。** 更新数据 = 改 `seed.json` 并 push 到 GitHub Pages；用户打开 APP 后会自动增量合并。

---

## 2. 目录结构（只改该改的）

```
t0-ledger/
├── index.html              # 页面骨架（4 个 Tab：台账/卖出/战绩/我的）
├── css/style.css           # 亮色、红涨绿跌
├── js/
│   ├── fees.js             # 费率：股票/ETF/债券
│   ├── match.js            # 价格最相近核销 + 账户总盈亏计算
│   ├── store.js            # localStorage 读写、去重 key
│   ├── import.js           # Excel 表头识别 → 成交记录
│   └── app.js              # UI、折叠分组、隐藏买单、ensureSeed 增量同步
├── data/seed.json          # ★ 历史成交 + 账户快照（更新数据主要改这个）
├── vendor/xlsx.full.min.js # SheetJS（勿删，离线解析 Excel）
├── manifest.json / sw.js   # PWA；改代码后必须 bump CACHE_VERSION
├── tools/
│   ├── merge-xlsx.js       # ★ 日常：增量合并对账单（最常用）
│   ├── import-user-xlsx.js # 全量重建 seed（慎用，会覆盖）
│   ├── test-match.js       # 核销算法自测
│   ├── serve.js            # 本地预览：node tools/serve.js 8765
│   └── ...
└── AI-HANDOFF.md           # 本文件
```

---

## 3. 核心业务规则（改逻辑前必读）

### 3.1 做T核销（`js/match.js`）

- 默认口径 **`closest`（价格最相近）**：卖单与同代码剩余买单配对，不限是否同一天。
  1. 优先：买价 ≤ 卖价 中，买价最高的；
  2. 否则：买价 > 卖价 中，买价最低的；
  3. 数量不够则级联下一笔。
- 可选口径 **`time`（时间顺序 + 待回补）**：`computeMatches(trades, { mode: 'time', fromDate? })`
  - 按成交时间扫描；先买后卖 → FIFO 配最早剩余买单；
  - 先卖且当时无多头 → 进入 `pendingCovers`（待回补）；之后买入优先回补（倒T）；
  - 设置：`settings.matchMode = 'closest' | 'time'`（默认 closest，在「我的」切换）。
- 盈亏 = Σ(卖价−买价)×数量 − 卖出费用分摊 − 买入费用分摊（倒T同样：卖高买低为正）。
- 整笔卖单净利 > 0 → 成功；≤ 0 → 亏损。
- **做T时间 / 底仓**：`fromDate` 之前买单不参与配对；之前卖单不计入该窗口核销。
- 扳本关注价：`settings.watchPrices`（卖出页可钉），不占库存。

### 3.2 账户总盈亏

```
总盈亏 ≈ 已实现盈亏(当前核销口径的配对净利) + 持仓浮动盈亏 + 股息 + 利息
```

持仓浮动优先用对账单；切「做T时间」不改账户总盈亏用的全历史已实现，但会随 **matchMode** 变化。

另有对照口径：`总资产 − 银证净入金`。

### 3.3 费率默认值（`js/fees.js`，可在 APP「我的」修改）

- 股票：佣金万 0.85（最低 5）+ 过户万 0.1 双向 + 印花万 5 仅卖出  
- ETF：佣金万 0.5（最低 0.1），免过户/印花  
- 债券：佣金万 0.1  
- 交割单带费用时用交割单实际值。

### 3.4 买单「已做T隐藏」

- 字段：`trade.tHidden === true`
- 只影响台账列表展示，**不参与**核销跳过；交割单配对照常。
- 设置：`settings.showHiddenLots` 控制是否显示已隐藏。

### 3.4b 台账「整体持仓 / 做T时间」（`settings`）

| 字段 | 含义 |
|------|------|
| `ledgerMode` | `full`（默认）\| `tWindow` |
| `tWindowPreset` | `today` / `d2`…`d5` / `halfMonth` / `month` / `quarter` / `custom` |
| `tFromDate` | 自定义起始日 `YYYY-MM-DD` |
| `unprofitableDisplay` | `tWindow`（默认）\| `full`：未盈利标的跟时间窗还是看整体仓 |
| `matchMode` | `closest`（默认）\| `time`：核销口径 |
| `watchPrices` | 扳本关注价数组 `{id,code,price,date,fromSellId}` |

- **未盈利**：该标的**历史累计**做T已实现净利 ≤ 0（全历史配对口径，不随时间窗变）。
- 做T时间模式下：起始日前底仓默认不显示；未盈利且 `unprofitableDisplay=full` 时该标的按全历史剩余仓显示。

### 3.5 去重键

有成交编号：`日期|代码|方向|成交编号`  
否则：`日期|时间|代码|方向|价格|数量`（同键多笔用 `#1` `#2`…）

---

## 4. ★ 日常任务：更新最新对账单数据

用户会提供华泰等券商导出的 Excel，例如：

`d:\小龙虾的文件夹\做T数据记录\普通账户电子对账单(YYYYMMDD).xlsx`

### 标准步骤（按顺序执行）

```bash
# 1）进入项目目录
cd "D:\我的cursor项目文件\t0-ledger"

# 2）增量合并（自动去重、更新账户快照、seedRevision+1）
#    ⚠ 同一份 xlsx 不要重复跑第二次：成交会去重，但银证转入/转出/股息会再累加一次！
node tools/merge-xlsx.js "对账单xlsx的完整路径"

# 3）把 sw.js 里 CACHE_VERSION 数字 +1
#    例如 t0ledger-v11 → t0ledger-v12

# 4）提交并推送到 GitHub
git add data/seed.json sw.js
git commit -m "增量合并 YYYY/MM/DD 对账单数据"
git push origin main
```

### 账户总盈亏为何可能和券商 APP 差一截

本 APP：`已实现(价格最相近配对) + 持仓浮动 + 股息利息`。

- **持仓浮动**必须用对账单「股票持仓」合计（含 **qty=0 但仍有持仓盈亏** 的已清仓行，例如某票清仓后仍挂着一笔亏损）。漏掉会把总盈亏抬高一千多。
- 字段 `account.holdPnlTotal` = 账单合计行持仓盈亏；计算时优先用它。
- 「已实现」与券商移动均价法不完全相同，所以和 APP 仍可能差几百，属口径差异；但不应再差一整块清仓盈亏。

### 合并脚本会做什么

1. 解析 Excel 中「证券买入/证券卖出」→ 成交列表  
2. 与现有 `data/seed.json` 按 `key` 去重，只追加新成交  
3. 更新 `account`：以**最新账单**的资金/总资产/持仓为准；银证转入转出、股息、利息在旧累计上**加本期**  
4. `seedRevision` 自增（手机端靠它判断要不要同步）

### 成功时控制台示例

```
新增成交 40 跳过重复 0 忽略非成交 35
总成交 3009 seedRevision 5
账户截至 2026-08-06 总资产 124860.77 ...
```

### 合并后告诉用户

- 新增几笔、总成交多少、账户截至日期  
- 打开主屏幕 APP（或 Safari 打开线上地址下拉刷新）即可自动同步  
- **不需要**换链接、不需要重新「添加到主屏幕」

### 禁止事项

- ❌ 不要用 `import-user-xlsx.js` 做日常更新（那是全量重建，易丢 `tHidden` 等本地字段；全量只在空库/灾难恢复时用）  
- ❌ 不要把用户对账单里的身份证号等隐私写进文档或 commit message  
- ❌ 不要 force push、不要改 git config  
- ❌ 不要提交 GitHub token 到仓库

### 推送鉴权

仓库 owner：`shijiuyumile`。需要有 `repo` 权限的 PAT，例如：

```powershell
$env:GH_TOKEN = "ghp_xxxx"   # 由用户提供，用完提醒用户轮换
git push origin main
```

若 token 失效，请用户到 https://github.com/settings/tokens 新建 classic token（勾选 `repo`）后再推。

---

## 5. 手机端如何拿到新数据（`js/app.js` → `ensureSeed`）

1. APP 启动时 `fetch('data/seed.json', { cache: 'no-cache' })`  
2. 本地无成交 → 全量载入 seed  
3. 本地已有成交 → 按 `key` **只追加** seed 里多出来的成交；若 `seedRevision` 更新则刷新账户快照  
4. 用户本地的 `tHidden`、预估卖价、手填现价保留在 localStorage，不会被 seed 覆盖掉已有成交上的字段（新合并进来的行是新对象）

若用户反馈「数据没变」：

1. 用 Safari 打开 https://shijiuyumile.github.io/t0-ledger/ 下拉刷新  
2. 再进主屏幕图标  
3. 仍不行：确认 Pages 已部署最新 commit；检查 `CACHE_VERSION` 是否已 bump  

---

## 6. 改功能时的注意点

1. 改 `js/`、`css/`、`index.html` 后：**必须**把 `sw.js` 的 `CACHE_VERSION` +1  
2. 改完跑自测：`node tools/test-match.js`  
3. 本地预览：`node tools/serve.js 8765` → http://localhost:8765  
4. 界面约定：亮色、**红涨绿跌**（盈利红、亏损绿）  
5. 台账/卖出按标的**折叠**；买单可「已做T隐藏」  
6. 不要引入必须 npm install 才能跑的构建链（当前零构建，直接静态托管）

---

## 7. seed.json 数据结构（摘要）

```json
{
  "version": 1,
  "seedRevision": 6,
  "trades": [
    {
      "id": "t...",
      "key": "去重键",
      "date": "2026-08-20",
      "time": "",
      "code": "510310",
      "name": "HS300ETF",
      "secType": "etf",
      "side": "buy",
      "price": 4.5,
      "qty": 300,
      "amount": 1350,
      "fees": { "commission": 0.1, "transfer": 0, "stamp": 0, "other": 0 },
      "feeSource": "statement",
      "estSell": null,
      "tHidden": false,
      "source": "import",
      "seq": 0
    }
  ],
  "account": {
    "asOf": "2026-08-20",
    "cash": 10069.93,
    "totalAssets": 77290.76,
    "deposit": ...,
    "withdraw": ...,
    "netDeposit": ...,
    "dividends": ...,
    "interest": ...,
    "holdings": [
      {
        "code": "510310",
        "name": "...",
        "qty": 4600,
        "marketValue": ...,
        "costPrice": ...,
        "lastPrice": ...,
        "holdPnl": ...
      }
    ]
  },
  "settings": {
    "lotSort": "asc",
    "sellFilter": "loss",
    "feeRules": {},
    "quotes": {},
    "showHiddenLots": false
  }
}
```

---

## 8. 用户常用话术 → AI 应执行的动作

| 用户说 | AI 做 |
|--------|--------|
| 「把这份对账单更新到做T里」+ xlsx 路径 | 跑 `merge-xlsx.js` → bump `CACHE_VERSION` → commit push → 汇报新增笔数 |
| 「改隐藏/界面/核销逻辑」 | 改对应 js/css → 自测 → bump cache → push |
| 「链接要不要每天换？」 | 答：不用，固定 https://shijiuyumile.github.io/t0-ledger/ |
| 「数据会自动更新吗？」 | 答：你合并推送后，用户打开 APP 会自动增量同步 |

---

## 9. 当前状态快照（撰写本文时）

- 线上：https://shijiuyumile.github.io/t0-ledger/  
- 仓库：`shijiuyumile/t0-ledger`，分支 `main`  
- `CACHE_VERSION`：`t0ledger-v11`  
- `seedRevision`：6  
- 成交约：3186 笔  
- 账户截至：2026-08-20  

（之后每次合并请以 `seed.json` / `sw.js` 实际内容为准，可覆盖本段。）

---

## 10. 一句话口令（用户可复制给任何 AI）

```
请打开项目 t0-ledger，严格按 AI-HANDOFF.md 操作。
我要增量更新对账单数据，文件在：<粘贴 xlsx 完整路径>
请执行 merge-xlsx → 提高 sw.js 的 CACHE_VERSION → commit 并 push 到 origin main，
最后用中文告诉我新增了多少笔、总成交多少、账户截至日期，以及我手机如何刷新。
```
