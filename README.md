[README.md](https://github.com/user-attachments/files/34146179/README.md)
# 对花 · 双人联机

两个人、两部手机、一副牌。随机主花色，领出、压牌、接力、捡牌、塞牌。

- **不需要账号**，不需要装 App
- **不需要服务器**，纯静态页面 + 公共 MQTT 中转
- **一个用 WiFi、一个用流量也没问题**
- 支持断线重连、刷新恢复、再来一局、结算翻牌、房间内累计比分

线上地址：`https://<你的用户名>.github.io/duihua/`

---

## 怎么玩

1. 用手机打开部署好的链接
2. 点「创建房间」，把生成的链接发给朋友（微信直接发就行）
3. 对方点开链接自动进入对局；主花色和先手由房间号随机决定
4. 一局结束后点「再来一局」，分数保留；双方都同意才开新局

### 建议加到主屏幕

- **Android**：Chrome 右上角菜单 →「添加到主屏幕」
- **iPhone**：Safari 分享按钮 →「添加到主屏幕」

加完之后是全屏运行，跟原生 App 基本没区别。

---

## 规则速查

### 准备

- 52 张牌，去掉大小王
- 每局随机一个主花色
- 每人 10 张，牌堆 32 张
- 每局随机决定先手
- 10 张是**补牌上限**，不是持牌上限；捡牌可以超过 10 张

### 牌力

- 点数：`2 < 3 < … < 10 < J < Q < K < A`
- 主花色大于任意副花色
- 主花色之间比点数；主花色 A 无敌
- 主花色 2 也可以毙副花色 A

### 一个回合

1. **领出**：领出方出任意一张牌（可以出主花色）
2. **压**：
   - 副花色 → 出同花色更大的牌，或用任意主花色毙
   - 主花色 → 只能出更大的主花色
   - 压不住（或主动）→ 捡牌
3. **接力**：压住之后，领出方可以出任意一张**点数在桌面上出现过**的牌，也可以停止
4. **捡牌**：防守方拿走桌面所有牌；领出方可以把手里的同点数牌**塞**给对手，塞的牌不能压
5. **补牌**：回合结束，领出方先补到 10，牌堆不足摸完为止

### 点数池 N

- N = 本回合桌面上所有牌的点数（双方都算）
- 接力牌只要点数属于 N 即可，花色不限
- **领出方的接力不会扩大 N，只有防守方的压牌会**

例：你出 5♥，对手 8♥ 压住 → N={5,8}；你可以接 5♠/5♣/5♦ 或 8♠/8♣/8♦。

### 胜负

- 牌堆没摸完时，手牌 0 不判胜，正常补牌
- 牌堆空后，手牌为 0 **立即胜**
- 最后一张打出即胜，最后一压也即胜
- 每局胜者 +1 分，分数跨局保留

---

## 本地预览

静态页面不能直接双击打开（浏览器的模块加载和跨域限制会拦），必须用 HTTP 服务。

```bash
cd duihua
python -m http.server 8124
```

浏览器打开 <http://127.0.0.1:8124/>。

想在电脑上模拟两个人对打：开两个**无痕窗口**分别打开首页和分享链接。普通标签页会共用 localStorage，两个窗口会被认成同一个玩家。

调试模式：在 URL 加 `?debug=1`，`window.__duihua` 会暴露双方手牌和动作钩子。

---

## 测试

### 规则单测

```bash
cd duihua
node --test test/rules.test.mjs
```

覆盖：发牌确定性、压牌/接力/捡牌/塞牌合法性、补牌顺序、胜负时机、52 张守恒、随机对局必终止、快照校验。

### 端到端

先启动本地服务：

```bash
cd duihua
python -m http.server 8124
```

再开一个终端：

```bash
cd .dev
node e2e-duihua.mjs
```

e2e 会开两个隔离的浏览器上下文，走真实 MQTT，跑：

玩法弹窗 → 建房 → 链接加入 → 手牌展开 → 完整一局（约 100 步）→ 结算翻牌 → 再来一局 → 四种手机尺寸布局检查 → 刷新恢复 → 认输 → 控制台无报错。

依赖在 `.dev/package.json` 里（`puppeteer-core`），Chrome 路径写在脚本顶部。

---

## 部署到 GitHub Pages

> ⚠️ **不要用 Cloudflare / EdgeOne。** 国内网络下 `*.workers.dev` 会被 DNS 污染，
> `*.pages.dev` 会在 TLS 握手后被重置，EdgeOne 免费版只给带时效签名的临时域名。
> 实测可用的是 **GitHub Pages**。

### 1. 生成干净的部署目录

```powershell
cd duihua
powershell -NoProfile -ExecutionPolicy Bypass -File .\make-deploy.ps1
```

会在 `duihua/` 同级生成 `duihua-deploy/`，只包含运行时文件：

```
duihua-deploy/
├── index.html
├── styles.css
├── app.js
├── rules.js
├── manifest.webmanifest
├── icons/
│   ├── icon-180.png
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-maskable-512.png
│   └── icon.svg
└── vendor/mqtt.esm.js
```

### 2. 上传

1. <https://github.com/new> 新建仓库，名字填 `duihua`，选 **Public**
2. 仓库页点 **uploading an existing file**
3. 进入 `duihua-deploy` 文件夹，`Ctrl+A` 全选**里面的内容**，拖进上传框

> ⚠️ 最容易出错的一步：拖文件夹本身会多套一层目录，网址变成 `/仓库名/duihua-deploy/`，打开 404。
> 正确的是进入文件夹、全选里面的内容、再拖。

4. 确认根目录直接是 `index.html`，`icons/` 和 `vendor/` 是文件夹
5. **Commit changes**

### 3. 开启 Pages

**Settings → Pages**：

- Source: `Deploy from a branch`
- Branch: `main` + `/ (root)`
- Save

等 1～2 分钟，得到 `https://<用户名>.github.io/duihua/`。

### 4. 以后更新

改完源码后重新跑 `make-deploy.ps1`，把 `duihua-deploy` 里有变化的文件重新上传，提交后一分钟内生效。

---

## 它是怎么联机的

```
iPhone(流量) ─┐
              ├── WSS ──→ broker.emqx.io:8084 ──→ 只转发 JSON
Android(WiFi)─┘
        ↑
        └── 静态页面（GitHub Pages）
```

- **中转站**：`wss://broker.emqx.io:8084/mqtt`
- **主题**：`duihua/v1/<20 位房间号>`
- **没有后端**，规则、发牌、胜负判定全部在浏览器里跑

### 确定性发牌

`roomId` 就是随机种子：

```js
rng = mulberry32(fnv1a(roomId + ':' + round))
deck = shuffle(52 张, rng)
trump = SUITS[floor(rng() * 4)]
first = rng() < 0.5 ? 'host' : 'guest'
```

两端用同一个 `roomId + round` 推导出完全相同的牌局。因此：

- 「再来一局」只要双方本地 `round + 1`，**不需要广播新快照**
- 刷新后可以从 localStorage 恢复
- 不会出现两端发牌不一样

### 消息协议

| 类型 | 说明 |
|---|---|
| `hello` | 打招呼，建立对手身份 |
| `state` | 整盘快照（双方手牌 + 桌面 + 牌堆位置 + 比分 + rev） |
| `lead` / `beat` / `pickup` / `relay` / `stop` / `dump` | 玩家动作，带 `round` |
| `resign` | 认输 |
| `restart-req` / `restart-ack` | 再来一局请求 / 应答，带 `round` |
| `ping` | 心跳 |
| `full` | 房主拒绝第三个人（带 `to`，只踢目标） |

每条消息带 `from` + 单调递增 `seq`。

### 必须实现的 8 个机制

1. **SUBACK 之后再发 hello**：`subscribe` 回调成功后才打招呼
2. **允许 state 反向确立对手**：晚加入的一方错过 hello 也能从快照认人
3. **seq 去重**：收到 hello 时把该 sender 的 `lastSeq` 重置为 `-1`
4. **rev + (round, rev) 比较**：同局 rev 更大才采纳；同 rev 冲突以房主为准
5. **每 15 秒周期同步**：3 × 5s 心跳后推一次 hello + state
6. **visibilitychange 重连**：iOS 切后台会挂起 WebSocket
7. **5 秒心跳 / 14 秒判掉线**：MQTT keepalive 只能感知我和 broker，感知不到对方
8. **重启一局不广播新快照**：确定性发牌，双方本地 `round + 1`

### 本地持久化

每次动作后把 `{session, game}` 写入 localStorage。刷新、锁屏回来先本地恢复，再和对手快照按 `(round, rev)` 对齐。

### 防跨局串消息

动作和再来一局消息都带 `round`；接收端发现 `round` 不匹配直接丢弃，避免上一局的延迟消息打进新一局。

---

## 已知限制

1. **公共 MQTT 是共享资源**。房间号 20 位随机，猜不出来，但不是密码学意义上的安全。朋友之间够用。
2. **没有防作弊**。两端都是前端，手牌在客户端状态里；懂技术的人开控制台/抓包能看到对方手牌。UI 只显示自己的手牌，`?debug=1` 才会暴露双方手牌（仅供测试）。
3. **房主必须在线**。没有房主迁移；房主离开后房间就结束了。
4. **只支持两个人**。第三个人点链接会提示「房间已满」，不会把原来的客人踢掉。
5. **v1 不限时、不悔棋、不和棋**。认输立即生效。
6. **比分按房间累计**，离开房间后清空。
7. **没有 Service Worker**。页面本身需要联网加载；MQTT 也必须联网。

---

## 目录结构

```
duihua/
├── index.html              页面结构（首页 / 等待页 / 对局页）
├── styles.css              移动端样式
├── app.js                  联机协议 + 界面 + 状态机
├── rules.js                纯规则逻辑（发牌、动作、快照校验）
├── manifest.webmanifest    PWA
├── icons/                  图标 + 生成脚本
├── vendor/mqtt.esm.js      MQTT 客户端（本地化，不依赖 CDN）
├── test/rules.test.mjs     规则单测
├── make-deploy.ps1         生成干净的部署目录
└── README.md
```

开发测试在仓库根目录的 `.dev/`：

```
.dev/
├── e2e-duihua.mjs          对花端到端测试
├── smoke-duihua.mjs        快速双端冒烟
├── layout-check.mjs        五子棋的布局检查（可参考）
└── package.json            puppeteer-core
```

---

## 可调参数

`app.js` 顶部：

```js
const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const PING_MS = 5000;              // 心跳间隔
const PEER_TIMEOUT_MS = 14000;     // 多久没消息算掉线
const REQUEST_TIMEOUT_MS = 20000;  // 再来一局请求超时
```

`rules.js` 顶部：

```js
export const HAND_LIMIT = 10;      // 补牌上限
export const INITIAL_HAND = 10;    // 初始手牌
export const DECK_SIZE = 52;
```

主花色、先手、发牌都由 `roomId + round` 推导，不需要手动配置。
