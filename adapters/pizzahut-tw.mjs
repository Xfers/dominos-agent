// Pizza Hut Taiwan adapter — stub for extensibility demo
// To implement: fill in each method with pizzahut.com.tw DOM interactions

export default {
  name: 'pizzahut-tw',
  displayName: '必勝客 Pizza Hut Taiwan',
  baseUrl: 'https://www.pizzahut.com.tw',
  menuUrl: 'https://www.pizzahut.com.tw/menu',
  checkoutUrl: 'https://www.pizzahut.com.tw/checkout',
  paymentGateway: 'unknown',

  selectors: {
    // TODO: inspect pizzahut.com.tw and fill selectors
    deliveryBtn: null,
    pickupBtn: null,
    addressInput: null,
    startNow: null,
    creditCardTile: null,
  },

  async selectStore(page, constraints) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async scanMenu(page) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async addToCart(page, itemName, options) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async addExtra(page, type) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async checkout(page, userInfo) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async reachPaymentGateway(page) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },

  async fillCard(page, cardDetails) {
    throw new Error('pizzahut-tw adapter not yet implemented');
  },
};
