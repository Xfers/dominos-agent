import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';

// Load .env if present (no external dependency needed)
try {
  const envFile = readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch(e) {}

const SS = process.env.SCREENSHOT_DIR || './screenshots';
try { mkdirSync(SS, { recursive: true }); } catch(e) {}
const CARD_MCP_URL = process.env.CARD_MCP_URL || 'https://card.straitsx.ai/mcp';
const PASSPHRASE = process.env.CARD_PASSPHRASE || '';
const CARD_OPAQUE_ID = process.env.CARD_OPAQUE_ID || '';
const SETTLEMENT_TX = process.env.CARD_SETTLEMENT_TX || '';
const USER_NAME = process.env.USER_NAME || '';
const USER_PHONE = process.env.USER_PHONE || '';
const USER_EMAIL = process.env.USER_EMAIL || '';
const INVOICE_CARRIER = process.env.INVOICE_CARRIER || '';
const USER_ADDRESS = process.env.USER_ADDRESS || '信義區';

// Seafood keywords to avoid
const SEAFOOD_WORDS = ['海鮮', '鮪魚', '蝦', '鱈魚', '魷魚', '蟹', '干貝', '鮭魚', '章魚'];

// Parse prompt from CLI or use default
const PROMPT = process.argv[2] || '4人份、無海鮮（過敏）、NT$1500以下、必須買可樂+副餐';
const SUBMIT_PAYMENT = process.argv.includes('--submit');
console.log(`\nPrompt: "${PROMPT}"`);
if (SUBMIT_PAYMENT) console.log('⚠️  LIVE MODE: Payment will be submitted!');
console.log('');

// Extract constraints from prompt
function parsePrompt(prompt) {
  // Chinese numeral conversion
  const cnNum = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
  let people = 2;
  const pMatch = prompt.match(/(\d+)\s*(?:人|個人|people|person|pax)/) || prompt.match(/([一二三四五六七八九十])\s*(?:人|個人)/) || prompt.match(/(?:for|feed)\s*(\d+)/i);
  if (pMatch) people = parseInt(pMatch[1]) || cnNum[pMatch[1]] || 2;

  const budgetRange = prompt.match(/介於\s*NT?\$?(\d{3,5})\s*到\s*NT?\$?(\d{3,5})/) || prompt.match(/(?:between|from)\s*NT?\$?(\d{3,5})\s*(?:to|and|-|~)\s*NT?\$?(\d{3,5})/i);
  let budgetMin = 0, budget = 1500;
  if (budgetRange) {
    budgetMin = parseInt(budgetRange[1]);
    budget = parseInt(budgetRange[2]);
  } else {
    const digitBudget = prompt.match(/(\d{3,5})\s*(?:以下|元|塊)/) || prompt.match(/NT\$?(\d{3,5})/) || prompt.match(/(?:under|below|max|budget|within)\s*(?:NT)?\$?(\d{3,5})/i) || prompt.match(/\$(\d{3,5})\s*(?:budget|max|or less)/i) || prompt.match(/\$(\d{3,5})/);
    if (digitBudget) {
      budget = parseInt(digitBudget[1]);
    } else {
      const cnBudgetMap = {'一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
      const cnBudgetMatch = prompt.match(/([一二兩三四五六七八九])千([五])?/);
      if (cnBudgetMatch) {
        budget = (cnBudgetMap[cnBudgetMatch[1]] || 1) * 1000 + (cnBudgetMatch[2] ? 500 : 0);
      }
    }
  }
  // noSeafood only if explicitly avoiding (無海鮮, 不要海鮮, 海鮮過敏)
  const noSeafood = /無海鮮|不要海鮮|不能.*海鮮|海鮮.*過敏|過敏|no seafood|no shrimp|seafood allerg/i.test(prompt);
  const wantSeafood = !noSeafood && /海鮮|蝦|龍蝦|蟹|干貝|魷魚|章魚|seafood|shrimp|prawn|lobster|crab|scallop/i.test(prompt);
  const wantCola = /可樂|飲料|喝|cola|coke|drink|beverage/i.test(prompt);
  const wantSpecificCola = /可樂|cola|coke/i.test(prompt) && !/飲料|drink|beverage/i.test(prompt);
  const wantSide = /副餐|副食|side|sides|appetizer|snack|chicken wings|fries/i.test(prompt);
  const isDelivery = /外送|送到|deliver/i.test(prompt) && !/不允許|無法|blocked/.test(prompt);
  const isLunch = /午|中午|lunch|noon/i.test(prompt) || /(?:^|\D)12(?:點|時|:00|\b)/i.test(prompt);
  const isDinner = /晚|傍晚|dinner|evening/i.test(prompt) || /(?:^|\D)(18|19|20)(?:點|時|:00|\b)/i.test(prompt);
  const wantChicken = (/雞肉|雞|chicken/i.test(prompt)) && !/雞條|chicken wing/i.test(prompt);
  const wantVeg = /素食|蔬菜|vegetarian|veggie|veg/i.test(prompt);

  // Explicit pizza count: "再加一個X的" = at least 2, "兩個披薩" = explicit count
  let explicitPizzaCount = 0;
  const explicitPizzaMatch = prompt.match(/([兩三四五六七八九]|[2-9])\s*(?:個|片)?\s*(?:披薩|pizza)/i);
  if (explicitPizzaMatch) {
    explicitPizzaCount = parseInt(explicitPizzaMatch[1]) || ({'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9})[explicitPizzaMatch[1]] || 0;
  }
  if (!explicitPizzaCount && /再加一個|再來一個|another|plus one|add one/i.test(prompt)) {
    explicitPizzaCount = 2;
  }
  // "蝦子的...再加一個雞肉的" implies 2 different flavor requests
  if (!explicitPizzaCount && wantSeafood && wantChicken) {
    explicitPizzaCount = 2;
  }

  // Drink quantity: "兩瓶", "兩杯", "2 bottles"
  let drinkCount = 1;
  const drinkQtyMatch = prompt.match(/([兩三四五六]|[2-6])\s*(?:瓶|杯|罐|bottles?|cans?)/i);
  if (drinkQtyMatch) {
    drinkCount = parseInt(drinkQtyMatch[1]) || ({'兩':2,'三':3,'四':4,'五':5,'六':6})[drinkQtyMatch[1]] || 1;
  }

  return { people, budget, budgetMin, noSeafood, wantSeafood, wantCola, wantSpecificCola, wantSide, isDelivery, isLunch, isDinner, wantChicken, wantVeg, explicitPizzaCount, drinkCount };
}

const constraints = parsePrompt(PROMPT);
console.log('Constraints:', JSON.stringify(constraints, null, 2));

// ============================================================
// EXACT ORDER MODE: detect when user specifies exact items
// ============================================================
function parseExactOrder(prompt) {
  const cnNum = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12};
  const segments = prompt.split(/[、，]/);

  // Pizzas: "name + 大/小/中 + 的餅皮 + crust" or "name + 大/小/中 + 的"
  const pizzas = [];
  for (const seg of segments) {
    const m = seg.match(/(?:我要|要)?(.+?)(大|小|中)的(?:餅皮(.+))?/);
    if (m && m[1].length >= 2 && m[1].length <= 15) {
      pizzas.push({ name: m[1].trim(), size: m[2], crust: (m[3] || '').trim() });
    }
  }

  // Sides: after 副餐 keyword OR segments matching known side patterns
  const sides = [];
  const SIDE_PATTERNS = /雞翅|雞條|雞塊|薯球|薯餅|濃湯|烤翅|洋蔥圈|麵包球|起司球|雞米花|鱈魚星星|花枝丸|辣雞翅/;
  const sideSegIdx = segments.findIndex(s => s.includes('副餐'));
  if (sideSegIdx >= 0) {
    let sideText = segments[sideSegIdx].replace(/^.*副餐/, '').trim();
    sides.push(...sideText.split(/跟|和/).filter(s => s.length > 1));
    for (let i = sideSegIdx + 1; i < segments.length; i++) {
      if (/可樂|飲料|外送|外帶|優惠|禮拜|星期/.test(segments[i])) break;
      sides.push(...segments[i].split(/跟|和/).filter(s => s.length > 1));
    }
  }
  // Also catch side items that appear as standalone segments (not matched as pizza)
  for (const seg of segments) {
    const cleaned = seg.replace(/^(跟|和|再來|還要|加)/, '').trim();
    if (SIDE_PATTERNS.test(cleaned) && !sides.includes(cleaned)) {
      sides.push(cleaned);
    }
  }

  // Time: 禮拜X晚上Y點半
  let desiredDay = '', desiredHour = 0, desiredMinute = 0;
  const dayMap = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7};
  const timeMatch = prompt.match(/(禮拜|星期|週)([一二三四五六日天]).*?(?:晚上|下午|傍晚|上午|中午|早上)?([一二三四五六七八九十\d]+)[點時](半)?/);
  if (timeMatch) {
    desiredDay = timeMatch[2];
    desiredHour = parseInt(timeMatch[3]) || cnNum[timeMatch[3]] || 0;
    if (/晚上|傍晚|下午/.test(prompt) && desiredHour < 12) desiredHour += 12;
    if (timeMatch[4] === '半') desiredMinute = 30;
  }

  // Coupon: 自動套用優惠券
  const wantCoupon = /優惠券|優惠碼|coupon|自動套用/i.test(prompt);

  if (pizzas.length === 0) return null;
  return { pizzas, sides, desiredDay, desiredHour, desiredMinute, wantCoupon };
}

const exactOrder = parseExactOrder(PROMPT);
if (exactOrder) {
  console.log('\n*** EXACT ORDER MODE ***');
  console.log('Pizzas:', JSON.stringify(exactOrder.pizzas));
  console.log('Sides:', exactOrder.sides);
  if (exactOrder.desiredHour) console.log(`Time: 禮拜${exactOrder.desiredDay} ${exactOrder.desiredHour}:${String(exactOrder.desiredMinute || 0).padStart(2,'0')}`);
  if (exactOrder.wantCoupon) console.log('Coupon: will auto-apply');
  console.log('');
}

// Decide pizza count based on people (or explicit request)
function decidePizzaCount(people, explicitPizzaCount) {
  const byPeople = people <= 2 ? 1 : people <= 4 ? 2 : people <= 6 ? 3 : Math.ceil(people / 2);
  return Math.max(byPeople, explicitPizzaCount || 0);
}

// Pick pizzas from menu based on constraints
function pickPizzas(menuItems, constraints) {
  let available = menuItems.filter(item => item.price >= 200);

  // Dessert/sweet pizzas are NOT main course — exclude for savory meals
  const DESSERT_WORDS = ['抹茶', '可可', '香蕉', '甜披薩', '麻吉', '相思'];
  const FIRE_VOLCANO = ['火山'];  // 火山 = stuffed crust variant, OK but pricier

  // For 3+ people, exclude small pizzas and desserts (they're snacks, not meals)
  if (constraints.people >= 3) {
    available = available.filter(item => !item.name.startsWith('小 ') && !item.name.includes('小披薩'));
    available = available.filter(item => !DESSERT_WORDS.some(w => item.name.includes(w)));
  }

  // Seafood filter
  if (constraints.noSeafood) {
    available = available.filter(item => !SEAFOOD_WORDS.some(w => item.name.includes(w)));
  }
  // Vegetarian filter
  if (constraints.wantVeg) {
    available = available.filter(item => /素|蔬菜|瑪格|田園|彩蔬/.test(item.name));
  }

  // Prefer non-火山 (regular) pizzas first — they're cheaper and standard
  // Also exclude Jumbo (too expensive for most budgets)
  available = available.filter(item => !item.name.includes('Jumbo'));
  const regular = available.filter(item => !FIRE_VOLCANO.some(w => item.name.includes(w)));
  const volcano = available.filter(item => FIRE_VOLCANO.some(w => item.name.includes(w)));

  // Combine: regular first, then volcano as fallback
  // Shuffle within same-priority tier for variety (real people don't always pick the same)
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Group by price tier, shuffle within each tier
  const tiers = {};
  for (const item of regular) {
    const tier = Math.round(item.price / 50) * 50; // group by ~50 NT$ bands
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push(item);
  }
  const shuffledRegular = Object.keys(tiers).sort((a,b) => Math.abs(a-650) - Math.abs(b-650)).flatMap(k => shuffle(tiers[k]));
  const shuffledVolcano = shuffle([...volcano]);
  const candidates = [...shuffledRegular, ...shuffledVolcano];

  // Sort by preference (chicken/seafood) but keep randomness within same preference level
  candidates.sort((a, b) => {
    // Chicken preference: boost chicken items to top
    if (constraints.wantChicken) {
      const aChicken = a.name.includes('雞') ? 1 : 0;
      const bChicken = b.name.includes('雞') ? 1 : 0;
      if (aChicken !== bChicken) return bChicken - aChicken;
    }
    // Seafood preference: boost seafood items
    if (constraints.wantSeafood) {
      const aSeafood = SEAFOOD_WORDS.some(w => a.name.includes(w)) ? 1 : 0;
      const bSeafood = SEAFOOD_WORDS.some(w => b.name.includes(w)) ? 1 : 0;
      if (aSeafood !== bSeafood) return bSeafood - aSeafood;
    }
    return 0; // keep shuffled order for same-priority items
  });

  const count = decidePizzaCount(constraints.people, constraints.explicitPizzaCount);
  const picked = [];
  const usedNames = new Set();
  let hasSeafood = false;

  // If wantSeafood, pick one seafood first (random), then fill rest with non-seafood for variety
  if (constraints.wantSeafood) {
    const seafoodItems = candidates.filter(item => SEAFOOD_WORDS.some(w => item.name.includes(w)));
    if (seafoodItems.length > 0) {
      const sf = seafoodItems[Math.floor(Math.random() * seafoodItems.length)];
      const estTotal = sf.price + (constraints.wantCola ? 45 * (constraints.drinkCount || 1) : 0) + (constraints.wantSide ? 70 : 0);
      if (estTotal <= constraints.budget) {
        picked.push(sf);
        usedNames.add(sf.name);
        hasSeafood = true;
      }
    }
  }

  for (const item of candidates) {
    if (picked.length >= count) break;
    if (usedNames.has(item.name)) continue;
    // If we already have seafood, prefer non-seafood for variety
    if (hasSeafood && SEAFOOD_WORDS.some(w => item.name.includes(w))) continue;
    // Domino's BOGO: 2nd+ pizzas ~50% off. Estimate discounted total.
    const allPrices = [...picked.map(p => p.price), item.price].sort((a,b) => b-a);
    const discountedPizzaTotal = allPrices[0] + allPrices.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0);
    const currentTotal = discountedPizzaTotal + (constraints.wantCola ? 45 * (constraints.drinkCount || 1) : 0) + (constraints.wantSide ? 70 : 0);
    if (currentTotal <= constraints.budget) {
      picked.push(item);
      usedNames.add(item.name);
    }
  }

  // Fallback: if budget too tight, pick cheapest savory options
  if (picked.length < count) {
    candidates.sort((a, b) => a.price - b.price);
    for (const item of candidates) {
      if (picked.length >= count) break;
      if (!usedNames.has(item.name)) { picked.push(item); usedNames.add(item.name); }
    }
  }

  // If there's a minimum budget, check if we need to upgrade picks or add more
  // Use budgetMin + 5% buffer because actual BOGO discount may exceed our 50% estimate
  if (constraints.budgetMin > 0) {
    const extras = (constraints.wantCola ? 45 * (constraints.drinkCount || 1) : 0) + (constraints.wantSide ? 70 : 0);
    const targetMin = Math.ceil(constraints.budgetMin * 1.05);
    const calcDisc = (prices) => {
      const sorted = [...prices].sort((a,b) => b-a);
      return sorted[0] + sorted.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0);
    };
    let discTotal = calcDisc(picked.map(p => p.price)) + extras;

    // Strategy 1: upgrade cheapest pizza to pricier one
    if (discTotal < targetMin && picked.length > 0) {
      const cheapestIdx = picked.reduce((minIdx, p, i, arr) => p.price < arr[minIdx].price ? i : minIdx, 0);
      const upgrade = candidates.find(item => {
        if (usedNames.has(item.name) || item.price <= picked[cheapestIdx].price) return false;
        const newPrices = picked.map((p,i) => i === cheapestIdx ? item.price : p.price);
        const newDisc = calcDisc(newPrices) + extras;
        return newDisc >= targetMin && newDisc <= constraints.budget;
      });
      if (upgrade) {
        usedNames.delete(picked[cheapestIdx].name);
        picked[cheapestIdx] = upgrade;
        usedNames.add(upgrade.name);
        discTotal = calcDisc(picked.map(p => p.price)) + extras;
      }
    }

    // Strategy 2: add extra pizzas until we reach targetMin
    if (discTotal < targetMin) {
      const addCandidates = candidates.filter(item => !usedNames.has(item.name));
      for (const item of addCandidates) {
        const newPrices = [...picked.map(p => p.price), item.price];
        const newDisc = calcDisc(newPrices) + extras;
        if (newDisc <= constraints.budget) {
          picked.push(item);
          usedNames.add(item.name);
          discTotal = newDisc;
          if (discTotal >= targetMin) break;
        }
      }
    }

    // Strategy 3: allow duplicates if still under min
    if (discTotal < targetMin) {
      for (const item of candidates) {
        const newPrices = [...picked.map(p => p.price), item.price];
        const newDisc = calcDisc(newPrices) + extras;
        if (newDisc <= constraints.budget) {
          picked.push(item);
          discTotal = newDisc;
          if (discTotal >= targetMin) break;
        }
      }
    }
  }

  return picked;
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  geolocation: { latitude: 25.0330, longitude: 121.5654 },
  permissions: ['geolocation'],
});
const page = await context.newPage();
let CARD_NUMBER = '', CARD_EXP_MM = '', CARD_EXP_YY = '', CARD_CVV = '';
const CARD_NAME = 'AGENTIC HACKATHON';

