# dsh-win-toast-notify

DeepSeek Harness（`dsh`）每完成一轮对话，就弹一条 Windows 原生通知——你可以放心把窗口切走。

```
任务完成 · 修复登录跳转
改了中间件，补了两个回归测试，41 个用例全过。
DeepSeek Harness · 用时 4 分 12 秒
```

第一行是结束原因加会话标题，第二行是本轮最终回复的摘要，第三行是来源和耗时。

## 环境要求

- Windows 10 / 11。通知走系统自带的 WinRT 接口，由 Windows PowerShell 调用——没有原生模块、没有构建步骤、没有安装脚本。
- 会发出 `session/event` 事件流、包含 `turn/end` 的 Harness 版本（dsh 0.2.x）。
- 通知所属应用的通知开关是打开的；专注助手 / 免打扰会像其它通知一样把它压掉。

## 安装

```sh
dsh plugin add dsh-win-toast-notify
```

也可以在 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场里一键安装。如果你的版本不会热加载插件行，重启 Harness 后生效。

## 什么时候会弹

Host 半边订阅每个 Session 的持久事件流，只对 `turn/end` 作出反应：

| `turn/end` 原因 | 默认是否通知 |
| --- | --- |
| `completed` | 是——「任务完成」 |
| `error` | 是——「任务出错」 |
| `blocked` | 是——「任务受阻」 |
| `max-tokens` | 是——「输出达到上限」 |
| `interrupted` | 是——「任务被中断」 |
| `aborted`（你点了停止） | 否 |
| `forked` | 否 |

子代理会话默认跳过，一轮并发分发不会按子任务逐个响。

## 配置

改 profile 补丁里这条行的 `config`（或插件设置卡片），然后重启：

```yaml
- id: dsh-win-toast-notify
  name: dsh-win-toast-notify
  config:
    enabled: true                 # 总开关
    reasons: [completed, error]   # 哪些结束原因要通知
    includeSubagents: false       # 是否也通知子会话
    previewChars: 160             # 摘要长度
    sound: true                   # 是否播放默认提示音
    titlePrefix: DeepSeek Harness # 第三行前缀
    showSessionTitle: true        # 关掉则用工作目录名
    appId: ''                     # 覆盖通知的 AppUserModelID（留空=自动）
    powershell: ''                # 覆盖通知进程的可执行文件
```

## 实现说明

- **只读观察者。** 插件订阅 `session/event`，只在内存里记本轮开始时间和最后一段 assistant 文本；不追加任何事件、不写文件，fork / resume / replay 完全不受影响。
- **纯 Host 侧。** 没有 Client 模块、没有 DOM、没有 iframe：通知由 Host 发出，所以网页切到后台标签页或关掉照样会弹。
- **通知投递。** `notify()` 拼一条 ToastGeneric XML，用 `powershell.exe -EncodedCommand`（UTF-16LE + Base64）调 WinRT `Windows.UI.Notifications`，所以中文、引号、换行都不会破坏命令行。
- **应用身份。** 桌面版的开始菜单快捷方式存在时，通知以 `com.deepseek.dsh` 发出，显示为 DeepSeek Harness；纯 `dsh web` 或命令行安装里这个 AUMID 没注册，Windows 会静默丢弃，此时插件自动回退到 Windows PowerShell 的 AUMID。
- **不 detach。** 通知进程作为 Host 的子进程存活，约一秒后自行退出。被作业对象接管的分离进程会被连带结束，通知反而丢掉。

## 限制

- 仅 Windows。其它平台插件能加载但什么也不做。
- 通知归属于 AUMID 对应的应用；走回退时，在通知中心里显示为 Windows PowerShell。
- 摘要按纯文本处理：代码块、链接、强调、行内代码都会被抹掉。

## 许可证

MIT
