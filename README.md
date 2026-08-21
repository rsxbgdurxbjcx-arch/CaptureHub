# CaptureHub · 七平台直播自动录制与上传系统

> **v2.4.1** — 新增 Stripchat 平台支持(拉流逻辑移植自 [StripchatRecorder](https://github.com/ChanTrail/StripchatRecorder))

自动化监控 **小红书 / 抖音 / 哔哩哔哩 / 快手 / SOOP / Pandalive / Stripchat** 直播 → 解析最高画质流 → FFmpeg 录制 → 自动转码 MP4 → **grammY 上传 Telegram 群组** 或 **rclone 上传网盘**。

- 支持平台:**小红书** (xiaohongshu.com / xhslink.com)、**抖音** (douyin.com)、**哔哩哔哩** (live.bilibili.com)、**快手** (live.kuaishou.com)、**SOOP** (sooplive.com / afreecatv.com)、**Pandalive** (pandalive.co.kr)、**Stripchat** (stripchat.com)
- 六平台直播流解析逻辑均移植自 [StreamCap](https://github.com/ihmily/StreamCap) 的 `streamget` 模块;Stripchat 拉流逻辑移植自 [StripchatRecorder](https://github.com/ChanTrail/StripchatRecorder)
- **登录系统**:Web UI 需登录后使用,初始账号 `capturehub` / 密码 `admin`,可在设置页面修改账号密码
- 抖音支持自动获取 ttwid Cookie、ABogus 签名、__ac_signature 签名,无需手动配置 Cookie 即可解析
- 哔哩哔哩支持 9 种 protocol/format/codec 组合智能选流,画质自动降级(杜比 > 4K > 8K > 原画 > 蓝光 > 超清 > 高清 > 流畅)
- 哔哩哔哩自动识别付费直播(DRM加密)、大航海权限直播、密码加密直播等特殊类型
- 快手支持原画/蓝光/超高清/高清/标清/流畅六档画质自动选择,默认原画最高画质
- SOOP 支持站点状态检测、播放器 API 解析、流分配获取,支持账号密码自动登录
- Pandalive 支持 member/bj API 检测直播状态、play API 获取播放信息、M3U8 多质量流解析
- Stripchat 支持 cam API 检测直播状态、多 CDN 域名竞速解析 master 播放列表、Mouflon 加密密钥配置
- **SOOP/Pandalive/Stripchat 主播 ID 自动解析**:添加主播后显示名称自动设为主播 ID,上传时文件夹和文件名均使用主播 ID
- **录制清晰度选择**:添加主播时可选择原画(OD)/超清(UHD)/高清(HD)/标清(SD)/流畅(LD)
- **七平台独立 Cookie 管理**,互不干扰;未设置平台专属 Cookie 时回退到全局 Cookie
- **SOOP 登录系统**:支持在设置页面配置 SOOP 账号密码,自动登录获取 Cookie
- 下载引擎:**FFmpeg**,默认录制引擎
- **双上传工具**:支持 **grammY**(上传到 Telegram 群组)和 **rclone**(上传到网盘),可独立配置、互不干扰
- **grammY 集成**:内置 [grammY](https://github.com/grammyjs/grammy) + Local Bot API Server,支持原生视频气泡上传、自动提取视频元数据(时长/分辨率/封面)、自动生成标签(如 `#sunaang #soop`)随视频一起上传,支持 2GB/4GB 大文件极速本地传输
- **切片功能**:支持按**时长**和**文件大小(MB)**切片,两者可独立使用;都留空则不切片
- **文件管理**:录制中卡片实时显示录制时长,处理中卡片显示上传工具与模式,支持全选/批量删除
- **主播管理**:支持全选/批量删除主播
- Web UI:**Material Design** 风格(深/浅色随系统自动切换)、卡片式布局、鲜明色彩、Material 阴影深度、流畅动画过渡、主播卡片实时直播画面缩略图(每 5 秒刷新)、长按多选
- 部署:Docker 一键构建,docker-compose 拉起

---

## 目录结构

```text
CaptureHub/
├── README.md
├── Dockerfile
├── docker-compose.yml
├── package.json              # npm workspaces 根
├── .env.example
├── scripts/
│   ├── entrypoint.sh         # 容器入口(PUID/PGID 权限修正)
│   ├── deploy.sh             # 宿主机一键部署
│   ├── install-tools.sh      # 非 Docker 环境工具安装
│   ├── rclone-init.sh        # rclone 交互配置(宿主机执行)
│   └── verify.sh             # 部署后 rclone 上传链路验证
├── server/                   # Express + SQLite 后端
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── xhs/              # 小红书拉流解析
│       │   ├── api.ts        # usersearch / 拉流 / 签名
│       │   ├── http.ts       # HTTP 客户端(undici)
│       │   ├── parser.ts     # URL/短链/主页解析器
│       │   └── types.ts
│       ├── douyin/           # 抖音拉流解析
│       │   ├── api.ts        # web/webHTML/mobile/userHTML 多接口解析
│       │   ├── parser.ts     # URL/短链/主页解析器
│       │   ├── sign.ts       # ABogus 签名算法
│       │   ├── utils.ts      # __ac_signature 签名
│       │   └── types.ts
│       ├── bilibili/         # 哔哩哔哩拉流解析
│       │   ├── api.ts        # room_init / getRoomPlayInfo / getRoomBaseInfo
│       │   ├── stream.ts     # 直播状态检测 + 画质/格式选流
│       │   ├── parser.ts     # URL/短号/主页解析器
│       │   └── types.ts      # B站画质常量 / 类型定义
│       ├── kuaishou/         # 快手拉流解析
│       │   ├── api.ts        # 用户信息 API / 直播页 HTML 获取
│       │   ├── stream.ts     # __INITIAL_STATE__ 解析 + 画质选流
│       │   ├── parser.ts     # URL/eid 解析器
│       │   ├── index.ts      # 模块导出
│       │   └── types.ts      # 快手画质常量 / 类型定义
│       ├── soop/             # SOOP (原 AfreecaTV) 拉流解析
│       │   ├── api.ts        # 站点状态 / 播放器API / 流分配 / 登录
│       │   ├── stream.ts     # 直播状态检测 + 画质选流
│       │   ├── parser.ts     # URL/bjId 解析器
│       │   ├── index.ts      # 模块导出
│       │   └── types.ts      # SOOP 类型定义
│       ├── pandalive/        # Pandalive 拉流解析
│       │   ├── api.ts        # member/bj API / play API
│       │   ├── stream.ts     # 直播状态检测 + M3U8 多质量流解析
│       │   ├── parser.ts     # URL/userId 解析器
│       │   ├── index.ts      # 模块导出
│       │   └── types.ts      # Pandalive 类型定义
│       ├── stripchat/        # Stripchat 拉流解析
│       │   ├── api.ts        # cam API / 多 CDN 竞速 / Mouflon 解密 / Worker 同步
│       │   ├── stream.ts     # 直播状态检测 + master 播放列表解析
│       │   ├── parser.ts     # URL/username 解析器
│       │   ├── mouflon.ts    # Mouflon 密钥存储 + Worker 自动同步
│       │   ├── index.ts      # 模块导出
│       │   └── types.ts      # Stripchat 类型定义
│       ├── services/         # 业务服务
│       │   ├── monitor.ts    # 轮询监控(七平台自动开播检测)
│       │   ├── recorder.ts   # FFmpeg 录制 + 切片(时长/文件大小)
│       │   ├── postprocess.ts # 转码 + 后处理(grammY/rclone 双通道上传)
│       │   ├── grammy.ts        # grammY 上传 + 标签生成 + 队列限流
│       │   └── bot-server-manager.ts # 内置 Local Bot API Server 管理
│       ├── routes/           # REST API
│       │   ├── streamers.ts      # 主播管理(含批量删除)
│       │   ├── files.ts          # 文件管理(含批量删除)
│       │   ├── settings.ts       # 全局设置
│       │   ├── postprocess.ts    # 后处理配置 + Bot API Server 管理接口
│       │   ├── auth.ts           # 登录/登出/修改密码 API
│       │   └── system.ts         # 系统状态
│       ├── db/index.ts       # SQLite 数据库层
│       ├── config.ts         # 配置加载/保存
│       ├── auth.ts           # 登录认证(session + 密码哈希)
│       ├── types.ts          # 共享类型
│       └── utils.ts          # 工具函数
├── client/                   # Vue3 + Vite 前端
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── views/
│       │   ├── StreamersView.vue  # 主播管理(含全选/批量删除)
│       │   ├── FilesView.vue      # 文件管理(含实时时长/上传工具显示/全选/批量删除)
│       │   ├── PostProcessView.vue # 后处理(grammY/rclone 独立卡片 + Bot Server 管理)
│       │   ├── SettingsView.vue   # 设置(含切片文件大小)
│       │   └── LoginView.vue
│       ├── api.ts            # 前端 API 封装
│       ├── router.ts
│       ├── types.ts
│       └── styles.css        # Material Design 主题(卡片/阴影/动画/深浅色)
├── data/                     # 运行时数据库(卷)
├── recordings/               # 本地录像(卷)
├── logs/
└── config/rclone/            # rclone.conf(卷)
```

---

## 前置要求

- **Docker** 20.10+ 和 **docker compose** v2
- **宿主机安装 rclone**(仅使用 rclone 上传时需要):`sudo apt install rclone`(容器通过卷挂载调用宿主机 rclone)
- **Telegram API 凭据**(仅使用 grammY 上传时需要):在 https://my.telegram.org 获取 API ID 和 API HASH,以及 Bot Token(通过 [@BotFather](https://t.me/BotFather) 创建)
- 小红书账号 Cookie(含 `a1` 和 `web_session`)——用于自动发现每场直播变化的 roomId
- 哔哩哔哩 Cookie(含 `SESSDATA` 和 `buvid3`,可选但推荐)——用于获取高画质流
- 快手 Cookie(含 `did`,推荐配置)——用于更稳定的直播状态检测和流解析
- SOOP Cookie 或 SOOP 账号密码(推荐配置)——用于解析需要登录的直播流
- Pandalive Cookie(可选)——用于更稳定的解析
- PikPak 账号(或其他 rclone 支持的网盘,仅使用 rclone 上传时需要)

---

## 部署(Docker Compose)

部署方式不变。Docker 镜像已内置 telegram-bot-api 二进制(预编译,无需源码编译)和 grammY 依赖。默认使用 Docker 缓存构建,首次约 2 分钟,后续增量构建更快。如需强制全量重建:`FORCE_REBUILD=1 ./deploy.sh`。

**部署顺序必须严格遵循以下步骤**,rclone 配置需要在构建容器前完成,否则容器内无法读取 rclone.conf。

### 方式 A:一键脚本(推荐)

```bash
curl -fsSL https://raw.githubusercontent.com/rsxbgdurxbjcx-arch/CaptureHub/main/scripts/deploy.sh -o /tmp/deploy.sh
chmod +x /tmp/deploy.sh && /tmp/deploy.sh
```

脚本会自动完成:Docker 安装 → rclone 安装/检查 → 拉取代码 → 引导 rclone 配置 → 构建镜像 → 启动容器 → 全链路验证。

### 方式 B:手动分步部署

#### 1. 安装 Docker(如已安装跳过)

```bash
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
sudo usermod -aG docker "$USER"
# 退出重新登录使 docker 组生效
```

#### 2. 安装宿主机 rclone(仅使用 rclone 上传时需要)

```bash
# rclone 官方一键安装脚本(发行版仓库版本过旧,不支持 PikPak)
curl -fsSL https://rclone.org/install.sh | sudo bash

# 验证安装
rclone version
```

#### 3. 配置 PikPak remote(仅使用 rclone 上传时需要)

```bash
rclone config
```

交互流程:

- `n`(new remote)
- 名称:`pikpak`
- 类型:输入 `pikpak`(或选择对应编号)
- user:PikPak 邮箱
- pass:PikPak 密码(选择 `y` 手动输入,完成后确认)
- 一路默认回车 → `y` 保存 → `q` 退出

**验证 rclone 配置可连接**:

```bash
rclone lsd pikpak:
# 应列出 PikPak 根目录内容(空目录也可以)

rclone mkdir pikpak:capturehub
# 创建 CaptureHub 文件夹,无报错即成功
```

#### 4. 克隆仓库并准备目录

```bash
git clone https://github.com/rsxbgdurxbjcx-arch/CaptureHub.git ~/CaptureHub
cd ~/CaptureHub
mkdir -p data recordings logs config/rclone
```

#### 5. 复制 rclone 配置到项目目录(仅使用 rclone 上传时需要)

```bash
cp ~/.config/rclone/rclone.conf ./config/rclone/rclone.conf
chmod 600 ./config/rclone/rclone.conf
```

> 这一步是 rclone 上传的关键:容器通过卷挂载 `./config/rclone:/config/rclone` 读取配置。

#### 6. 构建镜像并启动

```bash
docker compose build
docker compose up -d
```

#### 7. 验证部署

```bash
# 7a. 应用健康检查
curl http://127.0.0.1:3780/api/health
# → {"ok":true,"message":"CaptureHub ok","version":"2.1.1"}

# 7b. 系统状态(确认工具可用性)
curl http://127.0.0.1:3780/api/system/status | python3 -m json.tool
# 确认 "tools": { "ffmpeg": true, "telegramBotApi": true, "rclone": true, ... }

# 7c. 容器内 rclone 远端连通性(仅使用 rclone 时)
docker compose exec capturehub rclone lsd pikpak: --config /config/rclone/rclone.conf

# 7d. 浏览器访问
# http://<服务器IP>:3780
```

---

## 单独 Docker 部署

```bash
docker build -t capturehub .

docker run -d \
  --name capturehub \
  --restart unless-stopped \
  -p 3780:3780 \
  -v ~/CaptureHub/data:/data \
  -v ~/CaptureHub/recordings:/recordings \
  -v ~/CaptureHub/logs:/logs \
  -v ~/CaptureHub/config/rclone:/config/rclone \
  -v /usr/bin/rclone:/usr/bin/rclone:ro \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Asia/Shanghai \
  capturehub

# 验证
curl http://127.0.0.1:3780/api/health
docker exec capturehub rclone lsd pikpak: --config /config/rclone/rclone.conf
```

> 如果 rclone 安装在 `/usr/local/bin/rclone`,修改挂载路径为 `-v /usr/local/bin/rclone:/usr/bin/rclone:ro`

---

## rclone 配置说明

rclone 仅安装在宿主机,容器通过卷挂载(`/usr/bin/rclone:/usr/bin/rclone:ro`)调用宿主机 rclone。
配置文件通过 Docker 卷 `./config/rclone:/config/rclone` 挂载到容器内。

### 首次配置

```bash
# 宿主机配置 PikPak
rclone config
# → n → pikpak → 类型 pikpak → 邮箱 → 密码 → y 保存 → q

# 验证远端连通
rclone lsd pikpak:
rclone mkdir pikpak:capturehub

# 复制配置到项目
cp ~/.config/rclone/rclone.conf ./config/rclone/rclone.conf
chmod 600 ./config/rclone/rclone.conf

# 重启容器使配置生效
docker compose restart capturehub

# 容器内验证
docker compose exec capturehub rclone lsd pikpak: --config /config/rclone/rclone.conf
```

### 重新配置

```bash
rclone config
cp ~/.config/rclone/rclone.conf ./config/rclone/rclone.conf
docker compose restart capturehub
```

---

## Web UI 首次配置

1. 浏览器打开 `http://<服务器IP>:3780`
2. **登录**:初始账号 `capturehub` / 密码 `admin`(登录后可在「设置」页面修改)
3. **设置** → 分别粘贴各平台 Cookie:
   - **小红书 Cookie**(需含 `a1` + `web_session`)——用于自动发现每场直播变化的 roomId
   - **抖音 Cookie**(需含 `ttwid` + `msToken`,可选)——不配也可自动解析
   - **哔哩哔哩 Cookie**(需含 `SESSDATA` + `buvid3`,可选)——配置后可获取更高画质
   - **快手 Cookie**(需含 `did`,推荐)——配置后更稳定地检测直播状态和解析流
   - **SOOP Cookie**(可选)或 **SOOP 用户名 + 密码**(推荐)——用于解析需要登录的直播流
   - **PandaLive Cookie**(可选)——用于更稳定的解析
   - **全局 Cookie**(兼容旧版)——未设置平台专属 Cookie 时回退到此
4. **设置** → 轮询间隔(默认 30 秒)、切片时长(默认 `03:00:00`,留空不切片)、**切片文件大小(MB)**(留空不切片)、默认录制清晰度
5. **后处理** → 选择上传工具(grammY 或 rclone):
   - **grammY 配置**:填写 Bot Token、Chat ID、API ID、API HASH、Local Server Port → 点击「启动」启动内置 Local Bot API Server → 配置 grammY 模式(move/copy)
   - **rclone 配置**:填写远程名 `pikpak`、根目录 `capturehub`、模式 `move`
6. **主播** → 选择平台(小红书 / 抖音 / 哔哩哔哩 / 快手 / SOOP / PandaLive / Stripchat),添加主页或直播分享链接,选择录制清晰度

### 工具路径

三个外部工具的路径通过环境变量在容器启动时注入(Web UI 不再暴露路径配置):

| 工具 | 环境变量 | 容器内默认路径 | 说明 |
|------|----------|----------------|------|
| **ffmpeg** | `FFMPEG_PATH` | `/usr/bin/ffmpeg` | 录制引擎,镜像内置 |
| **rclone** | `RCLONE_PATH` | `/usr/bin/rclone` | 网盘上传工具,宿主机安装后通过卷挂载进入容器(`-v /usr/bin/rclone:/usr/bin/rclone:ro`) |
| **telegram-bot-api** | `TELEGRAM_BOT_API_PATH` | `telegram-bot-api`(PATH 查找) | Local Bot API Server 二进制,镜像内置 |

> 说明:若宿主机 rclone 安装在 `/usr/local/bin/rclone`,修改挂载路径为 `-v /usr/local/bin/rclone:/usr/bin/rclone:ro`;其他工具如需自定义路径,设置对应环境变量即可(见 `.env.example`)。

### Web UI 设计

- **Material Design 风格**:卡片式布局、鲜明色彩组合、Material 阴影深度层次、流畅动画过渡
- **卡片式设计**:以卡片为主要布局方式,内容清晰划分和展示,适度的阴影和深度效果营造层次感
- **动画效果**:页面切换、卡片悬浮、按钮按压、开关切换等均有流畅的过渡动画
- **主播卡片**:显示实时直播画面缩略图(每 5 秒自动刷新)、平台标识、在线/离线状态(无论开关状态都实时显示)、录制清晰度、实时录制时长(录制中以脉冲红点 + HH:MM:SS 计时器显示)
- **长按多选**:长按主播卡片进入多选模式,支持单选/多选/批量删除,单击仍可进入编辑页面
- **App Bar**:每页顶部固定 Material Design App Bar,显示页面标题和操作按钮
- **底部导航**:Lucide 图标风格底部导航栏(Users/Film/Workflow/Settings),高度对齐 StripchatRecorder-MobileUI,固定底部
- **添加主播按钮**:主播页面顶部标题栏右侧的主按钮,点击弹出添加/编辑主播弹窗
- **深色模式**:自动适配系统深色模式,所有组件均有完善的深色主题
- **滚动修复**:修复了各页面无法滚动的问题,采用自然文档流滚动方式

---

## 直播间地址格式

### 小红书

| 类型 | 示例 |
|------|------|
| 主页链接 | `https://www.xiaohongshu.com/user/profile/5a3b2e1f4eacab1b2c3d4e5f` |
| 直播链接 | `https://www.xiaohongshu.com/livestream/570180068897685033` |
| 分享短链 | `http://xhslink.com/m/5OUfMYyJsAz` |

**注意**:小红书 roomId **每场直播会变化**。必须配置 Cookie(含 `a1` + `web_session`)才能自动发现新场次的 roomId。未配置 Cookie 时,需手动填入当前直播的 roomId。

### 抖音

| 类型 | 示例 |
|------|------|
| 直播间链接 | `https://live.douyin.com/123456789` |
| 用户主页 | `https://www.douyin.com/user/MS4wLjABAAAA...` |
| 分享短链 | `https://v.douyin.com/DpfoBLAXoHM/` |

**说明**:抖音的 webRid (roomId) 是稳定的,不需要每场更新。系统自动获取 ttwid Cookie 并生成 ABogus / __ac_signature 签名,**无需配置 Cookie 即可解析**。如配置了 Cookie 可获得更稳定的解析效果。

### 哔哩哔哩

| 类型 | 示例 |
|------|------|
| 直播间链接 | `https://live.bilibili.com/12345678` |
| H5 直播间 | `https://live.bilibili.com/h5/12345678` |
| 用户主页 | `https://space.bilibili.com/12345678` |

**说明**:B站的 roomId 是稳定的(短号会自动转换为真实房间号),不需要每场更新。支持配置 Cookie(含 `SESSDATA` + `buvid3`)以获取更高画质。系统自动识别以下直播类型:
- **普通直播**:可正常录制
- **付费直播(DRM加密)**:流为 SAMPLE-AES + Widevine 加密,无法录制
- **大航海/权限专属直播**:无观看权限时拿不到流
- **密码加密直播**:未验证密码拿不到流

### 快手

| 类型 | 示例 |
|------|------|
| 直播间链接 | `https://live.kuaishou.com/u/3xxv9m9gvbquc2a` |
| 直播间(短格式) | `https://live.kuaishou.com/3xxv9m9gvbquc2a` |

**说明**:快手的用户 ID (eid) 是稳定的,不需要每场更新。推荐配置 Cookie(含 `did`)以获得更稳定的解析效果。系统通过解析直播页 `__INITIAL_STATE__` 获取直播流数据,支持原画/蓝光/超高清/高清/标清/流畅六档画质自动选择,默认原画最高画质。

### SOOP (原 AfreecaTV)

| 类型 | 示例 |
|------|------|
| 主播主页 | `https://www.sooplive.com/xxxxx` |
| 直播链接 | `https://play.sooplive.com/xxxxx` |
| 旧域名 | `https://www.afreecatv.com/xxxxx` |

**说明**:SOOP 的 bjId 是稳定的,不需要每场更新。部分直播需要登录才能解析,支持在设置页面配置 SOOP 账号密码自动登录。系统通过站点状态 API 检测直播状态,通过播放器 API 获取流分配信息。SOOP/Pandalive 添加主播后显示名称自动设为主播 ID。

### Pandalive

| 类型 | 示例 |
|------|------|
| 直播间链接 | `https://www.pandalive.co.kr/live/play/uuu282` |
| 主播主页 | `https://www.pandalive.co.kr/uuu282` |

**说明**:Pandalive 的 userId 是稳定的,不需要每场更新。系统通过 member/bj API 检测直播状态,通过 play API 获取播放信息,解析 M3U8 获取多质量流。SOOP/Pandalive 添加主播后显示名称自动设为主播 ID,上传时文件夹和文件名均使用主播 ID。

### Stripchat

| 类型 | 示例 |
|------|------|
| 主播主页 | `https://stripchat.com/username` |
| 直播间 | `https://stripchat.com/username/myRoom` |

**说明**:Stripchat 的 username 是稳定的,不需要每场更新。系统通过 cam API 检测直播状态,通过多 CDN 域名竞速解析 master 播放列表获取最高画质流,支持 Mouflon 加密密钥配置。仅 public(公开秀)状态可录制,私密/群组秀等需登录或令牌的直播无法录制。添加主播后显示名称自动设为主播 username。

**Mouflon 解密密钥**:Stripchat 部分直播使用 Mouflon 加密 HLS 分片文件名,需配置 `pkey=pdkey` 解密密钥。系统内置默认 Worker `https://mouflon.chantrail.com` 自动同步最新密钥(启动时 + 每小时),也可在「设置 → Stripchat → Mouflon 解密密钥」手动按每行一条 `pkey=pdkey` 填写(手动密钥优先)。

---

## 录制清晰度

添加主播时可选择录制清晰度,系统根据选择的清晰度自动匹配最接近的流。

| 清晰度 | 代号 | 说明 |
|--------|------|------|
| 原画 | OD | 最高画质,默认选项 |
| 超清 | UHD | 超高清 |
| 高清 | HD | 高清 |
| 标清 | SD | 标清 |
| 流畅 | LD | 最低画质 |

**全局默认清晰度**:在设置页面可配置全局默认录制清晰度,新建主播未单独设置时使用此清晰度。

---

## 七平台拉流逻辑

### 小红书

```text
URL/短链 → 解析 roomId / userId
Cookie + redId → usersearch 发现最新 roomId(每场变化)
GET https://www.xiaohongshu.com/livestream/{roomId}  (iOS UA)
解析 window.__INITIAL_STATE__
liveStatus === "success" 且标题不含「回放」
拼 CDN:
  FLV  http://live-source-play.xhscdn.com/live/{roomId}.flv
  HLS  http://live-source-play.xhscdn.com/live/{roomId}.m3u8
优先 FLV 原画录制
```

### 抖音

```text
URL/短链 → 解析 webRid (roomId)
自动获取 ttwid Cookie (6小时缓存)
ABogus 签名 / __ac_signature 签名
多 API 接口解析(web → webHTML → mobile → userHTML):
  web:      https://live.douyin.com/webcast/room/web/enter/?web_rid={roomId}
  webHTML:  https://live.douyin.com/{roomId} (HTML 页面解析)
  mobile:   https://webcast.amemv.com/webcast/room/reflow/info/
  userHTML: https://www.douyin.com/user/{secUid} (HTML 页面解析)
解析 stream_url → 画质优先级选择
优先 FLV 最高画质录制(原画 > 真原画 > 蓝光 > 超清 > 高清 > 标清)
```

### 哔哩哔哩

```text
URL → 提取 roomId(支持短号自动转换)
room_init 接口获取真实 room_id + uid + live_status
直播类型判定(仅在播时探测):
  1. 密码房 → encrypted === true
  2. 付费标记 → is_sp === 1 || special_type === 1
  3. 取流探测 → getRoomPlayInfo:
     - all_special_types 含 203 → DRM 加密(付费)
     - 无流返回 → 权限受限(大航海)
     - 正常有流 → 可录制
getRoomPlayInfo V2 接口获取流:
  protocol: http_stream, http_hls
  format:   flv, ts, fmp4
  codec:    avc, hevc, av1
9 种组合按优先级选流(FLV/AVC 最高优先)
画质选择: 杜比(30000) > 4K(20000) > 8K(25000) > 原画(15000/10000) > 蓝光(400) > 超清(250) > 高清(150) > 流畅(80)
画质不匹配时自动降级到 accept_qn[0]
```

### 快手

```text
URL → 提取 eid (用户ID)
GET https://live.kuaishou.com/u/{eid}  (直播页 HTML)
提取 window.__INITIAL_STATE__ JSON
解析 liveStream.playUrls (h264/hevc/av1) adaptationSet.representation[]
按码率排序: OD(原画) > BD(蓝光) > UHD(超清) > HD(高清) > SD(标清) > LD(流畅)
默认选择最高码率(原画)流地址
```

### SOOP (原 AfreecaTV)

```text
URL → 提取 bjId (主播ID)
步骤1: GET station status API 检测直播状态
步骤2: GET player API 获取播放信息 (BNO, TITLE)
  → 如需登录: 使用配置的用户名密码自动登录获取 Cookie
步骤3: GET stream assign API 获取流分配地址 (view_url)
步骤4: GET aid 接口获取 AID 验证令牌
步骤5: 拼接最终 HLS 流地址: {view_url}?aid={aid}
按画质选择: OD(原画) > UHD(超清) > HD(高清) > SD(标清) > LD(流畅)
```

### Pandalive

```text
URL → 提取 userId (主播ID)
步骤1: POST member/bj API 获取主播信息和直播状态
步骤2: POST play API 获取播放信息 (PlayList.hls[0].url)
步骤3: 解析 M3U8 获取多质量流列表 (variants)
步骤4: 按画质选择最佳流
  OD(原画) > UHD(超清) > HD(高清) > SD(标清) > LD(流畅)
```

### Stripchat

```text
URL → 提取 username (主播用户名)
步骤1: GET https://stripchat.com/api/front/v2/models/username/{username}/cam
  解析 isLive / status / viewersCount / id (modelId) / 缩略图
  仅 status == "public" 可录制
步骤2: 多 CDN 顶级域名竞速获取 master 播放列表
  https://edge-hls.{doppiocdn.com|.org|.live|.net}/hls/{modelId}/master/{modelId}_auto.m3u8
步骤3: 解析 master 播放列表
  收集 #EXT-X-MOUFLON:PSCH:scheme:key (Mouflon 参数)
  解析 #EXT-X-STREAM-INF:BANDWIDTH=... → 按带宽降序排列变体
步骤4: 按画质选择最佳变体
  OD(原画) > UHD(超清) > HD(高清) > SD(标清) > LD(流畅)
步骤5: 变体 URL 追加 Mouflon 参数 psch/pkey → 最终 HLS 地址
  若配置了 Mouflon 密钥,优先使用已匹配 pkey 的 pair
步骤6: 持续拉取变体 m3u8,解析分片列表
  - 解析 #EXT-X-MOUFLON:PSCH 获取当前 pkey
  - 解析 #EXT-X-MOUFLON:URI: 加密分片,用 pdkey 做 SHA-256 XOR 解密
  - 解析 EXT-X-MAP 获取 fMP4 init 段
步骤7: 多 CDN 竞速下载分片(init + media),fMP4 转 TS 写入会话目录
步骤8: 录制结束 ffmpeg concat 合并 TS 分片为 mp4/ts
```

> **Mouflon 说明**:Stripchat 对部分直播的 HLS 分片文件名做 Mouflon 加密(variant 播放列表中的 `#EXT-X-MOUFLON:URI:` 加密分片),因此不能直接用 FFmpeg 拉流,而是采用「手动下载分片 + SHA-256 XOR 解密 + fMP4 转 TS + ffmpeg 合并」的专用录制引擎(与 StripchatRecorder 一致)。解密密钥 `pkey=pdkey` 支持两种来源:
> 1. **手动配置**:设置页面「Stripchat → Mouflon 解密密钥」按每行一条 `pkey=pdkey` 填写
> 2. **自动同步**:内置默认 Worker `https://mouflon.chantrail.com`,启动时与每小时自动拉取最新密钥,合并到本地(手动密钥优先)

---

## Cookie 配置说明

系统支持七平台独立 Cookie 管理,互不干扰。在 **设置** 页面可为每个平台单独配置 Cookie。

| 平台 | Cookie 字段 | 说明 |
|------|------------|------|
| 小红书 | `a1`, `web_session` | 必须配置,用于 usersearch 自动发现 roomId |
| 抖音 | `ttwid`, `msToken` | 可选,不配也可自动解析;配置后更稳定 |
| 哔哩哔哩 | `SESSDATA`, `buvid3` | 可选,配置后可获取更高画质流 |
| 快手 | `did`, `userId` | 推荐,配置后更稳定地检测直播状态和解析流 |
| SOOP | SOOP 平台 Cookie | 可选;或配置用户名+密码自动登录获取 |
| Pandalive | Pandalive 平台 Cookie | 可选,配置后更稳定 |
| Stripchat | Stripchat 平台 Cookie | 可选;公开秀无需登录,可留空 |

**回退机制**:未设置平台专属 Cookie 时,自动回退到全局 Cookie。

### SOOP 登录系统

SOOP 平台部分直播需要登录才能解析流。系统支持两种方式获取 SOOP 登录凭证:

1. **手动配置 Cookie**:在设置页面直接粘贴 SOOP Cookie 字符串
2. **账号密码自动登录**:在设置页面配置 SOOP 用户名和密码,系统在解析流时自动调用登录接口获取 Cookie

登录流程:当播放器 API 返回需要登录的结果时,系统自动使用配置的用户名密码调用 SOOP 登录接口,获取 Cookie 后重新请求流分配。

---

## 登录系统

Web UI 需登录后使用,所有 API 接口(除 `/api/auth/*` 和 `/api/health`)均需携带 Bearer Token。

- **初始账号**:`capturehub`
- **初始密码**:`admin`
- **修改账号密码**:登录后进入「设置」页面,在「登录账号」卡片中修改
- 修改时需输入当前密码验证,新密码留空则仅修改账号名
- 修改成功后自动刷新 Token,无需重新登录
- Token 永不过期,仅在退出登录或修改密码后失效

---

## 切片功能

系统支持两种切片方式,可独立或组合使用:

| 配置项 | 说明 |
|--------|------|
| **切片时长** | 填入 `HH:MM:SS` 格式(如 `03:00:00`),录制达到此时长时自动切片 |
| **切片文件大小** | 填入数字(单位 MB,如 `1950`),录制文件达到此大小时自动切片 |
| 两者都留空 | 不切片,完整录制 |
| 仅填写切片时长 | 录制达到指定时长时切片 |
| 仅填写切片文件大小 | 录制文件达到指定大小时切片 |
| 两者都填写 | 两者同时生效,先达到阈值的先触发切片 |

切片触发后自动执行后处理上传(grammY 或 rclone)。

---

## 双上传工具

系统支持两种上传工具,在后处理页面顶部选择。grammY 配置卡片和 rclone 配置卡片完全分开,独立运行,互不干扰。

### grammY(Telegram 上传)

- **内置 Local Bot API Server**:自动拉起本地 telegram-bot-api 进程,不走外部网络
- **Bot Token 认证**:无需手机号登录,配置简单
- **原生视频气泡**:自动提取视频元数据 + 首帧封面
- **大文件支持**:2GB(普通用户)/ 4GB(Premium 会员)
- **极速本地传输**:grammY 以本地文件流读取,经 127.0.0.1 回环直传内置 Local Bot API Server,本地段不占用公网带宽,速度取决于磁盘 IO
- **自动标签**:主播名 + 平台名自动生成 Hashtag
- **队列限流**:串行上传 + FloodWait 自动重试
- **Chat ID 兼容**:支持普通群组和 -100 前缀超级群组
- **模式**:move(上传后删除本地)/ copy(保留本地),在后处理页面可配置

### rclone(网盘上传)

- **原理**:调用宿主机 rclone 二进制,通过配置文件上传到网盘
- **配置**:远程名、根目录、模式、后处理脚本
- **模式**:move / copy

两种工具完全独立运行,互不干扰。选择哪个工具即使用哪个工具的配置。

---

## 自动上传机制

录制完成后**自动触发**上传,七平台录制的视频均支持自动上传。支持以下触发时机:

| 触发时机 | 说明 |
|----------|------|
| 下播 (`stream_end`) | 直播流中断或主播主动下播时自动上传收尾片段 |
| 手动暂停 (`manual_stop`) | 点击「停录」后自动上传当前片段 |
| 时长切片 (`segment`) | 达到切片时长后自动上传已完成片段 |
| 文件大小切片 | 达到切片文件大小时自动上传已完成片段 |

所有触发时机均为后端默认功能,始终开启,无需在前端配置。

---

## grammY + Local Bot API Server 配置流程

grammY 上传方案无需手机号登录,只需 Bot Token + API ID + API HASH 即可。

### 第一步:获取 Telegram API 凭据

1. 访问 https://my.telegram.org 登录
2. 点击 API development tools
3. 创建应用,获取 `api_id` 和 `api_hash`

### 第二步:创建 Bot

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`,按提示创建 Bot
3. 获取 Bot Token

### 第三步:将 Bot 加入群组

1. 创建 Telegram 群组
2. 将 Bot 添加为群组成员
3. (推荐)将 Bot 设为群组管理员

### 第四步:获取群组 Chat ID

1. 在群组中发送任意消息
2. 使用 [@userinfobot](https://t.me/userinfobot) 等工具获取群组 Chat ID
3. 普通群组 ID 为负数(如 `-123456789`)
4. 超级群组 ID 以 `-100` 开头(如 `-1001234567890`)

### 第五步:在 CaptureHub 中配置 grammY

1. 打开 CaptureHub Web UI → 后处理页面
2. 在顶部选择上传工具为 **grammY**
3. 在 grammY 配置卡片中填写:
   - **Bot Token**:从 BotFather 获取的 Token
   - **Chat ID**:目标群组 ID(支持普通群组和 -100 前缀超级群组)
   - **API ID**:从 my.telegram.org 获取
   - **API Hash**:从 my.telegram.org 获取
   - **Local Server Port**:本地 Bot API Server 端口(默认 8081)
   - **grammY 模式**:选择 `move`(上传后删除本地文件)或 `copy`(保留本地)
4. 配置自动保存(输入后自动生效,无需手动保存)
5. 点击「启动」按钮启动内置 Local Bot API Server
6. 状态显示「运行中」后即可自动上传

### 特性说明

- **原生视频气泡**:自动使用 ffmpeg 提取视频时长、宽高、首帧封面,上传后在 Telegram 中显示边缘圆润的原生视频播放器
- **大文件支持**:通过 Local Bot API Server 的 `--local` 模式,支持上传 2GB(普通用户)/ 4GB(Premium 会员)大文件
- **极速本地传输**:文件以纯本地路径流式上传到内置 Local Bot API Server(127.0.0.1 回环直传),本地接收不走公网;再由其上传至 Telegram 服务器,外网耗时取决于 VPS 带宽
- **自动标签**:根据主播名和平台自动生成 Hashtag 标签(如 `#sunaang #soop`),每个标签之间用空格隔开
- **Chat ID 兼容**:全程使用 String 类型处理 Chat ID,完美兼容普通群组和 -100 前缀超级群组
- **防封号机制**:内置队列串行上传 + 429 FloodWait 自动重试,避免频繁调用 API 导致 Bot 被封禁

---

## 标签自动生成

上传到 Telegram 时,系统自动生成标签作为视频 caption,统一命名为 `#主播名 #平台名`:

| 平台 | 标签示例 |
|------|----------|
| 小红书 | `#sunaang #小红书` |
| 抖音 | `#sunaang #抖音` |
| 哔哩哔哩 | `#sunaang #哔哩哔哩` |
| 快手 | `#sunaang #快手` |
| SOOP | `#sunaang #soop` |
| Pandalive | `#sunaang #pandalive` |
| Stripchat | `#sunaang #stripchat` |

主播名取主播卡片内显示的名称;每个标签之间用一个空格隔开。

---

## rclone 上传模式

| 模式 | 行为 |
|------|------|
| **move**(默认) | `rclone move` 上传后自动删除本地文件 |
| **copy** | `rclone copy` 上传后保留本地副本 |

上传目录结构:

```text
PikPak/
└── capturehub/                    # ← rcloneRemotePath
    └── <主播名>/
        └── <主播名>_20260712_153000_s000.mp4
```

> **SOOP/Pandalive/Stripchat**:主播名即主播 ID(如 `sunaang`、`uuu282`),文件夹和文件名均使用主播 ID。

---

## 文件管理

- **录制中卡片**:实时显示录制时长(HH:MM:SS,每秒更新)
- **处理中卡片**:显示当前上传工具(grammY/rclone)和上传模式(move/copy),实时上传速度和进度条
- **全选/删除**:支持勾选单个或多个文件卡片,批量删除
- **删除已上传**:一键删除所有已上传记录,保留录制中卡片
- **下拉刷新**:保留下拉刷新功能

---

## 主播管理

- **长按多选**:长按主播卡片进入多选模式,支持单选/多选/批量删除;单击仍可进入编辑页面
- **实时直播画面**:主播在线/录制中时,卡片显示直播画面缩略图,每 5 秒自动刷新
- **实时状态显示**:无论开关开启或关闭,卡片都根据轮询情况实时显示主播在线/离线状态
- **实时录制时长**:录制中主播卡片显示脉冲红点 + HH:MM:SS 计时器

---

## 下载引擎

| 引擎 | 说明 |
|------|------|
| **FFmpeg** | 默认,稳定,直接拉 FLV/HLS 流写入文件 |

---

## 后处理脚本

### rclone 脚本环境变量

| 变量 | 说明 |
|------|------|
| `CAPTUREHUB_FILE_PATH` | 本地视频绝对路径 |
| `CAPTUREHUB_FILE_NAME` | 文件名 |
| `CAPTUREHUB_STREAMER` | 主播名(安全化处理) |
| `CAPTUREHUB_REMOTE` | rclone 远程名(默认 `pikpak`) |
| `CAPTUREHUB_REMOTE_ROOT` | 网盘根目录(默认 `capturehub`) |
| `CAPTUREHUB_RCLONE` | rclone 可执行文件路径(默认 `rclone`) |
| `CAPTUREHUB_TRIGGER` | 触发类型:`stream_end` / `manual_stop` / `segment` / `manual` |
| `CAPTUREHUB_RCLONE_MODE` | 上传模式:`move` / `copy` |
| `CAPTUREHUB_DELETE_LOCAL` | 是否删除本地:`1` / `0` |

### grammY 上传说明

grammY 上传不需要自定义脚本,系统内置完整的上传逻辑:
- 自动提取视频元数据(时长、分辨率)
- 自动生成首帧封面缩略图
- 自动生成 Hashtag 标签
- 自动队列限流和 FloodWait 重试
- 通过 Local Bot API Server 的本地路径极速上传(127.0.0.1 回环直传)

---

## 后处理日志清除

后处理菜单新增**清除日志**按钮,可快速清除所有后处理任务记录,释放存储空间。

---

## 权限说明

- 容器以 `node` 用户运行,默认 UID/GID=1000
- 通过 `PUID`/`PGID` 环境变量可匹配宿主机文件权限
- 录制文件属主自动修正为 `PUID:PGID`
- rclone 配置文件权限自动设为 `644`(确保容器内可读)

---

## API 协议

统一响应格式:`{ ok: boolean, data?: T, error?: string, message?: string }`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/login` | 登录(返回 token) |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/status` | 获取当前登录状态 |
| POST | `/api/auth/change-credentials` | 修改账号密码 |
| GET | `/api/system/status` | 系统状态(运行时间、录制数、工具可用性) |
| POST | `/api/system/monitor/restart` | 重启监控循环 |
| POST | `/api/system/recover` | 在线修复:清理残留录制状态并触发后处理上传 |
| GET | `/api/streamers` | 主播列表 |
| POST | `/api/streamers` | 添加主播 |
| GET | `/api/streamers/:id` | 获取主播详情 |
| PUT | `/api/streamers/:id` | 更新主播 |
| DELETE | `/api/streamers/:id` | 删除主播 |
| POST | `/api/streamers/batch/delete` | 批量删除主播 |
| POST | `/api/streamers/:id/check` | 手动检测开播状态 |
| POST | `/api/streamers/:id/start` | 触发检测+开录 |
| POST | `/api/streamers/:id/stop` | 停止录制 |
| GET | `/api/streamers/:id/snapshot` | 直播画面快照(从当前流抓取一帧 JPEG,支持 `?token=` 认证) |
| GET | `/api/files` | 录制文件列表 |
| GET | `/api/files/progress` | 处理中文件上传进度(转码/上传/速度) |
| GET | `/api/files/sizes` | 录制中文件实时大小(字节) |
| DELETE | `/api/files/:id` | 删除文件(含物理文件) |
| POST | `/api/files/batch/delete` | 批量删除文件 |
| POST | `/api/files/:id/upload` | 手动上传到网盘 |
| POST | `/api/files/sync` | 同步磁盘文件到数据库 |
| DELETE | `/api/files/uploaded/batch` | 删除所有已上传记录(保留录制中卡片) |
| GET | `/api/settings` | 获取全局设置 |
| PUT | `/api/settings` | 更新全局设置 |
| POST | `/api/settings/reset` | 恢复默认设置 |
| GET | `/api/postprocess/config` | 获取后处理配置 |
| PUT | `/api/postprocess/config` | 更新后处理配置 |
| GET | `/api/postprocess/bot-server/status` | Local Bot API Server 状态 |
| POST | `/api/postprocess/bot-server/start` | 启动 Local Bot API Server |
| POST | `/api/postprocess/bot-server/stop` | 停止 Local Bot API Server |
| GET | `/api/postprocess/jobs` | 后处理任务记录 |
| GET | `/api/postprocess/jobs/:id` | 单个后处理任务详情 |
| DELETE | `/api/postprocess/jobs` | 清除所有后处理任务记录 |
| POST | `/api/postprocess/run/:fileId` | 手动执行后处理 |
| GET | `/media/*` | 本地录像流媒体预览 |

---

## 更新 CaptureHub

仓库代码更新后,按以下步骤更新到最新版本。核心流程为:**拉取仓库最新代码 → 重新构建镜像 → 重启容器**。

### 方式 A:手动更新(推荐)

```bash
# 1. 进入项目目录
cd ~/CaptureHub

# 2. 拉取仓库最新代码(先 fetch,再快进合并)
git fetch --all --prune
git pull --ff-only

# 3. 重新构建镜像
docker compose build

# 4. 重启容器(数据卷 data / recordings / config 均保留)
docker compose up -d

# 5. 查看启动日志确认正常
docker compose logs -f capturehub
```

> **若第 2 步 `git pull --ff-only` 报 `Not possible to fast-forward`**:
> 说明远程仓库被强制更新(force push),本地分支与远程分叉。部署环境不保留本地代码改动,可强制对齐到远程:
> ```bash
> cd ~/CaptureHub
> git fetch --all --prune
> git reset --hard origin/main
> docker compose build
> docker compose up -d
> ```
> `data/`、`recordings/`、`config/rclone/` 等数据目录不在版本控制内,`reset --hard` 不会影响这些数据。

### 方式 B:一键脚本

脚本会自动执行 `git pull` 拉取仓库最新代码,随后重新构建并重启容器:

```bash
curl -fsSL https://raw.githubusercontent.com/rsxbgdurxbjcx-arch/CaptureHub/main/scripts/deploy.sh -o /tmp/deploy.sh
chmod +x /tmp/deploy.sh && /tmp/deploy.sh
```

> 脚本流程:拉取/更新代码(git pull) → 检查 rclone 配置 → 重新构建镜像 → 重启容器 → 全链路验证。

### 强制全量重建

若代码更新涉及依赖变更或构建缓存异常,可执行无缓存全量重建:

```bash
cd ~/CaptureHub
# 1. 拉取仓库最新代码
git fetch --all --prune
git pull --ff-only
# 2. 无缓存全量重建并重启
docker compose build --no-cache
docker compose up -d
```

### 更新说明

- **数据保留**:`data/`(数据库与设置)、`recordings/`(本地录像)、`config/rclone/`(rclone 配置)均为 Docker 卷挂载,重新构建镜像不会丢失。
- **首次由旧版 `red` 升级到 `CaptureHub`**:旧容器/镜像名为 `red`,升级时需先清理旧容器再启动新服务:
  ```bash
  cd ~/CaptureHub
  docker compose down          # 移除旧容器(保留数据卷)
  git pull --ff-only
  docker compose build
  docker compose up -d
  ```
- **健康检查**:更新后访问 `http://<服务器IP>:3780/api/health`,应返回 `{"ok":true,"message":"CaptureHub ok","version":"v2.4.1"}`。

---

## 运维命令

```bash
# 查看日志
docker logs -f capturehub

# 重启
docker restart capturehub

# 停止并删除
docker compose down

# 更新(拉最新代码重建)
git pull
docker compose build
docker compose up -d

# 查看容器状态
docker compose ps

# 进入容器
docker compose exec capturehub sh
```

---

## License

仅供学习与自用录制。请遵守各平台用户协议与当地法律法规。
