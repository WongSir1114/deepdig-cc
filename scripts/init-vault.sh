#!/usr/bin/env bash
set -euo pipefail

# ═══ 深度挖掘 · Vault 初始化脚本（macOS / Linux） ═══

VAULT="${1:-}"

if [ -z "$VAULT" ]; then
    echo ""
    echo "用法: ./init-vault.sh [Obsidian Vault 路径]"
    echo "示例: ./init-vault.sh ~/Documents/深度挖掘"
    echo ""
    exit 1
fi

if [ ! -d "$VAULT" ]; then
    echo "❌ Vault 目录不存在: $VAULT"
    echo -n "是否创建该目录？(y/n) "
    read -r CREATE
    if [ "$CREATE" = "y" ] || [ "$CREATE" = "Y" ]; then
        mkdir -p "$VAULT"
        echo "✅ 已创建: $VAULT"
    else
        exit 1
    fi
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     深度挖掘 · Vault 初始化              ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "📁 Vault: $VAULT"
echo ""

# ── 1. 创建目录结构 ──
echo "📂 创建目录结构..."

DIRS=(
    "1-原子笔记/概念"
    "1-原子笔记/实体"
    "1-原子笔记/关键词"
    "1-原子笔记/关系"
    "1-原子笔记/投资思想"
    "2-MOC"
    "报告输出"
    ".obsidian/plugins/deepdig-cc"
    "_claude-versions"
)

for d in "${DIRS[@]}"; do
    if [ ! -d "$VAULT/$d" ]; then
        mkdir -p "$VAULT/$d"
        echo "  ✅ $d"
    else
        echo "  ⏭  $d (已存在)"
    fi
done

echo ""

# ── 2. 确定源文件位置 ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 按优先级查找 CLAUDE.md
CLAUDE_SRC=""
for candidate in \
    "$SCRIPT_DIR/../CLAUDE.md" \
    "$SCRIPT_DIR/../../CLAUDE.md" \
    "$SCRIPT_DIR/CLAUDE.md"; do
    if [ -f "$candidate" ]; then
        CLAUDE_SRC="$candidate"
        break
    fi
done

CLAUDE_SHORT_SRC=""
for candidate in \
    "$SCRIPT_DIR/../CLAUDE-SHORT.md" \
    "$SCRIPT_DIR/../../CLAUDE-SHORT.md" \
    "$SCRIPT_DIR/CLAUDE-SHORT.md"; do
    if [ -f "$candidate" ]; then
        CLAUDE_SHORT_SRC="$candidate"
        break
    fi
done

# ── 3. 写入 CLAUDE.md ──
if [ -z "$CLAUDE_SRC" ]; then
    echo "⚠️ 未找到 CLAUDE.md 模板文件。请确保 CLAUDE.md 与此脚本在同一目录。"
else
    # 备份已有 CLAUDE.md
    if [ -f "$VAULT/CLAUDE.md" ]; then
        TODAY=$(date +%Y%m%d)
        BACKUP="$VAULT/_claude-versions/${TODAY}-自动备份.md"
        cp "$VAULT/CLAUDE.md" "$BACKUP"
        echo "⚠️ 已有 CLAUDE.md → 已备份到 _claude-versions/${TODAY}-自动备份.md"
    fi
    cp "$CLAUDE_SRC" "$VAULT/CLAUDE.md"
    echo "✅ CLAUDE.md 已写入"
fi

if [ -n "$CLAUDE_SHORT_SRC" ]; then
    cp "$CLAUDE_SHORT_SRC" "$VAULT/CLAUDE-SHORT.md"
    echo "✅ CLAUDE-SHORT.md 已写入"
fi

echo ""

# ── 4. 复制插件文件 ──
PLUGIN_DEST="$VAULT/.obsidian/plugins/deepdig-cc"

for f in main.js manifest.json styles.css; do
    FOUND=false
    for candidate in \
        "$SCRIPT_DIR/../$f" \
        "$SCRIPT_DIR/../../$f" \
        "$SCRIPT_DIR/$f"; do
        if [ -f "$candidate" ]; then
            cp "$candidate" "$PLUGIN_DEST/"
            echo "✅ $f → .obsidian/plugins/deepdig-cc/"
            FOUND=true
            break
        fi
    done
    if [ "$FOUND" = false ]; then
        echo "⚠️ 未找到 $f（插件核心文件）——请从 GitHub Releases 下载"
    fi
done

echo ""
echo "═══════════════════════════════════════════"
echo "✅ Vault 初始化完成"
echo ""
echo "📋 下一步："
echo "  1. 打开 Obsidian → 打开此 Vault"
echo "  2. 设置 → 第三方插件 → 启用"深度挖掘 · CC""
echo "  3. 左侧 ribbon 图标 → 开始使用"
echo ""
echo "🔑 首次使用无需 License Key（7 天免费试用）"
echo ""
