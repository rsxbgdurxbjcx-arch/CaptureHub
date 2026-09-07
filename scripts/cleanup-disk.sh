#!/bin/sh
# CaptureHub · 磁盘紧急清理脚本
#
# 适用场景:
#   - 录制文件堆积、磁盘爆满(96%+)、Web UI 卡死/无法访问
#   - 上传失败(超时/网络)导致文件未被自动删除,或进程崩溃残留
#     Stripchat 分片临时目录(.xxx_segments,内含数 GB .ts)
#
# 安全说明:
#   - 仅删除"可确定安全"的临时/残留物:
#     1) .*_segments 目录     —— Stripchat 分片录制临时目录(录制结束应自动删除;
#        残留说明进程崩溃/强杀;录制完成后只存在合并产物 mp4,分片无保留价值)
#     2) .tg_compat_*.mp4     —— Telegram 兼容转码的隐藏临时文件(上传后应自动删除)
#     3) post_*.sh            —— 后处理临时脚本(失败任务可能残留)
#   - 不会删除任何 .mp4/.ts/.flv/.mkv 成品文件(由你确认后再手动处理)
#
# 用法(在 CaptureHub 部署目录执行,容器内/宿主机均可):
#   sh scripts/cleanup-disk.sh            # 默认:仅清理临时/残留(安全)
#   sh scripts/cleanup-disk.sh --report   # 仅报告占用,不删除(先看再删)
#   sh scripts/cleanup-disk.sh --dry-run  # 同 --report
#
# 若清理临时物后仍空间不足,执行以下命令查看大文件,确认后手动删除:
#   find recordings -type f -size +500M -printf '%s %p\n' | sort -rn | head -n 30

set -e

ROOT_DIR="$(dirname "$0")/.."
cd "$ROOT_DIR"
echo "=== CaptureHub 磁盘清理 (目录: $PWD) ==="

MODE="clean"
for arg in "$@"; do
  case "$arg" in
    --report|--dry-run) MODE="report" ;;
  esac
done

disk_free_kb=$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$disk_free_kb" ]; then
  echo "剩余空间: $((disk_free_kb / 1024)) MB"
fi

# ---- 1. 残留 Stripchat 分片临时目录 ----
echo ""
echo "--- 1. 残留 Stripchat 分片目录 (.*_segments) ---"
found=0
for d in $(find recordings -type d -name '.*_segments' 2>/dev/null); do
  size=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
  echo "  $d  ($((size / 1024)) MB)"
  found=$((found + 1))
  if [ "$MODE" = "clean" ]; then
    rm -rf "$d" && echo "    已删除" || echo "    删除失败(请在容器内重试)"
  fi
done
[ "$found" -eq 0 ] && echo "  无残留目录"

# ---- 2. Telegram 兼容转码临时文件 ----
echo ""
echo "--- 2. Telegram 兼容转码临时文件 (.tg_compat_*.mp4) ---"
found=0
for f in $(find recordings -type f -name '.tg_compat_*.mp4' 2>/dev/null); do
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  echo "  $f  ($((size / 1024 / 1024)) MB)"
  found=$((found + 1))
  if [ "$MODE" = "clean" ]; then
    rm -f "$f" && echo "    已删除" || echo "    删除失败"
  fi
done
[ "$found" -eq 0 ] && echo "  无残留文件"

# ---- 3. 后处理临时脚本 ----
echo ""
echo "--- 3. 后处理临时脚本 (data/scripts/post_*.sh) ---"
if [ -d data/scripts ]; then
  found=0
  for f in data/scripts/post_*.sh; do
    [ -f "$f" ] || continue
    echo "  $f"
    found=$((found + 1))
    if [ "$MODE" = "clean" ]; then
      rm -f "$f" && echo "    已删除"
    fi
  done
  [ "$found" -eq 0 ] && echo "  无残留脚本"
else
  echo "  目录不存在"
fi

# ---- 4. (仅清理模式)提示剩余大文件 ----
echo ""
if [ "$MODE" = "clean" ]; then
  disk_free_kb=$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$disk_free_kb" ]; then
    echo "清理后剩余空间: $((disk_free_kb / 1024)) MB"
  fi
  echo ""
  echo "仍不足?查看最大的 30 个录制文件(确认后手动删除):"
  echo "  find recordings -type f \( -name '*.mp4' -o -name '*.ts' -o -name '*.flv' \) -size +100M \\
    -printf '%s %p\n' | sort -rn | head -n 30"
else
  echo "(报告模式:未删除任何文件。确认无误后执行: sh scripts/cleanup-disk.sh)"
fi

echo ""
echo "完成。"
