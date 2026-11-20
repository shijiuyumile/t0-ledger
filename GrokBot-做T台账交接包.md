# Grok Bot 交接包：做T台账 App（日常数据更新专用）

> 生成时间：2026-11-17  
> 目的：让 Grok Bot **读完本文后，能直接接手「用户发来对账单 → 更新 App + 电脑 Excel → 推送上线」**。  
> 权威工程说明还可对照：`D:\我的cursor项目文件\t0-ledger\AI-HANDOFF.md`

---

## 0. 你是谁、要干什么

你是用户的助手，负责维护自研 PWA「**做T台账**」。

用户几乎每天会说类似：

> 帮我把这个数据更新到做T应用：`D:\小龙虾的文件夹\做T数据记录\普通账户电子对账单(YYYYMMDD).xlsx`

你必须按本文 **§4 标准流程** 执行，不要发明第二套流程，不要全量重建 seed。

---

## 1. 项目是什么（构建逻辑摘要）

| 项 | 内容 |
|----|------|
| 名称 | 做T台账（A 股/ETF 做T成本台账 PWA） |
| 本地路径 | `D:\我的cursor项目文件\t0-ledger` |
| GitHub | https://github.com/shijiuyumile/t0-ledger （分支 `main`） |
| 线上 | https://shijiuyumile.github.io/t0-ledger/ |
| 形态 | **纯静态前端**（HTML/CSS/JS），无后端服务器 |
| 用户端 | iPhone Safari「添加到主屏幕」；**链接固定，不用每天换** |

### 1.1 数据怎么流动

```
华泰对账单.xlsx
    ↓  node tools/merge-xlsx.js
data/seed.json   （云端种子：成交 + 账户快照）
    ↓  git push → GitHub Pages
手机打开 App → fetch seed.json → 按 key 增量合并进 localStorage
```

同时必须导出：

```
node tools/export-todo-xlsx.js
    ↓
D:\小龙虾的文件夹\做T数据记录\做T待办台账_截至YYYYMMDD.xlsx
```

### 1.2 关键文件（只改该改的）

```
t0-ledger/
├── data/seed.json          ★ 成交+账户；日常更新主要改这个
├── sw.js                   ★ CACHE_VERSION 每次发版必须 +1
├── js/match.js             核销：价格匹配 / 时间+待回补 / 老太太扶楼梯
├── js/app.js               UI
├── js/import.js / fees.js / store.js
├── tools/merge-xlsx.js     ★ 日常合并对账单
├── tools/export-todo-xlsx.js ★ 日常导出电脑勾选台账
└── AI-HANDOFF.md           完整工程手册
```

### 1.3 App 功能结构（知道即可，日常更新不必改）

- **待做T**：全历史「价格最相近」核销后，剩余买入  
- **待回补**：时间核销下的先卖未买回  
- **待扳本**：已配对亏损卖出  
- **老太太扶楼梯**：近 N 天/全部窗口内，低买高卖 或 高买低卖（卖价严格 &gt;/&lt; 买价）  
- **账户总盈亏（主数字）** = 总资产 − 银证净入金（对齐涨乐）  
- **做T配对净利** = 价格最相近配对结果（分析用，勿与涨乐主数字混比）

### 1.4 合并脚本实际做什么

`node tools/merge-xlsx.js "<xlsx路径>"`：

1. 解析证券买入/卖出 → 成交  
2. 按 `key` 去重，只追加新成交  
3. 账户：最新账单的资金/总资产/持仓覆盖；银证转入转出、股息、利息在旧累计上 **加本期**（银证有去重）  
4. `seedRevision + 1`（手机靠它判断要不要刷新账户）

---

## 2. 当前数据快照（交接时点）

| 项 | 值 |
|----|----|
| CACHE_VERSION | `t0ledger-v57` |
| seedRevision | **37** |
| 总成交 | **4895** 笔 |
| 成交区间 | 2025-04-07 ~ 2026-11-18 |
| 账户截至 asOf | **2026-11-18** |
| 总资产 | 190454.55 |
| 银证净入金 | 194212.21 |
| 账户总盈亏 | **-3757.66** |
| 电脑台账 | `D:\小龙虾的文件夹\做T数据记录\做T待办台账_截至20261118.xlsx` |

