# EQ alert on GitHub Actions

Free, 24/7 earthquake alert with no server. A scheduled workflow runs every
5 minutes, reads the public P2PQuake history API, applies the same filter as the
local monitor, and posts to the Feishu bot.

| | |
| --- | --- |
| Source | P2PQuake `/history` (`551` 地震情報, `556` 緊急地震速報（警報）) |
| Trigger | 震度5弱以上 **or** M > 6.0 |
| Excluded | 訓練報, 試験報, キャンセル報, 第2報以降 |
| Dedupe | one alert per quake, keys cached between runs for 7 days |
| Delay | up to ~5 minutes (GitHub's cron minimum), sometimes longer under load |
| Cost | free for public repos; private repos use the 2,000 min/month Actions quota (~150 min/month here) |

## Setup

1. Create an empty GitHub repository (private is fine) and push this folder:

   ```bash
   cd alerts/gh-action
   git init
   git add .
   git commit -m "feat: earthquake alert action"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. In the repository: **Settings → Secrets and variables → Actions → New repository secret**

   | Name | Value |
   | --- | --- |
   | `FEISHU_WEBHOOK` | the bot's webhook URL (`https://open.feishu.cn/open-apis/bot/v2/hook/...`) |
   | `FEISHU_SECRET` | the bot's 签名校验 secret |

   Weak alternatives: set only `FEISHU_WEBHOOK` if the bot uses a keyword
   instead of a signature (the alert text always starts with 「🚨 地震アラート」,
   so the keyword `地震` matches).

3. **Actions → EQ alert → Run workflow** to test immediately. The run log shows
   `messages=… alerts=… keys=…`.

Scheduled runs start within a few minutes of enabling; GitHub disables schedules
after 60 days without repository activity — the cache saves count, but a manual
dispatch or any commit keeps it alive.

## Local check

```bash
node poll.mjs --dry-run
```

Prints the alerts that would be sent, without touching state or Feishu.

## Why not X / 妙搭

- X search needs an authenticated session; the cloud has none, and the official
  API's search is paid.
- 妙搭's automation cron floor is 30 minutes and its runtime is FaaS (no
  long-lived process), so it cannot watch a feed continuously.
