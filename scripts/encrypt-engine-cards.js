/**
 * 引擎卡片导出加密脚本
 * 从底座 Vault 导出投资思想卡+方法卡 → AES-256-GCM → data.json
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_VAULT = 'D:/Obsidian/self-evolving-knowledge-base';
const OUTPUT = 'D:/Beaver_Technology/obsidian-cc-plugin/src/engine_cards.json';

// ⚠️ 生产密钥——编译进 main.js 后随 esbuild 混淆
const ENGINE_KEY = 'deepdig-engine-v1-20260624-cc-plugin-core';

function encrypt(text) {
    const key = crypto.scryptSync(ENGINE_KEY, 'deepdig-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
}

function readCard(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    // 去掉 frontmatter 之外的 YAML 分隔符噪音，保留完整内容
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
    return body.trim();
}

// 扫描投资思想卡
const thoughtDir = path.join(BASE_VAULT, '1-原子笔记/投资思想');
const methodDir = path.join(BASE_VAULT, '1-原子笔记/方法');

const cards = {};

// 投资思想卡
for (const f of fs.readdirSync(thoughtDir)) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace('.md', '');
    const content = readCard(path.join(thoughtDir, f));
    cards[name] = content;
    console.log(`✅ 思想卡: ${name} (${content.length} 字)`);
}

// 方法卡
for (const f of fs.readdirSync(methodDir)) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace('.md', '');
    const content = readCard(path.join(methodDir, f));
    cards[name] = content;
    console.log(`✅ 方法卡: ${name} (${content.length} 字)`);
}

// 打包加密
const payload = JSON.stringify({ version: 1, date: '2026-06-24', cards });
const encrypted = encrypt(payload);

fs.writeFileSync(OUTPUT, JSON.stringify({ engine_cards: encrypted }, null, 2));
console.log(`\n🔒 已加密 ${Object.keys(cards).length} 张引擎卡 → ${OUTPUT}`);
console.log(`   加密串长度: ${encrypted.length} 字符`);
