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
    private statusEl: HTMLElement | null = null;

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
        await this.loadHistory();
        if (this.messages.length > 0) {
            this.messages.forEach(m => this.renderMessage(m));
            this.scrollToBottom();
        } else {
            this.renderWelcome();
        }
    }
    async onClose() { this.stopCC(); }

    // ═══ UI 状态指示器 ═══
    private showStatus(iconType: 'thinking' | 'cards', text: string): HTMLElement {
        this.removeStatus();
        const el = this.msgContainer.createDiv(`dd-status ${iconType}`);
        const ic = el.createDiv('dd-status-icon');
        el.createSpan('dd-status-text').setText(text);
        el.createSpan('dd-status-dots');
        this.statusEl = el;
        this.scrollToBottom();
        return el;
    }
    private removeStatus() {
        if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; }
    }
    private showCardNotice(files: string[]) {
        const unique = [...new Set(files)];
        const el = this.msgContainer.createDiv('dd-card-notice');
        el.createSpan().setText('📇 ');
        const cnt = el.createSpan('dd-card-count');
        cnt.setText(`已更新 ${unique.length} 张卡片`);
        el.createSpan().setText(' （点击展开）');
        const list = this.msgContainer.createDiv('dd-card-list');
        for (const f of unique) {
            list.createEl('a', { text: f }).onclick = () => {
                this.app.workspace.openLinkText(f, '', false);
            };
        }
        el.onclick = () => { list.classList.toggle('open'); };
        this.scrollToBottom();
    }

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

        try {
            // 第一步：思考动画——对话调用（分析 + 回复）
            this.ccStartTime = Date.now();
            this.showStatus('thinking', '深度挖掘 · 正在分析');
            const convStdin = this.buildStdin(userMsg);
            const convOutput = await this.spawnCC(ccPath, vaultPath, convStdin, 60, true);

            this.removeStatus();
            if (convOutput === null) {
                return;
            }

            // 解析 ##WRITE_CARDS 标记
            const writeCardsMatch = convOutput.match(/##WRITE_CARDS:\s*(.+)/);
        const cardList = writeCardsMatch
            ? writeCardsMatch[1].trim()
            : '';
        const shouldWriteCards = cardList && cardList.toLowerCase() !== 'none';

        // 检测本轮对话调用写的新文件
        const convFiles = this.verifyCardsWritten();

        // 第二步：写卡调用，带写卡动画
        if (shouldWriteCards) {
            this.showStatus('cards', `正在生成卡片：${cardList.slice(0, 60)}...`);

            // ═══ 底座版卡片标准（v0.26·与本地CC一致）═══
            const cardStandards = [
                '【硬约束——违反则写卡无效】',
                '- 只写下面列出的卡片。不碰任何其他文件。不修改已有卡片的内容。',
                '- 不需要扫描Vault中已有卡片——直接写新卡就行。',
                `- 需要写的卡片清单：${cardList}`,
                '- 本轮最多写 15 个文件。超过就停止。',
                '',
                '=== 以下是上一轮分析的全部内容 ===',
                convOutput.slice(0, 15000),  // 截断——分析太长也会浪费token
                '',
                '=== 写卡指令 ===',
                `基于以上分析，只写以下卡片到 Obsidian Vault（${vaultPath}）：`,
                cardList,
                '',
                '=== 卡片制作标准（与底座版 v0.26 一致·强制执行）===',
                '',
                '【通用 frontmatter】（所有卡片必含）',
                'tags: [类型, 子标签]',
                'domain: [领域]',
                'created: YYYY-MM-DD',
                'updated: YYYY-MM-DD',
                'version: v0.1',
                'status: 草稿',
                'linked: [[卡A]] [[卡B]] [[卡C]]',
                'aliases: [别名]',
                '锚点卡: true/false',
                '调用次数: 0',
                '',
                '【L4 实体主卡 frontmatter 额外字段】',
                'layer: L4',
                'card_stage: seed|growing|mature',
                'moat_score: 0-100',
                'governance_score: 0-100',
                'growth_quality: high|medium|low',
                '子卡数量: 0-7',
                '关键词触发词: [词1, 词2]',
                '',
                '【L4 实体主卡正文·10维结构】',
                '① 一句话定位（≤50字）',
                '② 治理体检 S4（含股东行为+ESG·governance_score+依据）',
                '③ 护城河分析 S5（7维度逐条·≥2家竞争对手对比表·毛利率/净利率/ROE/市占率）',
                '④ 成长质量 S6（增长来源拆解：内生/并表/会计/周期·近3年增速）',
                '⑤ 经营真实性 S7（CFO/NI·前五大客户占比·供应商占比·关联交易·海外收入分布）',
                '⑥ 估值与修正 S8（PE/PB分位+行业对比+PE×PB格雷厄姆锚·三情景估值）',
                '⑦ 核心矛盾（多方 vs 空方·双列表）',
                '⑧ 逆向思维·最可能死法（3种+量化触发信号）',
                '⑨ 数据溯源（5项关键数据·T1/T2/T3+获取时间）',
                '⑩ 综合判断（一句话：买/等/避 + 核心理由）',
                '',
                '【📇 子卡索引表格】（实体主卡末尾必含）',
                '| 维度 | 子卡 | 一句话 |',
                '|------|------|------|',
                '| 产品线 | [[公司·产品线]] | ≤20字 |',
                '| 股东结构 | [[公司·股东结构]] | ≤20字 |',
                '| 客户集中度 | [[公司·客户集中度]] | ≤20字 |',
                '| 管理层 | [[公司·管理层]] | ≤20字 |',
                '| 估值分析 | [[公司·估值分析]] | ≤20字 |',
                '| 风险跟踪 | [[公司·风险跟踪]] | ≤20字 |',
                '| 交叉关联 | [[公司·交叉关联]] | ≤20字 |',
                '',
                '【维度子卡】（6+1张·命名格式：{公司名}·{维度}）',
                '1. 股东结构：实控人/前十大/质押/增减持/机构变化/回购执行',
                '2. 产品线：各业务占比/增速/毛利率/生命周期/客户',
                '3. 客户集中度：前五大客户/单客依赖度/集中度风险/海外分布',
                '4. 管理层：核心团队/背景/持股/治理扣分项',
                '5. 估值分析：PE/PB分位/三情景/DCF参数/同行对比',
                '6. 风险跟踪：风险矩阵≥5行/量化触发信号/next_check到期日',
                '7. 交叉关联：因果链+矛盾矩阵+多空力量对比+竞争关系链',
                '',
                '【概念卡】→ 1-原子笔记/概念/{概念名}.md',
                '一句话定义+核心内容+为什么重要+链接≥3含原因',
                '',
                '【关键词卡】→ 1-原子笔记/关键词/{关键词}.md',
                'frontmatter: tags: [关键词, 子标签] / status: 新兴|追踪中|成熟 / priority: 高|中|低',
                '正文: 一句话定义+穿行于哪些L2+为什么重要+当前阶段+来源',
                'linked ≥1张实体卡 + ≥1张L2赛道卡',
                '',
                '【关系卡】→ 1-原子笔记/关系/{A}↔{B}.md',
                'frontmatter: tags: [关系, 子标签] / entity_A/entity_B / relation_type / discovery / confidence / strength',
                '正文: 关系描述+证据+为什么重要',
                '',
                '【报告】→ 报告输出/{标题}-YYYY-MM-DD.md',
                '自由格式·含数据质量声明段落·P0-0E审查日志（如有完整数据管道）',
                '',
                '【硬性要求】',
                '- linked ≥ 3 条，每条标注链接原因（→ why）',
                '- 同名卡片 → 更新 version，不新建',
                '- 首次引用 EPS/BVPS 注明计算口径',
                '- card_stage 判定：linked<3→seed | linked≥3+有评分→growing | ≥4维度+linked≥5→mature',
                '- 数据标注来源层级 T1/T2/T3 + 获取时间',
                '',
                '写完后在末尾单独一行：##CARDS_DONE',
            ].join('\n');

            // 写卡调用 —— 静默·不渲染（减少turns至40·只写新卡）
            this.scanExistingCards();
            await this.spawnCC(ccPath, vaultPath, cardStandards, 40, false);
            this.removeStatus();
        }

        // 只显示真正新建的文件（不在快照中的）·不显示被mtime误判的旧文件
        const allFiles = this.verifyCardsWritten();
        const newFiles = allFiles.found.filter(f => !this.cardSnapshot.has(f));
        const allFileNames = [...new Set([...convFiles.found.filter(f => !this.cardSnapshot.has(f)), ...newFiles])];

        if (allFileNames.length > 0) {
            this.lastWriteResult = { files: allFileNames };
            this.showCardNotice(allFileNames);
            this.app.vault.getMarkdownFiles();
        }

        this.busy = false; this.sendBtn.disabled = false; this.stopBtn.style.display = 'none';
        } catch (e: any) {
            console.error('runCC 异常:', e);
            this.removeSystemMessages();
            this.removeStreamBubble();
            this.addMessage('error', '插件异常: ' + (e?.message || String(e)));
            this.busy = false;
            this.sendBtn.disabled = false;
            this.stopBtn.style.display = 'none';
        }
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

    private stripCardMark(text: string): string {
        return text.replace(/\n*##WRITE_CARDS:.*(\n|$)/g, '').trim();
    }

    private finalizeStreamBubble() {
        if (!this.currentStreamEl) return;
        const c = this.stripCardMark(
            this.currentStreamContent
                .replace(/\x1b\[[0-9;]*m/g, '')
                .replace(/⏺.*?(\n|$)/g, '')
                .replace(/⎿.*?(\n|$)/g, '')
        );
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
