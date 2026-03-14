# 🛒 Restock

> An intelligent Telegram bot that learns your Swiggy Instamart grocery habits and automatically adds items to your cart when you're running low.

---

## How It Works

1. **Connects** to your Swiggy Instamart account via the official [Swiggy MCP Server](https://github.com/Swiggy/swiggy-mcp-server-manifest)
2. **Analyzes** your last 20 order's full details to detect recurring grocery items and brand preferences using AI (Gemini or Claude)
3. **Tracks** when each item is expected to run out based on your consumption frequency
4. **Alerts** you every morning via Telegram and adds the due items directly to your Swiggy Instamart cart
5. **You checkout** — the bot never places orders on your behalf. You always have the final say.

---

## Features

- 🔒 **Strictly Private** — Only responds to your personal Telegram account (allowlist by user ID)
- 🧠 **Brand-Aware** — Remembers exactly which brands you prefer (e.g., Amul Taaza, not just "Milk") and only suggests alternatives if your preferred brand is unavailable
- 🛡️ **Human-in-the-Loop** — Adds items to your cart and notifies you with a checkout link. Never places COD orders automatically
- 📅 **Smart Scheduling** — Uses AI to infer consumption frequency from historical data (e.g., "You order milk every 3 days")
- 🎛️ **Interactive UI** — Rich inline button menus for easy navigation and robust HTML message formatting to prevent crashes
- ☁️ **Cloud-Ready** — Deploy for free on Render + Firebase

---

## Tech Stack

| Component | Technology |
|---|---|
| Bot Interface | [Telegraf](https://telegraf.js.org/) (Telegram Bot) |
| Swiggy Integration | [Swiggy MCP Server](https://github.com/Swiggy/swiggy-mcp-server-manifest) + `@modelcontextprotocol/sdk` |
| AI Pattern Analysis | [Gemini 2.0 Flash](https://aistudio.google.com) / [Anthropic Claude 3.5](https://anthropic.com) |
| Database | [Firebase Firestore](https://firebase.google.com) |
| Server | [Express.js](https://expressjs.com) |
| Hosting | [Render](https://render.com) (Free tier) |
| Cron | [cron-job.org](https://cron-job.org) (Free tier) |

---

## Project Structure

```
restock-bot/
├── index.js          # Express server entry point (webhook + cron endpoint)
├── bot.js            # Telegram bot logic (commands + login flow)
├── cron.js           # Daily restock checker (searches & adds to cart)
├── mcp_client.js     # Swiggy Instamart MCP client
├── pattern_engine.js # AI order history analyzer
├── agent_brain.js    # Conversational agent logic & tool orchestration
├── llm_provider.js   # Multi-vendor LLM wrapper (Gemini/Claude)
├── db.js             # Firebase Firestore wrapper
├── .env.sample       # Environment variable template
└── .gitignore
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Interactive welcome menu (Analyze, Restock Check, Address Change) |
| `/login` | Authenticate with your Swiggy account |
| `/address` | List and select your preferred delivery address |
| `/analyze` | Fetch and analyze your last 20 orders to build a restock schedule |
| `hi`, `hello` | Natural language greetings also trigger the interactive menu |

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- A [Telegram account](https://telegram.org)
- A [Google Gemini account](https://aistudio.google.com) (Free) OR [Anthropic account](https://console.anthropic.com)
- A [Firebase project](https://console.firebase.google.com) (Free tier)

### 1. Clone the repo

```bash
git clone https://github.com/soumyadeb1809/restock-ai.git
cd restock-ai
npm install
```

### 2. Set up environment variables

```bash
cp .env.sample .env
```

Fill in your `.env` (see the table below for where to get each value):

| Variable | How to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Message `@BotFather` on Telegram → `/newbot` |
| `TELEGRAM_ALLOWED_USER_ID` | Message `@userinfobot` on Telegram |
| `LLM_PROVIDER` | `gemini` (Recommended-Free) or `anthropic` |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → API Keys |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Firebase Console → Project Settings → Service Accounts → Generate new private key |
| `CRON_SECRET` | Any random secure string you create |

### 3. Run locally

```bash
npm start
```

The bot runs in **long-polling mode** locally (no webhook needed). Open Telegram, find your bot, and type `/start`.

---

## Deployment (Render + Firebase)

### Render

1. Go to [render.com](https://render.com) → **New Web Service** → connect your GitHub repo
2. Set **Build Command**: `npm install`
3. Set **Start Command**: `npm start`
4. Add all environment variables from `.env.sample` (use `FIREBASE_SERVICE_ACCOUNT_BASE64` instead of the file path on Render)
5. Deploy — Render auto-sets `RENDER_EXTERNAL_URL` which switches the bot into **webhook mode** automatically

### Firebase (for Render)

Encode your service account JSON as a base64 string:
```bash
cat firebase-service-account.json | base64 | tr -d '\n' | pbcopy
```
Paste the result as `FIREBASE_SERVICE_ACCOUNT_BASE64` in Render's environment variables.

### Daily Cron (cron-job.org)

Create a free cron job on [cron-job.org](https://cron-job.org) that runs every day at 9 AM:
```
GET https://your-app.onrender.com/run-daily-check?key=YOUR_CRON_SECRET
```

---

## Authentication Flow (Mobile)

Since Swiggy's OAuth only allows `http://localhost/callback` as a redirect URI, the login flow works like this:

1. Type `/login` in the bot
2. Click the Swiggy login link → log in on your mobile browser
3. You'll see a "Site can't be reached" error — **this is expected!**
4. Copy the entire URL from your browser's address bar (it starts with `http://localhost/callback?code=...`)
5. Paste it back to the bot — it captures the auth code and saves it securely to Firebase

---

## Security

- **Private by design** — The bot silently drops messages from any user ID other than `TELEGRAM_ALLOWED_USER_ID`
- **No auto-checkout** — The bot adds items to your cart but never calls Swiggy's checkout/payment tools
- **Secrets management** — Auth tokens are stored in Firebase with strict security rules, never in code
- **Cron protection** — The `/run-daily-check` endpoint requires a `CRON_SECRET` key

---

## Important Notes

- ⚠️ Keep the Swiggy app **closed** while the bot is running to avoid session conflicts
- 🔄 Swiggy auth tokens may expire — if the bot can't connect, just type `/login` again
- 💳 Swiggy Instamart currently only supports **COD** for programmatic orders, so always review your cart before checking out

---

## License

MIT
