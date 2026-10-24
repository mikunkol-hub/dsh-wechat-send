# dsh-wechat-send

让 DSH agent 向微信会话（群/私聊）**发送原生表情包**，并**自动收集、学习、共享表情**。

- 两个模型工具：`wechat_sticker_pool`（候选池，带描述标签）与 `wechat_send_sticker`（dry 预演 → 真发）；
- **插件驱动收集**（绕过 WeChatAgent 的自动收集）：桥接只通知新表情，本插件拉图、复用标签、导入共享池；
- **主动学习标签**：收集时无标签就调 GLM-4V-Flash 看图打标签（描述 + 情绪/用途标签），复用与学习一条链；
- **账号共享表情池**：池上限 50 张，满池由 DS（模型）看图评选保留，白名单会话（好友与群聊）共用；
- **配置防篡改**：关键配置内置安全基线，被改自动纠正，运行时兜底。

## 链路

```
微信收到表情
  → WeChatAgent 桥接（白名单校验后）通知 127.0.0.1:11232/collect（只通知，不处理字节）
  → dsh-wechat-send（本插件）拉 reader 图 → 查已有标签 / GLM 主动打标 → 导入共享池
  → 满 50 张自动触发 DS 评选保留

DSH agent 主动发图
  → wechat_sticker_pool 列出共享池候选（id + 描述 + 标签）
  → wechat_send_sticker 挑一张 → 桥接 127.0.0.1:11231/send-sticker
  → 白名单 / 发送开关 / 限额 / MediaOutbox 持久队列 → hook → 微信会话
```

## 工具

| 工具 | 说明 |
|---|---|
| `wechat_sticker_pool` | 列出某会话可发送的共享池表情候选（id + 描述 + 标签，最多 20 张） |
| `wechat_send_sticker` | 发送一张原生表情（`dry=true` 只预演；缺省真发，走桥接持久队列与送达确认） |

## 安装

1. 把本目录 link 进 profile：`node_modules` 建 junction + `package.json` 的 `dependencies` 加
   `"dsh-wechat-send": "link:<本目录绝对路径>"`，`dsh.profile.bundles` 加 `"dsh-wechat-send"`。
2. 重启 DSH 让 bundle 组装生效。

## 配置（cordis.patch.yml）

| 键 | 缺省 | 说明 |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:11231` | 桥接受控发送端点 |
| `tokenFile` | `D:/WeChatAgent/data/workspace/state/social-dsh-token.txt` | 桥接鉴权 token（与 DSH 侧插件共用） |
| `timeoutMs` | `15000` | 单次 HTTP 超时 |
| `readerUrl` | `http://127.0.0.1:5031` | WeChatAgent reader 服务（拉图 / 导入共享池） |
| `readerTokenFile` | `D:/WeChatAgent/data/workspace/state/wechat-io-config.json` | reader 鉴权 token（读其中的 reader_token） |
| `collectPort` | `11232` | 本插件收集通知监听端口（仅回环） |
| `allowedKeys` | 好友与群白名单 | 允许发送与收集的会话（基线条目不可被移除） |

## 表情池

- 池存储：`E:\Deep Seek\表情池`（可配 `poolDir`，在 WeChatAgent 侧）；
- 上限 50 张，满池由 **DS 看图评选**保留（预览拼图 + 标签 + 使用次数）；
- 标签双通道：插件收集时 GLM 主动打标 + 微信会话顺带学习，两者复用同一标签库。

## 安全约定

- 收集端点只回环（127.0.0.1）、只收白名单会话、串行处理、去重；
- 发送 id 必须来自 `wechat_sticker_pool`；桥接侧不绕白名单/限额/送达确认；
- 发送是真实对外动作：先 dry 预演再真发；
- 配置防篡改：关键项内置基线，被改自动备份恢复；白名单只可增不可删。

## 许可证

MIT
