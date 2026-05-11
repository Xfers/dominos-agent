# Domino's Taiwan Autonomous Ordering Agent

AI-powered agent that autonomously orders pizza from Domino's Taiwan (dominos.com.tw) based on natural language prompts in **Chinese or English**. Uses **StraitsX MCP virtual card** for payment — card details are retrieved at checkout time via the `view_virtual_card` tool.

## Quick Start

```bash
git clone https://github.com/Xfers/dominos-agent.git && cd dominos-agent
npm install
npm run setup          # installs Chromium for Playwright
cp .env.example .env   # edit with your credentials
node order.mjs '2人份、想吃雞肉口味、預算800元、外帶'
```

## Usage

```bash
# Natural language prompt (card filled but NOT submitted by default)
node order.mjs '4人份、無海鮮、NT$1500以下、要可樂+副餐'

# English works too
node order.mjs 'Order for 4, seafood, budget $1500, with coke and sides, pickup'

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
│     → Adds pizzas, drinks (from menu), side dish                 │
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
│     → Waits up to 90s for 3DS auto-approval                     │
└──────────────────────────────────────────────────────────────────┘
```

## Supported Constraints

| Constraint | Chinese | English | Example |
|-----------|---------|---------|---------|
| People | N人, N個人, 一~十 | N people, for N, feed N | 4人份, feed 6 |
| Budget max | N元/以下/NT$ | under/below/max $N | NT$1500以下, under $800 |
| Budget range | 介於X到Y | between X to Y | 介於NT1000到NT1500 |
| Seafood (want) | 海鮮/蝦/蟹 | seafood/shrimp/crab | 想吃海鮮 |
| No seafood | 無海鮮/過敏 | no seafood/allergy | 無海鮮（過敏） |
| Chicken | 雞肉 | chicken | 想吃雞肉口味 |
| Vegetarian | 素食/蔬菜 | vegetarian/veggie | 素食 |
| Cola/drink | 可樂/飲料 | cola/coke/drink | 要可樂, with drinks |
| Side dish | 副餐/副食 | side/sides/appetizer | 要副餐, with sides |
| Delivery | 外送/送到 | deliver | 外送到信義區 |
| Pickup | 外帶 | pickup | 外帶 |
| Lunch | 中午/午/12 | lunch/noon | 明天中午12點 |
| Dinner | 晚/傍晚/18-20 | dinner/evening | 傍晚6點 |
| Multi-pizza | 再加一個/兩個披薩 | another/2 pizzas | 再加一個雞肉的 |
| Multi-drink | 兩瓶/三杯 | 2 bottles/3 cans | 帶兩瓶可樂 |

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
4. With `--submit`: waits up to 90s for 3DS auto-approval by StraitsX

