# GitHub 仓库创建 + Obsidian 商店提交指南

> 日期：2026-06-24

---

## 一、创建 GitHub 公开仓库

### 1.1 在网页上创建

1. 打开 [github.com/new](https://github.com/new)
2. Repository name: `deepdig-cc`
3. Description: `深度挖掘 · CC — Claude Opus investment research engine inside Obsidian`
4. 选 **Public**
5. **不要**勾选 "Add a README file"（我们已经有了）
6. **不要**勾选 ".gitignore"（我们已经有了）
7. License: 选 "MIT"（我们已经有了 LICENSE 文件也没关系）
8. 点击 "Create repository"

### 1.2 在终端推送代码

创建完后 GitHub 会显示一个页面，标题为 "…or push an existing repository from the command line"。在插件目录下执行：

```bash
cd d:\Beaver_Technology\obsidian-cc-plugin

# 关联远程仓库
git remote add origin https://github.com/你的用户名/deepdig-cc.git

# 推送到 main 分支
git branch -M main
git push -u origin main
```

### 1.3 验证

- 打开 `https://github.com/你的用户名/deepdig-cc`
- README.md 应该自动渲染为首页
- 截图应该能正常显示（screenshots/ 下的 4 张 PNG）

---

## 二、创建第一个 Release（v1.0.0）

1. 在仓库页面点击 "Releases" → "Create a new release"
2. Tag: `v1.0.0`
3. Title: `v1.0.0 — 首次公开发布`
4. 描述：

```
## 深度挖掘 · CC v1.0.0

Claude Opus 4 投研引擎 + Obsidian 知识底座。

### 功能
- 双调用架构（对话 + 写卡分离）
- 10 维 L4 尽调（护城河 / 治理 / 成长质量 / 估值 / 风险矩阵 / 大师会诊）
- 7 天免费试用 + Gumroad License Key 授权
- AES-256-GCM 加密引擎卡片（28 张投资框架）
- 对话历史持久化

### 文件
- `main.js` — 插件核心（含加密引擎）
- `manifest.json` — Obsidian 插件元数据
- `styles.css` — 聊天面板样式
- 初始化脚本：`scripts/init-vault.bat` / `scripts/init-vault.sh`
```

5. 将 `main.js`、`manifest.json`、`styles.css` 拖入 "Attach binaries" 区域
6. 点击 "Publish release"

---

## 三、提交 Obsidian 社区商店 PR

### 3.1 Fork 官方仓库

1. 打开 [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
2. 点击右上角 Fork → 你自己的账号

### 3.2 编辑 community-plugins.json

在你 fork 的仓库中，打开 `community-plugins.json`。按字母顺序找到 `deepdig-cc` 应该插入的位置（在 "deep" 附近），添加一行：

```json
{
  "id": "deepdig-cc",
  "name": "深度挖掘 · CC",
  "author": "深度挖掘",
  "description": "Claude Opus 投研引擎 + Obsidian 知识底座。双调用模式·7天免费试用·深度分析+自动建卡。",
  "repo": "你的用户名/deepdig-cc"
}
```

### 3.3 提交 PR

1. Commit message: `Add deepdig-cc plugin`
2. 点击 "Contribute" → "Open pull request"
3. PR 标题: `Add deepdig-cc plugin`
4. PR 描述:

```
## deepdig-cc — 深度挖掘 · CC

Claude Opus 4 investment research engine inside Obsidian.

- **Dual-call architecture**: conversation + card writing as separate CC runs
- **10-dimension deep dive**: moat, governance, growth quality, valuation, risk matrix, master panel
- **7-day free trial**: full features, no key required
- **License**: MIT
- **Desktop only**: uses Claude Code CLI (child_process.spawn)

### Compliance
- [x] Free — no paywall in plugin code
- [x] Open source — MIT license
- [x] No external paid dependencies — user brings their own Anthropic API key
- [x] Privacy — no data collection, no cloud upload
- [x] Desktop only — isDesktopOnly: true
```

### 3.4 审核周期

通常 1-2 周。审核期间可能会有人提意见——照做就行。

---

## 四、检查清单（提交前核对）

| # | 检查项 | 状态 |
|---|------|:--:|
| 1 | 仓库为 Public | ☐ |
| 2 | README.md 英文 + 截图能正常显示 | ☐ |
| 3 | LICENSE 文件存在（MIT） | ☐ |
| 4 | .gitignore 不含 node_modules/_tmp/release/*.bak | ☐ |
| 5 | engine_cards.json 已加密（AES-256-GCM） | ☐ |
| 6 | manifest.json 含 id/name/version/minAppVersion/description/author/isDesktopOnly | ☐ |
| 7 | 插件代码无可疑网络请求（仅 api.gumroad.com 用于验证） | ☐ |
| 8 | Release v1.0.0 已创建 + 含 main.js/manifest.json/styles.css | ☐ |

---

> 做完这四步（创建仓库 → 推送 → Release → PR），上架流程就完成了。
