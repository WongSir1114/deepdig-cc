export interface DeepDigSettings {
    ccCliPath: string;      // Claude Code CLI 路径（默认 'claude'）
    licenseKey: string;     // Gumroad License Key（商业版授权）
    dsApiKey: string;        // DeepSeek API Key（管道用，CC不需要）
    autoStart: boolean;      // 启动时自动打开聊天
    showThinking: boolean;   // 是否显示 CC 思考过程
}

export const DEFAULT_SETTINGS: DeepDigSettings = {
    ccCliPath: 'claude',
    licenseKey: '',
    dsApiKey: '',
    autoStart: false,
    showThinking: false,
};

import { App, PluginSettingTab, Setting } from 'obsidian';
import type DeepDigCCPlugin from '../main';

// ═══ Gumroad License Key 在线验证 ═══
async function verifyGumroadKey(key: string): Promise<{ valid: boolean; message: string }> {
    if (!key || !key.trim()) {
        return { valid: false, message: '请输入 License Key' };
    }
    try {
        const resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `product_permalink=deepdig-cc&license_key=${encodeURIComponent(key.trim())}`,
        });
        const data = await resp.json();
        if (data.success === true && !data.license?.cancelled) {
            return { valid: true, message: '✅ 已激活' };
        }
        if (data.license?.cancelled) {
            return { valid: false, message: '❌ 订阅已取消' };
        }
        return { valid: false, message: '❌ Key 无效' };
    } catch {
        return { valid: false, message: '⚠️ 网络不可达，请稍后重试' };
    }
}

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

        // ═══ License Key（商业版授权） ═══
        const hasKey = this.plugin.settings.licenseKey && this.plugin.settings.licenseKey.length > 0;
        const licenseStatusEl = containerEl.createDiv({
            text: hasKey ? `✅ 已激活 · ${this.plugin.settings.licenseKey.slice(0, 8)}...` : '🔑 未激活 · 7 天免费试用',
            cls: 'setting-item-description',
        });
        licenseStatusEl.style.marginBottom = '8px';
        licenseStatusEl.style.fontWeight = '600';

        new Setting(containerEl)
            .setName('License Key')
            .setDesc('从 Gumroad 购买后获取。粘贴后点击验证即可激活全部功能。')
            .addText(text => {
                text.setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXXXXXX')
                    .setValue(this.plugin.settings.licenseKey || '')
                    .onChange(async (value) => {
                        this.plugin.settings.licenseKey = value.trim();
                        await this.plugin.saveSettings();
                    });
                return text;
            })
            .addButton(btn => {
                btn.setButtonText('验证')
                    .setCta()
                    .onClick(async () => {
                        btn.setButtonText('验证中...');
                        btn.setDisabled(true);
                        const result = await verifyGumroadKey(this.plugin.settings.licenseKey || '');
                        btn.setButtonText('验证');
                        btn.setDisabled(false);
                        if (result.valid) {
                            licenseStatusEl.setText(`✅ 已激活 · ${(this.plugin.settings.licenseKey || '').slice(0, 8)}...`);
                        } else {
                            licenseStatusEl.setText(`🔑 ${result.message}`);
                        }
                    });
                return btn;
            });

        containerEl.createEl('p', {
            text: '💡 License Key 通过 Gumroad 购买。插件不做中间商，Key 由 Gumroad 管理订阅和续费，存于本地。',
            cls: 'setting-item-description',
        });

        containerEl.createEl('hr');

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
