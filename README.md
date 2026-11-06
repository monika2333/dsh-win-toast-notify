# dsh-win-toast-notify

Native Windows toast notification every time a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) turn finishes — so you can look away from the window while the agent works.

```
任务完成 · Fix the login redirect
Updated the middleware and added two regression tests; all 41 tests pass.
DeepSeek Harness · 用时 4 分 12 秒
```

Line 1 is the end reason plus the session title, line 2 is a preview of the turn's final reply, line 3 is where it came from and how long the turn took.

## Requirements

- Windows 10 or 11 (uses the built-in WinRT notification API through Windows PowerShell — no native module, no build step, no install script).
- A Harness build that emits the `session/event` feed with `turn/end` (dsh 0.2.x).
- Notifications enabled for the app the toast is posted under; Focus assist / Do not disturb suppresses it like any other notification.

## Install

```sh
dsh plugin add dsh-win-toast-notify
```

or install it from the [dsh-market](https://github.com/dsh-market/dsh-market) plugin browser. Restart Harness if your build does not reload plugin rows live.

## What triggers a toast

The Host half listens to each Session's durable event feed and reacts to `turn/end`:

| `turn/end` reason | Notified by default |
| --- | --- |
| `completed` | yes — "任务完成" |
| `error` | yes — "任务出错" |
| `blocked` | yes — "任务受阻" |
| `max-tokens` | yes — "输出达到上限" |
| `interrupted` | yes — "任务被中断" |
| `aborted` (you pressed Stop) | no |
| `forked` | no |

Subagent sessions are skipped by default so a fan-out does not ring once per child.

## Configuration

Edit the row's `config` in the profile patch (or the plugin's settings card), then restart:

```yaml
- id: dsh-win-toast-notify
  name: dsh-win-toast-notify
  config:
    enabled: true                 # master switch
    reasons: [completed, error]   # which end reasons notify
    includeSubagents: false       # also notify child sessions
    previewChars: 160             # length of the reply preview
    sound: true                   # play the default notification sound
    titlePrefix: DeepSeek Harness # third line prefix
    showSessionTitle: true        # fall back to the working-directory name when off
    appId: ''                     # override the toast's AppUserModelID (empty = auto)
    powershell: ''                # override the notifier executable
```

## How it works

- **Read-only observer.** The plugin subscribes to `session/event` and keeps only the turn's start time and its last assistant text in memory. It appends no events and writes no files, so fork, resume and replay are untouched.
- **Host-side only.** No Client module, no DOM, no iframe: the toast is raised by the Host, so it also fires when the Web GUI is in a background tab or closed.
- **Toast delivery.** `notify()` builds a ToastGeneric XML payload and runs `powershell.exe -EncodedCommand` (UTF-16LE + Base64) against the WinRT `Windows.UI.Notifications` API, so arbitrary text — Chinese, quotes, newlines — cannot break the command line.
- **App identity.** Toasts are posted under `com.deepseek.dsh` when the desktop app's Start-menu shortcut is present, which makes them appear as DeepSeek Harness. On a plain `dsh web` or CLI install that AUMID is unregistered and Windows drops the toast silently, so the plugin falls back to the Windows PowerShell AUMID instead.
- **No detaching.** The notifier process stays a child of the Host; it exits in about a second. A detached child can be reaped together with the job object that owns the Host, which loses the notification.

## Limitations

- Windows only. On other platforms the plugin loads and does nothing.
- The toast is attributed to whichever app the AUMID belongs to; with the fallback it shows as Windows PowerShell in Action Center.
- Preview text is plain text: Markdown fences, links, emphasis and inline code are stripped.

## License

MIT
