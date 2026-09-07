#!/bin/sh
# 宿主机 Debian 13 工具安装辅助脚本（非 Docker 场景）
set -e

echo "[install-tools] apt update"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl unzip ffmpeg

# rclone 必须用官方安装脚本：发行版仓库版本过旧，不支持 PikPak
if ! command -v rclone >/dev/null 2>&1; then
  echo "[install-tools] 安装 rclone（官方脚本）..."
  curl -fsSL https://rclone.org/install.sh | sudo bash
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
