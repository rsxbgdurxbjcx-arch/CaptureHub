#!/bin/sh
# rclone config 交互配置（在宿主机执行）
# 用于 docker run 方式：
#   docker exec -it capturehub rclone-init
# 或：
#   docker run --rm -it -v $(pwd)/config/rclone:/config/rclone capturehub:latest rclone-init

set -e

CONFIG_FILE="${RCLONE_CONFIG:-/config/rclone/rclone.conf}"
REMOTE_NAME="${RCLONE_REMOTE_NAME:-pikpak}"

mkdir -p "$(dirname "$CONFIG_FILE")" 2>/dev/null || true
export RCLONE_CONFIG="$CONFIG_FILE"

echo "============================================="
echo " CaptureHub · rclone PikPak 配置"
echo " 配置文件: $CONFIG_FILE"
echo " 远程名称: $REMOTE_NAME"
echo "============================================="
echo ""
echo "交互创建 remote:"
echo "  n (new remote)"
echo "  名称: pikpak"
echo "  类型: pikpak"
echo "  user: 你的 PikPak 邮箱"
echo "  pass: 你的 PikPak 密码"
echo ""

if command -v rclone >/dev/null 2>&1; then
  rclone config --config "$CONFIG_FILE"
else
  echo "未找到 rclone"
  exit 1
fi

# 权限修正：docker exec 默认以 root 运行，node 应用以 node 用户运行
# 必须让 node 用户可读配置文件
echo ""
echo "=== 权限修正 ==="
if [ -f "$CONFIG_FILE" ]; then
  chmod 600 "$CONFIG_FILE"
  # 尝试修正为 node 用户（UID 1000）或 PUID 指定的用户
  if command -v gosu >/dev/null 2>&1 && id node >/dev/null 2>&1; then
    chown node:node "$CONFIG_FILE" 2>/dev/null || true
    chown node:node "$(dirname "$CONFIG_FILE")" 2>/dev/null || true
  else
    # 兜底：其它用户可读
    chmod 644 "$CONFIG_FILE" 2>/dev/null || true
  fi
fi
echo "配置文件权限: $(ls -la "$CONFIG_FILE" 2>/dev/null || echo 'N/A')"

echo ""
echo "测试: rclone lsd ${REMOTE_NAME}: --config $CONFIG_FILE"
rclone lsd "${REMOTE_NAME}:" --config "$CONFIG_FILE" || echo "(首次可能失败，请检查账号)"
echo ""
echo "创建网盘根目录:"
rclone mkdir "${REMOTE_NAME}:capturehub" --config "$CONFIG_FILE" 2>/dev/null || true
echo "完成。"
