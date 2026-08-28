#!/bin/sh
set -e

echo "=== CaptureHub starting ==="

# 确保目录存在
mkdir -p /data /recordings /logs /config/rclone /data/scripts /home/node/.config/rclone 2>/dev/null || true

# rclone 提示
if [ ! -f /config/rclone/rclone.conf ]; then
  echo "[entrypoint] rclone 未配置。请在宿主机执行: rclone config"
  echo "[entrypoint] 然后复制: cp ~/.config/rclone/rclone.conf ./config/rclone/"
fi

# 使用 PUID/PGID 环境变量修正容器内 node 用户的 UID/GID
# 默认 PUID=1000 PGID=1000（与 node:20-alpine 内置 node 用户一致）
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  # 若 PUID/PGID 不是 1000，则修改 node 用户 uid/gid 以匹配宿主机权限
  if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
    echo "[entrypoint] 调整 node 用户 UID=$PUID GID=$PGID"
    # Alpine 兼容：使用 deluser/delgroup + addgroup/adduser 重建用户
    deluser node 2>/dev/null || true
    delgroup node 2>/dev/null || true
    addgroup -g "$PGID" node 2>/dev/null || true
    adduser -D -u "$PUID" -G node -h /home/node -s /bin/sh node 2>/dev/null || true
  fi

  # 权限修正
  chown -R "$PUID:$PGID" /data /recordings /logs /config /home/node 2>/dev/null || true
  if [ -f /config/rclone/rclone.conf ]; then
    chmod 644 /config/rclone/rclone.conf 2>/dev/null || true
    chown "$PUID:$PGID" /config/rclone/rclone.conf 2>/dev/null || true
    cp /config/rclone/rclone.conf /home/node/.config/rclone/rclone.conf 2>/dev/null || true
    chown "$PUID:$PGID" /home/node/.config/rclone/rclone.conf 2>/dev/null || true
    chmod 644 /home/node/.config/rclone/rclone.conf 2>/dev/null || true
  fi

  # 后台守护进程：持续修复 rclone 配置文件权限
  (
    while true; do
      if [ -f /config/rclone/rclone.conf ]; then
        chmod 644 /config/rclone/rclone.conf 2>/dev/null || true
        chown "$PUID:$PGID" /config/rclone/rclone.conf 2>/dev/null || true
        cp /config/rclone/rclone.conf /home/node/.config/rclone/rclone.conf 2>/dev/null || true
        chown "$PUID:$PGID" /home/node/.config/rclone/rclone.conf 2>/dev/null || true
        chmod 644 /home/node/.config/rclone/rclone.conf 2>/dev/null || true
      fi
      sleep 10
    done
  ) &

  # Alpine 使用 su-exec 替代 gosu
  exec su-exec node "$@"
fi

exec "$@"
