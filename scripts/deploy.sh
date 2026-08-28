#!/bin/sh
# CaptureHub · 一键部署脚本
# 支持 Debian 11+ / Ubuntu 20.04+
# 用法: chmod +x deploy.sh && ./deploy.sh
set -e

REPO_URL="${REPO_URL:-https://github.com/rsxbgdurxbjcx-arch/CaptureHub.git}"
APP_DIR="${APP_DIR:-$HOME/CaptureHub}"
RCLONE_REMOTE="${RCLONE_REMOTE:-pikpak}"
RCLONE_CONFIG_SRC="${RCLONE_CONFIG_SRC:-$HOME/.config/rclone/rclone.conf}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[-]${NC} $*"; exit 1; }

echo "============================================"
echo " CaptureHub · 一键部署"
echo " 仓库: $REPO_URL"
echo " 目录: $APP_DIR"
echo "============================================"
echo ""

# ── 1. 检查/安装 Docker ──────────────────────────────────
log "步骤 1/7: 检查 Docker..."

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker 未安装,开始安装..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) \
signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian \
$(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  log "Docker 安装完成。请退出重新登录使 docker 组生效,然后重新运行此脚本。"
  exit 0
fi

# 检查 docker compose 插件
if ! docker compose version >/dev/null 2>&1; then
  warn "docker compose 插件不可用,尝试安装..."
  sudo apt-get install -y docker-compose-plugin
fi

log "Docker $(docker --version | awk '{print $3}' | tr -d ',') 已就绪"

# ── 2. 检查/安装宿主机 rclone ───────────────────────────
log "步骤 2/7: 检查宿主机 rclone..."

if ! command -v rclone >/dev/null 2>&1; then
  warn "rclone 未安装,正在安装..."
  curl -fsSL https://rclone.org/install.sh | sudo bash
fi

RCLONE_VER=$(rclone version 2>/dev/null | head -n1)
log "rclone: $RCLONE_VER"

# ── 3. 拉取/更新代码 ─────────────────────────────────────
log "步骤 3/7: 拉取代码..."

if [ -d "$APP_DIR/.git" ]; then
  log "已有仓库,拉取最新代码..."
  git -C "$APP_DIR" fetch --all --prune
  # 部署环境无需保留本地代码改动,且远程可能被 force push 导致分支分叉,
  # 因此直接强制对齐到远程最新代码
  # (data/recordings/config 等数据目录不在版本控制内,reset --hard 不影响数据)
  BRANCH="$(git -C "$APP_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)"
  log "当前分支: $BRANCH, 强制对齐到 origin/$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "克隆仓库..."
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# ── 4. 准备目录 ──────────────────────────────────────────
log "步骤 4/7: 准备目录..."
mkdir -p data recordings logs config/rclone

# ── 5. 检查并复制 rclone 配置 ────────────────────────────
log "步骤 5/7: 检查 rclone 配置..."

RCLONE_CONF_DEST="$APP_DIR/config/rclone/rclone.conf"

if [ -f "$RCLONE_CONF_DEST" ]; then
  log "已有项目 rclone 配置: $RCLONE_CONF_DEST"
else
  if [ ! -f "$RCLONE_CONFIG_SRC" ]; then
    echo ""
    warn "未找到 rclone 配置文件: $RCLONE_CONFIG_SRC"
    warn "请先配置 rclone remote(名称: $RCLONE_REMOTE):"
    echo ""
    echo "  rclone config"
    echo ""
    echo "交互流程:"
    echo "  n → 名称 $RCLONE_REMOTE → 类型 pikpak → 输入邮箱和密码 → 一路默认 → y 保存 → q"
    echo ""
    echo "完成后重新运行此脚本。"
    exit 1
  fi

  log "复制 rclone 配置: $RCLONE_CONFIG_SRC → $RCLONE_CONF_DEST"
  cp "$RCLONE_CONFIG_SRC" "$RCLONE_CONF_DEST"
  chmod 600 "$RCLONE_CONF_DEST"
  log "rclone 配置已就绪"
