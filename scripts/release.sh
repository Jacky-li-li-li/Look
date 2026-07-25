#!/bin/bash
# ============================================================
# release.sh — 本地构建、签名、公证 macOS 包并上传到腾讯云 COS
#
# 用法: ./scripts/release.sh
#
# 前置条件:
#   1. Keychain 中有 "Developer ID Application" 证书
#   2. coscmd 已安装: pip3 install coscmd
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 凭据（必须通过环境变量传入，禁止硬编码） ──
: "${APPLE_ID:?需要设置 APPLE_ID}"
: "${APPLE_TEAM_ID:?需要设置 APPLE_TEAM_ID}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?需要设置 APPLE_APP_SPECIFIC_PASSWORD}"

# ── COS 配置 ──
COS_BUCKET="${COS_BUCKET:-look-updates-1382933627}"
COS_REGION="${COS_REGION:-ap-guangzhou}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[release]${NC} $*"; }
error() { echo -e "${RED}[release]${NC} $*"; exit 1; }

# ── 检查依赖 ──
info "检查环境..."

if ! python3 -c "import coscmd" 2>/dev/null; then
    error "coscmd 未安装，运行: pip3 install coscmd"
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    error "未找到 Developer ID Application 证书，请先导入 Keychain"
fi

# ── 配置公证 Keychain Profile（一次性） ──
NOTARY_PROFILE="${LOOK_NOTARY_PROFILE:-LOOK_NOTARY}"
export LOOK_NOTARY_PROFILE="$NOTARY_PROFILE"

if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" &>/dev/null; then
    info "配置公证 Keychain Profile (一次性)..."
    xcrun notarytool store-credentials "$NOTARY_PROFILE" \
        --apple-id "$APPLE_ID" \
        --team-id "$APPLE_TEAM_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD"
    info "  Keychain Profile '$NOTARY_PROFILE' 已创建"
else
    info "Keychain Profile '$NOTARY_PROFILE' 已存在"
fi

# ── 解锁 Keychain（签名需要） ──
info "解锁 Keychain..."
security unlock-keychain ~/Library/Keychains/login.keychain-db 2>/dev/null || true

# ── 版本号 ──
VERSION=$(node -p "require('./apps/electron/package.json').version")
info "版本: ${VERSION}"

# ── 构建 ──
info "构建项目..."
npm run build

info "Stage 生产环境..."
npm run stage:production

# ── 打包（electron-builder: 签名 + 公证 + 生成 channel 文件） ──
info "打包 & 签名 & 公证..."
info "这可能需要几分钟，请耐心等待..."

cd apps/electron
npx electron-builder --mac
cd "$ROOT"

# ── 检查产物 ──
DMG_FILE="release/Look-${VERSION}-arm64.dmg"
YML_FILE="release/latest-mac.yml"

if [ ! -f "$DMG_FILE" ]; then
    error "DMG 未生成: $DMG_FILE"
fi
if [ ! -f "$YML_FILE" ]; then
    error "latest-mac.yml 未生成: $YML_FILE"
fi

info "产物就绪:"
ls -lh "$DMG_FILE" "$YML_FILE"

# ── 上传 COS ──
info "上传到 COS..."

COSCMD="/Users/jacky/Library/Python/3.9/bin/coscmd"
if [ ! -f "$COSCMD" ]; then
    COSCMD="coscmd"
fi

"$COSCMD" upload "$DMG_FILE" "/Look-${VERSION}-arm64.dmg" -f
info "  DMG 上传完成"

"$COSCMD" upload "$YML_FILE" "/latest-mac.yml" -f
info "  latest-mac.yml 上传完成"

for f in release/Look-${VERSION}-arm64*.blockmap; do
    if [ -f "$f" ]; then
        "$COSCMD" upload "$f" "/$(basename "$f")" -f 2>/dev/null
    fi
done

# ── 验证 ──
info "验证公网访问..."
YML_URL="https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/latest-mac.yml"
if curl -sf "$YML_URL" > /dev/null; then
    info "  latest-mac.yml 可访问"
else
    error "  latest-mac.yml 访问失败: $YML_URL"
fi

# ── 完成 ──
echo ""
echo -e "${GREEN}${BOLD}========================================${NC}"
echo -e "${GREEN}${BOLD}  发布完成 v${VERSION}${NC}"
echo -e "${GREEN}${BOLD}========================================${NC}"
echo ""
echo "下载地址:"
echo "  https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/Look-${VERSION}-arm64.dmg"
echo ""
echo "用户下次打开 Look 时会自动检测到此更新。"
