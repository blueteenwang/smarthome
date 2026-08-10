# Synology 部署指南

把 Smart Home AI Dashboard 跑在群晖 NAS 上，24h 守家。

---

## 0. 先决条件

- 群晖型号 ≥ DS218+/DS920+（推荐 x86_64 Intel/AMD 芯片）
- DSM ≥ 7.2，已安装 **Container Manager**（套件中心搜索安装；旧版叫 Docker）
- 已开启 **SSH**（控制面板 → 终端机和 SNMP → 启用 SSH）
- HA 实例可达
- DashScope API Key（https://bailian.console.aliyun.com/）
- 摄像头 RTSP URL

---

## 1. 确认架构

SSH 到群晖：

```bash
ssh USER@NAS_IP
uname -m
# x86_64 → Intel/AMD 群晖（最常见）
# aarch64 → arm64 群晖
```

---

## 2. 推荐路径：在群晖直接 build（最稳）

### 2.1 准备目录

群晖 SSH 里：

```bash
sudo mkdir -p /volume1/docker/smart-home-ai
sudo chown -R $USER:users /volume1/docker/smart-home-ai
cd /volume1/docker/smart-home-ai
```

### 2.2 把源码传上来

Mac 端（一次拷贝）：

```bash
cd /path/to/homesense

# 用 rsync 排除大文件 + 不该传的文件
rsync -av --progress \
  --exclude='.DS_Store' \
  --exclude='*.bak' \
  --exclude='before/' \
  --exclude='redesign/' \
  --exclude='snapshots/' \
  --exclude='audio/' \
  --exclude='config.json' \
  ./ USER@NAS_IP:/volume1/docker/smart-home-ai/
```

> 注意：故意不传 `config.json`（含 token 等敏感信息），等下单独传脱敏副本

### 2.3 准备 config.json

Mac 端复制脱敏模板，填好真实值：

```bash
cp config.json.example /tmp/config.json
# 编辑 /tmp/config.json，填入：
#   - homeAssistant.url + token
#   - camera.rtspUrl
#   - ai.apiKey
#   - xiaoai 配置（可选）
```

传到群晖：

```bash
scp /tmp/config.json USER@NAS_IP:/volume1/docker/smart-home-ai/config.json
```

### 2.4 在群晖 SSH 内 build

```bash
ssh USER@NAS_IP
cd /volume1/docker/smart-home-ai

sudo docker build -t smart-home-ai:latest .
# 第一次约 2-4 分钟（拉 node:20-bookworm-slim + apt 装 ffmpeg）

# 验证
sudo docker images smart-home-ai
# REPOSITORY      TAG       IMAGE ID    SIZE
# smart-home-ai   latest    abcd1234    ~280MB
```

### 2.5 启动

```bash
cd /volume1/docker/smart-home-ai
sudo docker compose up -d   # 注意 DSM 7.2+ 是 `docker compose`（无横线），旧版是 `docker-compose`

# 实时看日志
sudo docker logs -f smart-home-ai
```

正常启动应看到：

```
[Server] HTTP listening on 0.0.0.0:8090
[Camera] Snapshot daemon started
[Automation] Loaded N rules (enabled=true)
```

### 2.6 验证

浏览器开 `http://NAS_IP:8090`，看到仪表盘。

```bash
# 命令行 health
curl -s http://NAS_IP:8090/api/snapshot.json | head -c 200
```

---

## 3. 备选路径：Mac 打包 → 拷到 NAS

> 适合不想给 NAS 装编译环境，或者要分发给别人用的场景。需要 Mac 上有 Docker Desktop / OrbStack / Colima 任一。

```bash
cd /path/to/homesense

# 1) build（Mac 是 arm64，群晖是 x86 → 加 --platform 交叉编译）
docker build --platform linux/amd64 -t smart-home-ai:latest .

# 2) 导出
docker save smart-home-ai:latest -o smart-home-ai.tar

# 3) 传到群晖
scp smart-home-ai.tar USER@NAS_IP:/volume1/docker/smart-home-ai/
scp config.json docker-compose.yml USER@NAS_IP:/volume1/docker/smart-home-ai/

# 4) 群晖端 load + up
ssh USER@NAS_IP
cd /volume1/docker/smart-home-ai
sudo docker load -i smart-home-ai.tar
sudo docker compose up -d
```

---

## 4. 用 Container Manager UI（不爱命令行的）

