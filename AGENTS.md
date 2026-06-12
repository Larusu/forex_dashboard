Create a complete responsive Foreign Exchange Dashboard using HTML, CSS, and JavaScript in a single HTML file.

Use this API:
https://github.com/fawazahmed0/exchange-api

Use these API endpoint patterns:
Primary:
https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{baseCurrency}.json

Historical:
https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@YYYY-MM-DD/v1/currencies/{baseCurrency}.json

Fallback:
https://latest.currency-api.pages.dev/v1/currencies/{baseCurrency}.json
https://YYYY-MM-DD.currency-api.pages.dev/v1/currencies/{baseCurrency}.json

Build a polished foreign exchange dashboard with the following features:

1. Current value section
- Show the selected base currency and target currency.
- Display the latest exchange rate prominently.
- Include daily percentage change if historical data is available.
- Add small status badges such as “Uptrend,” “Downtrend,” or “Stable.”

2. Currency table or list
- Show a searchable and sortable table of currency exchange rates.
- Include currency code, currency name if available, current rate, change percentage, and trend direction.
- Highlight strongest and weakest currencies.

3. Candlestick chart
- Add a candlestick-style chart for the selected currency pair.
- Since the API provides daily exchange rates, build historical candles using daily values.
- Use previous day rate as open and current day rate as close.
- Estimate high and low based on the daily range or volatility.
- Clearly label the candlestick chart as “daily estimated candles.”

4. Line chart
- Add a clean historical line chart showing exchange rate movement over time.
- Let users choose 7 days, 14 days, 30 days, and 90 days.
- Use Chart.js or a lightweight chart library through CDN.

5. Calculator
- Add a currency converter calculator.
- Inputs:
  - Amount
  - From currency
  - To currency
- Output the converted amount instantly.
- Update the result whenever the user changes amount or currency.

6. Pattern and trend analysis
- Detect simple market patterns using JavaScript:
  - Uptrend
  - Downtrend
  - Sideways movement
  - Breakout
  - Volatility spike
  - Moving average crossover
- Show a short explanation for each detected pattern.

7. AI insight panel
- Create an “AI Insight” card.
- Generate smart, human-readable insights based on the exchange rate data.
- Do not use a paid AI API.
- Use rule-based analysis that feels intelligent.
- Example insights:
  - “USD/PHP is showing mild upward pressure over the last 7 days.”
  - “Volatility is higher than usual, so short-term movement may be unstable.”
  - “The current price is above its 7-day moving average, suggesting bullish momentum.”

8. Heatmap
- Add a currency strength heatmap.
- Compare major currencies such as USD, EUR, GBP, JPY, AUD, CAD, CHF, CNY, SGD, and PHP.
- Use cool colors only.
- Use blue, cyan, teal, navy, slate, and soft green tones.
- Do not use purple.
- Strong currencies should appear brighter or more saturated.
- Weak currencies should appear darker or muted.

9. Light and dark mode
- Add a toggle for light mode and dark mode.
- Save the user’s selected theme using localStorage.
- Design both themes carefully.
- Light mode should feel clean and airy.
- Dark mode should feel professional and finance-focused.

10. Visual and design requirements
- Use a modern dashboard layout.
- Color palette must use cool colors only.
- Avoid purple completely.
- Suggested colors:
  - Navy
  - Deep blue
  - Cyan
  - Teal
  - Slate
  - Ice blue
  - Soft mint
- Use glassmorphism or subtle card shadows.
- Use rounded cards, clean spacing, and responsive grids.
- Make it look like a professional fintech dashboard.
- Add smooth hover states and transitions.
- Make the dashboard fully responsive for desktop, tablet, and mobile.

11. UX requirements
- Add currency selectors for base and target currency.
- Add loading states while fetching data.
- Add error handling if the API request fails.
- Use the fallback API automatically if the primary API fails.
- Add refresh button.
- Add last updated timestamp.
- Make all charts and values update when the selected currencies change.

12. Technical requirements
- Put everything in one HTML file.
- Include HTML, CSS, and JavaScript.
- Use semantic HTML.
- Use CSS variables for themes.
- Use async/await for API calls.
- Use clean reusable JavaScript functions.
- Comment important sections of the code.
- Avoid unnecessary frameworks.
- CDN libraries are allowed for charts only.
- The final output should be ready to copy, paste, and run in a browser.

Important:
- Do not use purple anywhere in the UI.
- Make the design visually impressive.
- The dashboard should not be static.
- It must fetch real exchange-rate data from the provided API.
- If exact OHLC data is not available, clearly present the candlestick as estimated from daily exchange-rate values.