// ============================================================
// STEP 1: Store Selection
// ============================================================
console.log('=== STEP 1: Store Selection ===');
console.log(`  Mode: ${constraints.isDelivery ? '外送' : '外帶'}`);
await page.goto('https://www.dominos.com.tw/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);

let storeOk = false;

if (constraints.isDelivery) {
  console.log('  Trying delivery...');
  try {
    await page.getByText('外送', { exact: true }).first().click();
    await page.waitForTimeout(2000);
    const addrInput = page.locator('[data-testid="delivery-address-search.search-input"] input, input[placeholder*="輸入"]').first();
    await addrInput.click();
    await page.waitForTimeout(500);
    // Extract address from prompt or use .env USER_ADDRESS
    const addrMatch = PROMPT.match(/送到(.+?)(?:、|$|，)/) || PROMPT.match(/外送到(.+?)(?:、|$|，)/);
    let addr = addrMatch ? addrMatch[1] : USER_ADDRESS;
    if (/指定|地址|家|公司|預先/.test(addr)) addr = USER_ADDRESS;
    // For autocomplete: extract street portion (remove zip, 台灣, 臺北市, 區 prefix)
    let searchAddr = addr.replace(/^\d{3,5}/, '').replace(/^台灣/, '').replace(/^臺北市|^台北市/, '').replace(/^.{2,3}區/, '').replace(/\d+樓.*$/, '').trim();
    if (!searchAddr || searchAddr.length < 3) searchAddr = addr;
    console.log(`    Address: ${addr}`);
    console.log(`    Search term: ${searchAddr}`);
    await addrInput.fill(searchAddr);
    await page.waitForTimeout(3000);
    // Click the address prediction option button
    const predOption = page.locator('[data-testid="delivery-address-predictions-results.options.option"]').first();
    const predExists = await predOption.count();
    if (predExists > 0) {
      const predText = await predOption.textContent();
      console.log(`    Prediction: ${predText.substring(0, 50)}`);
      await predOption.click();
    } else {
      // Fallback: click suggestion by text match
      await page.evaluate((searchTerm) => {
        const d = [...document.querySelectorAll('button, div')].filter(el => {
          const t = el.textContent.trim();
          return t.includes(searchTerm.substring(0, 8)) && t.length < 80 && el.getBoundingClientRect().height > 0;
        });
        d.sort((a, b) => a.textContent.length - b.textContent.length);
        if (d[0]) d[0].click();
      }, searchAddr);
    }
    await page.waitForTimeout(3000);

    // Confirm address page: fill floor number field and click 選擇地址
    const confirmBtn = page.locator('[data-testid="confirm-address.button"]');
    for (let w = 0; w < 8; w++) {
      if (await confirmBtn.count() > 0) break;
      await page.waitForTimeout(1000);
    }
    if (await confirmBtn.count() > 0) {
      const floorMatch = addr.match(/(\d+)樓/);
      if (floorMatch) {
        const floorInput = page.locator('[data-testid="address-field-floorNumber"] input').first();
        if (await floorInput.count() > 0) {
          await floorInput.fill(floorMatch[1]);
          console.log(`    Floor: ${floorMatch[1]}`);
        }
      }
      await confirmBtn.click();
      console.log('    Confirmed address');
      await page.waitForTimeout(4000);
    }

    // Wait for either start-now or start-later button
    for (let i = 0; i < 12; i++) {
      const hasNow = await page.locator('[data-testid="start-order-now-button"]').count();
      const hasLater = await page.locator('[data-testid="start-order-later-button"]').count();
      if (hasNow > 0 || hasLater > 0) break;
      // Also check for "外送 預約" expander button
      const hasExpander = await page.locator('[data-testid="order-later-expander-button"]').count();
      if (hasExpander > 0) {
        await page.locator('[data-testid="order-later-expander-button"]').click({ force: true });
        await page.waitForTimeout(1500);
        const hasLater2 = await page.locator('[data-testid="start-order-later-button"]').count();
        if (hasLater2 > 0) break;
      }
      await page.waitForTimeout(1500);
    }

    // Debug: what's visible now
    const deliveryDebug = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], [data-testid]')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({
        text: el.textContent.trim().substring(0, 50), testId: el.getAttribute('data-testid')
      })).filter(b => b.testId || b.text.length < 40).slice(0, 15);
      return btns;
    });
    console.log('    Delivery buttons:', JSON.stringify(deliveryDebug.filter(b => /start|order|預約|外送/.test(b.text + (b.testId || '')))));

    const hasNowBtn = await page.locator('[data-testid="start-order-now-button"]').count();
    const hasLaterBtn = await page.locator('[data-testid="start-order-later-button"]').count();
    // Check if user wants a scheduled time
    let wantScheduled = false;
    let desiredHour = exactOrder ? exactOrder.desiredHour : 0;
    let desiredMinute = exactOrder ? (exactOrder.desiredMinute || 0) : 0;
    let desiredDay = exactOrder ? exactOrder.desiredDay : '';
    if (!desiredHour) {
      const timeMatch2 = PROMPT.match(/(\d{1,2})\s*[點:時](半)?/);
      if (timeMatch2) { desiredHour = parseInt(timeMatch2[1]); if (timeMatch2[2] === '半') desiredMinute = 30; }
      else if (constraints.isLunch) desiredHour = 12;
      else if (constraints.isDinner) desiredHour = 18;
    }
    if (desiredDay || desiredHour) wantScheduled = true;

    if (hasNowBtn > 0 && !wantScheduled) {
      await page.locator('[data-testid="start-order-now-button"]').click({ force: true });
    } else {
      console.log(`    Scheduling: ${desiredDay || 'today'} ${desiredHour || 'ASAP'}:${String(desiredMinute).padStart(2,'0')}`);
      // Click expander to reveal scheduling UI
      const expander = page.locator('[data-testid="order-later-expander-button"]');
      if (await expander.count() > 0) {
        await expander.click({ force: true });
        await page.waitForTimeout(2000);
      }

      // Select day if specified (e.g. 禮拜五 → 星期五, or just "五")
      if (desiredDay) {
        const dayMatch = desiredDay.match(/[禮星期週周].*?([一二三四五六日天])/) || desiredDay.match(/([一二三四五六日天])/);
        const targetDayChar = dayMatch ? dayMatch[1] : '';
        const targetDayName = targetDayChar ? '星期' + targetDayChar : '';
        if (targetDayName) {
          const dateSelect = page.locator('[data-testid="OrderLaterContainer-OrderDate-select"]');
          if (await dateSelect.count() > 0) {
            await dateSelect.click();
            await page.waitForTimeout(1500);
            const dayClicked = await page.evaluate((target) => {
              const opts = [...document.querySelectorAll('[role="option"], div, span, li')].filter(el =>
                el.textContent.trim().includes(target) && el.getBoundingClientRect().height > 0 && el.textContent.trim().length < 30
              );
              opts.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
              if (opts[0]) { opts[0].click(); return opts[0].textContent.trim(); }
              return null;
            }, targetDayName);
            console.log(`    Day selected: ${dayClicked || 'not found'}`);
            await page.waitForTimeout(1500);
          }
        }
      }

      const timeSelect = page.locator('[data-testid="OrderLaterContainer-OrderTime-select"]');
      if (await timeSelect.count() > 0) {
        await timeSelect.click();
        await page.waitForTimeout(1500);
        // Try clicking time option from dropdown
        const timeClicked = await page.evaluate(({targetHour, targetMinute}) => {
          const opts = [...document.querySelectorAll('div, span, option')].filter(el =>
            /^\d{1,2}:\d{2}/.test(el.textContent.trim()) && el.textContent.trim().length < 20 && el.children.length <= 1 && el.getBoundingClientRect().height > 0
          );
          if (opts.length === 0) return 'no_options';
          if (targetHour === 0) { opts[0].click(); return opts[0].textContent.trim(); }
          const targetTotal = targetHour * 60 + (targetMinute || 0);
          let best = opts[0], bestDiff = 999;
          for (const opt of opts) {
            const t = opt.textContent.trim();
            const parts = t.match(/(\d{1,2}):(\d{2})/);
            if (!parts) continue;
            let h = parseInt(parts[1]);
            const m = parseInt(parts[2]);
            const ctx = (opt.parentElement?.textContent || '') + t;
            if (ctx.includes('下午') || ctx.includes('PM')) { if (h < 12) h += 12; }
            const diff = Math.abs((h * 60 + m) - targetTotal);
            if (diff < bestDiff) { bestDiff = diff; best = opt; }
          }
          best.click();
          return best.textContent.trim();
        }, {targetHour: desiredHour, targetMinute: desiredMinute});
        console.log(`    Time selected: ${timeClicked}`);
        await page.waitForTimeout(1500);
      }
      // Try clicking the order-later button with shorter timeout
      const laterBtn = page.locator('[data-testid="start-order-later-button"]');
      try {
        await laterBtn.click({ force: true, timeout: 10000 });
      } catch(e) {
        // Maybe button text is different for delivery
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
            (el.textContent.includes('預約') || el.textContent.includes('開始')) && el.getBoundingClientRect().height > 0
          );
          if (btns[0]) btns[0].click();
        });
      }
    }
    await page.waitForTimeout(5000);
    if (page.url().includes('/menu')) { storeOk = true; console.log('  Delivery: ✓'); }
    else console.log('  Delivery failed, fallback to pickup');
  } catch(e) { console.log('  Delivery error:', e.message?.substring(0,60), '→ fallback to pickup'); }
}

