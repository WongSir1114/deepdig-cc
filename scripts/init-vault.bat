@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════╗
echo ║     深度挖掘 · Vault 初始化              ║
echo ╚══════════════════════════════════════════╝
echo.

REM ── 1. 检测 vault 目录 ──
if "%~1"=="" (
    echo 用法: init-vault.bat [Obsidian Vault 路径]
    echo 示例: init-vault.bat "C:\Users\用户名\Documents\深度挖掘"
    echo.
    echo 或者直接拖拽 Obsidian Vault 文件夹到这个脚本上。
    exit /b 1
)

set "VAULT=%~1"

if not exist "%VAULT%" (
    echo ❌ Vault 目录不存在: %VAULT%
    echo 是否创建该目录？(y/n)
    set /p CREATE=
    if /i "!CREATE!"=="y" (
        mkdir "%VAULT%"
        echo ✅ 已创建: %VAULT%
    ) else (
        exit /b 1
    )
)

echo 📁 Vault: %VAULT%
echo.

REM ── 2. 创建目录结构 ──
echo 📂 创建目录结构...

set "DIRS=1-原子笔记\概念 1-原子笔记\实体 1-原子笔记\关键词 1-原子笔记\关系 1-原子笔记\投资思想 2-MOC 报告输出 .obsidian\plugins\deepdig-cc _claude-versions"

for %%d in (%DIRS%) do (
    if not exist "%VAULT%\%%d" (
        mkdir "%VAULT%\%%d"
        echo   ✅ %%d
    ) else (
        echo   ⏭  %%d (已存在)
    )
)

echo.

REM ── 3. 写入 CLAUDE.md ──
set "SCRIPT_DIR=%~dp0"
set "CLAUDE_SRC=%SCRIPT_DIR%..\CLAUDE.md"
set "CLAUDE_SHORT_SRC=%SCRIPT_DIR%..\CLAUDE-SHORT.md"

REM 尝试从 release 目录找，找不到就从脚本同目录找
if not exist "%CLAUDE_SRC%" set "CLAUDE_SRC=%SCRIPT_DIR%CLAUDE.md"
if not exist "%CLAUDE_SHORT_SRC%" set "CLAUDE_SHORT_SRC=%SCRIPT_DIR%CLAUDE-SHORT.md"

if not exist "%CLAUDE_SRC%" (
    echo ⚠️ 未找到 CLAUDE.md 模板文件。请确保 CLAUDE.md 与此脚本在同一目录。
) else (
    REM 备份已有 CLAUDE.md
    if exist "%VAULT%\CLAUDE.md" (
        for /f "tokens=1-3 delims=/ " %%a in ('date /t') do set "TODAY=%%a%%b%%c"
        set "BACKUP=%VAULT%\_claude-versions\!TODAY!-自动备份.md"
        copy "%VAULT%\CLAUDE.md" "!BACKUP!" >nul
        echo ⚠️ 已有 CLAUDE.md → 已备份到 _claude-versions\!TODAY!-自动备份.md
    )
    copy "%CLAUDE_SRC%" "%VAULT%\CLAUDE.md" >nul
    echo ✅ CLAUDE.md 已写入
)

if exist "%CLAUDE_SHORT_SRC%" (
    copy "%CLAUDE_SHORT_SRC%" "%VAULT%\CLAUDE-SHORT.md" >nul
    echo ✅ CLAUDE-SHORT.md 已写入
)

echo.

REM ── 4. 复制插件文件 ──
set "PLUGIN_SRC=%SCRIPT_DIR%..\"
set "PLUGIN_DEST=%VAULT%\.obsidian\plugins\deepdig-cc\"

REM 尝试从不同位置找 main.js
for %%f in (main.js manifest.json styles.css) do (
    if exist "%PLUGIN_SRC%%%f" (
        copy "%PLUGIN_SRC%%%f" "%PLUGIN_DEST%" >nul
        echo ✅ %%f → .obsidian/plugins/deepdig-cc/
    ) else if exist "%SCRIPT_DIR%%%f" (
        copy "%SCRIPT_DIR%%%f" "%PLUGIN_DEST%" >nul
        echo ✅ %%f → .obsidian/plugins/deepdig-cc/
    ) else (
        echo ⚠️ 未找到 %%f（插件核心文件）——请从 GitHub Releases 下载
    )
)

echo.

REM ── 5. 完成 ──
echo ═══════════════════════════════════════════
echo ✅ Vault 初始化完成
echo.
echo 📋 下一步：
echo   1. 打开 Obsidian → 打开此 Vault
echo   2. 设置 → 第三方插件 → 启用"深度挖掘 · CC"
echo   3. 左侧 ribbon 图标 → 开始使用
echo.
echo 🔑 首次使用无需 License Key（7 天免费试用）
echo.
pause