结构化副本：同目录 `grokbot-t0-current-status.json`（每次你更新后请顺手改这个文件或重写）。

---

## 3. 路径约定

| 用途 | 路径 |
|------|------|
| 项目根目录 | `D:\我的cursor项目文件\t0-ledger` |
| 对账单目录 | `D:\小龙虾的文件夹\做T数据记录\` |
| 对账单文件名 | `普通账户电子对账单(YYYYMMDD).xlsx` 或 `(YYYYMMDD-YYYYMMDD).xlsx` |
| 电脑勾选台账 | `做T待办台账_截至YYYYMMDD.xlsx`（按 asOf 命名，由 export 自动生成） |

环境：Windows + PowerShell；用 Node.js 跑脚本（本机有 `node`）。

---

## 4. ★ 每日更新标准流程（必须按序）

用户给出 xlsx 完整路径后：

### Step 0 — 开工前先同步远端（★ 强制，不可跳过）

本项目由多个 AI 工具**接力维护**（WorkBuddy / Cursor / GrokBot，今天用这个明天用那个），
GitHub `main` 分支是唯一真相源，你手上的本地副本可能已落后。**任何 merge 之前必须先同步检查**：

```powershell
cd "D:\我的cursor项目文件\t0-ledger"
git fetch origin
git log --oneline HEAD..origin/main
```

- 若 `git log HEAD..origin/main` **有输出** → 别的工具已先行合并过新数据，必须先 `git pull --ff-only` 同步到最新再往下做。
- 若**无输出** → 本地已是最新，可继续。
- ⚠ 绝不可在未同步时直接 merge：同一份 xlsx 重复合并会让**银证转入转出、股息、利息重复累加**，账户盈亏算错（成交虽按 key 去重，但这些累计字段不会）。
- ⚠ push 被拒（non-fast-forward）就是没先同步的信号：正确做法是 `git pull --ff-only` 后重试，**绝不可 force push**。

### Step A — 确认文件存在 + 读当前 seed

```powershell
cd "D:\我的cursor项目文件\t0-ledger"
Test-Path -LiteralPath "用户给的xlsx完整路径"
node -e "const s=require('./data/seed.json'); console.log('before', s.trades.length, s.seedRevision, s.account.asOf);"
```

### Step B — 增量合并（同一份 xlsx 不要跑第二次）

```powershell
node tools/merge-xlsx.js "用户给的xlsx完整路径"
```

记下控制台：`新增成交 / 总成交 / seedRevision / 账户截至 / 总资产 / 净入金 / 本期银证 / 账户总盈亏`。

⚠ **禁止**：同一账单重复 merge（成交会去重，但历史上股息等曾有累加风险；现行脚本对银证有去重，仍不要重复跑）。  
⚠ **多份账单**：按时间从早到晚依次 merge。  
⚠ **禁止**日常使用 `import-user-xlsx.js`（全量重建，易丢本地隐藏等字段）。

### Step C — 导出电脑勾选台账（用户硬性要求：每次必做）

```powershell
node tools/export-todo-xlsx.js
```

输出类似：`D:\小龙虾的文件夹\做T数据记录\做T待办台账_截至20261112.xlsx`

### Step D — bump 缓存版本

编辑 `sw.js`，把：

```js
const CACHE_VERSION = 't0ledger-v54';
```

改成数字 **+1**（例：`t0ledger-v55`）。  
改 js/css/html 时也必须 bump；**只改 seed 也要 bump**，否则手机可能仍用旧壳/旧缓存策略。

### Step E — 提交并推送

```powershell
git add data/seed.json sw.js
git commit -m "增量合并 YYYY/MM/DD 对账单数据"
git push origin main
```

- 只提交仓库内文件；**不要**把用户对账单 xlsx / 电脑台账 Excel 提交进 git  
- 不要 force push、不要改 git config  
- 若 push 被保护分支策略拦截，按环境要求申请用户批准后再推  
- commit message 用简体中文，格式沿用：`增量合并 2026/11/07-11/12 对账单数据`

### Step F — 回复用户（固定要素）

用中文简短汇报：

1. 新增几笔、总成交、账户截至日  
2. 本期银证转入/转出（若有）  
3. 总资产、账户总盈亏  
4. 电脑 Excel 完整路径 + 待做T/扶楼梯等笔数（export 日志里有）  
5. 手机：打开 https://shijiuyumile.github.io/t0-ledger/ **强刷**；缓存版本号（如 v55）；**不用换链接**

---

## 5. 成功示例（对照）

合并成功时控制台类似：

```
新增成交 147 跳过重复 0 忽略非成交 46
总成交 4710 seedRevision 34
账户截至 2026-11-12 总资产 148561.67 资金 4979.64
持仓数 12 ... 累计净入金 148748.23
本期银证新增 转入 0 转出 714 ...
账户总盈亏(资产−净入金) -186.56
```

导出成功时类似：

```
已写出 D:\小龙虾的文件夹\做T数据记录\做T待办台账_截至20261112.xlsx
待做T 161 扶楼梯未做完 272 扶楼梯做T成功 2282 ... 待扳本 666
账户总盈亏 -186.56 截至 2026-11-12
```

---

## 6. 手机端如何同步（用户侧）

1. App 启动 `fetch('data/seed.json', { cache: 'no-cache' })`  
2. 本地无数据 → 全量载入  
3. 本地已有 → 按成交 `key` **只追加**新行；`seedRevision` 更新则刷新账户快照  
4. 用户本地的隐藏标记、预估卖价等保留在 localStorage  

若用户说「数据没变」：Safari 打开线上地址下拉刷新 → 再进主屏幕图标 → 确认 Pages 已部署且 CACHE 已 bump。

---

## 7. 禁止事项

- ❌ **未先 `git fetch` 同步远端就 merge**（多工具接力，远端可能已被他人更新；重复合并会让银证/股息累加算错）  
- ❌ 同一 xlsx 重复 merge  
- ❌ 日常全量 `import-user-xlsx.js`  
- ❌ 把身份证等隐私写进文档或 commit message  
- ❌ force push / 改 git config / 提交 token  
- ❌ 更新 App 数据却忘记 `export-todo-xlsx.js`  
- ❌ 改代码或 seed 却忘记 bump `CACHE_VERSION`

---

## 8. 用户常见话术 → 你的动作

| 用户说 | 你做 |
|--------|------|
| 「更新到做T」「同步对账单」+ xlsx 路径 | §4 全流程 |
| 一次给多份 xlsx | 按日期从早到晚依次 merge，再 export + bump + push 一次即可 |
| 「改扶楼梯/隐藏/界面」 | 改对应 js/css → 自测 → bump CACHE → commit push（详见 AI-HANDOFF） |
| 「链接要换吗」 | 不用，固定 https://shijiuyumile.github.io/t0-ledger/ |

---

## 9. 给 Grok 的开场白（用户可直接粘贴）

```
请先完整阅读：
D:\小龙虾的文件夹\做T数据记录\GrokBot-做T台账交接包.md