if (!storeOk) {
  // Pickup fallback
  await page.goto('https://www.dominos.com.tw/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SS}/smart-s1-home.png` });
  await page.getByText('外帶', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SS}/smart-s2-pickup.png` });
  await page.locator('input[placeholder*="輸入"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('input[placeholder*="輸入"]').first().fill(USER_ADDRESS);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SS}/smart-s3-search.png` });
  const suggClicked = await page.evaluate((searchAddr) => { const d = [...document.querySelectorAll('div')].filter(el => { const t = el.textContent.trim(); return t.includes('台灣') && el.children.length <= 3 && t.length < 50; }); d.sort((a,b) => a.textContent.length - b.textContent.length); if (d[0]) { d[0].click(); return true; } return false; }, USER_ADDRESS);
  console.log(`    Address suggestion clicked: ${suggClicked}`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SS}/smart-s4-stores.png` });
  const storeClicked = await page.evaluate(() => { const d = [...document.querySelectorAll('div')].filter(el => el.textContent.trim().startsWith('松信店') && el.children.length <= 3); d.sort((a,b) => a.textContent.length - b.textContent.length); if (d[0]) { d[0].click(); return true; } return false; });
  console.log(`    Store clicked: ${storeClicked}`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SS}/smart-s5-store-selected.png` });
  // Debug: dump what buttons/elements are visible
  const visibleBtns = await page.evaluate(() => {
    return [...document.querySelectorAll('button, [role="button"], [data-testid]')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({
      tag: el.tagName, text: el.textContent.trim().substring(0, 40), testId: el.getAttribute('data-testid')
    })).slice(0, 20);
  });
  console.log('    Visible buttons:', JSON.stringify(visibleBtns, null, 2));
  // Wait for start button to appear
  for (let i = 0; i < 8; i++) {
    const hasNow = await page.locator('[data-testid="start-order-now-button"]').count();
    const hasLater = await page.locator('[data-testid="start-order-later-button"]').count();
    if (hasNow > 0 || hasLater > 0) break;
    console.log(`    Waiting for start button... (${i+1})`);
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${SS}/smart-before-start.png` });

  // Check if store is open (立即) or closed (預約)
  const hasNowBtn = await page.locator('[data-testid="start-order-now-button"]').count();
  if (hasNowBtn > 0) {
    console.log('    Store open → 立即');
    await page.locator('[data-testid="start-order-now-button"]').click({ force: true });
  } else {
    console.log('    Store closed → selecting time for 預約');
    let desiredHour = exactOrder ? exactOrder.desiredHour : 0;
    let desiredMinute = exactOrder ? (exactOrder.desiredMinute || 0) : 0;
    if (!desiredHour) {
      const timeMatch = PROMPT.match(/(\d{1,2})\s*[點:時](半)?/);
      if (timeMatch) { desiredHour = parseInt(timeMatch[1]); if (timeMatch[2] === '半') desiredMinute = 30; }
      else if (constraints.isLunch) desiredHour = 12;
      else if (constraints.isDinner) desiredHour = 18;
    }

    // Select time
    const timeSelect = page.locator('[data-testid="OrderLaterContainer-OrderTime-select"]');
    if (await timeSelect.count() > 0) {
      await timeSelect.click();
      await page.waitForTimeout(1000);
      await page.evaluate(({targetHour, targetMinute}) => {
        const opts = [...document.querySelectorAll('div, span')].filter(el =>
          /^\d{1,2}:\d{2}/.test(el.textContent.trim()) && el.textContent.trim().length < 20 && el.children.length <= 1
        );
        if (opts.length === 0) return;
        if (targetHour === 0) { opts[0].click(); return; }
        const targetTotal = targetHour * 60 + (targetMinute || 0);
        let best = opts[0];
        let bestDiff = 999;
        for (const opt of opts) {
          const parts = opt.textContent.trim().match(/(\d{1,2}):(\d{2})/);
          if (!parts) continue;
          let h = parseInt(parts[1]);
          const m = parseInt(parts[2]);
          const isPM = opt.textContent.includes('下午') || opt.textContent.includes('PM');
          if (isPM && h < 12) h += 12;
          const diff = Math.abs((h * 60 + m) - targetTotal);
          if (diff < bestDiff) { bestDiff = diff; best = opt; }
        }
        best.click();
      }, {targetHour: desiredHour, targetMinute: desiredMinute});
      await page.waitForTimeout(1000);
    }
    await page.locator('[data-testid="start-order-later-button"]').click({ force: true });
  }
  await page.waitForTimeout(5000);
}

if (!page.url().includes('/menu')) {
  console.log('FATAL: Store selection failed');
  await browser.close(); process.exit(1);
}
console.log('  Store ready ✓\n');

// ============================================================
// STEP 1.5: Scan Promotions (當期主打, 精選套餐, 自由任你配, 專屬優惠)
// ============================================================
console.log('=== STEP 1.5: Scan Promotions ===');
let promoUsed = false;
let promoItems = [];

async function scanPromos() {
  // Check deals page for active promotions
  await page.goto('https://order.dominos.com.tw/menu/deals', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Click through each promo tab to load content
  const TABS = ['當期主打', '精選套餐', '自由任你配', '專屬優惠'];
  const allPromoItems = [];

  for (const tabName of TABS) {
    const tabClicked = await page.evaluate((name) => {
      const tabs = [...document.querySelectorAll('div, span, button, a')].filter(el =>
        el.textContent.trim() === name && el.children.length <= 2 && el.getBoundingClientRect().height > 0
      );
      if (tabs[0]) { tabs[0].click(); return true; }
      return false;
    }, tabName);

    if (!tabClicked) continue;
    await page.waitForTimeout(2000);

    // Scroll to load items in this tab
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(300);
    }

    // Extract promo items from current tab view
    const tabItems = await page.evaluate((tab) => {
      const items = [];
      const seen = new Set();
      const allText = document.body.innerText;
      const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for promo deal names with prices
        if (line.length >= 4 && line.length <= 60 && !line.match(/^NT\$/) && !seen.has(line)) {
          // Check if next few lines have a price
          for (let j = 0; j <= 3; j++) {
            const checkLine = j === 0 ? line : (i + j < lines.length ? lines[i + j] : '');
            const priceMatch = checkLine.match(/NT\$(\d+)/);
            if (priceMatch) {
              const name = j === 0 ? line.split('NT$')[0].trim() : line;
              if (name.length >= 4 && name.length <= 50) {
                items.push({ name, price: parseInt(priceMatch[1]), tab });
                seen.add(name);
              }
              break;
            }
          }
        }
      }

      // Also look for deal cards with specific patterns
      const DEAL_PATTERNS = ['買大送大', '買一送一', '套餐', '任你配', '起', '優惠', '加購'];
      const cards = [...document.querySelectorAll('[role="button"], button, a')].filter(el => {
        const t = el.textContent.trim();
        return DEAL_PATTERNS.some(p => t.includes(p)) && t.length > 5 && t.length < 150 && el.getBoundingClientRect().height > 0;
      }).map(el => {
        const t = el.textContent.trim();
        const pm = t.match(/NT\$(\d+)/);
        return { name: t.substring(0, 60), price: pm ? parseInt(pm[1]) : 0, tab };
      }).filter(c => !seen.has(c.name));

      return { items, cards };
    }, tabName);

    allPromoItems.push(...tabItems.items, ...tabItems.cards);
    if (tabItems.items.length > 0 || tabItems.cards.length > 0) {
      console.log(`  [${tabName}] ${tabItems.items.length} items, ${tabItems.cards.length} cards`);
    }
  }

  // Deduplicate
  const seen = new Set();
  const promos = allPromoItems.filter(p => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });

  console.log(`  Total promos found: ${promos.length}`);
  promos.slice(0, 8).forEach(p => console.log(`    ${p.tab}: ${p.name} ${p.price ? '(NT$' + p.price + ')' : ''}`));

  return { promos, tabs: TABS };
}

const pizzaCount = decidePizzaCount(constraints.people, constraints.explicitPizzaCount);

// Only try promos if ordering 2+ pizzas (BOGO deals are the main value)
if (pizzaCount >= 2) {
  const promos = await scanPromos();

  // Look for BOGO-type deals (買大送大, 買一送一) that fit our budget
  const bogoPromos = promos.promos.filter(p => /買大送大|買一送一|兩個大披薩/.test(p.name));
  const comboPromos = promos.promos.filter(p => /套餐|任你配/.test(p.name));

  if (bogoPromos.length > 0) {
    console.log(`  → BOGO deal available: ${bogoPromos[0].name}`);
    // Try to use the BOGO deal by clicking it on the deals page
    const bogoClicked = await page.evaluate((bogoText) => {
      const els = [...document.querySelectorAll('div, span, [role="button"], button')].filter(el => {
        const t = el.textContent.trim();
        return t.includes(bogoText.substring(0, 6)) && el.getBoundingClientRect().height > 0 && t.length < 200;
      });
      // Click the most specific (shortest text) match
      els.sort((a, b) => a.textContent.length - b.textContent.length);
      const clickTarget = els.find(el => el.closest('[role="button"]') || el.closest('button') || el.closest('a'));
      if (clickTarget) {
        const btn = clickTarget.closest('[role="button"]') || clickTarget.closest('button') || clickTarget.closest('a') || clickTarget;
        btn.click();
        return btn.textContent.trim().substring(0, 50);
      }
      if (els[0]) { els[0].click(); return els[0].textContent.trim().substring(0, 50); }
      return null;
    }, bogoPromos[0].name);

    if (bogoClicked) {
      console.log(`    Clicked: "${bogoClicked}"`);
      await page.waitForTimeout(3000);

      // Check if we landed on a promo configuration page (pizza selection within deal)
      const promoPage = await page.evaluate(() => {
        const body = document.body.innerText;
        return {
          hasPizzaSelection: body.includes('選擇') && (body.includes('披薩') || body.includes('口味')),
          hasAddButton: !!([...document.querySelectorAll('button')].find(b => b.textContent.includes('增加到訂單中') || b.textContent.includes('加入'))),
          url: window.location.href
        };
      });
      console.log(`    Promo page: ${JSON.stringify(promoPage)}`);

      if (promoPage.hasPizzaSelection) {
        // We're in a promo builder — select pizzas within the deal
        console.log('    → Promo builder detected, selecting pizzas within deal...');
        promoUsed = true;
      }
    }
  } else if (comboPromos.length > 0) {
    console.log(`  → Combo deal available: ${comboPromos[0].name}`);
  }

  if (!promoUsed) {
    console.log('  → No usable promo applied, will use regular menu ordering');
    // Also check if there's a coupon code we can apply later at checkout
    const couponInfo = promos.promos.filter(p => /優惠碼|折扣碼|coupon/i.test(p.name));
    if (couponInfo.length > 0) console.log(`  → Coupon codes found: ${couponInfo.map(c => c.name).join(', ')}`);
  }
} else {
  console.log('  Skipping promos (single pizza order)');
}

// Also try to apply any available coupons at the menu level
if (!promoUsed) {
  // Navigate to menu and check for promo banner/coupon input
  await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Apply voucher: click "新增優惠券" on the voucher card (e.g. "買大送大")
  // Auto-apply when 2+ large pizzas OR user explicitly requests coupon
  const hasMultipleLargePizzas = exactOrder && exactOrder.pizzas.filter(p => p.size === '大').length >= 2;
  if (exactOrder && (exactOrder.wantCoupon || hasMultipleLargePizzas)) {
    console.log('  [Voucher] Applying deal from pizza menu page...');
    // Scroll to top to ensure voucher cards are visible
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    const voucherApplied = await page.evaluate(() => {
      // Strategy 1: testId-based selectors
      let voucherCards = [...document.querySelectorAll('[data-testid*="Voucher"][data-testid*="lovable-menu"]')];
      // Strategy 2: any element containing 買大送大/買大送小 text
      if (voucherCards.length === 0) {
        voucherCards = [...document.querySelectorAll('[data-testid*="lovable-menu"]')].filter(el =>
          /買大送[大小]|送可樂/.test(el.textContent || '')
        );
      }
      // Strategy 3: broader search for cards/buttons with coupon text
      if (voucherCards.length === 0) {
        voucherCards = [...document.querySelectorAll('div, section, article, [role="button"]')].filter(el => {
          const t = el.textContent || '';
          const r = el.getBoundingClientRect();
          return r.height > 40 && r.height < 300 && /買大送[大小]|送可樂/.test(t) && t.length < 100;
        });
      }
      if (voucherCards.length === 0) {
        const allText = document.body.innerText.substring(0, 500);
        return { found: false, debug: `no voucher cards found. Page top: ${allText.substring(0, 200)}` };
      }
      // Log all available vouchers
      const allVouchers = voucherCards.map(el => el.textContent.trim().substring(0, 50));
      // Priority: 買大送大送可樂 > 買大送大 > 買大送小
      const targetVoucher = voucherCards.find(el => {
        const t = el.textContent || '';
        return t.includes('送可樂');
      }) || voucherCards.find(el => {
        const t = el.textContent || '';
        return t.includes('買大送大');
      }) || voucherCards.find(el => {
        const t = el.textContent || '';
        return t.includes('買大送小');
      }) || voucherCards[0];
      const btn = targetVoucher.querySelector('button');
      if (btn) { btn.click(); return { found: true, text: targetVoucher.textContent.trim().substring(0, 60), method: 'button', allVouchers }; }
      targetVoucher.click();
      return { found: true, text: targetVoucher.textContent.trim().substring(0, 60), method: 'card-click', allVouchers };
    });

    if (voucherApplied.found) {
      console.log(`    Available vouchers: ${JSON.stringify(voucherApplied.allVouchers || [])}`);
      console.log(`    Selected: ${voucherApplied.text} (${voucherApplied.method})`);
      promoUsed = true;
      await page.waitForTimeout(3000);
    } else {
      console.log(`    ${voucherApplied.debug || 'No voucher card found'}`);
      // Fallback: try clicking any "新增優惠券" button on the page
      const fallbackBtn = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(el =>
          el.textContent.trim() === '新增優惠券' && el.getBoundingClientRect().height > 0
        );
        if (btns.length > 0) { btns[0].click(); return true; }
        return false;
      });
      if (fallbackBtn) {
        console.log('    Clicked fallback "新增優惠券" button');
        await page.waitForTimeout(3000);
        // Try to select deal from opened UI
        const dealPicked = await page.evaluate(() => {
          const els = [...document.querySelectorAll('div, button, [role="button"]')].filter(el => {
            const t = el.textContent.trim();
            return (t.includes('買大送小') || t.includes('買大送大') || t.includes('外送')) && t.length < 60 && el.getBoundingClientRect().height > 0;
          });
          if (els.length > 0) { els[0].click(); return els[0].textContent.trim().substring(0, 40); }
          return null;
        });
        if (dealPicked) { console.log(`    Selected: ${dealPicked}`); promoUsed = true; }
        await page.waitForTimeout(2000);
      }
    }
  }
}

console.log('');

// ============================================================
// STEP 2: Scan Menu & Decide
// ============================================================
console.log('=== STEP 2: Scan Menu ===');
await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

// Scroll through entire menu to load all items
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(400);
}

// Extract pizza names and prices from the page
const menuItems = await page.evaluate(() => {
  const items = [];
  const seen = new Set();
  const allText = document.body.innerText;
  const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // UI/non-pizza words to exclude
  const EXCLUDE = ['外送', '外帶', '達美樂', '菜單', '完成訂單', '增加到訂單中', '大披薩', '中披薩', '小披薩', '手拍', '鬆厚', '經典', '尺寸', '餅皮', '搜尋', '篩選', '全部', '人氣推薦', '新品', '經典口味', '素食', '回到頂部', '繁體中文', '移除', '增加優惠碼', '使用', '訂單細節', '全部訂單', '你可能會喜歡', '增加', '增加一些菜單項目以開始！', '熱銷主打', '極致系列披薩', '招牌系列披薩', '經典系列披薩', '巨無霸披薩', '火山披薩(精選優惠口味)', '新增優惠券', '條款與細則', '隱私權政策'];
  // Non-pizza food items (sides/drinks that appear on page)
  const SIDES = ['香烤雞條', '鱈魚星星', '可樂', '薯球', '濃湯', '雞塊'];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length >= 2 && lines[i].length <= 20 && !lines[i].includes('NT$') && !lines[i].match(/^\d/)) {
      for (let j = 1; j <= 5; j++) {
        if (i + j < lines.length && lines[i + j].includes('NT$')) {
          const priceMatch = lines[i + j].match(/NT\$(\d+)/);
          if (priceMatch && !seen.has(lines[i])) {
            const name = lines[i];
            const price = parseInt(priceMatch[1]);
            // Filter: must be real pizza (price > 100, not UI element, not side item)
            if (price >= 100 && !EXCLUDE.includes(name) && !SIDES.some(s => name.includes(s))) {
              items.push({ name, price });
              seen.add(name);
            }
          }
          break;
        }
      }
    }
  }
  return items;
});

console.log(`  Found ${menuItems.length} pizza items on menu:`);
menuItems.forEach(item => console.log(`    ${item.name} - NT$${item.price}`));

// Decide what to order
const selectedPizzas = pickPizzas(menuItems, constraints);
console.log(`\n  Decision (${constraints.people} people, budget NT$${constraints.budget}):`);
selectedPizzas.forEach(p => console.log(`    Pizza: ${p.name} (NT$${p.price})`));
if (constraints.wantSide) console.log('    Side: 香烤雞條 (NT$70)');
if (constraints.wantCola) console.log('    Drink: random from menu (~NT$45)');
const pizzaPrices = selectedPizzas.map(p => p.price).sort((a,b) => b-a);
const estTotal = pizzaPrices[0] + pizzaPrices.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0) + (constraints.wantSide ? 70 : 0) + (constraints.wantCola ? 45 * (constraints.drinkCount || 1) : 0);
console.log(`    Estimated total: NT$${estTotal}`);
console.log('');

// ============================================================
// STEP 3: Add Items to Cart
// ============================================================
console.log('=== STEP 3: Add Items ===');

async function addPizza(name, opts = {}) {
  const { size, crust } = opts;
  console.log(`  [Pizza] ${name}${size ? ' (' + size + ')' : ''}${crust ? ' 餅皮:' + crust : ''}...`);
  await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  let modalOpen = false;
  for (let attempt = 0; attempt < 3 && !modalOpen; attempt++) {
    let found = false;
    const searchNames = [name];
    if (size === '小') searchNames.push(name + '小披薩');
    if (size === '大') searchNames.push(name + '大披薩');
    for (let s = 0; s < 15; s++) {
      found = await page.evaluate((names) => {
        for (const n of names) {
          const els = [...document.querySelectorAll('div, span')].filter(e =>
            e.textContent.trim() === n && e.children.length === 0 && e.getBoundingClientRect().height > 0
          );
          if (els.length > 0) {
            const el = els[0];
            const clickTarget = el.closest('[role="button"]') || el.closest('[data-testid]') || el.closest('button') || el.parentElement?.parentElement?.parentElement || el.parentElement?.parentElement || el;
            clickTarget.click();
            return true;
          }
        }
        return false;
      }, searchNames);
      if (found) break;
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(500);
    }
    if (!found) { console.log(`    ✗ not found on menu`); return false; }
    await page.waitForTimeout(2500);

    // Check if modal opened (增加到訂單中 button visible)
    modalOpen = await page.evaluate(() => !!([...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0)));
    if (!modalOpen && attempt < 2) {
      console.log(`    retry ${attempt + 1} (modal didn't open)...`);
      // Alternative: try clicking via coordinates on the pizza card
      const coords = await page.evaluate((n) => {
        const el = [...document.querySelectorAll('div, span')].find(e => e.textContent.trim() === n && e.children.length === 0 && e.getBoundingClientRect().height > 0);
        if (!el) return null;
        const card = el.closest('[role="button"]') || el.parentElement?.parentElement?.parentElement || el.parentElement;
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, name);
      if (coords) {
        await page.mouse.click(coords.x, coords.y);
        await page.waitForTimeout(2500);
        modalOpen = await page.evaluate(() => !!([...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0)));
      }
    }
  }

  if (!modalOpen) { console.log(`    ✗ add button not found (modal didn't open)`); return false; }

  // Select size: exact mode uses specified size, otherwise 大披薩 for 3+ people
  const targetSize = size === '大' ? '大披薩' : size === '小' ? '小披薩' : size === '中' ? '中披薩' : (constraints.people >= 3 ? '大披薩' : null);
  if (targetSize) {
    // Scroll modal to top to reveal size tabs
    await page.evaluate(() => {
      const addBtn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0);
      if (addBtn) {
        const modal = addBtn.closest('[role="dialog"]') || addBtn.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
        if (modal) { const scrollable = modal.querySelector('[data-testid*="scroll"]') || modal; scrollable.scrollTop = 0; }
      }
    });
    await page.waitForTimeout(500);
    const sizeClicked = await page.evaluate((sz) => {
      const addBtn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0);
      const modal = addBtn ? (addBtn.closest('[role="dialog"]') || addBtn.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement) : document;
      const container = modal || document;
      // Strategy 1: exact match on role="tab"
      const exactTabs = [...container.querySelectorAll('[role="tab"]')].filter(el => el.textContent.trim() === sz && el.getBoundingClientRect().height > 0);
      if (exactTabs.length > 0) { exactTabs[0].click(); return { clicked: sz, method: 'exact-tab' }; }
      // Strategy 2: any element with exact text (allow children)
      const exact = [...container.querySelectorAll('div, span, button')].filter(el => {
        const t = el.textContent.trim();
        return t === sz && el.getBoundingClientRect().height > 0;
      });
      if (exact.length > 0) { exact[0].click(); return { clicked: sz, method: 'exact-text' }; }
      // Strategy 3: size dropdown button — look for button containing "尺寸" text, click to open dropdown
      const sizeBtn = [...container.querySelectorAll('button, [role="button"]')].find(el => {
        const t = el.textContent.trim();
        return t.includes('尺寸') && t.length < 20 && el.getBoundingClientRect().height > 0;
      });
      if (sizeBtn) {
        sizeBtn.click();
        return { clicked: null, openedDropdown: sizeBtn.textContent.trim() };
      }
      return { clicked: null, error: 'no size control found' };
    }, targetSize);
    if (sizeClicked.clicked) {
      console.log(`    size: ${sizeClicked.clicked}`);
    } else if (sizeClicked.openedDropdown) {
      // Dropdown opened — wait and select the target size
      await page.waitForTimeout(1000);
      const picked = await page.evaluate((sz) => {
        const options = [...document.querySelectorAll('div, span, button, [role="option"], [role="menuitem"], [role="radio"]')].filter(el => {
          const t = el.textContent.trim();
          return t === sz && el.getBoundingClientRect().height > 0 && el.children.length <= 2;
        });
        if (options.length > 0) { options[0].click(); return sz; }
        // Try partial
        const partial = [...document.querySelectorAll('div, span, button, [role="option"], [role="menuitem"]')].filter(el => {
          const t = el.textContent.trim();
          return t.includes(sz) && t.length < 20 && el.getBoundingClientRect().height > 0;
        });
        if (partial.length > 0) { partial[0].click(); return partial[0].textContent.trim(); }
        // List what's available in the dropdown
        const visible = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="radio"], [role="listbox"] *, [role="menu"] *')].filter(el => el.getBoundingClientRect().height > 0 && el.textContent.trim().length > 1 && el.textContent.trim().length < 20).map(el => el.textContent.trim());
        return { error: 'option not found', visible: [...new Set(visible)].slice(0, 10) };
      }, targetSize);
      if (typeof picked === 'string') {
        console.log(`    size: ${picked} (from dropdown)`);
      } else {
        console.log(`    ⚠ size "${targetSize}" not in dropdown, visible: ${JSON.stringify(picked.visible)}`);
      }
    } else {
      console.log(`    ⚠ size "${targetSize}" not found: ${sizeClicked.error}`);
    }
    await page.waitForTimeout(2500);
  }

  // Select crust if specified (手拍, 鬆厚, 經典, 帕瑪滋心, etc.)
  // Must search WITHIN the modal only (scoped to the dialog containing "增加到訂單中")
  if (crust) {
    const crustResult = await page.evaluate((c) => {
      // Find the modal container by locating "增加到訂單中" button and going up
      const addBtn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0);
      if (!addBtn) return { clicked: null, error: 'no modal found' };
      const modal = addBtn.closest('[role="dialog"]') || addBtn.closest('[data-testid*="modal"]') || addBtn.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
      if (!modal) return { clicked: null, error: 'no modal container' };
      // Search for crust option within modal only
      const els = [...modal.querySelectorAll('div, span, button, [role="radio"], [role="tab"]')].filter(el => {
        const t = el.textContent.trim();
        return t.includes(c) && t.length < 20 && el.children.length <= 2 && el.getBoundingClientRect().height > 0;
      });
      if (els.length > 0) {
        els.sort((a,b) => a.textContent.length - b.textContent.length);
        els[0].click();
        return { clicked: els[0].textContent.trim(), count: els.length };
      }
      // Dump ALL short text elements in modal for debugging
      const allOptions = [...modal.querySelectorAll('div, span, [role="radio"], [role="tab"]')].filter(el => {
        const t = el.textContent.trim();
        return el.getBoundingClientRect().height > 0 && t.length >= 2 && t.length < 20 && el.children.length <= 1;
      }).map(el => el.textContent.trim());
      const unique = [...new Set(allOptions)];
      return { clicked: null, available: unique.slice(0, 30) };
    }, crust);
    if (crustResult.clicked) {
      console.log(`    crust: ${crustResult.clicked}`);
    } else {
      console.log(`    ⚠ crust "${crust}" not found in modal, available: ${JSON.stringify(crustResult.available || crustResult.error)}`);
    }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(800);

  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中'); if (b) b.click(); });
  await page.waitForTimeout(2000);
  console.log(`    ✓`);
  return true;
}