Full MCP response is logged to console for debugging.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CARD_MCP_URL` | Yes | StraitsX MCP endpoint |
| `CARD_PASSPHRASE` | Yes | Passphrase for view_virtual_card |
| `CARD_OPAQUE_ID` | Yes | Card opaque ID (identifies which card to view) |
| `CARD_SETTLEMENT_TX` | Yes | Settlement transaction hash (proves funding) |
| `USER_NAME` | Yes | Name for checkout (Chinese) |
| `USER_PHONE` | Yes | Phone for checkout (09xxxxxxxx) |
| `USER_EMAIL` | Yes | Email for checkout |
| `INVOICE_CARRIER` | No | Taiwan e-invoice carrier ID |

## Verified Test Results

All tests run end-to-end: store selection → menu scan → cart → checkout → payment gateway → card filled. Items are **randomized** each run (different pizzas, drinks, sides) while satisfying all constraints.

### Chinese Prompts

| # | Prompt | Items Ordered | Total | Verdict |
|---|--------|--------------|-------|---------|
| 1 | 今天晚餐想吃披薩，我們家三個人，不要太貴大概一千塊左右就好，幫我訂外帶 | 奶油白醬烤雞, 小農田園鮮蔬 | NT$965 | PASS — 2 pizzas for 3人, ≤$1000, pickup ✓ |
| 2 | 老婆說想吃有蝦子的披薩，再加一個雞肉的，順便幫我帶兩瓶可樂，預算抓兩千以內，外帶 | 日式章魚燒, 奶油白醬烤雞, 1.25L可樂 ×2 | NT$1,105 | PASS — seafood+chicken pizza ✓, 2 drinks ✓, ≤$2000 ✓ |
| 3 | 4人份、其中一個要有海鮮口味、金額要介於NT1000到NT1500、必須買可樂跟隨便一個副餐、明天中午12點外送到預先指定的地址 | 蟹肉鮮蝦沙拉, 超級美國, 香烤雞條, 1.25L可樂 | NT$1,070 | PASS — seafood ✓, side ✓, drink ✓, $1000-1500 ✓, delivery ✓ |
| 4 | 5人份、無海鮮、想吃雞肉、金額要介於NT1500到NT2500、必須買可樂跟副餐、傍晚6點外帶 | 奶油白醬烤雞, BBQ雞肉, BBQ雞肉(火山), 玉米濃湯2杯, 1.25L可樂 | NT$1,500 | PASS — 3 chicken pizzas ✓, no seafood ✓, side ✓, drink ✓, ≥$1500 ✓ |
| 5 | 4人份、無海鮮（過敏）、預算NT$1500以下、要可樂+副餐、外帶 | 在地食鮮總匯, 奶油白醬烤雞, 香烤雞條, 1.25L可樂 | NT$1,065 | PASS — no seafood ✓, side ✓, drink ✓, ≤$1500 ✓ |

### English Prompts

| # | Prompt | Items Ordered | Total | Verdict |
|---|--------|--------------|-------|---------|
| 6 | Order pizza for 4 people, seafood, budget under NT$1500, with coke and sides, pickup | 蟹肉鮮蝦沙拉, 超級美國, 香烤雞條, 1.25L可樂 | NT$1,190 | PASS — seafood ✓, side ✓, drink ✓, ≤$1500 ✓ |
| 7 | Feed 2, chicken flavor, $800 max, pickup | 奶油白醬烤雞 | NT$630 | PASS — chicken ✓, ≤$800 ✓ |
| 8 | Pizza night! 6 people, no seafood allergy, under $2000, with drinks and sides | 超級墨西哥, 肉魔王四喜, 極致蒜香壽喜牛, 香烤雞條, 1.25L可樂 | NT$1,465 | PASS — 3 pizzas for 6人 ✓, no seafood ✓, side ✓, drink ✓, ≤$2000 ✓ |
| 9 | Dinner for 5, between NT1500 to NT2500, no shrimp, want chicken, with drinks | 極致蒜香壽喜牛, BBQ雞肉, BBQ雞肉(火山), 1.25L可樂 | NT$1,180 | PARTIAL — chicken ✓, no seafood ✓, drink ✓, ≤$2500 ✓, but actual total below $1500 min (see note) |
| 10 | 3 people, vegetarian, no seafood, under 1200, with drinks | 小農田園鮮蔬, 白醬彩蔬, 1.25L可樂 | NT$680 | PASS — vegetarian ✓, no seafood ✓, drink ✓, ≤$1200 ✓ |

### Notes on Test #9

The agent correctly plans 3 pizzas with estimated total NT$1,590 (above budgetMin $1,500). However, Domino's live BOGO promotions sometimes discount more aggressively than our 50% estimate (e.g., buy-2-get-1-free deals), resulting in an actual total of NT$1,180. This is a known limitation: **budgetMin is enforced at planning time** based on menu prices, but actual checkout totals depend on live promotions that vary by day/time.

### Constraint Verification Matrix

| Test | People | Budget | Flavor | Drink | Side | Time | Mode | Result |
|------|--------|--------|--------|-------|------|------|------|--------|
| 1 | 3 | ≤1000 | any | - | - | dinner | pickup | ✓ |
| 2 | 2 | ≤2000 | seafood+chicken | ×2 | - | - | pickup | ✓ |
| 3 | 4 | 1000-1500 | seafood | ×1 | ✓ | noon | delivery | ✓ |
| 4 | 5 | 1500-2500 | chicken, no seafood | ×1 | ✓ | dinner | pickup | ✓ |
| 5 | 4 | ≤1500 | no seafood | ×1 | ✓ | - | pickup | ✓ |
| 6 | 4 | ≤1500 | seafood | ×1 | ✓ | - | pickup | ✓ |
| 7 | 2 | ≤800 | chicken | - | - | - | pickup | ✓ |
| 8 | 6 | ≤2000 | no seafood | ×1 | ✓ | - | pickup | ✓ |
| 9 | 5 | 1500-2500 | chicken, no seafood | ×1 | - | dinner | pickup | ⚠️ |
| 10 | 3 | ≤1200 | vegetarian | ×1 | - | - | pickup | ✓ |

### Edge Cases Handled

- **Store closed** → automatic time selection (預約) matching desired hour
- **Delivery fails** → fallback to pickup
- **Budget minimum not met** → 3-strategy upgrade: swap cheapest pizza → add extra pizzas → allow duplicates (BOGO-aware, +5% buffer)
- **Dessert pizzas excluded** for 3+ people (not a real meal)
- **Randomized selection** — pizza, drink, and side are all randomized each run
- **React Native Web overlay** workaround for Pressable elements (Domino's uses RNW)
- **Pizza click retry** — if modal doesn't open on first click, retries with coordinate-based click
- **Domino's BOGO discount** (~50% off 2nd+ pizza) factored into budget estimation
- **noSeafood enforced** on both pizzas AND side dishes
- **Chinese numeral parsing** — 兩千, 一千五, 三個人, etc.
- **Multi-drink support** — navigates to drinks menu for 2nd+ drinks (upsell cards disappear after first add)
- **Explicit pizza count** — "再加一個雞肉的" correctly orders 2 pizzas
- **3DS auto-approval** — waits up to 90s for StraitsX 3DS verification
- **MCP response logging** — full JSON-RPC response printed for debugging

## Architecture

```
dominos-agent/
├── order.mjs              # Main orchestrator (~1000 lines)
│   ├── parsePrompt()      # NLP constraint extraction (CN + EN)
│   ├── pickPizzas()       # Budget-aware, constraint-filtered, randomized
│   ├── addPizza()         # Navigate menu, click with retry, select size, add
│   ├── Store selection    # Delivery/pickup, open/closed handling
│   ├── Checkout           # Contact fill, side/drink from suggestions
│   └── Payment            # MCP card retrieval, Paydollar form fill, 3DS wait
├── adapters/
│   ├── interface.mjs      # Adapter contract (extensibility)
│   ├── dominos-tw.mjs     # Domino's Taiwan (reference)
│   └── pizzahut-tw.mjs    # Pizza Hut Taiwan (stub)
├── .env.example           # Credential template
├── Dockerfile             # Containerized execution
└── package.json           # Pinned deps (playwright 1.52.0)
```

**Key Design Decisions:**
- **Dynamic menu scanning** — reads live prices from DOM, not hardcoded
- **BOGO-aware budgeting** — 2nd+ pizzas estimated at 50% off for accurate budget checks
- **Randomization within constraints** — shuffles by price tier, picks randomly from valid options
- **MCP at payment time** — card details retrieved only when needed (secure, auditable)
- **No payment submission by default** — `--submit` flag required for real transactions
- **Retry with fallback** — pizza clicks retry up to 3× with coordinate-based fallback

## Running for Judges

```bash
# 1. Clone and setup
git clone https://github.com/Xfers/dominos-agent.git
cd dominos-agent
npm install && npm run setup

# 2. Configure credentials
cp .env.example .env
# Edit .env with your StraitsX card credentials and contact info

# 3. Run any test (browser opens, watch the automation)
node order.mjs '4人份、無海鮮、NT$1500以下、要可樂+副餐、外帶'

# 4. Observe:
#    - Store selection (pickup/delivery)
#    - Menu scanning (all pizzas + prices logged)
#    - Decision making (constraint satisfaction logged)
#    - Cart building (items added one by one)
#    - Checkout (contact filled, payment selected)
#    - MCP card retrieval (visible in 2nd tab)
#    - Payment form filled (NOT submitted without --submit)
```

The browser stays open 10 seconds after completion for visual inspection (30s with `--submit`). Screenshots are saved to `./screenshots/`.

## License

MIT