1. 打开 **Container Manager** → 项目 → 新增
2. 项目名称：`smart-home-ai`
3. 路径：选 `/volume1/docker/smart-home-ai`
4. 来源：选 `从 docker-compose.yml 创建`（系统自动识别）
5. 下一步 → 启动

UI 启动后日志页能直接看到容器输出。

---

## 5. 常见问题

### Q1：容器启动后立即 exit

```bash
sudo docker logs smart-home-ai
```

最常见原因：
- **`Cannot find module ... config.json`** → `volumes` 路径错，确认 `./config.json` 在当前目录存在
- **`EACCES: permission denied`** → 群晖创建的文件 owner 是 admin (uid 1026)，容器里 node 用户 (uid 1000) 读不到。两种解法：
  1. `sudo chmod 644 /volume1/docker/smart-home-ai/config.json`
  2. docker-compose.yml 取消注释 `user: "1026:100"`

### Q2：HA 调不通（`Failed to fetch HA states`）

```bash
sudo docker exec smart-home-ai curl -s http://192.168.X.X:8123/api/ -H "Authorization: Bearer YOUR_TOKEN"
```

不通的可能：
- HA 在同台 NAS 容器跑 → url 改 `http://172.17.0.1:8123`，或启用 `network_mode: host`
- HA 在另一台机器 → 检查防火墙、IP 段

### Q3：RTSP 拉不到流

```bash
sudo docker exec smart-home-ai ffmpeg -rtsp_transport tcp -i "rtsp://USER:PASS@..." -t 3 -frames:v 1 -y /tmp/test.jpg
```

- `401 Unauthorized` → DSM SS 重新生成 RTSP 密码
- `Connection refused` → 用 host 网络模式

### Q4：DashScope 调不通

```bash
sudo docker exec smart-home-ai curl -s -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-turbo","messages":[{"role":"user","content":"hi"}]}'
```

应返回 `{"choices":[...]}`。`Invalid API-key` → key 错。超时 → 群晖访问公网受限。

### Q5：CPU 100%（4K HEVC 软解打满）

群晖 CPU 弱（J4115/V1500B 这类），**强烈建议**摄像头/SS 端转 1080p H.264：
- 萤石 APP → 设备设置 → 视频质量 → 流畅/标清
- 海康/大华 → IPC web → 编码改 H.264 + 1080p

或在 docker-compose.yml 加资源限制保护其他服务：

```yaml
deploy:
  resources:
    limits:
      memory: 512M
      cpus: "1.5"
```

---

## 6. 日常运维

```bash
# 看日志
sudo docker logs --tail 100 smart-home-ai
sudo docker logs -f smart-home-ai

# 改了 config.json 不需要重 build，重启即可
sudo docker restart smart-home-ai

# 升级（在群晖 build 路径下）
cd /volume1/docker/smart-home-ai
git pull   # 如果用 git；否则手动 rsync 新代码
sudo docker compose down
sudo docker build -t smart-home-ai:latest .
sudo docker compose up -d

# 停 / 删
sudo docker compose down
sudo docker rmi smart-home-ai:latest
```

---

## 7. 备份

值得备份的就一个：`config.json`（含 token / API key / 自动化规则）。

```bash
# 群晖端定时备份
cp /volume1/docker/smart-home-ai/config.json /volume1/backup/smart-home-ai-$(date +%Y%m%d).json
```

snapshots/ + audio/ 是缓存，不用备份。

---

## 8. 已知限制（Docker 部署）

- **本地麦克风模式不可用**：容器内没有 macOS avfoundation，audioSource 必须用 `rtsp` 模式（从摄像头音频流唤醒）
- **macOS `say` TTS 不可用**：要语音反馈必须用小爱音箱（HA notify）
- **VideoToolbox 硬解不可用**：群晖只能软解，4K HEVC 流务必转 1080p H.264

---

## 9. 想发布给别人用？

- 把镜像推到 Docker Hub：
  ```bash
  docker tag smart-home-ai:latest YOUR_DOCKERHUB_USER/smart-home-ai:0.1.0
  docker push YOUR_DOCKERHUB_USER/smart-home-ai:0.1.0
  ```
- 别人 docker-compose.yml 里 image 改成 `YOUR_DOCKERHUB_USER/smart-home-ai:0.1.0`，`docker compose up -d` 就跑起来了

> 这步等社区文章 + GitHub 仓库立稳之后再做，先别急。
