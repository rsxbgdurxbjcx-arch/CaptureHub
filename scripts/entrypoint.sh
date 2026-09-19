#!/bin/sh
set -e

echo "=== CaptureHub starting ==="

# 确保目录存在
mkdir -p /data /recordings /logs /config/rclone /data/scripts /home/node/.config/rclone 2>/dev/null || true

# rclone 提示(配置文件由 Web UI「后处理 → rclone」自动生成/更新)
if [ ! -f /config/rclone/rclone.conf ]; then
  echo "[entrypoint] rclone 尚未配置:请登录 Web UI → 后处理 → rclone,填写网盘账号密码并保存"
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

  # 权限修正(配置文件权限由应用自身维护为 600,此处仅修正属主)
  chown -R "$PUID:$PGID" /data /recordings /logs /config /home/node 2>/dev/null || true
  if [ -f /config/rclone/rclone.conf ]; then
    # 兼容旧部署:收紧历史配置文件权限(应用生成的配置已是 600)
    chmod 600 /config/rclone/rclone.conf 2>/dev/null || true
  fi

  # Alpine 使用 su-exec 替代 gosu
  exec su-exec node "$@"
fi

exec "$@"
