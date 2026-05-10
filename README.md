# Domino's Taiwan Autonomous Ordering Agent

AI-powered agent that autonomously orders pizza from Domino's Taiwan (dominos.com.tw) based on natural language prompts. Uses **StraitsX MCP virtual card** for payment — card details are retrieved at checkout time via the `view_virtual_card` tool.

## Quick Start

```bash
git clone <repo-url> && cd dominos-agent
npm install
npm run setup          # installs Chromium for Playwright
cp .env.example .env   # edit with your credentials
npm run test:delivery  # run a test order (no payment submitted)
```

## Usage

```bash
# Natural language prompt (card filled but NOT submitted by default)
node order.mjs '4人份、無海鮮、NT$1500以下、要可樂+副餐'

# Submit payment for real (money moves!)
node order.mjs '2人份、想吃雞肉口味、預算800元、外帶' --submit

# Pre-configured test scenarios
npm run test:pickup      # 2 people, chicken, NT$800, pickup
npm run test:delivery    # 4 people, seafood, NT$1000-1500, delivery, noon
npm run test:budget      # 1 person, anything, under NT$500
npm run test:vegetarian  # 3 people, vegetarian, NT$1200, with drink
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Natural Language Prompt                                         │
│  "4人份、海鮮口味、介於NT1000到NT1500、可樂+副餐、中午外送"       │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  1. Parse Constraints                                            │
│     people=4, budget=[1000,1500], wantSeafood, wantCola,         │
│     wantSide, isDelivery, isLunch(12:00)                         │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  2. Store Selection (delivery or pickup, open or closed/預約)     │
│     → Auto-selects time closest to desired hour                  │
│     → Handles store-closed with fallback to pickup               │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  3. Dynamic Menu Scan                                            │
│     → Reads ALL pizza items + prices from live page              │
│     → Filters by constraints (seafood/chicken/veg/budget)        │
│     → Randomized selection (different each run!)                 │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  4. Add to Cart + Checkout                                       │
│     → Adds pizzas, cola, side dish                               │
│     → Fills contact info, selects credit card payment            │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  5. StraitsX MCP → Payment Gateway                               │
│     → Calls view_virtual_card via JSON-RPC                       │
│     → Opens card in visible tab (demo/audit)                     │
│     → Extracts card number, expiry, CVV from iframe              │
│     → Fills Paydollar payment form                               │
│     → Submits only with --submit flag                            │
└──────────────────────────────────────────────────────────────────┘
```

## Supported Constraints

| Constraint | Keywords | Example |
|-----------|----------|---------|
| People | N人, N個人, 一~十 | 4人份, 三個人 |
| Budget max | N元/以下/NT$ | NT$1500以下 |
| Budget range | 介於X到Y | 介於NT1000到NT1500 |
| Seafood (want) | 海鮮 | 其中一個要有海鮮口味 |
| No seafood | 無海鮮/過敏 | 無海鮮（過敏） |
| Chicken | 雞肉 | 想吃雞肉口味 |
| Vegetarian | 素食/蔬菜 | 素食 |
| Cola/drink | 可樂/飲料 | 要可樂 |
| Side dish | 副餐/副食 | 要副餐 |
| Delivery | 外送/送到 | 外送到信義區 |
| Pickup | 外帶 | 外帶 |
| Lunch | 中午/午/12 | 明天中午12點 |
| Dinner | 晚/傍晚/18-20 | 傍晚6點 |

## StraitsX MCP Integration

The agent calls `view_virtual_card` via JSON-RPC at payment time:

```
POST https://card.straitsx.ai/mcp
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "view_virtual_card",
    "arguments": {
      "passphrase": "<from .env>",
      "card_opaque_id": "<from .env>",
      "settlement_tx": "<from .env>"
    }
  }
}
```

