#!/bin/sh
# CaptureHub · 一键部署脚本
# 支持 Debian 11+ / Ubuntu 20.04+
# 用法: chmod +x deploy.sh && ./deploy.sh
set -e

REPO_URL="${REPO_URL:-https://github.com/rsxbgdurxbjcx-arch/CaptureHub.git}"
APP_DIR="${APP_DIR:-$HOME/CaptureHub}"

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

# ── 2. 拉取/更新代码 ─────────────────────────────────────
log "步骤 2/6: 拉取代码..."

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

# ── 3. 准备目录 ──────────────────────────────────────────
log "步骤 3/6: 准备目录..."
mkdir -p data recordings logs config/rclone

# ── 4. 检查 rclone 配置 ──────────────────────────────────
# rclone 已内置在镜像中,配置文件由 Web UI 自动生成/更新,无需宿主机 rclone
log "步骤 4/6: 检查 rclone 配置..."

RCLONE_CONF_DEST="$APP_DIR/config/rclone/rclone.conf"

if [ -f "$RCLONE_CONF_DEST" ]; then
  log "已有 rclone 配置: $RCLONE_CONF_DEST(由 Web UI 管理,也可继续使用)"
else
  warn "尚未配置网盘:部署完成后,请登录 Web UI → 后处理 → rclone,填写网盘类型/账号/密码并保存"
  warn "配置将自动写入 $RCLONE_CONF_DEST 并持久化(容器重建不丢失)"
fi

# ── 5. 构建并启动 ────────────────────────────────────────
log "步骤 5/6: 构建 Docker 镜像并启动..."

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

# ── 6. 验证 ──────────────────────────────────────────────
log "步骤 6/6: 验证部署..."

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

# 容器内 rclone(镜像内置,固定 v1.75.1)
log "检查容器内 rclone(内置 v1.75.1)..."
RCLONE_VER=$(docker compose exec -T capturehub rclone version 2>/dev/null | head -n1 || echo "")
if echo "$RCLONE_VER" | grep -q "v1.75.1"; then
  log "容器内 rclone: PASS"
  echo "  $RCLONE_VER"
else
  warn "容器内 rclone: FAIL(镜像未正确内置 rclone)"
  echo "  实际输出: ${RCLONE_VER:-无}"
fi

echo ""

# rclone 配置文件(未配置不算失败,由 Web UI 完成)
log "检查容器内 rclone 配置..."
CONF_OK=$(docker compose exec -T capturehub test -f /config/rclone/rclone.conf && echo "yes" || echo "no")
if [ "$CONF_OK" = "yes" ]; then
  log "rclone 配置文件: PASS (/config/rclone/rclone.conf)"
  CONF_PERM=$(docker compose exec -T capturehub stat -c '%a' /config/rclone/rclone.conf 2>/dev/null || echo "")
  echo "  权限: ${CONF_PERM:-未知}"

  # 远端连通性(取配置中第一个 remote)
  REMOTE_NAME=$(docker compose exec -T capturehub sh -c "rclone listremotes --config /config/rclone/rclone.conf 2>/dev/null | head -n1" | tr -d ':\r')
  if [ -n "$REMOTE_NAME" ]; then
    log "验证远端连通性 ($REMOTE_NAME)..."
    REMOTE_LSD=$(docker compose exec -T capturehub rclone lsd "${REMOTE_NAME}:" --config /config/rclone/rclone.conf 2>&1 || echo "FAIL")
    if [ "$REMOTE_LSD" != "FAIL" ] && ! echo "$REMOTE_LSD" | grep -q "^FAIL"; then
      log "远端 $REMOTE_NAME: PASS"
      # 创建网盘根目录
      log "创建网盘根目录 (${REMOTE_NAME}:capturehub)..."
      docker compose exec -T capturehub rclone mkdir "${REMOTE_NAME}:capturehub" --config /config/rclone/rclone.conf 2>/dev/null || true
    else
      warn "远端 $REMOTE_NAME: 连接失败,请检查网盘账号密码"
      echo "  手动测试: docker compose exec capturehub rclone lsd ${REMOTE_NAME}: --config /config/rclone/rclone.conf"
    fi
  fi
else
  warn "rclone 配置文件: 尚未配置(登录 Web UI → 后处理 → rclone 填写网盘账号密码后自动生成)"
fi

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
echo "   4. 后处理 → rclone:选择网盘类型、填写网盘账号密码(自动保存并连接)"
echo "   5. 后处理 → rclone:确认网盘根目录(capturehub)、模式(move),并按需切换上传器"
echo "   6. 主播 → 添加小红书主页或直播链接"
echo ""
echo " 运维命令:"
echo "   查看日志:  docker logs -f capturehub"
echo "   重启服务:  docker compose restart capturehub"
echo "   停止服务:  docker compose down"
echo "   更新重建:  重新运行 ./deploy.sh"
echo "============================================"
