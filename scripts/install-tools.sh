#!/bin/sh
# 宿主机 Debian 13 工具安装辅助脚本（非 Docker 场景）
set -e

echo "[install-tools] apt update"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl unzip ffmpeg

# rclone v1.75.1(固定版本,与容器内版本一致;Docker 部署无需此步)
if ! command -v rclone >/dev/null 2>&1; then
  echo "[install-tools] 安装 rclone v1.75.1..."
  ARCH=$(dpkg --print-architecture)
  cd /tmp
  curl -fsSL -O "https://downloads.rclone.org/v1.75.1/rclone-v1.75.1-linux-${ARCH}.zip"
  unzip -q "rclone-v1.75.1-linux-${ARCH}.zip"
  sudo install -m 0755 "rclone-v1.75.1-linux-${ARCH}/rclone" /usr/local/bin/rclone
  rm -rf "/tmp/rclone-v1.75.1-linux-${ARCH}" "/tmp/rclone-v1.75.1-linux-${ARCH}.zip"
fi

echo "[install-tools] node 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "[install-tools] done"
node -v
ffmpeg -version | head -n1
rclone version | head -n1