fi

# ── 6. 构建并启动 ────────────────────────────────────────
log "步骤 6/7: 构建 Docker 镜像并启动..."

# 默认使用缓存构建(首次约 2 分钟,后续增量构建更快)
# 如需强制全量重建:FORCE_REBUILD=1 ./deploy.sh
if [ "${FORCE_REBUILD:-0}" = "1" ]; then
  warn "FORCE_REBUILD=1,执行无缓存全量构建(较慢)..."
  docker compose build --no-cache
else
  docker compose build
fi
docker compose up -d

log "等待容器启动..."
sleep 5

# ── 7. 验证 ──────────────────────────────────────────────
log "步骤 7/7: 验证部署..."

echo ""

# 健康检查
HEALTH_RESP=$(curl -fsS http://127.0.0.1:3780/api/health 2>/dev/null || echo "")
if echo "$HEALTH_RESP" | grep -q '"ok":true'; then
  log "应用健康检查: PASS"
  echo "  $HEALTH_RESP"
else
  warn "应用健康检查: FAIL(容器可能仍在启动)"
  echo "  稍后执行: curl http://127.0.0.1:3780/api/health"
fi

echo ""

# 容器内 rclone 可用性
log "检查容器内 rclone..."
RCLONE_OK=$(docker compose exec -T capturehub rclone version 2>/dev/null || echo "")
if [ -n "$RCLONE_OK" ]; then
  log "容器内 rclone: PASS"
  echo "  $(echo "$RCLONE_OK" | head -n1)"
else
  warn "容器内 rclone: FAIL(请确认宿主机 /usr/bin/rclone 存在且已挂载)"
fi

echo ""

# rclone 配置文件检查
log "检查容器内 rclone 配置..."
CONF_OK=$(docker compose exec -T capturehub test -f /config/rclone/rclone.conf && echo "yes" || echo "no")
if [ "$CONF_OK" = "yes" ]; then
  log "rclone 配置文件: PASS (/config/rclone/rclone.conf)"
else
  warn "rclone 配置文件: FAIL(未找到 /config/rclone/rclone.conf)"
fi

echo ""

# rclone 远端连通性
log "验证 rclone 远端连通性..."
REMOTE_LSD=$(docker compose exec -T capturehub rclone lsd "${RCLONE_REMOTE}:" --config /config/rclone/rclone.conf 2>&1 || echo "FAIL")
if [ "$REMOTE_LSD" != "FAIL" ] && echo "$REMOTE_LSD" | grep -qv "FAIL"; then
  log "远端 $RCLONE_REMOTE: PASS"
else
  warn "远端 $RCLONE_REMOTE: 连接失败,请检查 rclone 配置和网络"
  echo "  手动测试: docker compose exec capturehub rclone lsd ${RCLONE_REMOTE}: --config /config/rclone/rclone.conf"
fi

echo ""

# 创建网盘根目录
log "创建网盘根目录 (${RCLONE_REMOTE}:capturehub)..."
docker compose exec -T capturehub rclone mkdir "${RCLONE_REMOTE}:capturehub" --config /config/rclone/rclone.conf 2>/dev/null || true

echo ""
echo "============================================"
echo -e " ${GREEN}部署完成!${NC}"
echo ""
echo " Web UI:  http://127.0.0.1:3780"
echo "          http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>'):3780"
echo ""
echo " 下一步:"
echo "   1. 浏览器打开 Web UI"
echo "   2. 设置 → 粘贴小红书 Cookie(需含 a1 + web_session)"
echo "   3. 设置 → 确认下载器为 ffmpeg"
echo "   4. 后处理 → 确认 remote=pikpak, 根目录=capturehub, 模式=move"
echo "   5. 主播 → 添加小红书主页或直播链接"
echo ""
echo " 运维命令:"
echo "   查看日志:  docker logs -f capturehub"
echo "   重启服务:  docker compose restart capturehub"
echo "   停止服务:  docker compose down"
echo "   更新重建:  重新运行 ./deploy.sh"
echo "============================================"