// Add each selected pizza (exact mode or constraint mode)
let addedCount = 0;
if (exactOrder) {
  // Split pizzas: 大 pizzas go through deal-builder (if voucher active), others added normally
  const dealPizzas = promoUsed ? exactOrder.pizzas.filter(p => p.size === '大') : [];
  const normalPizzas = promoUsed ? exactOrder.pizzas.filter(p => p.size !== '大') : exactOrder.pizzas;

  if (dealPizzas.length > 0) {
    console.log(`  [Deal-Builder] Adding ${dealPizzas.length} 大 pizzas via voucher...`);
    for (const pizza of dealPizzas) {
      // In deal-builder mode, size is forced to 大/手拍 — just find and click the pizza
      const ok = await addPizza(pizza.name, { size: null, crust: pizza.crust });
      if (ok) addedCount++;
    }
    // Wait for deal-builder to complete/close
    await page.waitForTimeout(2000);
  }

  if (normalPizzas.length > 0) {
    console.log(`  [Normal] Adding ${normalPizzas.length} non-deal pizzas...`);
    // Make sure we're on the regular pizza menu (not deal-builder)
    await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    for (const pizza of normalPizzas) {
      const ok = await addPizza(pizza.name, { size: pizza.size, crust: pizza.crust });
      if (ok) addedCount++;
    }
  }
} else {
  for (const pizza of selectedPizzas) {
    const ok = await addPizza(pizza.name);
    if (ok) addedCount++;
  }
}

