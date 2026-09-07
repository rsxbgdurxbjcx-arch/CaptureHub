#!/bin/sh
# CaptureHub · 部署验证脚本
# 验证 rclone 上传链路是否正常工作
# 用法: docker compose exec capturehub sh /app/verify.sh  或宿主机直接运行
set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

echo "============================================"
echo " CaptureHub · rclone 上传链路验证"
echo "============================================"
echo ""

# 1. 检查 rclone 二进制
echo "--- 1. rclone 二进制 ---"
if command -v rclone >/dev/null 2>&1; then
  RCLONE_BIN=$(command -v rclone)
  pass "rclone 可执行: $RCLONE_BIN"
  rclone version | head -n1
else
  fail "rclone 未找到"
  exit 1
fi

echo ""

# 2. 检查配置文件
echo "--- 2. rclone 配置文件 ---"
RCLONE_CONFIG="${RCLONE_CONFIG:-/config/rclone/rclone.conf}"
if [ -f "$RCLONE_CONFIG" ]; then
  pass "配置文件存在: $RCLONE_CONFIG"
  echo "  权限: $(stat -c '%a %U:%G' "$RCLONE_CONFIG" 2>/dev/null || ls -la "$RCLONE_CONFIG" | awk '{print $1, $3":"$4}')"
else
  fail "配置文件不存在: $RCLONE_CONFIG"
  exit 1
fi

echo ""

# 3. 列出配置的 remote
echo "--- 3. rclone remote 列表 ---"
REMOTES=$(rclone listremotes --config "$RCLONE_CONFIG" 2>/dev/null || echo "")
if [ -n "$REMOTES" ]; then
  pass "找到 remote:"
  echo "$REMOTES" | sed 's/^/  /'
else
  fail "没有配置 remote"
  exit 1
fi

echo ""

# 4. 测试远端连通性
echo "--- 4. 远端连通性 ---"
# 取第一个 remote 名（去掉末尾冒号）
FIRST_REMOTE=$(echo "$REMOTES" | head -n1 | sed 's/:$//')
if [ -n "$FIRST_REMOTE" ]; then
  if rclone lsd "${FIRST_REMOTE}:" --config "$RCLONE_CONFIG" >/dev/null 2>&1; then
    pass "远端 $FIRST_REMOTE 连通正常"
  else
    warn "远端 $FIRST_REMOTE 连接失败，尝试列出详情:"
    rclone lsd "${FIRST_REMOTE}:" --config "$RCLONE_CONFIG" --low-level-retries 1 2>&1 | head -n5
  fi
fi

echo ""

# 5. 测试上传/删除（写入一个小测试文件）
echo "--- 5. 上传功能测试 ---"
if [ -n "$FIRST_REMOTE" ]; then
  TEST_FILE="/tmp/rclone_test_$$.txt"
  echo "CaptureHub rclone test $(date)" > "$TEST_FILE"

  if rclone copy "$TEST_FILE" "${FIRST_REMOTE}:capturehub/" --config "$RCLONE_CONFIG" 2>/dev/null; then
    pass "上传测试文件到 ${FIRST_REMOTE}:capturehub/ 成功"
    # 清理远程测试文件
    rclone delete "${FIRST_REMOTE}:capturehub/$(basename "$TEST_FILE")" --config "$RCLONE_CONFIG" 2>/dev/null || true
  else
    warn "上传测试失败，尝试详情:"
    rclone copy "$TEST_FILE" "${FIRST_REMOTE}:capturehub/" --config "$RCLONE_CONFIG" -v 2>&1 | tail -n10
  fi

  rm -f "$TEST_FILE"
fi

echo ""

# 6. 检查应用 API
echo "--- 6. 应用健康检查 ---"
if curl -fsS http://127.0.0.1:3780/api/health 2>/dev/null; then
  echo ""
  pass "应用健康检查通过"
else
  warn "应用健康检查失败（容器内运行跳过此步骤）"
fi

echo ""

# 7. 系统状态（含工具可用性）
echo "--- 7. 系统状态 ---"
SYS_STATUS=$(curl -fsS http://127.0.0.1:3780/api/system/status 2>/dev/null || echo "")
if [ -n "$SYS_STATUS" ]; then
  echo "$SYS_STATUS" | python3 -m json.tool 2>/dev/null || echo "$SYS_STATUS"
  echo ""
  # 检查 tools.rclone
  if echo "$SYS_STATUS" | grep -q '"rclone":true'; then
    pass "系统状态 rclone 可用"
  else
    warn "系统状态 rclone 不可用，检查 rclonePath 设置"
  fi
else
  warn "无法获取系统状态（如不在容器内运行属正常）"
fi

echo ""
echo "============================================"
echo " 验证完成"
echo "============================================"
