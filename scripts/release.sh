#!/bin/bash
# ============================================================
# release.sh — 本地签名/公证构建（验证用）
#
# 正式发布走 GitHub Actions：推 v* tag 触发 .github/workflows/release.yml
# （构建 → 签名 → 公证 → 上传 GitHub Releases，应用内自动更新随之生效）。
# 本脚本用于在本机验证签名 + 公证链路是否正常，不发布、不上传。
#
# 用法: ./scripts/release.sh
#
# 前置条件:
#   1. Keychain 中有 "Developer ID Application" 证书
#   2. 环境变量: APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD
#      （electron-builder 内置公证使用）
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${APPLE_ID:?需要设置 APPLE_ID}"
: "${APPLE_TEAM_ID:?需要设置 APPLE_TEAM_ID}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?需要设置 APPLE_APP_SPECIFIC_PASSWORD}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[release]${NC} $*"; }
error() { echo -e "${RED}[release]${NC} $*"; exit 1; }

# ── 检查证书 ──
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    error "未找到 Developer ID Application 证书，请先导入 Keychain"
fi

VERSION=$(node -p "require('./apps/electron/package.json').version")
info "版本: ${VERSION}"

# ── 构建 ──
info "构建项目..."
npm run build

# ── 打包（electron-builder: 签名 + 公证，不发布） ──
info "打包 & 签名 & 公证（可能需要几分钟）..."
cd apps/electron
npx electron-builder --mac --publish never
cd "$ROOT"

# ── 检查产物 ──
DMG_FILE="apps/electron/release/Look-${VERSION}-arm64.dmg"
ZIP_FILE="apps/electron/release/Look-${VERSION}-arm64.zip"

[ -f "$DMG_FILE" ] || error "DMG 未生成: $DMG_FILE"
[ -f "$ZIP_FILE" ] || error "ZIP 未生成: $ZIP_FILE（自动更新需要 zip）"

info "验证公证状态..."
if spctl -a -vvv "$DMG_FILE" 2>&1 | grep -q "accepted"; then
    info "  公证通过"
else
    error "  公证验证失败: $DMG_FILE"
fi

echo ""
echo -e "${GREEN}${BOLD}========================================${NC}"
echo -e "${GREEN}${BOLD}  本地构建完成 v${VERSION}（未发布）${NC}"
echo -e "${GREEN}${BOLD}========================================${NC}"
echo ""
echo "产物:"
ls -lh "$DMG_FILE" "$ZIP_FILE"
echo ""
echo "正式发布: git tag v${VERSION} && git push origin v${VERSION}"
echo "（GitHub Actions 会自动构建并发布到 Releases）"