// Add exact sides from sides menu (exact mode)
if (exactOrder && exactOrder.sides.length > 0) {
  console.log(`  [Sides] Adding ${exactOrder.sides.length} specific items...`);

  // Navigate to sides by clicking the "副食" menuitem in the top nav bar
  async function navigateToSides() {
    const tabClicked = await page.evaluate(() => {
      // The category is "副食" (not "副餐") — it's a role="menuitem" DIV in the top NAV
      const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="tab"]')].filter(el => {
        const t = el.textContent.trim();
        return (t === '副食' || t === '副餐' || t.includes('副食')) && el.getBoundingClientRect().height > 0;
      });
      if (menuItems.length > 0) { menuItems[0].click(); return 'menuitem:' + menuItems[0].textContent.trim(); }
      // Broader search: any element in the top nav area (y < 150) with 副食
      const topNav = [...document.querySelectorAll('nav [role="menuitem"], nav div, nav span')].filter(el => {
        const t = el.textContent.trim();
        return (t === '副食' || t === '副餐') && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().y < 150;
      });
      if (topNav.length > 0) { topNav[0].click(); return 'nav:' + topNav[0].textContent.trim(); }
      // Last resort: find in the NAV that contains "披薩" and "飲料" (the category nav)
      const navEl = document.querySelector('nav[role="navigation"]');
      if (navEl) {
        const items = [...navEl.querySelectorAll('*')].filter(el => {
          const t = el.textContent.trim();
          return (t === '副食' || t === '副餐') && el.children.length <= 2 && el.getBoundingClientRect().height > 0;
        });
        if (items.length > 0) { items[0].click(); return 'nav-child:' + items[0].textContent.trim(); }
      }
      return null;
    });
    if (tabClicked) {
      console.log(`    Nav: clicked (${tabClicked})`);
      await page.waitForTimeout(4000);
      return true;
    }
    // Fallback: use URL with menu/sides
    console.log(`    Nav: "副食" not found, trying URL...`);
    await page.goto('https://order.dominos.com.tw/menu/sides', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(5000);
    return false;
  }

  // Make sure we're on the menu page first (not checkout)
  if (!page.url().includes('/menu')) {
    await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
  }

  await navigateToSides();

  // Wait for side items to appear (look for NT$ price indicators)
  let sidesLoaded = false;
  for (let w = 0; w < 10; w++) {
    sidesLoaded = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[role="button"], [data-testid*="product"]')].filter(el => {
        const t = el.textContent.trim();
        return t.includes('NT$') && t.length < 80 && !t.includes('訂單') && !t.includes('尺寸') && el.getBoundingClientRect().height > 0;
      });
      return items.length >= 3;
    });
    if (sidesLoaded) break;
    await page.waitForTimeout(1000);
  }
  if (!sidesLoaded) {
    console.log(`    [Warn] Sides page may not have loaded products`);
  }

  for (const sideName of exactOrder.sides) {
    console.log(`    Adding: ${sideName}...`);
    const keywords = [sideName];
    if (sideName.includes('鱈魚')) keywords.push('鱈魚');
    if (sideName.includes('花椒')) keywords.push('花椒');
    if (sideName.includes('薯球')) keywords.push('薯球');
    if (sideName.includes('雞塊')) keywords.push('雞塊');
    if (sideName.includes('雞條')) keywords.push('雞條');
    if (sideName.includes('星星')) keywords.push('星星');
    if (sideName.length >= 4) keywords.push(sideName.substring(0, 3));

    // Ensure we're on the sides page (re-navigate if needed after previous item's modal)
    const onSides = await page.evaluate(() => {
      const sideItems = [...document.querySelectorAll('[data-testid*="product"]')].filter(el =>
        el.getBoundingClientRect().height > 0 && el.textContent.includes('NT$')
      );
      return sideItems.length >= 3;
    });
    if (!onSides) {
      await navigateToSides();
      await page.waitForTimeout(2000);
    }

    // Scroll and search for the item
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    let found = null;
    for (let s = 0; s < 30; s++) {
      found = await page.evaluate((kws) => {
        const els = [...document.querySelectorAll('div, span, h3, button, [role="button"]')].filter(e => {
          const t = e.textContent.trim();
          if (t.length < 3 || t.length > 60 || e.getBoundingClientRect().height <= 0) return false;
          if (t.includes('訂單') || t.includes('尺寸') || t.includes('餅皮')) return false;
          return kws.some(k => t.includes(k));
        });
        els.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        if (els.length > 0) {
          const el = els[0];
          const clickTarget = el.closest('[role="button"]') || el.closest('button') || el.closest('[data-testid*="product"]') || el.parentElement?.parentElement || el;
          clickTarget.click();
          return el.textContent.trim().substring(0, 40);
        }
        return null;
      }, keywords);
      if (found) break;
      await page.evaluate(() => window.scrollBy(0, 400));
      await page.waitForTimeout(400);
    }

    if (!found) {
      // Try upsell cards as fallback
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      found = await page.evaluate((kws) => {
        const cards = [...document.querySelectorAll('[data-testid*="inline-upsell-card"], [data-testid*="product"]')];
        for (const card of cards) {
          const text = card.textContent || '';
          if (kws.some(k => text.includes(k)) && text.includes('增加') && card.getBoundingClientRect().height > 0) {
            const btn = card.querySelector('[data-testid*="button.add"]') || [...card.querySelectorAll('button, [role="button"]')].find(b => b.textContent.trim() === '增加');
            if (btn) { btn.click(); return 'upsell:' + text.substring(0, 30); }
          }
        }
        return null;
      }, keywords);
    }

    if (found) {
      console.log(`      found: "${found}"`);
      await page.waitForTimeout(2500);
      // Click add button if modal appeared
      await page.evaluate(() => {
        const modalBtn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0);
        if (modalBtn) { modalBtn.click(); return; }
        const inl = [...document.querySelectorAll('button, [role="button"]')].find(el => {
          const t = el.textContent.trim();
          return (t === '增加' || t === '加入') && el.getBoundingClientRect().height > 0;
        });
        if (inl) inl.click();
      });
      console.log(`      ✓`);
      await page.waitForTimeout(2000);
    } else {
      console.log(`      ✗ not found (tried: ${keywords.join(', ')})`);
    }
  }
}

