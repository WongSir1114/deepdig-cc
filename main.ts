import { Plugin, WorkspaceLeaf, addIcon, Notice } from 'obsidian';
import { ChatView, CHAT_VIEW_TYPE } from './src/ChatView';
import { DeepDigSettings, DeepDigSettingTab, DEFAULT_SETTINGS } from './src/settings';
import { execSync } from 'child_process';

// 自定义图标：深度挖掘 logo
addIcon('deepdig-logo', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3-3 4 4 3-3"/><path d="M8 12l3 3 4-4 3 3"/></svg>`);

export default class DeepDigCCPlugin extends Plugin {
    declare settings: DeepDigSettings;
    private ccProcess: any = null;

    async onload() {
        await this.loadSettings();

        // 注册聊天视图
        this.registerView(
            CHAT_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new ChatView(leaf, this)
        );

        // 左侧 ribbon 图标
        this.addRibbonIcon('deepdig-logo', '深度挖掘 CC', () => {
            this.activateView();
        });

        // 命令面板命令
        this.addCommand({
            id: 'open-deepdig-chat',
            name: '打开深度挖掘聊天',
            callback: () => this.activateView(),
        });

        // 新对话命令
        this.addCommand({
            id: 'new-deepdig-chat',
            name: '深度挖掘 · 新对话',
            callback: () => {
                const leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
                if (leaf && leaf.view instanceof ChatView) {
                    leaf.view.clearChat();
                }
                this.activateView();
            },
        });

        // 设置
        this.addSettingTab(new DeepDigSettingTab(this.app, this));

        // 检测 CC 是否已安装
        this.checkCCInstall();

        console.log('深度挖掘 CC 插件已加载 v0.1.0');
    }

    onunload() {
        this.killCCProcess();
        console.log('深度挖掘 CC 插件已卸载');
    }

    /** 激活（打开或聚焦）聊天视图 */
    async activateView() {
        const { workspace } = this.app;

        // 检查是否已经打开
        const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            return;
        }

        // 在右侧边栏打开
        const leaf = workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
            workspace.revealLeaf(leaf);
        }
    }

    /** 获取当前 CC 进程（用于 stdin 交互） */
    getCCProcess(): any {
        return this.ccProcess;
    }

    setCCProcess(proc: any) {
        this.ccProcess = proc;
    }

    killCCProcess() {
        if (this.ccProcess) {
            try { this.ccProcess.kill(); } catch (e) { /* ignore */ }
            this.ccProcess = null;
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        // 保留 chatHistory（ChatView 存储在 data 中）
        const data = await this.loadData();
        const chatHistory = data?.chatHistory;
        await this.saveData({ ...this.settings, chatHistory });
    }

    /** 检测 claude 命令是否可用 */
    async checkCCInstall(): Promise<boolean> {
        try {
            const version = execSync('claude --version', {
                timeout: 10000,
                encoding: 'utf-8',
                windowsHide: true,
            });
            console.log('✅ CC 已安装:', version.trim());
            return true;
        } catch (e) {
            console.log('⚠️ CC 未安装。用户需运行: npm install -g @anthropic-ai/claude-code');
            new Notice(
                '⚠️ 深度挖掘：Claude Code 未安装。请在终端运行 npm install -g @anthropic-ai/claude-code',
                8000
            );
            return false;
        }
    }
}