必要时再读：
D:\我的cursor项目文件\t0-ledger\AI-HANDOFF.md
D:\小龙虾的文件夹\做T数据记录\grokbot-t0-current-status.json

★ 关键：本项目由多个 AI 工具接力维护，仓库 main 是唯一真相源。
开工第一件事永远是 §4 Step 0：git fetch + git log HEAD..origin/main，
若远端有他人新提交，先 git pull --ff-only 同步再动手。绝不可跳过，绝不可 force push。

你的日常职责：按交接包 §4，把我给你的华泰「普通账户电子对账单」xlsx
增量合并进做T台账 App（Step 0 同步 → merge → export电脑台账 → bump CACHE → commit push），
并用中文汇报新增笔数、总成交、账户截至、盈亏、Excel路径和手机刷新方式。

现在数据状态以交接包 §2 / current-status.json 为准。
准备好后回复「已就绪」，等我发下一份对账单路径。
```

---

## 10. 附件

| 文件 | 说明 |
|------|------|
| 本文 | `GrokBot-做T台账交接包.md` |
| 状态 JSON | `grokbot-t0-current-status.json` |
| 工程手册 | `D:\我的cursor项目文件\t0-ledger\AI-HANDOFF.md` |
| 最新电脑台账 | `做T待办台账_截至20261112.xlsx` |
| 完整成交 | `t0-ledger\data\seed.json`（体积大，日常更新不必整文件读入上下文） |

每次你成功更新后，请把 §2 数字和 `grokbot-t0-current-status.json` 改成最新值，方便下一班助手接着干。