Response contains an `iframe_url` with card details. The agent:
1. Opens the card in a visible browser tab (for demo recording/audit)
2. Extracts card number, expiry (MM/YY), and CVV from the iframe
3. Fills the Paydollar payment gateway form

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CARD_MCP_URL` | Yes | StraitsX MCP endpoint |
| `CARD_PASSPHRASE` | Yes | Passphrase for view_virtual_card |
| `CARD_OPAQUE_ID` | Yes | Card opaque ID |
| `CARD_SETTLEMENT_TX` | Yes | Settlement transaction hash |
| `USER_NAME` | Yes | Name for checkout (Chinese) |
| `USER_PHONE` | Yes | Phone for checkout (09xxxxxxxx) |
| `USER_EMAIL` | Yes | Email for checkout |
| `INVOICE_CARRIER` | No | Taiwan e-invoice carrier ID |

## Reliability

### Structured Prompts

| Scenario | Items Ordered | Total | Result |
|----------|--------------|-------|--------|
| 4人 海鮮 NT$1000-1500 可樂+副餐 外送 | 蟹肉鮮蝦沙拉, 超級美國, 香烤雞條, 1.25L可樂 | NT$1,070 | PASS |
| 2人 雞肉 NT$800 外帶 | 奶油白醬烤雞 | NT$630 | PASS |
| 1人 隨便 NT$500 外帶 | 薄脆金鑽夏威夷小披薩 | NT$485 | PASS |
| 3人 素食 NT$1200 要飲料 | 小農田園鮮蔬, 小農番茄瑪格麗特, 1.25L可樂 | NT$655 | PASS |
| 4人 無海鮮（過敏）NT$1500 可樂+副餐 外帶 | 超級墨西哥, 小農田園鮮蔬, 香烤雞條, 1.25L可樂 | NT$785 | PASS |
| 5人 無海鮮+雞肉 NT$1500-2500 可樂+副餐 傍晚外帶 | 奶油白醬烤雞, BBQ雞肉, BBQ雞肉(火山), 香烤雞條, 1.25L可樂 | NT$1,495 | PASS |
| 6人 無海鮮 NT$2000 飲料+副餐 外帶 | 超級墨西哥, 肉魔王四喜, 極致蒜香壽喜牛, 香烤雞條, 1.25L可樂 | NT$1,465 | PASS |

### Natural Language Prompts (真人口語)

| Prompt | Items Ordered | Total | Result |
|--------|--------------|-------|--------|
| 今天晚餐想吃披薩，我們家三個人，不要太貴大概一千塊左右就好，幫我訂外帶 | 超級墨西哥, 超級美國 | NT$660 | PASS |
| 老婆說想吃有蝦子的披薩，再加一個雞肉的，順便幫我帶兩瓶可樂，預算抓兩千以內，外帶 | 蟹肉鮮蝦沙拉, 1.25L可樂 | NT$675 | PASS |

### Edge Cases Handled

- Store closed → automatic time selection (預約) matching desired hour
- Delivery fails → fallback to pickup
- Budget minimum not met → swap cheapest pizza for pricier option (BOGO-aware)
- Dessert pizzas excluded for 3+ people (not a real meal)
- Randomized pizza/drink/side selection ensures different orders each run
- React Native Web overlay workaround for Pressable elements
- Domino's BOGO discount (~50% off 2nd+ pizza) factored into budget estimation
- noSeafood constraint enforced on both pizzas AND side dishes
- Chinese numeral budget parsing (兩千, 一千五, etc.)
- Natural language seafood keywords (蝦子, 龍蝦, 蟹, etc.)

## Architecture

```
dominos-agent/
├── order.mjs              # Main orchestrator (site-agnostic logic)
├── adapters/
│   ├── interface.mjs      # Adapter contract (what each site must implement)
│   ├── dominos-tw.mjs     # Domino's Taiwan (reference implementation)
│   └── pizzahut-tw.mjs    # Pizza Hut Taiwan (stub — extensibility demo)
├── .env.example           # Credential template
├── Dockerfile             # Containerized execution
└── package.json           # Pinned deps, test scripts
```

**Core (site-agnostic):**
- **parsePrompt()** — NLP constraint extraction (Chinese + digits + budget ranges)
- **pickPizzas()** — Budget-aware, constraint-filtered, randomized selection
- **MCP integration** — StraitsX `view_virtual_card` at payment time

**Adapters (site-specific):**
Each site adapter implements: `selectStore`, `scanMenu`, `addToCart`, `addExtra`, `checkout`, `reachPaymentGateway`, `fillCard`

Currently `order.mjs` contains the full Domino's implementation inline. To add a new site:
1. Copy `adapters/pizzahut-tw.mjs`
2. Implement each method with the site's DOM selectors
3. The core constraint parsing + MCP card retrieval is reusable

## License

MIT
