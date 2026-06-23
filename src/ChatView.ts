import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import type DeepDigCCPlugin from '../main';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const CHAT_VIEW_TYPE = 'deepdig-cc-chat';
interface ChatMessage { role: 'user' | 'ai' | 'system' | 'error'; content: string; time: string; id: string; }

export class ChatView extends ItemView {
    plugin: DeepDigCCPlugin;
    messages: ChatMessage[] = [];
    busy = false;
    private ccProc: any = null;
    private msgContainer!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtn!: HTMLButtonElement;
    private stopBtn!: HTMLButtonElement;
    private currentStreamEl: HTMLElement | null = null;
    private currentStreamContent = '';

    // ═══ 方案2.5：状态追踪 ═══
    private cardSnapshot: Set<string> = new Set();
    private ccStartTime: number = 0;
    private lastWriteResult: { files: string[] } | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: DeepDigCCPlugin) { super(leaf); this.plugin = plugin; }
    getViewType(): string { return CHAT_VIEW_TYPE; }
    getDisplayText(): string { return '深度挖掘 CC'; }
    getIcon(): string { return 'deepdig-logo'; }

    async onOpen() {
        const c = this.containerEl.children[1]; c.empty(); c.addClass('deepdig-cc-container');
        const h = c.createDiv('dd-header'); const lo = h.createSpan('dd-logo'); setIcon(lo, 'deepdig-logo');
        h.createSpan('dd-title').setText('深度挖掘 · CC'); h.createSpan('dd-subtitle').setText('Claude Opus 投研分析');
        const nb = h.createEl('button', { text: '🔄 新对话', cls: 'dd-header-btn' }); nb.onclick = () => this.clearChat();
        this.msgContainer = c.createDiv('dd-messages');
        const f = c.createDiv('dd-footer'); const iw = f.createDiv('dd-input-wrap');
        this.inputEl = iw.createEl('textarea', { placeholder: '深挖XX / XX赛道怎么看 / XX是什么', cls: 'dd-input' });
        this.inputEl.rows = 2;
        this.inputEl.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); } };
        const br = f.createDiv('dd-btn-row'); br.createSpan('dd-hint').setText('Enter 发送 · Shift+Enter 换行');
        this.stopBtn = br.createEl('button', { text: '⏹ 停止', cls: 'dd-stop-btn' }); this.stopBtn.style.display = 'none'; this.stopBtn.onclick = () => this.stopCC();
        this.sendBtn = br.createEl('button', { text: '发送', cls: 'dd-send-btn' }); this.sendBtn.onclick = () => this.sendMessage();
        this.renderWelcome();
    }
    async onClose() { this.stopCC(); }

    async sendMessage() {
        if (this.busy) return; const t = this.inputEl.value.trim(); if (!t) return;
        this.inputEl.value = ''; this.addMessage('user', t);
        this.busy = true; this.sendBtn.disabled = true; this.stopBtn.style.display = 'inline-block';
        await this.runCC(t);
    }

    // ═══ 文件扫描 ═══
    private scanDirForMd(dir: string, vaultPath: string, snapshot: Set<string>, names: string[]): void {
        try {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    this.scanDirForMd(fp, vaultPath, snapshot, names);
                } else if (entry.name.endsWith('.md')) {
                    const rel = path.relative(vaultPath, fp).replace(/\\/g, '/');
                    snapshot.add(rel);
                    names.push(entry.name.replace('.md', ''));
                }
            }
        } catch (_) {}
    }

    private scanExistingCards(): string[] {
        const vaultPath = (this.app.vault.adapter as any).basePath || '';
        const names: string[] = [];
        this.cardSnapshot = new Set();
        this.scanDirForMd(path.join(vaultPath, '1-原子笔记'), vaultPath, this.cardSnapshot, names);
        this.scanDirForMd(path.join(vaultPath, '报告输出'), vaultPath, this.cardSnapshot, names);
        return names;
    }

    private verifyCardsWritten(): { found: string[] } {
        const vaultPath = (this.app.vault.adapter as any).basePath || '';
        const found: string[] = [];
        const scanDir = (dir: string): void => {
            try {
                if (!fs.existsSync(dir)) return;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fp = path.join(dir, entry.name);
                    if (entry.isDirectory()) { scanDir(fp); }
                    else if (entry.name.endsWith('.md')) {
                        const rel = path.relative(vaultPath, fp).replace(/\\/g, '/');
                        if (!this.cardSnapshot.has(rel)) {
                            found.push(rel);
                        } else if (this.ccStartTime > 0) {
                            try {
                                if (fs.statSync(fp).mtimeMs > this.ccStartTime) {
                                    found.push(rel);
                                }
                            } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        };
        scanDir(path.join(vaultPath, '1-原子笔记'));
        scanDir(path.join(vaultPath, '报告输出'));
        return { found };
    }

    // ═══ 方案2.5 新增：扫描知识底座卡片摘要 ═══
    private scanKnowledgeBase(): string[] {
        const vaultPath = (this.app.vault.adapter as any).basePath || '';
        const lines: string[] = [];

        // L1 政策卡（概念/目录中 layer: L1 的卡片）
        const conceptDir = path.join(vaultPath, '1-原子笔记', '概念');
        const l1Cards: string[] = [];
        const l2Cards: string[] = [];
        if (fs.existsSync(conceptDir)) {
            for (const f of fs.readdirSync(conceptDir)) {
                if (!f.endsWith('.md')) continue;
                try {
                    const content = fs.readFileSync(path.join(conceptDir, f), 'utf-8').slice(0, 500);
                    const title = f.replace('.md', '');
                    // 检测 layer 字段
                    if (content.includes('layer: L1')) {
                        // 提取一句话定义
                        const defMatch = content.match(/## 一句话定义\n\n([^\n]+)/);
                        l1Cards.push(`  - ${title}${defMatch ? '：' + defMatch[1] : ''}`);
                    } else if (content.includes('layer: L2') || content.includes('锚点卡: true')) {
                        l2Cards.push(`  - ${title}`);
                    }
                } catch (_) {}
            }
        }

        if (l1Cards.length > 0) {
            lines.push('【L1 政策卡】');
            lines.push(...l1Cards);
            lines.push('');
        }
        if (l2Cards.length > 0) {
            lines.push('【L2 赛道卡】');
            lines.push(...l2Cards);
            lines.push('');
        }

        // 关键词卡
        const kwDir = path.join(vaultPath, '1-原子笔记', '关键词');
        if (fs.existsSync(kwDir)) {
            const kwCards: string[] = [];
            for (const f of fs.readdirSync(kwDir)) {
                if (!f.endsWith('.md')) continue;
                try {
                    const content = fs.readFileSync(path.join(kwDir, f), 'utf-8').slice(0, 400);
                    const title = f.replace('.md', '');
                    // 提取穿行L2数
                    const crossMatch = content.match(/穿行于哪些L2[\s\S]*?(?:##|$)/);
                    const l2Refs = crossMatch ? (crossMatch[0].match(/\[\[([^\]]+)\]\]/g) || []).length : 0;
                    kwCards.push(`  - ${title}（穿行${l2Refs}个L2）`);
                } catch (_) {}
            }
            if (kwCards.length > 0) {
                lines.push('【关键词卡】');
                lines.push(...kwCards.slice(0, 15));
                lines.push('');
            }
        }

        return lines;
    }

    // ═══ 方案2.5 核心：构建完整 stdin ═══
    private buildStdin(userMsg: string): string {
        const parts: string[] = [];

        // ① 完整对话历史（不截断·用于上下文连贯）
        if (this.messages.length > 0) {
            const recent = this.messages
                .filter(m => m.role === 'user' || m.role === 'ai')
                .slice(-10);
            if (recent.length > 0) {
                parts.push('=== 对话历史 ===');
                parts.push(recent.map(m =>
                    (m.role === 'user' ? '用户' : '深度挖掘') + ': ' + m.content
                ).join('\n\n'));
                parts.push('');
            }
        }

        // ② 知识底座摘要
        const kbSummary = this.scanKnowledgeBase();
        if (kbSummary.length > 0) {
            parts.push('=== 知识底座 ===');
            parts.push('以下是你所在知识库已有的 L1/L2/关键词卡片（分析时可引用）：');
            parts.push(...kbSummary);
        }

        // ③ 上一轮写卡结果
        if (this.lastWriteResult && this.lastWriteResult.files.length > 0) {
            parts.push('=== 上一轮写卡结果 ===');
            parts.push('你上一轮成功写入了以下文件（如果用户追问"写到哪里"，以此为准）：');
            parts.push(this.lastWriteResult.files.join('\n'));
            parts.push('');
        }

        // ④ 用户消息
        parts.push('=== 用户消息 ===');
        parts.push(userMsg);

        // ⑤ 末尾标注规则
        parts.push('');
        parts.push('---');
        parts.push('直接开始分析。在回复末尾，用单独一行标注应该新建或更新的卡片（如果不需要写卡则写 none）：');
        parts.push('##WRITE_CARDS: 卡片名(类型), 卡片名(类型)');

        return parts.join('\n');
    }

    // ═══ 方案2.5 重构：双调用模式（对话 → 写卡分离）═══
    async runCC(userMsg: string) {
        const ccPath = this.plugin.settings.ccCliPath || 'claude';
        const vaultPath = (this.app.vault.adapter as any).basePath || '';

        // 第一步：对话调用（分析 + 回复）
        this.ccStartTime = Date.now();
        const convStdin = this.buildStdin(userMsg);
        const convOutput = await this.spawnCC(ccPath, vaultPath, convStdin, 60, true);

        if (convOutput === null) return; // CC 启动失败或异常退出·已在 spawnCC 内处理

        // 解析 ##WRITE_CARDS 标记
        const writeCardsMatch = convOutput.match(/##WRITE_CARDS:\s*(.+)/);
        const cardList = writeCardsMatch
            ? writeCardsMatch[1].trim()
            : '';
        const shouldWriteCards = cardList && cardList.toLowerCase() !== 'none';

        // 检测本轮对话调用写的新文件
        const convFiles = this.verifyCardsWritten();

        // 第二步：写卡调用（如果有卡片要写）
        if (shouldWriteCards) {
            const cardStdin = [
                '=== 以下是上一轮分析的全部内容 ===',
                convOutput,
                '',
                '=== 写卡指令 ===',
                `基于以上分析，将以下卡片写入 Vault（${vaultPath}）：`,
                cardList,
                '',
                '要求：',
                '- 实体主卡含 frontmatter（tags/created/updated/layer/linked≥3/moat_score/governance_score/growth_quality）',
                '- 实体主卡末尾必须含 ## 📇 子卡索引 表格',
                '- 新概念建关键词卡到 1-原子笔记/关键词/',
                '- 对比/涌现时建关系卡',
                '- 同名卡片 → 更新版本号，不新建',
                '- linked≥3 条且标注原因',
                '- 写完后在末尾标一行 ##CARDS_DONE',
            ].join('\n');

            // 写卡调用 —— 静默·不渲染
            this.scanExistingCards(); // 重新拍快照（对话调用可能已写了部分文件）
            await this.spawnCC(ccPath, vaultPath, cardStdin, 90, false);
        }

        // 合并检测所有写入的文件
        const allFiles = this.verifyCardsWritten();
        const allFileNames = [...new Set([...convFiles.found, ...allFiles.found])];

        if (allFileNames.length > 0) {
            this.lastWriteResult = { files: allFileNames };
            this.addMessage('system', '📇 ' + allFileNames.join(', '));
            this.app.vault.getMarkdownFiles();
        }

        this.busy = false; this.sendBtn.disabled = false; this.stopBtn.style.display = 'none';
    }

    /** 方案2.5：统一的 spawn CC 方法 */
    private spawnCC(
        ccPath: string,
        vaultPath: string,
        stdinContent: string,
        maxTurns: number,
        renderToUser: boolean
    ): Promise<string | null> {
        return new Promise((resolve) => {
            if (renderToUser) {
                this.currentStreamContent = '';
                this.currentStreamEl = this.createStreamBubble();
            }

            const isWin = process.platform === 'win32';
            const ccCmd = `"${ccPath}" --print --model opus --max-turns ${maxTurns} --allowedTools "Write,Edit,Bash,Read,WebSearch,Glob,Grep" --add-dir "${vaultPath}"`;

            const spawnOpts: any = {
                cwd: vaultPath,
                stdio: ['pipe', 'pipe', 'pipe'] as const,
                shell: isWin ? true : false,
                env: {
                    ...process.env,
                    PATH: `C:\\Program Files\\nodejs;${process.env.PATH || ''}`,
                }
            };

            const proc = spawn(ccCmd, [], spawnOpts);
            if (renderToUser) {
                this.ccProc = proc;
                this.plugin.setCCProcess(proc);
            }

            proc.stdin.write(stdinContent);
            proc.stdin.end();

            let stdoutBuf = '';
            let stderrBuf = '';

            proc.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf-8');
                stdoutBuf += text;
                if (renderToUser) {
                    this.appendStreamText(text);
                }
            });

            proc.stderr.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString('utf-8');
            });

            proc.on('close', (code: number | null) => {
                if (renderToUser) {
                    this.ccProc = null;
                    this.plugin.setCCProcess(null);
                    this.removeSystemMessages();
                }

                if (code !== 0 && stdoutBuf.length === 0) {
                    if (renderToUser) {
                        this.removeStreamBubble();
                        this.addMessage('error',
                            `CC 异常退出 (code=${code})。${stderrBuf ? '\n\n' + stderrBuf.slice(0, 500) : ''}\n\n确认已安装：npm install -g @anthropic-ai/claude-code`);
                        this.busy = false;
                        this.sendBtn.disabled = false;
                        this.stopBtn.style.display = 'none';
                    }
                    resolve(null);
                } else {
                    if (renderToUser) {
                        this.finalizeStreamBubble();
                    }
                    // 去掉 ANSI 控制字符后返回
                    const clean = stdoutBuf
                        .replace(/\x1b\[[0-9;]*m/g, '')
                        .replace(/⏺.*?(\n|$)/g, '')
                        .replace(/⎿.*?(\n|$)/g, '')
                        .trim();
                    resolve(clean);
                }
            });

            proc.on('error', (err: Error) => {
                if (renderToUser) {
                    this.removeSystemMessages();
                    this.removeStreamBubble();
                    this.addMessage('error', '无法启动 CC: ' + err.message);
                    this.busy = false;
                    this.sendBtn.disabled = false;
                    this.stopBtn.style.display = 'none';
                    this.ccProc = null;
                    this.plugin.setCCProcess(null);
                }
                resolve(null);
            });
        });
    }

    // ═══════════════════════ UI（基本不变·仅调整 stream 处理）═══════════════════════
    private appendStreamText(text: string) {
        this.currentStreamContent += text;
        if (this.currentStreamEl) {
            const c = this.currentStreamContent
                .replace(/\x1b\[[0-9;]*m/g, '')
                .replace(/⏺.*?(\n|$)/g, '')
                .replace(/⎿.*?(\n|$)/g, '')
                .trim();
            this.currentStreamEl.empty();
            MarkdownRenderer.render(this.app, c, this.currentStreamEl, '', this);
        }
        this.scrollToBottom();
    }

    private finalizeStreamBubble() {
        if (!this.currentStreamEl) return;
        const c = this.currentStreamContent
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/⏺.*?(\n|$)/g, '')
            .replace(/⎿.*?(\n|$)/g, '')
            .trim();
        if (!c) {
            this.removeStreamBubble();
            this.addMessage('ai', '（CC 未返回内容）');
            return;
        }
        this.currentStreamEl.empty();
        this.addMessageBubble(this.currentStreamEl, 'ai', c);
        this.currentStreamEl.removeClass('dd-streaming');
        this.messages.push({ role: 'ai', content: c, time: this.now(), id: 'ai_' + Date.now() });
        this.saveHistory();
        this.currentStreamEl = null;
        this.currentStreamContent = '';
    }

    private createStreamBubble(): HTMLElement { return this.msgContainer.createDiv('dd-msg ai streaming'); }
    private removeStreamBubble() {
        if (this.currentStreamEl) { this.currentStreamEl.remove(); this.currentStreamEl = null; this.currentStreamContent = ''; }
    }
    private removeSystemMessages() { this.msgContainer.querySelectorAll('.dd-msg.system').forEach(el => el.remove()); }

    addMessage(role: ChatMessage['role'], content: string) {
        const m: ChatMessage = { role, content, time: this.now(), id: role + '_' + Date.now() };
        if (role === 'user' || role === 'ai') { this.messages.push(m); this.saveHistory(); }
        this.renderMessage(m); this.scrollToBottom();
    }

    private renderMessage(msg: ChatMessage) {
        const el = this.msgContainer.createDiv('dd-msg ' + msg.role);
        this.addMessageBubble(el, msg.role, msg.content, msg.time);
    }

    private addMessageBubble(el: HTMLElement, role: string, content: string, time?: string) {
        if (role === 'user') el.createDiv('dd-avatar').setText('👤');
        else if (role === 'ai') setIcon(el.createDiv('dd-avatar'), 'deepdig-logo');
        else if (role === 'system') el.createDiv('dd-avatar').setText('⚡');
        else if (role === 'error') el.createDiv('dd-avatar').setText('⚠️');
        const body = el.createDiv('dd-body');
        const rl = role === 'user' ? '你' : role === 'system' ? '系统' : role === 'error' ? '错误' : '深度挖掘';
        const meta = body.createDiv('dd-meta');
        meta.setText(rl + ' · ' + (time || this.now()));
        if (role === 'ai' || role === 'user') {
            const cb = meta.createSpan('dd-copy-btn');
            cb.setText('📋');
            cb.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const t = content
                    .replace(/\x1b\[[0-9;]*m/g, '')
                    .replace(/⏺.*?(\n|$)/g, '')
                    .replace(/⎿.*?(\n|$)/g, '');
                navigator.clipboard.writeText(t).then(() => { cb.setText('✅'); setTimeout(() => cb.setText('📋'), 1500); })
                    .catch(() => { cb.setText('❌'); setTimeout(() => cb.setText('📋'), 1500); });
            };
        }
        const bub = body.createDiv('dd-bubble');
        if (role === 'system' || role === 'error') bub.setText(content);
        else MarkdownRenderer.render(this.app, content, bub, '', this);
    }

    private renderWelcome() {
        if (this.messages.length > 0) {
            this.msgContainer.empty();
            for (const m of this.messages) this.renderMessage(m);
            return;
        }
        const el = this.msgContainer.createDiv('dd-msg ai');
        setIcon(el.createDiv('dd-avatar'), 'deepdig-logo');
        const b = el.createDiv('dd-body');
        b.createDiv('dd-meta').setText('深度挖掘 · ' + this.now());
        const bb = b.createDiv('dd-bubble');
        bb.innerHTML = '<p>你好，我是<strong>深度挖掘 · CC</strong>。</p><p>Claude Opus 推理引擎 + Obsidian 知识底座。问我你想了解的赛道、公司或概念。</p><hr><p><strong>试试：</strong></p><ul><li>"深挖宁德时代 300750"</li><li>"储能赛道怎么看"</li><li>"钠离子电池产业化进展"</li></ul>';
    }

    stopCC() {
        if (this.ccProc) { this.ccProc.kill('SIGTERM'); this.ccProc = null; this.plugin.setCCProcess(null); }
        this.busy = false; this.sendBtn.disabled = false; this.stopBtn.style.display = 'none';
        this.removeSystemMessages();
        if (this.currentStreamContent) this.finalizeStreamBubble();
        new Notice('已停止 CC');
    }

    clearChat() {
        this.stopCC();
        this.messages = [];
        this.lastWriteResult = null;
        this.currentStreamContent = '';
        this.currentStreamEl = null;
        this.saveHistory();
        this.msgContainer.empty();
        this.renderWelcome();
    }

    private scrollToBottom() { this.msgContainer.scrollTop = this.msgContainer.scrollHeight; }
    private now(): string {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes());
    }
    async saveHistory() {
        const ts = this.messages.slice(-40).map(m => ({
            role: m.role,
            content: m.content.slice(0, 5000),
            time: m.time,
            id: m.id
        }));
        await this.plugin.saveData({ ...this.plugin.settings, chatHistory: ts });
    }
    async loadHistory() {
        const d = await this.plugin.loadData();
        if (d?.chatHistory) this.messages = d.chatHistory;
    }
}