// Add drink from suggestions
if (constraints.wantCola) {
  const drinkTotal = constraints.drinkCount || 1;
  console.log(`  [Drink] Selecting ${drinkTotal > 1 ? drinkTotal + ' drinks' : 'cola/drink'}...`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  // First drink: pick ONLY drink upsell cards (exclude non-drink items like chicken wings)
  const drinkResult = await page.evaluate((wantSpecificCola) => {
    const DRINK_KEYWORDS = ['可樂', '雪碧', '芬達', '奶茶', '紅茶', '綠茶', '檸檬', '汽水', '果汁', '舒跑', '1.25L', '600ml'];
    const NON_DRINK = ['雞翅', '雞塊', '薯球', '雞條', '濃湯', '烤翅', '披薩'];
    const cards = [...document.querySelectorAll('[data-testid*="inline-upsell-card"]')];
    // Find cards that are specifically drink items (not combo cards with mixed items)
    const drinkCards = [];
    for (const card of cards) {
      const text = card.textContent || '';
      if (!DRINK_KEYWORDS.some(k => text.includes(k))) continue;
      if (!text.includes('增加')) continue;
      // Check if this card is specifically a drink (not a mixed upsell section)
      // Look for individual add buttons within the card
      const addBtns = [...card.querySelectorAll('button, [role="button"]')].filter(b => b.textContent.trim() === '增加');
      for (const btn of addBtns) {
        // Get the item context around this button
        const itemContainer = btn.closest('[data-testid*="card"]') || btn.parentElement?.parentElement || btn.parentElement;
        const itemText = itemContainer ? itemContainer.textContent.trim() : '';
        if (DRINK_KEYWORDS.some(k => itemText.includes(k)) && !NON_DRINK.some(k => itemText.includes(k)) && itemText.length < 80) {
          drinkCards.push({ btn, text: itemText, card });
        }
      }
    }
    // If no individual drink buttons found, try the whole card approach
    if (drinkCards.length === 0) {
      for (const card of cards) {
        const text = card.textContent || '';
        if (DRINK_KEYWORDS.some(k => text.includes(k)) && text.length < 60 && !NON_DRINK.some(k => text.includes(k))) {
          const btn = card.querySelector('[data-testid*="button.add"]') || [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '增加');
          if (btn) drinkCards.push({ btn, text, card });
        }
      }
    }
    let target = drinkCards.length > 0 ? drinkCards[0] : null;
    if (wantSpecificCola && drinkCards.length > 0) {
      const colaItem = drinkCards.find(d => d.text.includes('可樂'));
      if (colaItem) target = colaItem;
    }
    if (target) {
      target.btn.click();
      // Extract just the drink name
      const nameMatch = target.text.match(/([\d.]+L[^\s]*|可樂|雪碧|芬達|奶茶|紅茶|綠茶|檸檬|汽水|果汁|舒跑)/);
      return nameMatch ? nameMatch[0] : target.text.split('NT$')[0].trim().substring(0, 15);
    }
    return null;
  }, constraints.wantSpecificCola);
  console.log(`    ${drinkResult ? '✓ ' + drinkResult : 'will add at checkout'}`);

  // Additional drinks: navigate to drinks menu and add from there
  if (drinkResult && drinkTotal > 1) {
    await page.waitForTimeout(1500);
    for (let di = 1; di < drinkTotal; di++) {
      console.log(`    Adding drink ${di + 1}/${drinkTotal} from menu...`);
      await page.goto('https://order.dominos.com.tw/menu/drinks', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      for (let s = 0; s < 5; s++) { await page.evaluate(() => window.scrollBy(0, 400)); await page.waitForTimeout(300); }
      // Click on a drink item
      const drinkClicked = await page.evaluate((wantSpecificCola) => {
        const DRINK_KEYWORDS = ['可樂', '雪碧', '芬達', '奶茶', '紅茶', '綠茶', '檸檬', '汽水', '果汁', '舒跑', '1.25L'];
        const els = [...document.querySelectorAll('div, span')].filter(e => {
          const t = e.textContent.trim();
          return DRINK_KEYWORDS.some(k => t.includes(k)) && t.length > 2 && t.length < 30 && e.children.length === 0 && e.getBoundingClientRect().height > 0;
        });
        let target = null;
        if (wantSpecificCola) target = els.find(el => el.textContent.includes('可樂'));
        if (!target && els.length > 0) target = els[Math.floor(Math.random() * els.length)];
        if (target) {
          const clickTarget = target.closest('[role="button"]') || target.closest('[data-testid]') || target.parentElement?.parentElement?.parentElement || target.parentElement?.parentElement || target;
          clickTarget.click();
          return target.textContent.trim();
        }
        return null;
      }, constraints.wantSpecificCola);
      if (!drinkClicked) { console.log(`    ✗ no drink found on menu`); continue; }
      await page.waitForTimeout(2500);
      // Try "增加到訂單中" (modal) first, then "增加" (inline)
      const added = await page.evaluate(() => {
        const modalBtn = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中' && el.getBoundingClientRect().height > 0);
        if (modalBtn) { modalBtn.click(); return 'modal'; }
        const inlineBtn = [...document.querySelectorAll('button, [role="button"]')].find(el => el.textContent.trim() === '增加' && el.getBoundingClientRect().height > 0);
        if (inlineBtn) { inlineBtn.click(); return 'inline'; }
        return null;
      });
      if (added) { console.log(`    ✓ ${drinkClicked} (${added})`); }
      else { console.log(`    ✗ no add button for ${drinkClicked}`); }
      await page.waitForTimeout(1500);
    }
  }
}

const cartText = await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim().match(/^\d+ 項目/) && e.textContent.includes('NT$')); return el ? el.textContent.trim() : ''; });
console.log(`  Cart: ${cartText}\n`);

// ============================================================
// STEP 4: Checkout
// ============================================================
console.log('=== STEP 4: Checkout ===');
await page.evaluate(() => { const b = [...document.querySelectorAll('div, button, span')].filter(el => el.textContent.trim() === '完成訂單' && el.children.length <= 2); if (b[0]) b[0].click(); });
await page.waitForTimeout(4000);

