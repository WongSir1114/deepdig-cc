export interface DeepDigSettings {
    ccCliPath: string;      // Claude Code CLI 路径（默认 'claude'）
    dsApiKey: string;        // DeepSeek API Key（管道用，CC不需要）
    autoStart: boolean;      // 启动时自动打开聊天
    showThinking: boolean;   // 是否显示 CC 思考过程
}

export const DEFAULT_SETTINGS: DeepDigSettings = {
    ccCliPath: 'claude',
    dsApiKey: '',
    autoStart: false,
    showThinking: false,
};

import { App, PluginSettingTab, Setting } from 'obsidian';
import type DeepDigCCPlugin from '../main';

export class DeepDigSettingTab extends PluginSettingTab {
    plugin: DeepDigCCPlugin;

    constructor(app: App, plugin: DeepDigCCPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '深度挖掘 · CC 插件设置' });

        new Setting(containerEl)
            .setName('CC CLI 路径')
            .setDesc('Claude Code 命令行路径，默认 claude（PATH 中已存在时无需修改）')
            .addText(text => text
                .setPlaceholder('claude')
                .setValue(this.plugin.settings.ccCliPath)
                .onChange(async (value) => {
                    this.plugin.settings.ccCliPath = value || 'claude';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('DeepSeek API Key')
            .setDesc('用于 AKShare 金融数据管道（CC 推理本身不需要）')
            .addText(text => text
                .setPlaceholder('sk-xxx...')
                .setValue(this.plugin.settings.dsApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.dsApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('启动时自动打开聊天')
            .setDesc('Obsidian 启动后自动激活深度挖掘聊天面板')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoStart)
                .onChange(async (value) => {
                    this.plugin.settings.autoStart = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('显示思考过程')
            .setDesc('在聊天中显示 CC 的工具调用和推理过程')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showThinking)
                .onChange(async (value) => {
                    this.plugin.settings.showThinking = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('hr');
        containerEl.createEl('p', {
            text: '💡 插件不做 AI 推理——所有分析由 Claude Code (Claude Opus) 完成。卡片自动写入当前 Obsidian Vault 的 1-原子笔记/ 目录。',
            cls: 'setting-item-description'
        });
    }
}
