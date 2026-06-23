"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DeepDigCCPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/ChatView.ts
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var CHAT_VIEW_TYPE = "deepdig-cc-chat";
var ChatView = class extends import_obsidian.ItemView {
  plugin;
  messages = [];
  busy = false;
  ccProc = null;
  msgContainer;
  inputEl;
  sendBtn;
  stopBtn;
  currentStreamEl = null;
  currentStreamContent = "";
  // ═══ 方案2.5：状态追踪 ═══
  cardSnapshot = /* @__PURE__ */ new Set();
  ccStartTime = 0;
  lastWriteResult = null;
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText() {
    return "\u6DF1\u5EA6\u6316\u6398 CC";
  }
  getIcon() {
    return "deepdig-logo";
  }
  async onOpen() {
    const c = this.containerEl.children[1];
    c.empty();
    c.addClass("deepdig-cc-container");
    const h = c.createDiv("dd-header");
    const lo = h.createSpan("dd-logo");
    (0, import_obsidian.setIcon)(lo, "deepdig-logo");
    h.createSpan("dd-title").setText("\u6DF1\u5EA6\u6316\u6398 \xB7 CC");
    h.createSpan("dd-subtitle").setText("Claude Opus \u6295\u7814\u5206\u6790");
    const nb = h.createEl("button", { text: "\u{1F504} \u65B0\u5BF9\u8BDD", cls: "dd-header-btn" });
    nb.onclick = () => this.clearChat();
    this.msgContainer = c.createDiv("dd-messages");
    const f = c.createDiv("dd-footer");
    const iw = f.createDiv("dd-input-wrap");
    this.inputEl = iw.createEl("textarea", { placeholder: "\u6DF1\u6316XX / XX\u8D5B\u9053\u600E\u4E48\u770B / XX\u662F\u4EC0\u4E48", cls: "dd-input" });
    this.inputEl.rows = 2;
    this.inputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    };
    const br = f.createDiv("dd-btn-row");
    br.createSpan("dd-hint").setText("Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C");
    this.stopBtn = br.createEl("button", { text: "\u23F9 \u505C\u6B62", cls: "dd-stop-btn" });
    this.stopBtn.style.display = "none";
    this.stopBtn.onclick = () => this.stopCC();
    this.sendBtn = br.createEl("button", { text: "\u53D1\u9001", cls: "dd-send-btn" });
    this.sendBtn.onclick = () => this.sendMessage();
    this.renderWelcome();
  }
  async onClose() {
    this.stopCC();
  }
  async sendMessage() {
    if (this.busy)
      return;
    const t = this.inputEl.value.trim();
    if (!t)
      return;
    this.inputEl.value = "";
    this.addMessage("user", t);
    this.busy = true;
    this.sendBtn.disabled = true;
    this.stopBtn.style.display = "inline-block";
    await this.runCC(t);
  }
  // ═══ 文件扫描 ═══
  scanDirForMd(dir, vaultPath, snapshot, names) {
    try {
      if (!fs.existsSync(dir))
        return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanDirForMd(fp, vaultPath, snapshot, names);
        } else if (entry.name.endsWith(".md")) {
          const rel = path.relative(vaultPath, fp).replace(/\\/g, "/");
          snapshot.add(rel);
          names.push(entry.name.replace(".md", ""));
        }
      }
    } catch (_) {
    }
  }
  scanExistingCards() {
    const vaultPath = this.app.vault.adapter.basePath || "";
    const names = [];
    this.cardSnapshot = /* @__PURE__ */ new Set();
    this.scanDirForMd(path.join(vaultPath, "1-\u539F\u5B50\u7B14\u8BB0"), vaultPath, this.cardSnapshot, names);
    this.scanDirForMd(path.join(vaultPath, "\u62A5\u544A\u8F93\u51FA"), vaultPath, this.cardSnapshot, names);
    return names;
  }
  verifyCardsWritten() {
    const vaultPath = this.app.vault.adapter.basePath || "";
    const found = [];
    const scanDir = (dir) => {
      try {
        if (!fs.existsSync(dir))
          return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fp);
          } else if (entry.name.endsWith(".md")) {
            const rel = path.relative(vaultPath, fp).replace(/\\/g, "/");
            if (!this.cardSnapshot.has(rel)) {
              found.push(rel);
            } else if (this.ccStartTime > 0) {
              try {
                if (fs.statSync(fp).mtimeMs > this.ccStartTime) {
                  found.push(rel);
                }
              } catch (_) {
              }
            }
          }
        }
      } catch (_) {
      }
    };
    scanDir(path.join(vaultPath, "1-\u539F\u5B50\u7B14\u8BB0"));
    scanDir(path.join(vaultPath, "\u62A5\u544A\u8F93\u51FA"));
    return { found };
  }
  // ═══ 方案2.5 新增：扫描知识底座卡片摘要 ═══
  scanKnowledgeBase() {
    const vaultPath = this.app.vault.adapter.basePath || "";
    const lines = [];
    const conceptDir = path.join(vaultPath, "1-\u539F\u5B50\u7B14\u8BB0", "\u6982\u5FF5");
    const l1Cards = [];
    const l2Cards = [];
    if (fs.existsSync(conceptDir)) {
      for (const f of fs.readdirSync(conceptDir)) {
        if (!f.endsWith(".md"))
          continue;
        try {
          const content = fs.readFileSync(path.join(conceptDir, f), "utf-8").slice(0, 500);
          const title = f.replace(".md", "");
          if (content.includes("layer: L1")) {
            const defMatch = content.match(/## 一句话定义\n\n([^\n]+)/);
            l1Cards.push(`  - ${title}${defMatch ? "\uFF1A" + defMatch[1] : ""}`);
          } else if (content.includes("layer: L2") || content.includes("\u951A\u70B9\u5361: true")) {
            l2Cards.push(`  - ${title}`);
          }
        } catch (_) {
        }
      }
    }
    if (l1Cards.length > 0) {
      lines.push("\u3010L1 \u653F\u7B56\u5361\u3011");
      lines.push(...l1Cards);
      lines.push("");
    }
    if (l2Cards.length > 0) {
      lines.push("\u3010L2 \u8D5B\u9053\u5361\u3011");
      lines.push(...l2Cards);
      lines.push("");
    }
    const kwDir = path.join(vaultPath, "1-\u539F\u5B50\u7B14\u8BB0", "\u5173\u952E\u8BCD");
    if (fs.existsSync(kwDir)) {
      const kwCards = [];
      for (const f of fs.readdirSync(kwDir)) {
        if (!f.endsWith(".md"))
          continue;
        try {
          const content = fs.readFileSync(path.join(kwDir, f), "utf-8").slice(0, 400);
          const title = f.replace(".md", "");
          const crossMatch = content.match(/穿行于哪些L2[\s\S]*?(?:##|$)/);
          const l2Refs = crossMatch ? (crossMatch[0].match(/\[\[([^\]]+)\]\]/g) || []).length : 0;
          kwCards.push(`  - ${title}\uFF08\u7A7F\u884C${l2Refs}\u4E2AL2\uFF09`);
        } catch (_) {
        }
      }
      if (kwCards.length > 0) {
        lines.push("\u3010\u5173\u952E\u8BCD\u5361\u3011");
        lines.push(...kwCards.slice(0, 15));
        lines.push("");
      }
    }
    return lines;
  }
  // ═══ 方案2.5 核心：构建完整 stdin ═══
  buildStdin(userMsg) {
    const parts = [];
    if (this.messages.length > 0) {
      const recent = this.messages.filter((m) => m.role === "user" || m.role === "ai").slice(-10);
      if (recent.length > 0) {
        parts.push("=== \u5BF9\u8BDD\u5386\u53F2 ===");
        parts.push(recent.map(
          (m) => (m.role === "user" ? "\u7528\u6237" : "\u6DF1\u5EA6\u6316\u6398") + ": " + m.content
        ).join("\n\n"));
        parts.push("");
      }
    }
    const kbSummary = this.scanKnowledgeBase();
    if (kbSummary.length > 0) {
      parts.push("=== \u77E5\u8BC6\u5E95\u5EA7 ===");
      parts.push("\u4EE5\u4E0B\u662F\u4F60\u6240\u5728\u77E5\u8BC6\u5E93\u5DF2\u6709\u7684 L1/L2/\u5173\u952E\u8BCD\u5361\u7247\uFF08\u5206\u6790\u65F6\u53EF\u5F15\u7528\uFF09\uFF1A");
      parts.push(...kbSummary);
    }
    if (this.lastWriteResult && this.lastWriteResult.files.length > 0) {
      parts.push("=== \u4E0A\u4E00\u8F6E\u5199\u5361\u7ED3\u679C ===");
      parts.push('\u4F60\u4E0A\u4E00\u8F6E\u6210\u529F\u5199\u5165\u4E86\u4EE5\u4E0B\u6587\u4EF6\uFF08\u5982\u679C\u7528\u6237\u8FFD\u95EE"\u5199\u5230\u54EA\u91CC"\uFF0C\u4EE5\u6B64\u4E3A\u51C6\uFF09\uFF1A');
      parts.push(this.lastWriteResult.files.join("\n"));
      parts.push("");
    }
    parts.push("=== \u7528\u6237\u6D88\u606F ===");
    parts.push(userMsg);
    parts.push("");
    parts.push("---");
    parts.push("\u76F4\u63A5\u5F00\u59CB\u5206\u6790\u3002\u5728\u56DE\u590D\u672B\u5C3E\uFF0C\u7528\u5355\u72EC\u4E00\u884C\u6807\u6CE8\u5E94\u8BE5\u65B0\u5EFA\u6216\u66F4\u65B0\u7684\u5361\u7247\uFF08\u5982\u679C\u4E0D\u9700\u8981\u5199\u5361\u5219\u5199 none\uFF09\uFF1A");
    parts.push("##WRITE_CARDS: \u5361\u7247\u540D(\u7C7B\u578B), \u5361\u7247\u540D(\u7C7B\u578B)");
    return parts.join("\n");
  }
  // ═══ 方案2.5 重构：双调用模式（对话 → 写卡分离）═══
  async runCC(userMsg) {
    const ccPath = this.plugin.settings.ccCliPath || "claude";
    const vaultPath = this.app.vault.adapter.basePath || "";
    this.ccStartTime = Date.now();
    const convStdin = this.buildStdin(userMsg);
    const convOutput = await this.spawnCC(ccPath, vaultPath, convStdin, 60, true);
    if (convOutput === null)
      return;
    const writeCardsMatch = convOutput.match(/##WRITE_CARDS:\s*(.+)/);
    const cardList = writeCardsMatch ? writeCardsMatch[1].trim() : "";
    const shouldWriteCards = cardList && cardList.toLowerCase() !== "none";
    const convFiles = this.verifyCardsWritten();
    if (shouldWriteCards) {
      const cardStdin = [
        "=== \u4EE5\u4E0B\u662F\u4E0A\u4E00\u8F6E\u5206\u6790\u7684\u5168\u90E8\u5185\u5BB9 ===",
        convOutput,
        "",
        "=== \u5199\u5361\u6307\u4EE4 ===",
        `\u57FA\u4E8E\u4EE5\u4E0A\u5206\u6790\uFF0C\u5C06\u4EE5\u4E0B\u5361\u7247\u5199\u5165 Vault\uFF08${vaultPath}\uFF09\uFF1A`,
        cardList,
        "",
        "\u8981\u6C42\uFF1A",
        "- \u5B9E\u4F53\u4E3B\u5361\u542B frontmatter\uFF08tags/created/updated/layer/linked\u22653/moat_score/governance_score/growth_quality\uFF09",
        "- \u5B9E\u4F53\u4E3B\u5361\u672B\u5C3E\u5FC5\u987B\u542B ## \u{1F4C7} \u5B50\u5361\u7D22\u5F15 \u8868\u683C",
        "- \u65B0\u6982\u5FF5\u5EFA\u5173\u952E\u8BCD\u5361\u5230 1-\u539F\u5B50\u7B14\u8BB0/\u5173\u952E\u8BCD/",
        "- \u5BF9\u6BD4/\u6D8C\u73B0\u65F6\u5EFA\u5173\u7CFB\u5361",
        "- \u540C\u540D\u5361\u7247 \u2192 \u66F4\u65B0\u7248\u672C\u53F7\uFF0C\u4E0D\u65B0\u5EFA",
        "- linked\u22653 \u6761\u4E14\u6807\u6CE8\u539F\u56E0",
        "- \u5199\u5B8C\u540E\u5728\u672B\u5C3E\u6807\u4E00\u884C ##CARDS_DONE"
      ].join("\n");
      this.scanExistingCards();
      await this.spawnCC(ccPath, vaultPath, cardStdin, 90, false);
    }
    const allFiles = this.verifyCardsWritten();
    const allFileNames = [.../* @__PURE__ */ new Set([...convFiles.found, ...allFiles.found])];
    if (allFileNames.length > 0) {
      this.lastWriteResult = { files: allFileNames };
      this.addMessage("system", "\u{1F4C7} " + allFileNames.join(", "));
      this.app.vault.getMarkdownFiles();
    }
    this.busy = false;
    this.sendBtn.disabled = false;
    this.stopBtn.style.display = "none";
  }
  /** 方案2.5：统一的 spawn CC 方法 */
  spawnCC(ccPath, vaultPath, stdinContent, maxTurns, renderToUser) {
    return new Promise((resolve) => {
      if (renderToUser) {
        this.currentStreamContent = "";
        this.currentStreamEl = this.createStreamBubble();
      }
      const isWin = process.platform === "win32";
      const ccCmd = `"${ccPath}" --print --model opus --max-turns ${maxTurns} --allowedTools "Write,Edit,Bash,Read,WebSearch,Glob,Grep" --add-dir "${vaultPath}"`;
      const spawnOpts = {
        cwd: vaultPath,
        stdio: ["pipe", "pipe", "pipe"],
        shell: isWin ? true : false,
        env: {
          ...process.env,
          PATH: `C:\\Program Files\\nodejs;${process.env.PATH || ""}`
        }
      };
      const proc = (0, import_child_process.spawn)(ccCmd, [], spawnOpts);
      if (renderToUser) {
        this.ccProc = proc;
        this.plugin.setCCProcess(proc);
      }
      proc.stdin.write(stdinContent);
      proc.stdin.end();
      let stdoutBuf = "";
      let stderrBuf = "";
      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        stdoutBuf += text;
        if (renderToUser) {
          this.appendStreamText(text);
        }
      });
      proc.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf-8");
      });
      proc.on("close", (code) => {
        if (renderToUser) {
          this.ccProc = null;
          this.plugin.setCCProcess(null);
          this.removeSystemMessages();
        }
        if (code !== 0 && stdoutBuf.length === 0) {
          if (renderToUser) {
            this.removeStreamBubble();
            this.addMessage(
              "error",
              `CC \u5F02\u5E38\u9000\u51FA (code=${code})\u3002${stderrBuf ? "\n\n" + stderrBuf.slice(0, 500) : ""}

\u786E\u8BA4\u5DF2\u5B89\u88C5\uFF1Anpm install -g @anthropic-ai/claude-code`
            );
            this.busy = false;
            this.sendBtn.disabled = false;
            this.stopBtn.style.display = "none";
          }
          resolve(null);
        } else {
          if (renderToUser) {
            this.finalizeStreamBubble();
          }
          const clean = stdoutBuf.replace(/\x1b\[[0-9;]*m/g, "").replace(/⏺.*?(\n|$)/g, "").replace(/⎿.*?(\n|$)/g, "").trim();
          resolve(clean);
        }
      });
      proc.on("error", (err) => {
        if (renderToUser) {
          this.removeSystemMessages();
          this.removeStreamBubble();
          this.addMessage("error", "\u65E0\u6CD5\u542F\u52A8 CC: " + err.message);
          this.busy = false;
          this.sendBtn.disabled = false;
          this.stopBtn.style.display = "none";
          this.ccProc = null;
          this.plugin.setCCProcess(null);
        }
        resolve(null);
      });
    });
  }
  // ═══════════════════════ UI（基本不变·仅调整 stream 处理）═══════════════════════
  appendStreamText(text) {
    this.currentStreamContent += text;
    if (this.currentStreamEl) {
      const c = this.currentStreamContent.replace(/\x1b\[[0-9;]*m/g, "").replace(/⏺.*?(\n|$)/g, "").replace(/⎿.*?(\n|$)/g, "").trim();
      this.currentStreamEl.empty();
      import_obsidian.MarkdownRenderer.render(this.app, c, this.currentStreamEl, "", this);
    }
    this.scrollToBottom();
  }
  finalizeStreamBubble() {
    if (!this.currentStreamEl)
      return;
    const c = this.currentStreamContent.replace(/\x1b\[[0-9;]*m/g, "").replace(/⏺.*?(\n|$)/g, "").replace(/⎿.*?(\n|$)/g, "").trim();
    if (!c) {
      this.removeStreamBubble();
      this.addMessage("ai", "\uFF08CC \u672A\u8FD4\u56DE\u5185\u5BB9\uFF09");
      return;
    }
    this.currentStreamEl.empty();
    this.addMessageBubble(this.currentStreamEl, "ai", c);
    this.currentStreamEl.removeClass("dd-streaming");
    this.messages.push({ role: "ai", content: c, time: this.now(), id: "ai_" + Date.now() });
    this.saveHistory();
    this.currentStreamEl = null;
    this.currentStreamContent = "";
  }
  createStreamBubble() {
    return this.msgContainer.createDiv("dd-msg ai streaming");
  }
  removeStreamBubble() {
    if (this.currentStreamEl) {
      this.currentStreamEl.remove();
      this.currentStreamEl = null;
      this.currentStreamContent = "";
    }
  }
  removeSystemMessages() {
    this.msgContainer.querySelectorAll(".dd-msg.system").forEach((el) => el.remove());
  }
  addMessage(role, content) {
    const m = { role, content, time: this.now(), id: role + "_" + Date.now() };
    if (role === "user" || role === "ai") {
      this.messages.push(m);
      this.saveHistory();
    }
    this.renderMessage(m);
    this.scrollToBottom();
  }
  renderMessage(msg) {
    const el = this.msgContainer.createDiv("dd-msg " + msg.role);
    this.addMessageBubble(el, msg.role, msg.content, msg.time);
  }
  addMessageBubble(el, role, content, time) {
    if (role === "user")
      el.createDiv("dd-avatar").setText("\u{1F464}");
    else if (role === "ai")
      (0, import_obsidian.setIcon)(el.createDiv("dd-avatar"), "deepdig-logo");
    else if (role === "system")
      el.createDiv("dd-avatar").setText("\u26A1");
    else if (role === "error")
      el.createDiv("dd-avatar").setText("\u26A0\uFE0F");
    const body = el.createDiv("dd-body");
    const rl = role === "user" ? "\u4F60" : role === "system" ? "\u7CFB\u7EDF" : role === "error" ? "\u9519\u8BEF" : "\u6DF1\u5EA6\u6316\u6398";
    const meta = body.createDiv("dd-meta");
    meta.setText(rl + " \xB7 " + (time || this.now()));
    if (role === "ai" || role === "user") {
      const cb = meta.createSpan("dd-copy-btn");
      cb.setText("\u{1F4CB}");
      cb.onclick = (e) => {
        e.stopPropagation();
        const t = content.replace(/\x1b\[[0-9;]*m/g, "").replace(/⏺.*?(\n|$)/g, "").replace(/⎿.*?(\n|$)/g, "");
        navigator.clipboard.writeText(t).then(() => {
          cb.setText("\u2705");
          setTimeout(() => cb.setText("\u{1F4CB}"), 1500);
        }).catch(() => {
          cb.setText("\u274C");
          setTimeout(() => cb.setText("\u{1F4CB}"), 1500);
        });
      };
    }
    const bub = body.createDiv("dd-bubble");
    if (role === "system" || role === "error")
      bub.setText(content);
    else
      import_obsidian.MarkdownRenderer.render(this.app, content, bub, "", this);
  }
  renderWelcome() {
    if (this.messages.length > 0) {
      this.msgContainer.empty();
      for (const m of this.messages)
        this.renderMessage(m);
      return;
    }
    const el = this.msgContainer.createDiv("dd-msg ai");
    (0, import_obsidian.setIcon)(el.createDiv("dd-avatar"), "deepdig-logo");
    const b = el.createDiv("dd-body");
    b.createDiv("dd-meta").setText("\u6DF1\u5EA6\u6316\u6398 \xB7 " + this.now());
    const bb = b.createDiv("dd-bubble");
    bb.innerHTML = '<p>\u4F60\u597D\uFF0C\u6211\u662F<strong>\u6DF1\u5EA6\u6316\u6398 \xB7 CC</strong>\u3002</p><p>Claude Opus \u63A8\u7406\u5F15\u64CE + Obsidian \u77E5\u8BC6\u5E95\u5EA7\u3002\u95EE\u6211\u4F60\u60F3\u4E86\u89E3\u7684\u8D5B\u9053\u3001\u516C\u53F8\u6216\u6982\u5FF5\u3002</p><hr><p><strong>\u8BD5\u8BD5\uFF1A</strong></p><ul><li>"\u6DF1\u6316\u5B81\u5FB7\u65F6\u4EE3 300750"</li><li>"\u50A8\u80FD\u8D5B\u9053\u600E\u4E48\u770B"</li><li>"\u94A0\u79BB\u5B50\u7535\u6C60\u4EA7\u4E1A\u5316\u8FDB\u5C55"</li></ul>';
  }
  stopCC() {
    if (this.ccProc) {
      this.ccProc.kill("SIGTERM");
      this.ccProc = null;
      this.plugin.setCCProcess(null);
    }
    this.busy = false;
    this.sendBtn.disabled = false;
    this.stopBtn.style.display = "none";
    this.removeSystemMessages();
    if (this.currentStreamContent)
      this.finalizeStreamBubble();
    new import_obsidian.Notice("\u5DF2\u505C\u6B62 CC");
  }
  clearChat() {
    this.stopCC();
    this.messages = [];
    this.lastWriteResult = null;
    this.currentStreamContent = "";
    this.currentStreamEl = null;
    this.saveHistory();
    this.msgContainer.empty();
    this.renderWelcome();
  }
  scrollToBottom() {
    this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
  }
  now() {
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  async saveHistory() {
    const ts = this.messages.slice(-40).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 5e3),
      time: m.time,
      id: m.id
    }));
    await this.plugin.saveData({ ...this.plugin.settings, chatHistory: ts });
  }
  async loadHistory() {
    const d = await this.plugin.loadData();
    if (d?.chatHistory)
      this.messages = d.chatHistory;
  }
};

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  ccCliPath: "claude",
  dsApiKey: "",
  autoStart: false,
  showThinking: false
};
var DeepDigSettingTab = class extends import_obsidian2.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "\u6DF1\u5EA6\u6316\u6398 \xB7 CC \u63D2\u4EF6\u8BBE\u7F6E" });
    new import_obsidian2.Setting(containerEl).setName("CC CLI \u8DEF\u5F84").setDesc("Claude Code \u547D\u4EE4\u884C\u8DEF\u5F84\uFF0C\u9ED8\u8BA4 claude\uFF08PATH \u4E2D\u5DF2\u5B58\u5728\u65F6\u65E0\u9700\u4FEE\u6539\uFF09").addText((text) => text.setPlaceholder("claude").setValue(this.plugin.settings.ccCliPath).onChange(async (value) => {
      this.plugin.settings.ccCliPath = value || "claude";
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("DeepSeek API Key").setDesc("\u7528\u4E8E AKShare \u91D1\u878D\u6570\u636E\u7BA1\u9053\uFF08CC \u63A8\u7406\u672C\u8EAB\u4E0D\u9700\u8981\uFF09").addText((text) => text.setPlaceholder("sk-xxx...").setValue(this.plugin.settings.dsApiKey).onChange(async (value) => {
      this.plugin.settings.dsApiKey = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u542F\u52A8\u65F6\u81EA\u52A8\u6253\u5F00\u804A\u5929").setDesc("Obsidian \u542F\u52A8\u540E\u81EA\u52A8\u6FC0\u6D3B\u6DF1\u5EA6\u6316\u6398\u804A\u5929\u9762\u677F").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
      this.plugin.settings.autoStart = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u663E\u793A\u601D\u8003\u8FC7\u7A0B").setDesc("\u5728\u804A\u5929\u4E2D\u663E\u793A CC \u7684\u5DE5\u5177\u8C03\u7528\u548C\u63A8\u7406\u8FC7\u7A0B").addToggle((toggle) => toggle.setValue(this.plugin.settings.showThinking).onChange(async (value) => {
      this.plugin.settings.showThinking = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("hr");
    containerEl.createEl("p", {
      text: "\u{1F4A1} \u63D2\u4EF6\u4E0D\u505A AI \u63A8\u7406\u2014\u2014\u6240\u6709\u5206\u6790\u7531 Claude Code (Claude Opus) \u5B8C\u6210\u3002\u5361\u7247\u81EA\u52A8\u5199\u5165\u5F53\u524D Obsidian Vault \u7684 1-\u539F\u5B50\u7B14\u8BB0/ \u76EE\u5F55\u3002",
      cls: "setting-item-description"
    });
  }
};

// main.ts
var import_child_process2 = require("child_process");
(0, import_obsidian3.addIcon)("deepdig-logo", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3-3 4 4 3-3"/><path d="M8 12l3 3 4-4 3 3"/></svg>`);
var DeepDigCCPlugin = class extends import_obsidian3.Plugin {
  ccProcess = null;
  async onload() {
    await this.loadSettings();
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this)
    );
    this.addRibbonIcon("deepdig-logo", "\u6DF1\u5EA6\u6316\u6398 CC", () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-deepdig-chat",
      name: "\u6253\u5F00\u6DF1\u5EA6\u6316\u6398\u804A\u5929",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "new-deepdig-chat",
      name: "\u6DF1\u5EA6\u6316\u6398 \xB7 \u65B0\u5BF9\u8BDD",
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
        if (leaf && leaf.view instanceof ChatView) {
          leaf.view.clearChat();
        }
        this.activateView();
      }
    });
    this.addSettingTab(new DeepDigSettingTab(this.app, this));
    this.checkCCInstall();
    console.log("\u6DF1\u5EA6\u6316\u6398 CC \u63D2\u4EF6\u5DF2\u52A0\u8F7D v0.1.0");
  }
  onunload() {
    this.killCCProcess();
    console.log("\u6DF1\u5EA6\u6316\u6398 CC \u63D2\u4EF6\u5DF2\u5378\u8F7D");
  }
  /** 激活（打开或聚焦）聊天视图 */
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      workspace.revealLeaf(leaf);
    }
  }
  /** 获取当前 CC 进程（用于 stdin 交互） */
  getCCProcess() {
    return this.ccProcess;
  }
  setCCProcess(proc) {
    this.ccProcess = proc;
  }
  killCCProcess() {
    if (this.ccProcess) {
      try {
        this.ccProcess.kill();
      } catch (e) {
      }
      this.ccProcess = null;
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    const data = await this.loadData();
    const chatHistory = data?.chatHistory;
    await this.saveData({ ...this.settings, chatHistory });
  }
  /** 检测 claude 命令是否可用 */
  async checkCCInstall() {
    try {
      const version = (0, import_child_process2.execSync)("claude --version", {
        timeout: 1e4,
        encoding: "utf-8",
        windowsHide: true
      });
      console.log("\u2705 CC \u5DF2\u5B89\u88C5:", version.trim());
      return true;
    } catch (e) {
      console.log("\u26A0\uFE0F CC \u672A\u5B89\u88C5\u3002\u7528\u6237\u9700\u8FD0\u884C: npm install -g @anthropic-ai/claude-code");
      new import_obsidian3.Notice(
        "\u26A0\uFE0F \u6DF1\u5EA6\u6316\u6398\uFF1AClaude Code \u672A\u5B89\u88C5\u3002\u8BF7\u5728\u7EC8\u7AEF\u8FD0\u884C npm install -g @anthropic-ai/claude-code",
        8e3
      );
      return false;
    }
  }
};
