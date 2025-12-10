#!/bin/bash
# 发票工具跨平台打包脚本

set -e

DIST_DIR="dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "🔨 开始构建跨平台可执行文件..."

# macOS ARM64 (Apple Silicon)
echo "📦 构建 macOS ARM64..."
bun build main.ts --compile --target=bun-darwin-arm64 --outfile "$DIST_DIR/fapiao-mac-arm64"
cp template.docx "$DIST_DIR/fapiao-mac-arm64-template.docx"

# macOS x64 (Intel)
echo "📦 构建 macOS x64..."
bun build main.ts --compile --target=bun-darwin-x64 --outfile "$DIST_DIR/fapiao-mac-x64"

# Linux x64
echo "📦 构建 Linux x64..."
bun build main.ts --compile --target=bun-linux-x64 --outfile "$DIST_DIR/fapiao-linux-x64"

# Windows x64
echo "📦 构建 Windows x64..."
bun build main.ts --compile --target=bun-windows-x64 --outfile "$DIST_DIR/fapiao-win-x64.exe"

# 复制模板文件
echo "📋 复制模板文件..."
cp template.docx "$DIST_DIR/"

# 创建各平台的发布包
echo "📦 创建发布包..."

# macOS ARM64
mkdir -p "$DIST_DIR/release/fapiao-mac-arm64"
cp "$DIST_DIR/fapiao-mac-arm64" "$DIST_DIR/release/fapiao-mac-arm64/fapiao"
cp template.docx "$DIST_DIR/release/fapiao-mac-arm64/"
cp 使用说明.txt "$DIST_DIR/release/fapiao-mac-arm64/"
mkdir -p "$DIST_DIR/release/fapiao-mac-arm64/pdfs"
mkdir -p "$DIST_DIR/release/fapiao-mac-arm64/reports"
cd "$DIST_DIR/release" && zip -r ../fapiao-mac-arm64.zip fapiao-mac-arm64 && cd ../..

# macOS x64
mkdir -p "$DIST_DIR/release/fapiao-mac-x64"
cp "$DIST_DIR/fapiao-mac-x64" "$DIST_DIR/release/fapiao-mac-x64/fapiao"
cp template.docx "$DIST_DIR/release/fapiao-mac-x64/"
cp 使用说明.txt "$DIST_DIR/release/fapiao-mac-x64/"
mkdir -p "$DIST_DIR/release/fapiao-mac-x64/pdfs"
mkdir -p "$DIST_DIR/release/fapiao-mac-x64/reports"
cd "$DIST_DIR/release" && zip -r ../fapiao-mac-x64.zip fapiao-mac-x64 && cd ../..

# Linux x64
mkdir -p "$DIST_DIR/release/fapiao-linux-x64"
cp "$DIST_DIR/fapiao-linux-x64" "$DIST_DIR/release/fapiao-linux-x64/fapiao"
cp template.docx "$DIST_DIR/release/fapiao-linux-x64/"
cp 使用说明.txt "$DIST_DIR/release/fapiao-linux-x64/"
mkdir -p "$DIST_DIR/release/fapiao-linux-x64/pdfs"
mkdir -p "$DIST_DIR/release/fapiao-linux-x64/reports"
cd "$DIST_DIR/release" && zip -r ../fapiao-linux-x64.zip fapiao-linux-x64 && cd ../..

# Windows x64
mkdir -p "$DIST_DIR/release/fapiao-win-x64"
cp "$DIST_DIR/fapiao-win-x64.exe" "$DIST_DIR/release/fapiao-win-x64/fapiao.exe"
cp template.docx "$DIST_DIR/release/fapiao-win-x64/"
cp 使用说明.txt "$DIST_DIR/release/fapiao-win-x64/"
mkdir -p "$DIST_DIR/release/fapiao-win-x64/pdfs"
mkdir -p "$DIST_DIR/release/fapiao-win-x64/reports"
cd "$DIST_DIR/release" && zip -r ../fapiao-win-x64.zip fapiao-win-x64 && cd ../..

echo ""
echo "✅ 构建完成！发布包位于 dist/ 目录:"
ls -lh "$DIST_DIR"/*.zip

echo ""
echo "📖 使用说明:"
echo "1. 解压对应平台的 zip 文件"
echo "2. 将 PDF 发票放入 pdfs 文件夹"
echo "3. 运行可执行文件 (macOS/Linux: ./fapiao, Windows: fapiao.exe)"
echo "4. 生成的报告将在 reports 文件夹中"
