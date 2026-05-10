// Site adapter interface — implement one per merchant site
// Each adapter handles site-specific DOM interactions
export const ADAPTER_INTERFACE = {
  name: '',           // e.g. 'dominos-tw'
  baseUrl: '',        // e.g. 'https://www.dominos.com.tw'

  // Store selection: navigate to store, handle open/closed state
  // Returns true if store is ready for ordering
  selectStore: async (page, constraints) => {},

  // Menu scan: extract all available items with names and prices
  // Returns [{ name, price, category }]
  scanMenu: async (page) => {},

  // Add item to cart by name, with size selection
  // Returns true if successfully added
  addToCart: async (page, itemName, options) => {},

  // Add drink/side from upsell suggestions
  addExtra: async (page, type) => {},  // type: 'drink' | 'side'

  // Navigate to checkout, fill contact info
  checkout: async (page, userInfo) => {},

  // Select credit card payment and reach payment gateway
  // Returns true when on payment gateway page
  reachPaymentGateway: async (page) => {},

  // Fill card details on payment gateway
  fillCard: async (page, cardDetails) => {},

  // Submit payment (only when --submit flag)
  submitPayment: async (page) => {},
};