if (page.url().includes('product-recommendations')) {
  await page.evaluate(() => { const b = [...document.querySelectorAll('div, button, span, a')].filter(el => { const t = el.textContent.trim(); return (t.includes('不用了') || t === '繼續結帳') && t.length < 20; }); b.sort((a,b) => a.textContent.length - b.textContent.length); if (b[0]) b[0].click(); });
  await page.waitForTimeout(3000);
}
if (!page.url().includes('/checkout')) {
  await page.goto('https://order.dominos.com.tw/checkout', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(4000);
}

// Add side from checkout suggestions (skip in exact order mode — sides already added)
if (constraints.wantSide && !exactOrder) {
  console.log('  [Side] Adding from checkout suggestions...');
  await page.waitForTimeout(1000);
  const sideOk = await page.evaluate((noSeafood) => {
    const SEAFOOD = ['海鮮', '鮪魚', '蝦', '鱈魚', '魷魚', '蟹', '干貝', '鮭魚', '章魚', '花枝'];
    const allBtns = [...document.querySelectorAll('button, [role="button"]')].filter(b => b.textContent.trim() === '增加' && b.getBoundingClientRect().height > 0);
    const SIDE_KEYWORDS = ['雞條', '薯球', '雞塊', '濃湯', '烤翅', '薯餅', '洋蔥圈', '麵包球', '起司球', '雞米花'];
    const isSafe = (container) => !noSeafood || !SEAFOOD.some(w => container.textContent.includes(w));
    // Collect all safe side options
    const safeSides = [];
    for (const btn of allBtns) {
      const container = btn.closest('[data-testid]') || btn.parentElement?.parentElement?.parentElement;
      if (container && isSafe(container)) {
        const text = container.textContent.trim().substring(0, 40);
        const isSideItem = SIDE_KEYWORDS.some(k => container.textContent.includes(k)) || !container.textContent.includes('可樂');
        if (isSideItem) safeSides.push({ btn, text });
      }
    }
    // Pick random from available sides
    if (safeSides.length > 0) {
      const pick = safeSides[Math.floor(Math.random() * safeSides.length)];
      pick.btn.click();
      return pick.text;
    }
    if (allBtns.length > 0) { allBtns[0].click(); return 'fallback_any'; }
    return 'not_found';
  }, constraints.noSeafood);
  console.log(`    ${sideOk}`);
  await page.waitForTimeout(2000);
}

// Auto-apply coupons at checkout — SKIP if already applied at menu level (promoUsed)
if (exactOrder && exactOrder.wantCoupon && !promoUsed) {
  console.log('  [Coupon] Checking for available vouchers at checkout...');
  await page.waitForTimeout(2000);
  // Debug: dump all visible text related to coupons/vouchers on checkout page
  const couponDebug = await page.evaluate(() => {
    const keywords = ['優惠', '折扣', '券', 'coupon', 'voucher', 'promo', '新增', '套用'];
    const found = [];
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.children.length > 3) continue; // skip containers
      const t = el.textContent.trim();
      if (t.length < 2 || t.length > 60) continue;
      if (el.getBoundingClientRect().height === 0) continue;
      if (keywords.some(k => t.includes(k))) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const cls = el.className?.toString()?.substring(0, 30) || '';
        found.push(`[${tag}${role ? ' role=' + role : ''}] "${t}" (${cls})`);
      }
    }
    return found.slice(0, 20);
  });
  console.log('    [Debug] Coupon-related elements on checkout:');
  couponDebug.forEach(d => console.log(`      ${d}`));
  await page.screenshot({ path: `${SS}/coupon-debug.png` });

  // Look for "新增優惠券" or voucher section and click to expand/apply
  const couponResult = await page.evaluate(() => {
    // Strategy 1: Find "新增優惠券" button
    const addCouponBtns = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
      el.textContent.trim() === '新增優惠券' && el.getBoundingClientRect().height > 0
    );
    if (addCouponBtns.length > 0) { addCouponBtns[0].click(); return 'clicked:新增優惠券'; }
    // Strategy 2: Look for any clickable element with coupon-related text
    const expandBtn = [...document.querySelectorAll('div, button, span, a, [role="button"]')].find(el => {
      const t = el.textContent.trim();
      if (t.length < 2 || t.length > 40) return false;
      if (el.getBoundingClientRect().height === 0) return false;
      if (el.children.length > 3) return false;
      return t.includes('優惠券') || t.includes('折扣碼') || t.includes('新增優惠') || t.includes('查看可用') || t === '優惠' || t.includes('使用優惠');
    });
    if (expandBtn) { expandBtn.click(); return 'expanded:' + expandBtn.textContent.trim(); }
    // Strategy 3: Look for input field for coupon code
    const couponInput = document.querySelector('input[placeholder*="優惠"], input[placeholder*="折扣"], input[placeholder*="coupon"]');
    if (couponInput) return 'input_found';
    return 'no_coupon_ui';
  });
  console.log(`    Coupon: ${couponResult}`);
  await page.waitForTimeout(2000);

  // If a coupon list/modal opened, select the best matching one
  if (couponResult !== 'no_coupon_ui') {
    const appliedCoupon = await page.evaluate(() => {
      // Look for voucher items with "套用"/"使用"/"選擇" buttons
      const applyBtns = [...document.querySelectorAll('button, [role="button"]')].filter(el => {
        const t = el.textContent.trim();
        return (t === '套用' || t === '使用' || t === '選擇' || t === '領取') && el.getBoundingClientRect().height > 0;
      });
      if (applyBtns.length > 0) { applyBtns[0].click(); return applyBtns[0].parentElement?.textContent?.trim()?.substring(0, 50) || 'applied'; }
      // Look for radio buttons or selectable coupon cards
      const cards = [...document.querySelectorAll('[data-testid*="voucher"], [data-testid*="coupon"]')].filter(el => el.getBoundingClientRect().height > 0);
      if (cards.length > 0) { cards[0].click(); return 'card:' + cards[0].textContent.trim().substring(0, 40); }
      return null;
    });
    if (appliedCoupon) console.log(`    Applied: ${appliedCoupon}`);
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${SS}/coupon-applied.png` });
}

// Read final order
const orderDetails = await page.evaluate(() => { const body = document.body.innerText; const idx = body.indexOf('訂單細節'); if (idx >= 0) return body.substring(idx, idx + 800); return ''; });
const itemLines = orderDetails.match(/\d+ x/g) || [];
let actualTotal = 0;
const totalIdx = orderDetails.indexOf('全部訂單');
if (totalIdx >= 0) { const m = orderDetails.substring(totalIdx).match(/NT\$(\d+)/); if (m) actualTotal = parseInt(m[1]); }
const itemNames = [...orderDetails.matchAll(/\d+ x\n(.+)/g)].map(m => m[1].trim());

console.log(`\n  Final Order: ${itemLines.length} items, NT$${actualTotal}`);
itemNames.forEach(n => console.log(`    - ${n}`));
await page.screenshot({ path: `${SS}/smart-order.png` });

// Fill contact
async function fillField(sel, val) {
  const el = page.locator(sel).first();
  await el.click({ timeout: 5000 });
  await el.fill(val);
  await page.waitForTimeout(200);
  // Trigger React Native Web's onChange via native events
  await el.evaluate(node => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(node, node.value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new Event('blur', { bubbles: true }));
  });
  await page.waitForTimeout(200);
}

const needsFill = await page.evaluate(() => !!document.querySelector('input[aria-label="姓名*"]'));
if (needsFill) {
  console.log('  Filling contact...');
  await fillField('input[aria-label="姓名*"]', USER_NAME);
  await fillField('input[aria-label="手機號碼*"]', USER_PHONE);
  await fillField('input[aria-label="電子郵件信箱*"]', USER_EMAIL);
  await fillField('input[aria-label="行動發票載具"]', INVOICE_CARRIER);
  // Trigger blur on all fields to activate React validation
  await page.evaluate(() => {
    document.querySelectorAll('input').forEach(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    });
  });
  await page.waitForTimeout(2000);
  // Try clicking 確認 — force if disabled
  try {
    const confirmBtn = page.locator('[data-testid="my-details-modal.confirm-button"], button:has-text("確認")').first();
    await confirmBtn.click({ force: true, timeout: 5000 });
  } catch(e) {
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="my-details-modal.confirm-button"]') || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '確認');
      if (btn) { btn.removeAttribute('disabled'); btn.removeAttribute('aria-disabled'); btn.click(); }
    });
  }
  await page.waitForTimeout(2500);
  const saveBtn = page.locator('[data-testid="my-details-modal-confirm.confirm-button"]');
  if (await saveBtn.count() > 0) { await saveBtn.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
}

// Wait for payment
console.log('  Waiting for payment...');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(2000);
for (let i = 0; i < 15; i++) { if (await page.evaluate(() => !!document.querySelector('[data-testid="payment-method.CreditCard.tile"]'))) break; await page.waitForTimeout(1000); }
const payBtnText = await page.evaluate(() => { const btn = document.querySelector('[data-testid="payment-method.CreditCard.tile"]'); return btn ? btn.textContent.trim() : 'NOT FOUND'; });
console.log(`  Payment: ${payBtnText}`);
// Debug: check for minimum order warning or disabled buttons
const pageDebug = await page.evaluate(() => {
  const warnings = [...document.querySelectorAll('div, span')].filter(el => el.textContent.includes('最低') && el.textContent.length < 100).map(el => el.textContent.trim());
  const disabledBtns = [...document.querySelectorAll('button[disabled], [aria-disabled="true"]')].map(el => el.textContent.trim().substring(0, 50));
  const orderBtns = [...document.querySelectorAll('button, [role="button"]')].filter(el => el.textContent.includes('下單') && el.getBoundingClientRect().height > 0).map(el => ({ text: el.textContent.trim().substring(0, 50), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' }));
  return { warnings, disabledBtns: disabledBtns.slice(0, 5), orderBtns };
});
console.log(`  Debug:`, JSON.stringify(pageDebug));
await page.screenshot({ path: `${SS}/smart-before-pay.png` });
console.log(`  URL: ${page.url()}\n`);

// ============================================================
// STEP 5: Payment Gateway
// ============================================================
console.log('=== STEP 5: Payment ===');

// Aggressively remove ALL overlays and disabled states on payment tiles
await page.evaluate(() => {
  document.querySelectorAll('[data-testid*="payment-method"]').forEach(tile => {
    tile.querySelectorAll('*').forEach(el => {
      el.style.pointerEvents = 'auto';
      el.removeAttribute('disabled');
      el.removeAttribute('aria-disabled');
    });
    tile.style.pointerEvents = 'auto';
  });
  // Also remove all tabindex=0 empty div overlays globally
  document.querySelectorAll('div[tabindex="0"]').forEach(el => {
    if (el.children.length === 0) { el.style.pointerEvents = 'none'; el.style.display = 'none'; }
  });
});
await page.waitForTimeout(500);

// Step A: Select credit card payment method
const ccTile = page.locator('[data-testid="payment-method.CreditCard.tile"]');
await ccTile.click({ force: true }).catch(() => {});
await page.waitForTimeout(2000);

// Step B: Click 下單 to submit — this triggers navigation to paydollar
let gatewayReached = false;
for (let attempt = 0; attempt < 5 && !gatewayReached; attempt++) {
  // Remove overlays again before each attempt
  await page.evaluate(() => {
    document.querySelectorAll('div[tabindex="0"]').forEach(el => {
      if (el.children.length === 0) { el.style.pointerEvents = 'none'; el.style.display = 'none'; }
    });
    document.querySelectorAll('[disabled], [aria-disabled="true"]').forEach(el => {
      el.removeAttribute('disabled'); el.removeAttribute('aria-disabled');
      el.style.pointerEvents = 'auto';
    });
  });
  await page.waitForTimeout(300);

  try {
    if (attempt <= 1) {
      // Click the credit card tile's 下單 button specifically
      const clicked = await page.evaluate(() => {
        // Strategy: find the CreditCard tile and click its submit area
        const ccTile = document.querySelector('[data-testid="payment-method.CreditCard.tile"]');
        if (ccTile) {
          // Look for 下單 text within or near the CC tile
          const btnsInTile = [...ccTile.querySelectorAll('button, [role="button"], div, span')].filter(el => {
            const t = el.textContent.trim();
            return t.includes('下單') && !t.includes('重新') && t.length < 80;
          });
          if (btnsInTile.length > 0) { btnsInTile[0].click(); return 'cc-tile:' + btnsInTile[0].textContent.trim().substring(0, 40); }
          // Click the tile itself
          ccTile.click();
          return 'cc-tile-direct';
        }
        // Fallback: find button that starts with "信用卡" and contains "下單"
        const allBtns = [...document.querySelectorAll('button, [role="button"], div')].filter(el => {
          const t = el.textContent.trim();
          return t.startsWith('信用卡') && t.includes('下單') && el.getBoundingClientRect().height > 0 && t.length < 80;
        });
        if (allBtns.length > 0) { allBtns[0].click(); return allBtns[0].textContent.trim().substring(0, 40); }
        return null;
      });
      console.log(`  Attempt ${attempt + 1}: clicked "${clicked}"`);
      await page.waitForURL(/paydollar/, { timeout: 12000 });
    } else if (attempt === 2) {
      // Try clicking with mouse coordinates
      const box = await ccTile.boundingBox();
      if (box) await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
      await page.waitForURL(/paydollar/, { timeout: 12000 });
    } else if (attempt === 3) {
      // Try page.click on the testid directly
      await page.click('[data-testid="payment-method.CreditCard.tile"]', { force: true });
      await page.waitForURL(/paydollar/, { timeout: 12000 });
    } else {
      // Navigate directly if we can find the payment URL
      const links = await page.evaluate(() => [...document.querySelectorAll('a, form')].map(el => el.href || el.action).filter(u => u && u.includes('paydollar')));
      if (links.length > 0) { await page.goto(links[0]); }
      else {
        // Submit any form on the page
        await page.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
      }
      await page.waitForURL(/paydollar/, { timeout: 12000 });
    }
    gatewayReached = true;
  } catch(e) {
    console.log(`  Payment attempt ${attempt + 1} failed`);
    await page.waitForTimeout(1000);
  }
}
if (!gatewayReached) {
  // Last resort: check if maybe we need to navigate to checkout/payment
  console.log('  All attempts failed. Current URL:', page.url());
  const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('  Page content:', bodySnippet.substring(0, 200));
  await page.screenshot({ path: `${SS}/smart-pay-fail.png` });
  await browser.close(); process.exit(1);
}
console.log('  Payment gateway reached');
await page.waitForTimeout(1500);

// Select Visa/CC
await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')];
  const visa = imgs.find(i => (i.alt || '').toLowerCase().includes('visa') || (i.src || '').toLowerCase().includes('visa'));
  if (visa) { (visa.closest('a') || visa.parentElement).click(); return; }
  const links = [...document.querySelectorAll('a, td, div')];
  const cc = links.find(el => el.textContent.trim() === '信用卡' || /^Card$/i.test(el.textContent.trim()));
  if (cc) { (cc.closest('a') || cc).click(); }
});
await page.waitForTimeout(2000);

// Now retrieve virtual card via MCP (like a real person looking up their card at payment time)
console.log('  Retrieving virtual card via MCP (view_virtual_card)...');
const mcpRes = await fetch(CARD_MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'view_virtual_card', arguments: { passphrase: PASSPHRASE, card_opaque_id: CARD_OPAQUE_ID, settlement_tx: SETTLEMENT_TX } } }) });
const mcpJson = await mcpRes.json();
console.log('  MCP Response:', JSON.stringify(mcpJson, null, 2));
let iframeUrl = '';
let cardHtml = '';
if (mcpJson.result && mcpJson.result.content) {
  for (const item of mcpJson.result.content) {
    if (item.text) {
      try {
        const p = JSON.parse(item.text);
        if (p.iframe_url) iframeUrl = p.iframe_url;
        if (p.card_html) cardHtml = p.card_html;
      } catch(e) {}
    }
  }
}

// Parse card details from card_html if available
if (cardHtml) {
  const numM = cardHtml.match(/card-number[^>]*>([^<]+)/);
  const expM = cardHtml.match(/exp_val[^>]*>([^<]+)/);
  const cvvM = cardHtml.match(/cvv_val[^>]*>([^<]+)/);
  if (numM) CARD_NUMBER = numM[1].trim().replace(/\s/g, '');
  if (expM) {
    const parts = expM[1].trim().match(/(\d{2})\/(\d{2,4})/);
    if (parts) { CARD_EXP_MM = parts[1]; CARD_EXP_YY = parts[2].length === 4 ? parts[2].substring(2) : parts[2]; }
  }
  if (cvvM) CARD_CVV = cvvM[1].trim();
  console.log(`  Card (from card_html): ${CARD_NUMBER.substring(0,4)} **** **** ${CARD_NUMBER.substring(12)}, Exp: ${CARD_EXP_MM}/${CARD_EXP_YY}`);
  // Show card in visible tab — fetch CSS from merchant server and inline it
  const cardPage = await context.newPage();
  let cvvCss = '', physCss = '';
  try { cvvCss = await (await fetch('https://merchant.cop.xfers.com/static/cvv/assets/cvv.css')).text(); } catch(e) {}
  try { physCss = await (await fetch('https://merchant.cop.xfers.com/static/cvv/assets/Xfers/physical.css')).text(); } catch(e) {}
  physCss = physCss.replace(/url\("\/static/g, 'url("https://merchant.cop.xfers.com/static');
  const displayHtml = cardHtml
    .replace(/<link[^>]*cvv\.css[^>]*>/, `<style>${cvvCss}</style>`)
    .replace(/<link[^>]*physical\.css[^>]*>/, `<style>${physCss}</style>`);
  await cardPage.setContent(displayHtml, { waitUntil: 'networkidle' });
  await cardPage.waitForTimeout(2000);
  await cardPage.screenshot({ path: `${SS}/smart-card.png` });
} else if (iframeUrl) {
  // Fallback: iframe only (no card_html) — embed in wrapper page
  const cardPage = await context.newPage();
  await cardPage.setContent(`<!DOCTYPE html><html><head><title>StraitsX Virtual Card</title></head><body style="margin:0;padding:0;overflow:hidden;"><iframe id="cf" src="${iframeUrl}" style="width:100vw;height:100vh;border:none;"></iframe></body></html>`, { waitUntil: 'networkidle' });
  await cardPage.waitForTimeout(2000);
  let cardText = '';
  try { cardText = await cardPage.frameLocator('#cf').locator('body').innerText({ timeout: 5000 }); } catch(e) {}
  await cardPage.screenshot({ path: `${SS}/smart-card.png` });
  const cardNumMatch = cardText.match(/(\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/);
  const expMatch = cardText.match(/(\d{2})\/(\d{2})/);
  const cvvMatch = cardText.match(/CVV[\s\n]*(\d{3})/i);
  if (cardNumMatch) CARD_NUMBER = cardNumMatch[1].replace(/\s/g, '');
  if (expMatch) { CARD_EXP_MM = expMatch[1]; CARD_EXP_YY = expMatch[2]; }
  if (cvvMatch) CARD_CVV = cvvMatch[1];
  console.log(`  Card (from iframe): ${CARD_NUMBER.substring(0,4)} **** **** ${CARD_NUMBER.substring(12)}, Exp: ${CARD_EXP_MM}/${CARD_EXP_YY}`);
} else {
  console.log('FATAL: No card_html or iframe_url from MCP. Full response above.');
  await browser.close();
  process.exit(1);
}

// Switch back and fill
await page.bringToFront();
await page.waitForTimeout(500);

console.log('  Filling card details...');
const cardInputs = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => { const s = window.getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden'; }).map(el => ({ name: el.name, id: el.id, maxLength: el.maxLength, placeholder: el.placeholder })));
for (const inp of cardInputs) {
  const sel = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
  const hint = (inp.name + inp.id + inp.placeholder).toLowerCase();
  try {
    if (hint.includes('cardno') || hint.includes('card_no') || hint.includes('pan') || inp.maxLength === 16 || inp.maxLength === 19) await page.locator(sel).first().fill(CARD_NUMBER);
    else if (hint.includes('cvv') || hint.includes('cvc') || hint.includes('security') || inp.maxLength === 3 || inp.maxLength === 4) await page.locator(sel).first().fill(CARD_CVV);
    else if (hint.includes('holder') || hint.includes('cardname') || hint.includes('cardholder')) await page.locator(sel).first().fill(CARD_NAME);
  } catch(e) {}
}
const selects = await page.evaluate(() => [...document.querySelectorAll('select')].map(s => ({ name: s.name, id: s.id })));
for (const s of selects) {
  const hint = (s.name + s.id).toLowerCase();
  const selector = s.id ? `#${s.id}` : `select[name="${s.name}"]`;
  try {
    if (hint.includes('month') || hint.includes('mm')) await page.locator(selector).first().selectOption(CARD_EXP_MM);
    else if (hint.includes('year') || hint.includes('yy')) { try { await page.locator(selector).first().selectOption(`20${CARD_EXP_YY}`); } catch(e) { await page.locator(selector).first().selectOption(CARD_EXP_YY); } }
  } catch(e) {}
}
await page.waitForTimeout(1000);
await page.screenshot({ path: `${SS}/smart-filled.png` });

