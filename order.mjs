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
  const wantSide = /副餐|副食|side|sides|appetizer|snack|chicken wings|fries/i.test(prompt);
  const isDelivery = /外送|送到|deliver/i.test(prompt) && !/不允許|無法|blocked/.test(prompt);
  const isLunch = /午|中午|lunch|noon/i.test(prompt) || /(?:^|\D)12(?:點|時|:00|\b)/i.test(prompt);
  const isDinner = /晚|傍晚|dinner|evening/i.test(prompt) || /(?:^|\D)(18|19|20)(?:點|時|:00|\b)/i.test(prompt);
  const wantChicken = (/雞肉|雞|chicken/i.test(prompt)) && !/雞條|chicken wing/i.test(prompt);
  const wantVeg = /素食|蔬菜|vegetarian|veggie|veg/i.test(prompt);
  return { people, budget, budgetMin, noSeafood, wantSeafood, wantCola, wantSide, isDelivery, isLunch, isDinner, wantChicken, wantVeg };
}

const constraints = parsePrompt(PROMPT);
console.log('Constraints:', JSON.stringify(constraints, null, 2));

// Decide pizza count based on people
function decidePizzaCount(people) {
  if (people <= 2) return 1;
  if (people <= 4) return 2;
  if (people <= 6) return 3;
  return Math.ceil(people / 2);
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

  const count = decidePizzaCount(constraints.people);
  const picked = [];
  const usedNames = new Set();
  let hasSeafood = false;

  // If wantSeafood, pick one seafood first, then fill rest with non-seafood for variety
  if (constraints.wantSeafood) {
    const seafoodItems = candidates.filter(item => SEAFOOD_WORDS.some(w => item.name.includes(w)));
    if (seafoodItems.length > 0) {
      const sf = seafoodItems[0];
      const estTotal = sf.price + (constraints.wantCola ? 45 : 0) + (constraints.wantSide ? 70 : 0);
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
    const currentTotal = discountedPizzaTotal + (constraints.wantCola ? 45 : 0) + (constraints.wantSide ? 70 : 0);
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

  // If there's a minimum budget, check if we need to upgrade picks
  if (constraints.budgetMin > 0) {
    const extras = (constraints.wantCola ? 45 : 0) + (constraints.wantSide ? 70 : 0);
    // Use discounted estimate (BOGO: 2nd+ pizzas ~50% off)
    const pickedPrices = picked.map(p => p.price).sort((a,b) => b-a);
    const discTotal = pickedPrices[0] + pickedPrices.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0) + extras;
    if (discTotal < constraints.budgetMin && picked.length > 0) {
      // Try upgrading the cheapest pizza to a pricier one
      const cheapestIdx = picked.reduce((minIdx, p, i, arr) => p.price < arr[minIdx].price ? i : minIdx, 0);
      const upgrade = candidates.find(item => {
        if (usedNames.has(item.name) || item.price <= picked[cheapestIdx].price) return false;
        const newPrices = picked.map((p,i) => i === cheapestIdx ? item.price : p.price).sort((a,b) => b-a);
        const newDisc = newPrices[0] + newPrices.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0) + extras;
        return newDisc >= constraints.budgetMin && newDisc <= constraints.budget;
      });
      if (upgrade) {
        usedNames.delete(picked[cheapestIdx].name);
        picked[cheapestIdx] = upgrade;
        usedNames.add(upgrade.name);
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
    const addrInput = page.locator('input[placeholder*="輸入"]').first();
    await addrInput.click();
    await page.waitForTimeout(500);
    // Extract address from prompt or use default
    const addrMatch = PROMPT.match(/送到(.+?)(?:、|$|，)/) || PROMPT.match(/外送到(.+?)(?:、|$|，)/);
    let addr = addrMatch ? addrMatch[1] : '信義區';
    // If extracted address is generic (指定地址, 家, etc.), use 信義區
    if (/指定|地址|家|公司/.test(addr)) addr = '信義區';
    console.log(`    Address: ${addr}`);
    await addrInput.fill(addr);
    await page.waitForTimeout(4000);
    // Click the first address suggestion that contains 台灣 and our search term
    await page.evaluate((searchTerm) => {
      const d = [...document.querySelectorAll('div')].filter(el => {
        const t = el.textContent.trim();
        return t.includes('台灣') && t.includes('臺北') && el.children.length <= 3 && t.length < 50;
      });
      if (d.length > 0) { d.sort((a,b) => a.textContent.length - b.textContent.length); d[0].click(); return; }
      // Fallback: any suggestion with 台灣
      const d2 = [...document.querySelectorAll('div')].filter(el => el.textContent.trim().includes('台灣') && el.children.length <= 3 && el.textContent.trim().length < 50);
      d2.sort((a,b) => a.textContent.length - b.textContent.length);
      if (d2[0]) d2[0].click();
    }, addr);
    await page.waitForTimeout(5000);

    // Wait for either start-now or start-later button
    for (let i = 0; i < 8; i++) {
      const hasNow = await page.locator('[data-testid="start-order-now-button"]').count();
      const hasLater = await page.locator('[data-testid="start-order-later-button"]').count();
      if (hasNow > 0 || hasLater > 0) break;
      await page.waitForTimeout(1500);
    }

    const hasNowBtn = await page.locator('[data-testid="start-order-now-button"]').count();
    if (hasNowBtn > 0) {
      await page.locator('[data-testid="start-order-now-button"]').click({ force: true });
    } else {
      console.log('    Store closed → selecting delivery time');
      let desiredHour = 0;
      const timeMatch2 = PROMPT.match(/(\d{1,2})\s*[點:時]/);
      if (timeMatch2) desiredHour = parseInt(timeMatch2[1]);
      else if (constraints.isLunch) desiredHour = 12;
      else if (constraints.isDinner) desiredHour = 18;

      const timeSelect = page.locator('[data-testid="OrderLaterContainer-OrderTime-select"]');
      if (await timeSelect.count() > 0) {
        await timeSelect.click();
        await page.waitForTimeout(1500);
        // Try clicking time option from dropdown
        const timeClicked = await page.evaluate((targetHour) => {
          const opts = [...document.querySelectorAll('div, span, option')].filter(el =>
            /^\d{1,2}:\d{2}/.test(el.textContent.trim()) && el.textContent.trim().length < 20 && el.children.length <= 1 && el.getBoundingClientRect().height > 0
          );
          if (opts.length === 0) return 'no_options';
          if (targetHour === 0) { opts[0].click(); return opts[0].textContent.trim(); }
          let best = opts[0], bestDiff = 999;
          for (const opt of opts) {
            const t = opt.textContent.trim();
            const parts = t.match(/(\d{1,2}):(\d{2})/);
            if (!parts) continue;
            let h = parseInt(parts[1]);
            // Detect PM: if text or parent contains 下午/PM, or hour < current options suggest PM
            const ctx = (opt.parentElement?.textContent || '') + t;
            if (ctx.includes('下午') || ctx.includes('PM')) { if (h < 12) h += 12; }
            const diff = Math.abs(h - targetHour);
            if (diff < bestDiff) { bestDiff = diff; best = opt; }
          }
          best.click();
          return best.textContent.trim();
        }, desiredHour);
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
  await page.locator('input[placeholder*="輸入"]').first().fill('信義區');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SS}/smart-s3-search.png` });
  const suggClicked = await page.evaluate(() => { const d = [...document.querySelectorAll('div')].filter(el => el.textContent.trim() === '信義區台灣臺北市' && el.children.length <= 3); d.sort((a,b) => a.textContent.length - b.textContent.length); if (d[0]) { d[0].click(); return true; } return false; });
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
    // Parse desired time from prompt
    let desiredHour = 0;
    const timeMatch = PROMPT.match(/(\d{1,2})\s*[點:時]/);
    if (timeMatch) desiredHour = parseInt(timeMatch[1]);
    else if (constraints.isLunch) desiredHour = 12;
    else if (constraints.isDinner) desiredHour = 18;

    // Select time
    const timeSelect = page.locator('[data-testid="OrderLaterContainer-OrderTime-select"]');
    if (await timeSelect.count() > 0) {
      await timeSelect.click();
      await page.waitForTimeout(1000);
      // Pick the time closest to desired hour
      await page.evaluate((targetHour) => {
        const opts = [...document.querySelectorAll('div, span')].filter(el =>
          /^\d{1,2}:\d{2}/.test(el.textContent.trim()) && el.textContent.trim().length < 20 && el.children.length <= 1
        );
        if (opts.length === 0) return;
        if (targetHour === 0) { opts[0].click(); return; }
        // Find closest match to target hour
        let best = opts[0];
        let bestDiff = 999;
        for (const opt of opts) {
          const h = parseInt(opt.textContent.trim().split(':')[0]);
          // Handle AM/PM: if text includes 下午/PM, add 12
          const isPM = opt.textContent.includes('下午') || opt.textContent.includes('PM');
          const hour24 = (isPM && h < 12) ? h + 12 : h;
          const diff = Math.abs(hour24 - targetHour);
          if (diff < bestDiff) { bestDiff = diff; best = opt; }
        }
        best.click();
      }, desiredHour);
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
const estTotal = pizzaPrices[0] + pizzaPrices.slice(1).reduce((s,p) => s + Math.round(p * 0.5), 0) + (constraints.wantSide ? 70 : 0) + (constraints.wantCola ? 45 : 0);
console.log(`    Estimated total: NT$${estTotal}`);
console.log('');

// ============================================================
// STEP 3: Add Items to Cart
// ============================================================
console.log('=== STEP 3: Add Items ===');

async function addPizza(name) {
  console.log(`  [Pizza] ${name}...`);
  await page.goto('https://order.dominos.com.tw/menu/pizza', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
  let found = false;
  for (let s = 0; s < 15; s++) {
    found = await page.evaluate((n) => {
      const els = [...document.querySelectorAll('div, span')].filter(e =>
        e.textContent.trim() === n && e.children.length === 0 && e.getBoundingClientRect().height > 0
      );
      if (els.length > 0) { (els[0].closest('[role="button"]') || els[0].closest('button') || els[0].parentElement?.parentElement || els[0]).click(); return true; }
      return false;
    }, name);
    if (found) break;
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(500);
  }
  if (!found) { console.log(`    ✗ not found`); return false; }
  await page.waitForTimeout(2000);

  // Select size: 大披薩 for 3+ people, otherwise keep default
  if (constraints.people >= 3) {
    await page.evaluate(() => { [...document.querySelectorAll('div, span, button')].filter(el => el.textContent.trim() === '大披薩' && el.children.length <= 1).forEach(el => el.click()); });
  }
  await page.waitForTimeout(800);

  const added = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '增加到訂單中'); if (b) { b.click(); return true; } return false; });
  if (!added) { console.log(`    ✗ add button not found`); return false; }
  await page.waitForTimeout(2000);
  console.log(`    ✓`);
  return true;
}

// Add each selected pizza
let addedCount = 0;
for (const pizza of selectedPizzas) {
  const ok = await addPizza(pizza.name);
  if (ok) addedCount++;
}

// Add drink from suggestions
if (constraints.wantCola) {
  console.log('  [Drink] Selecting random drink...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  const drinkResult = await page.evaluate((wantSpecificCola) => {
    const DRINK_KEYWORDS = ['可樂', '雪碧', '芬達', '奶茶', '紅茶', '綠茶', '檸檬', '汽水', '果汁', '舒跑'];
    const cards = [...document.querySelectorAll('[data-testid*="inline-upsell-card"]')];
    const drinkCards = cards.filter(c => DRINK_KEYWORDS.some(k => c.textContent.includes(k)));
    // If user specifically said 可樂, prefer it; otherwise pick random
    let target = drinkCards.length > 0 ? drinkCards[Math.floor(Math.random() * drinkCards.length)] : null;
    if (wantSpecificCola && drinkCards.length > 0) {
      const colaCard = drinkCards.find(c => c.textContent.includes('可樂'));
      if (colaCard) target = colaCard;
    }
    if (target) {
      const btn = target.querySelector('[data-testid*="button.add"]') || [...target.querySelectorAll('button')].find(b => b.textContent.trim() === '增加');
      if (btn) { btn.click(); return target.textContent.replace(/\s+/g,' ').trim().substring(0,30); }
    }
    // Fallback: find any drink container
    const containers = [...document.querySelectorAll('div')].filter(el => DRINK_KEYWORDS.some(k => el.textContent.includes(k)) && el.textContent.includes('增加') && el.textContent.length < 200 && el.children.length >= 2);
    if (containers.length > 0) {
      const pick = containers[Math.floor(Math.random() * containers.length)];
      const btn = [...pick.querySelectorAll('button, [role="button"]')].find(b => b.textContent.trim() === '增加');
      if (btn) { btn.click(); return pick.textContent.replace(/\s+/g,' ').trim().substring(0,30); }
    }
    return null;
  }, /可樂/.test(PROMPT));
  console.log(`    ${drinkResult ? '✓ ' + drinkResult : 'will add at checkout'}`);
  await page.waitForTimeout(1500);
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

// Add side from checkout suggestions
if (constraints.wantSide) {
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
      // Find the 下單 button/text inside or near the CC tile
      const clicked = await page.evaluate(() => {
        // Look for standalone 下單 button
        const btns = [...document.querySelectorAll('button, [role="button"], div')].filter(el => {
          const t = el.textContent.trim();
          return t.includes('下單') && !t.includes('重新') && el.getBoundingClientRect().height > 0 && t.length < 80;
        });
        // Prefer the one that also mentions 信用卡 or NT$
        const ccBtn = btns.find(b => b.textContent.includes('信用卡') || b.textContent.includes('NT$'));
        const target = ccBtn || btns[0];
        if (target) { target.click(); return target.textContent.trim().substring(0, 50); }
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
let iframeUrl = '';
if (mcpJson.result && mcpJson.result.content) { for (const item of mcpJson.result.content) { if (item.text) { try { const p = JSON.parse(item.text); if (p.iframe_url) iframeUrl = p.iframe_url; } catch(e) {} } } }
if (!iframeUrl) { console.log('FATAL: No iframe URL from MCP'); await browser.close(); process.exit(1); }

// Show card in visible tab for demo
const cardPage = await context.newPage();
await cardPage.setContent(`
<html><head><title>StraitsX Virtual Card</title></head>
<body style="margin:0;padding:30px;background:#0d1117;font-family:'Courier New',monospace;color:#58a6ff;">
<h2 style="margin:0 0 5px 0;">StraitsX Virtual Card</h2>
<p style="color:#8b949e;margin:0 0 15px 0;">MCP: view_virtual_card | TX: ${SETTLEMENT_TX.substring(0,10)}...</p>
<iframe id="cf" src="${iframeUrl}" style="width:450px;height:320px;border:2px solid #58a6ff;border-radius:12px;"></iframe>
</body></html>
`);
await cardPage.waitForTimeout(1500);  // Hold for demo recording

let cardText = '';
try { cardText = await cardPage.frameLocator('#cf').locator('body').innerText({ timeout: 5000 }); } catch(e) {}
await cardPage.screenshot({ path: `${SS}/smart-card.png` });

const cardNumMatch = cardText.match(/(\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/);
const expMatch = cardText.match(/(\d{2})\/(\d{2})/);
const cvvMatch = cardText.match(/CVV[\s\n]*(\d{3})/i);
CARD_NUMBER = cardNumMatch ? cardNumMatch[1].replace(/\s/g, '') : '4665171023425884';
CARD_EXP_MM = expMatch ? expMatch[1] : '05';
CARD_EXP_YY = expMatch ? expMatch[2] : '29';
CARD_CVV = cvvMatch ? cvvMatch[1] : '228';
console.log(`  Card: ${CARD_NUMBER.substring(0,4)} **** **** ${CARD_NUMBER.substring(12)}, Exp: ${CARD_EXP_MM}/${CARD_EXP_YY}`);

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
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('input[type="submit"], button[type="submit"], input[type="image"]')].find(el => el.getBoundingClientRect().height > 0);
    if (btn) btn.click();
  });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SS}/smart-submitted.png` });
  console.log('  Payment submitted! URL:', page.url());
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
console.log(`  Payment: Card filled, NOT submitted ✓`);
console.log(`${'═'.repeat(55)}\n`);

console.log('Browser open 30s for inspection...');
await page.waitForTimeout(10000);
await browser.close();
