// Domino's Taiwan adapter — site-specific DOM interactions
// This is the reference implementation; other sites follow the same interface.

export default {
  name: 'dominos-tw',
  displayName: "達美樂 Domino's Taiwan",
  baseUrl: 'https://www.dominos.com.tw',
  menuUrl: 'https://order.dominos.com.tw/menu/pizza',
  checkoutUrl: 'https://order.dominos.com.tw/checkout',
  paymentGateway: 'paydollar',

  selectors: {
    deliveryBtn: 'text=外送',
    pickupBtn: 'text=外帶',
    addressInput: 'input[placeholder*="輸入"]',
    startNow: '[data-testid="start-order-now-button"]',
    startLater: '[data-testid="start-order-later-button"]',
    timeSelect: '[data-testid="OrderLaterContainer-OrderTime-select"]',
    dateSelect: '[data-testid="OrderLaterContainer-OrderDate-select"]',
    creditCardTile: '[data-testid="payment-method.CreditCard.tile"]',
    addToOrderBtn: 'button:has-text("增加到訂單中")',
    checkoutBtn: 'text=完成訂單',
  },

  // Domino's uses React Native Web with Pressable overlays
  // that block clicks — must remove them before interacting
  async removeOverlay(page, selector) {
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return;
      [...btn.querySelectorAll('div[tabindex="0"]')].forEach(el => {
        if (el.children.length === 0) {
          el.style.pointerEvents = 'none';
          el.style.display = 'none';
        }
      });
    }, selector);
  },

  async selectStore(page, constraints) {
    // Implementation in order.mjs STEP 1
    // Handles: delivery vs pickup, open vs closed (預約), time selection
  },

  async scanMenu(page) {
    // Implementation in order.mjs STEP 2
    // Scrolls page, extracts pizza names + NT$ prices from DOM text
  },

  async addToCart(page, itemName, options) {
    // Implementation in order.mjs STEP 3
    // Finds item by text match, selects size, clicks 增加到訂單中
  },

  async addExtra(page, type) {
    // Adds drink/side from inline-upsell-card or checkout suggestions
  },

  async checkout(page, userInfo) {
    // Fills 姓名, 手機號碼, 電子郵件信箱, 行動發票載具
    // Clicks 確認, handles my-details-modal-confirm
  },

  async reachPaymentGateway(page) {
    // Removes Pressable overlay, clicks credit card tile
    // Waits for redirect to paydollar URL
  },

  async fillCard(page, { number, expMM, expYY, cvv, holder }) {
    // Paydollar gateway: select Visa, fill card inputs + expiry selects
  },
};