const payAmount = await page.evaluate(() => { const m = document.body.innerText.match(/(TWD|NT\$?)\s*[\d,.]+/); return m ? m[0] : 'unknown'; });
console.log(`  Gateway amount: ${payAmount}`);

// Submit payment if --submit flag
if (SUBMIT_PAYMENT) {
  console.log('  Submitting payment...');
  // Auto-accept any confirmation dialogs (e.g. "確認付款?")
  page.on('dialog', async dialog => {
    console.log(`  Dialog: "${dialog.message()}" → accepting`);
    await dialog.accept();
  });
  // Debug: show all clickable elements on payment page
  const payBtns = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input[type="submit"], button[type="submit"], input[type="image"], input[type="button"], button, a')].filter(el => el.getBoundingClientRect().height > 0);
    return els.map(el => ({ tag: el.tagName, type: el.type, value: el.value, text: el.textContent?.trim()?.substring(0, 30), name: el.name }));
  });
  console.log('  Payment page buttons:', JSON.stringify(payBtns));
  // Click submit
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('input[type="submit"], button[type="submit"], input[type="image"]')].find(el => el.getBoundingClientRect().height > 0);
    if (btn) { btn.click(); return btn.tagName + ':' + (btn.value || btn.name || btn.textContent?.trim()); }
    // Fallback: any input[type="button"] or button
    const fallback = [...document.querySelectorAll('input[type="button"], button')].find(el => el.getBoundingClientRect().height > 0 && (el.value?.includes('Pay') || el.value?.includes('Submit') || el.textContent?.includes('Pay') || el.textContent?.includes('Submit')));
    if (fallback) { fallback.click(); return 'fallback:' + (fallback.value || fallback.textContent?.trim()); }
    return null;
  });
  console.log(`  Clicked: ${clicked}`);
  // Wait for 3DS verification — StraitsX auto-approves but it takes time
  console.log('  Waiting for navigation after submit...');
  try {
    await page.waitForURL(url => !url.toString().includes('payForm'), { timeout: 30000 });
  } catch(e) {
    // May already have navigated
  }
  console.log('  Post-submit URL:', page.url());
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SS}/smart-3ds.png` });
  // Check if we're on a 3DS page and wait for redirect back to Domino's
  const currentUrl = page.url();
  const is3ds = currentUrl.includes('3ds') || currentUrl.includes('acs') || currentUrl.includes('secure') || currentUrl.includes('paydollar');
  if (is3ds) {
    console.log('  3DS page detected, waiting for auto-approval (up to 90s)...');
    try {
      await page.waitForURL(url => url.toString().includes('dominos') || url.toString().includes('order'), { timeout: 90000 });
    } catch(e) {
      console.log('  3DS wait timed out, checking current state...');
    }
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SS}/smart-submitted.png` });
  console.log('  Final URL:', page.url());
  try {
    const finalText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log('  Page text:', finalText.replace(/\n/g, ' '));
  } catch(e) {
    console.log('  (could not read page text)');
  }
}

// ============================================================
// VERIFICATION
// ============================================================
const gwAmount = parseInt((payAmount.match(/[\d,]+/) || ['0'])[0].replace(',', ''));

console.log(`\n${'═'.repeat(55)}`);
console.log('  VERIFICATION REPORT');
console.log(`${'═'.repeat(55)}`);
console.log(`  Prompt: "${PROMPT}"`);
console.log(`  Items: ${itemLines.length} | Total: NT$${gwAmount}`);
console.log(`  Budget: NT$${constraints.budget} → ${gwAmount <= constraints.budget ? 'PASS ✓' : 'OVER ✗'}`);
console.log(`  Seafood check: ${constraints.noSeafood ? (itemNames.some(n => SEAFOOD_WORDS.some(w => n.includes(w))) ? 'FAIL ✗' : 'PASS ✓') : 'N/A'}`);
console.log(`  Drink: ${constraints.wantCola ? (itemNames.some(n => /可樂|雪碧|芬達|奶茶|紅茶|綠茶|檸檬|汽水|果汁|舒跑|L/.test(n)) ? 'PASS ✓' : 'FAIL ✗') : 'N/A'}`);
console.log(`  Side: ${constraints.wantSide ? (itemNames.length > selectedPizzas.length + (constraints.wantCola ? 1 : 0) ? 'PASS ✓' : 'FAIL ✗') : 'N/A'}`);
console.log(`  Card: ${CARD_NUMBER.length === 16 ? 'PASS ✓' : 'FAIL ✗'} (${CARD_NUMBER.substring(0,4)}***)`);
console.log(`  Payment: ${SUBMIT_PAYMENT ? 'SUBMITTED ✓' : 'Card filled, NOT submitted ✓'}`);
console.log(`${'═'.repeat(55)}\n`);

console.log('Browser open for inspection (press Ctrl+C to close)...');
await new Promise(() => {});
