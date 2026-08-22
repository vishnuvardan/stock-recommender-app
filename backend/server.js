import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend integration
app.use(cors());
app.use(express.json());

// Initialize Google GenAI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ordered list of models for fallback (containing only valid, supported model strings to avoid 404s)
const GEMINI_MODELS = [
  'gemini-3.5-flash',       // Primary stable target
  'gemini-3.1-flash-lite',  // High-efficiency alternative
  'gemini-2.5-flash',       // Highly responsive fallback
  'gemini-2.5-flash-lite',  // Core light fallback
  'gemini-3.1-flash',       // Next-gen flash alternative
  'gemini-3-flash',         // Tier 3 flash model
  'gemini-3.1-pro',         // High-reasoning backup
  'gemini-2.5-pro',         // Stable professional backup
  'gemini-3-pro',           // Alternate high-intelligence tier
  'gemini-3-deep-think'     // Ultimate deep analysis tier fallback
];

const SYSTEM_INSTRUCTION = `You are an expert Indian financial market macro analyst specializing in the NSE and BSE. Your task is to process 20 live market headlines. 

1. Filter and evaluate how each piece of news impacts India's economy or specific publicly listed Indian companies on the NSE/BSE. 
2. Categorize every relevant news item strictly into one of three classifications:
   - "Good news": Positive economic, sector, or company-specific catalysts.
   - "No change": Neutral news, general market noise, or items with no short-term impact.
   - "Bad news": Negative regulatory, earnings, macroeconomic, or company-specific headwinds.
3. Generate recommendations based on the classification:
   - For "Good news": Recommend a highly relevant Indian stock ticker (NSE/BSE) that will likely benefit, along with a concise summary explanation of why it can go up.
   - For "No change": Identify a related Indian stock/sector asset that matches the theme of the headline, but explicitly tag the recommendation action as "HOLD/MONITOR" with no directional target.
   - For "Bad news": Recommend a related Indian stock ticker likely to drop, along with a concise summary explanation of why it can go down.

Return STRICTLY a JSON object matching this structural schema:
{
  "disclaimer": "This analysis is purely for swing trading purposes. Market news has highly volatile short-term impacts that can reverse rapidly. We are NOT SEBI registered advisors. This output is an AI-generated text analysis and does NOT constitute formal financial advice. Use your own knowledge and due diligence before making any trade decisions. We hold zero liability for financial actions taken based on this tool.",
  "lastUpdated": "ISO Timestamp",
  "items": [
    {
      "headline": "Original news title",
      "summary": "Original news description",
      "classification": "Good news" | "No change" | "Bad news",
      "relatedStock": "NSE/BSE Ticker (e.g. RELIANCE, TCS, HDFCBANK, INFY, TATASTEEL). MUST be a valid Indian stock ticker. Do NOT recommend foreign stocks like TSLA, AAPL, NVDA.",
      "recommendationReason": "Concise 2-sentence rationale outlining the directional momentum or lack thereof."
    }
  ]
}`;

// Structured JSON output schema definition to prevent JSON parse errors
const RECOMMENDATION_SCHEMA = {
  type: "object",
  properties: {
    disclaimer: { type: "string" },
    lastUpdated: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          classification: { 
            type: "string", 
            enum: ["Good news", "No change", "Bad news"] 
          },
          relatedStock: { type: "string" },
          recommendationReason: { type: "string" }
        },
        required: ["headline", "summary", "classification", "relatedStock", "recommendationReason"]
      }
    }
  },
  required: ["disclaimer", "lastUpdated", "items"]
};

// Express Request Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Incoming Request: ${req.method} ${req.url}`);
  console.log(`[Headers]:`, JSON.stringify(req.headers));
  next();
});

app.get('/api/news', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] GET /api/news: Starting news retrieval...`);

  try {
    const finnhubToken = process.env.FINNHUB_API_KEY || 'd99jf91r01qssj13hm60d99jf91r01qssj13hm6g';
    const finnhubUrl = `https://finnhub.io/api/v1/news?category=general&token=${finnhubToken}`;

    console.log(`[${new Date().toISOString()}] Initiating Axios fetch to Finnhub news API...`);
    const fetchStart = Date.now();
    const newsResponse = await axios.get(finnhubUrl);
    console.log(`[${new Date().toISOString()}] Finnhub response received in ${Date.now() - fetchStart}ms. Status: ${newsResponse.status}`);

    if (!Array.isArray(newsResponse.data)) {
      console.error(`[${new Date().toISOString()}] Finnhub response data is not an array:`, newsResponse.data);
      throw new Error('Invalid response structure from Finnhub news API');
    }

    // Extract first 20 articles directly as-is
    const rawArticles = newsResponse.data.slice(0, 20);
    console.log(`[${new Date().toISOString()}] Mapped ${rawArticles.length} articles from Finnhub feed.`);

    // Map to clean format containing title, description, and original URL
    const cleanArticles = rawArticles.map((item, index) => {
      return {
        title: item.headline || 'No Headline',
        description: item.summary || 'No Summary Available',
        url: item.url || ''
      };
    });

    console.log(`[${new Date().toISOString()}] Successfully completed news retrieval in ${Date.now() - startTime}ms.`);
    return res.json({ items: cleanArticles });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal Error fetching news:`, error);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving news.',
      message: error.message
    });
  }
});

app.post('/api/recommendations', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] POST /api/recommendations: Starting processing pipeline...`);

  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      console.warn(`[${new Date().toISOString()}] Request validation failed: articles array is missing or empty.`);
      return res.status(400).json({
        error: 'Invalid request body. An array of "articles" is required.'
      });
    }

    // Map to clean format for prompt inputs
    const cleanArticles = articles.slice(0, 20).map((item, index) => {
      console.log(`  [Payload Article #${index + 1}] Title: "${item.title || 'No Headline'}"`);
      return {
        title: item.title || 'No Headline',
        description: item.description || 'No Summary Available'
      };
    });

    const promptArticles = cleanArticles.map(a => ({ title: a.title, description: a.description }));
    const userPrompt = `Here are the latest 20 live news headlines. Evaluate and categorize them based on the system instructions. Focus strictly on NSE/BSE stock recommendations. Current date: ${new Date().toISOString()}.\n\nArticles:\n${JSON.stringify(promptArticles, null, 2)}`;

    let geminiResponseText = null;
    let successfulModel = null;
    const errorsList = [];

    console.log(`[${new Date().toISOString()}] Beginning Gemini fallback loop across ${GEMINI_MODELS.length} candidate models...`);

    // Fallback loop over models
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const model = GEMINI_MODELS[i];
      const modelStartTime = Date.now();
      try {
        console.log(`[${new Date().toISOString()}] [Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
        console.log(`  [Config]: responseMimeType="application/json", systemInstruction length=${SYSTEM_INSTRUCTION.length} chars, prompt length=${userPrompt.length} chars`);

        const response = await ai.models.generateContent({
          model: model,
          contents: userPrompt,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: RECOMMENDATION_SCHEMA
          }
        });

        if (response && response.text) {
          geminiResponseText = response.text;
          successfulModel = model;
          console.log(`[${new Date().toISOString()}] SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms. Response length: ${geminiResponseText.length} characters.`);
          break;
        } else {
          console.warn(`[${new Date().toISOString()}] Model "${model}" completed execution but returned empty response text.`);
          errorsList.push({ model, error: 'Empty text response received' });
        }
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Model "${model}" FAILED after ${Date.now() - modelStartTime}ms:`, error.message);
        if (error.stack) {
          console.warn(`  [Stack Trace]:`, error.stack);
        }
        errorsList.push({ model, error: error.message });
      }
    }

    // If all models failed, throw fallback exhaustion error
    if (!geminiResponseText) {
      console.error(`[${new Date().toISOString()}] FATAL: Complete Gemini fallback exhaustion. All ${GEMINI_MODELS.length} models failed. Details:`, JSON.stringify(errorsList, null, 2));
      return res.status(502).json({
        error: 'Complete Gemini fallback exhaustion. All attempted models failed.',
        details: errorsList
      });
    }

    // Parse the JSON returned by Gemini
    console.log(`[${new Date().toISOString()}] Attempting to parse response text from Gemini...`);
    let recommendationData;
    try {
      recommendationData = JSON.parse(geminiResponseText);
      console.log(`[${new Date().toISOString()}] Successfully parsed Gemini JSON payload.`);
    } catch (parseError) {
      console.error(`[${new Date().toISOString()}] JSON Parse Error. Succeeded model: "${successfulModel}". Raw text returned was:`);
      console.error(geminiResponseText);
      console.error(parseError);
      return res.status(500).json({
        error: 'Invalid JSON structure returned by Gemini AI.',
        rawResponse: geminiResponseText
      });
    }

    // Log metrics on classifications
    if (recommendationData && Array.isArray(recommendationData.items)) {
      const good = recommendationData.items.filter(item => item.classification === 'Good news').length;
      const bad = recommendationData.items.filter(item => item.classification === 'Bad news').length;
      const neutral = recommendationData.items.filter(item => item.classification === 'No change').length;
      console.log(`[${new Date().toISOString()}] Recommendation Metrics -> Total: ${recommendationData.items.length} items | Bullish: ${good} | Bearish: ${bad} | Neutral: ${neutral}`);
    }

    // Attach metadata about which model succeeded for verification
    recommendationData.processedByModel = successfulModel;

    console.log(`[${new Date().toISOString()}] Completed request successfully. Pipeline time: ${Date.now() - startTime}ms.`);
    return res.json(recommendationData);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal Error handling recommendations request:`, error);
    return res.status(500).json({
      error: 'An internal server error occurred while processing recommendations.',
      message: error.message
    });
  }
});


// ==========================================
// INDIVIDUAL STOCK RESEARCH FEATURE EXTENSIONS
// ==========================================

let cachedEquities = [];

function loadInstruments() {
  console.time('Load Instruments');
  try {
    // 3-way path resolution for local development & Vercel serverless hosting
    let csvPath = path.join(process.cwd(), 'instruments.csv');
    if (!fs.existsSync(csvPath)) {
      csvPath = path.join(__dirname, 'instruments.csv');
    }
    if (!fs.existsSync(csvPath)) {
      csvPath = path.join(process.cwd(), 'backend', 'instruments.csv');
    }

    if (!fs.existsSync(csvPath)) {
      console.error(`[Instruments] CSV file not found at any candidate paths.`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Loading instruments CSV from: ${csvPath}`);
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');
    const equitiesMap = new Map();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = [];
      let current = '';
      let inQuotes = false;
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          cols.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      cols.push(current);

      if (cols.length < 12) continue;

      const symbol = cols[2];
      const name = cols[3];
      const instrumentType = cols[9];
      const exchange = cols[11];

      if (instrumentType === 'EQ' && (exchange === 'NSE' || exchange === 'BSE')) {
        if (!equitiesMap.has(symbol) || exchange === 'NSE') {
          equitiesMap.set(symbol, {
            symbol,
            name: name.replace(/^"(.*)"$/, '$1').trim(),
            exchange
          });
        }
      }
    }

    cachedEquities = Array.from(equitiesMap.values());
    console.log(`Loaded ${cachedEquities.length} unique equities for autocomplete.`);
  } catch (error) {
    console.error('Error loading instruments.csv:', error);
  }
  console.timeEnd('Load Instruments');
}

// System Instruction for Stock Research
const RESEARCH_SYSTEM_INSTRUCTION = `You are an expert financial researcher and senior investment analyst specializing in the Indian stock markets (NSE & BSE). 
Your task is to conduct a detailed, comprehensive fundamental and market research report for a given stock symbol.

Your response must strictly be a JSON object matching this schema:
{
  "symbol": "Requested stock symbol",
  "companyName": "Full name of the company",
  "signal": "BUY" | "HOLD" | "SELL",
  "signalReason": "A concise 1-sentence explanation of the investment signal.",
  
  "overview": {
    "primaryExchange": "Identify primary listing/ticker exchange (e.g. NSE, BSE)",
    "previousNames": "Previous names of the company if recently rebranded or restructured. If none, state 'None'",
    "coreSegments": ["Core business segment 1", "Core business segment 2", "etc."],
    "revenueDrivers": "Description of the main revenue drivers and business model."
  },
  
  "financials": [
    {
      "metric": "Current Market Price (CMP)",
      "value": "Estimate or current value (e.g. ₹2,450)",
      "insight": "Concise 1-sentence insight about the current valuation or price level."
    },
    {
      "metric": "52-Week High / Low",
      "value": "Estimate or current range (e.g. ₹2,600 / ₹1,800)",
      "insight": "Concise 1-sentence insight about how current price relates to this range."
    },
    {
      "metric": "Market Capitalization",
      "value": "Estimate (e.g. ₹15,40,000 Cr)",
      "insight": "Concise 1-sentence insight about the company size and category (Large/Mid/Small cap)."
    },
    {
      "metric": "Valuation Multiples (P/E TTM or EV/EBITDA)",
      "value": "P/E: X or EV/EBITDA: Y",
      "insight": "Concise 1-sentence insight comparing it with industry averages or historical mean."
    },
    {
      "metric": "Key Moving Averages (50 DMA & 200 DMA)",
      "value": "50 DMA: ₹X, 200 DMA: ₹Y",
      "insight": "Concise 1-sentence insight about technical trend (Golden Cross, Death Cross, trading above/below MA)."
    },
    {
      "metric": "Momentum Indicators (RSI, MACD signal)",
      "value": "RSI: X, MACD: Crossover status",
      "insight": "Concise 1-sentence insight about overbought/oversold levels or momentum trend."
    }
  ],
  
  "thesis": {
    "pros": [
      "Key business moat, competitive advantage, or growth tailwind 1",
      "Key business moat, competitive advantage, or growth tailwind 2",
      "Key business moat, competitive advantage, or growth tailwind 3"
    ],
    "cons": [
      "Major operational, regulatory, competitive, or valuation risk 1",
      "Major operational, regulatory, competitive, or valuation risk 2",
      "Major operational, regulatory, competitive, or valuation risk 3"
    ]
  },
  
  "guidance": {
    "newInvestors": "Fresh Buy / Entry Strategy with specific buy zones or dip conditions.",
    "existingHolders": "Hold / Profit Taking logic.",
    "swingTraders": "Key support/resistance levels & trailing stop-loss."
  },
  "priceTargetAnalysis": {
    "accumulationMin": 250.0,
    "accumulationMax": 280.0,
    "targetPrice": 380.0,
    "stopLoss": 220.0
  }
}`;

// JSON schema for Gemini validation
const RESEARCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    companyName: { type: "string" },
    signal: { type: "string", enum: ["BUY", "HOLD", "SELL"] },
    signalReason: { type: "string" },
    overview: {
      type: "object",
      properties: {
        primaryExchange: { type: "string" },
        previousNames: { type: "string" },
        coreSegments: {
          type: "array",
          items: { type: "string" }
        },
        revenueDrivers: { type: "string" }
      },
      required: ["primaryExchange", "previousNames", "coreSegments", "revenueDrivers"]
    },
    financials: {
      type: "array",
      items: {
        type: "object",
        properties: {
          metric: { type: "string" },
          value: { type: "string" },
          insight: { type: "string" }
        },
        required: ["metric", "value", "insight"]
      }
    },
    thesis: {
      type: "object",
      properties: {
        pros: {
          type: "array",
          items: { type: "string" }
        },
        cons: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["pros", "cons"]
    },
    guidance: {
      type: "object",
      properties: {
        newInvestors: { type: "string" },
        existingHolders: { type: "string" },
        swingTraders: { type: "string" }
      },
      required: ["newInvestors", "existingHolders", "swingTraders"]
    },
    priceTargetAnalysis: {
      type: "object",
      properties: {
        accumulationMin: { type: "number" },
        accumulationMax: { type: "number" },
        targetPrice: { type: "number" },
        stopLoss: { type: "number" }
      },
      required: ["accumulationMin", "accumulationMax", "targetPrice", "stopLoss"]
    }
  },
  required: ["symbol", "companyName", "signal", "signalReason", "overview", "financials", "thesis", "guidance", "priceTargetAnalysis"]
};

// Endpoint 1: Auto-suggestions
app.get('/api/suggestions', (req, res) => {
  const query = (req.query.q || '').toString().trim().toUpperCase();
  if (query.length < 2) {
    return res.json([]);
  }

  const matches = [];
  for (const eq of cachedEquities) {
    const symbol = eq.symbol.toUpperCase();
    const name = eq.name.toUpperCase();

    let score = -1;
    if (symbol.startsWith(query)) {
      score = 3;
    } else if (name.startsWith(query)) {
      score = 2;
    } else if (symbol.includes(query)) {
      score = 1;
    } else if (name.includes(query)) {
      score = 0;
    }

    if (score >= 0) {
      matches.push({ ...eq, score });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.symbol.localeCompare(b.symbol);
  });

  const results = matches.slice(0, 15).map(m => ({
    symbol: m.symbol,
    name: m.name,
    exchange: m.exchange
  }));

  return res.json(results);
});

// Helper to fetch real-time quote data from Yahoo Finance chart endpoint
async function fetchRealTimeStockData(symbol, exchange) {
  try {
    const suffix = exchange === 'BSE' ? '.BO' : '.NS';
    const ticker = `${symbol.toUpperCase()}${suffix}`;
    console.log(`[${new Date().toISOString()}] [Yahoo Finance] Fetching 1y historical chart for ${ticker}...`);
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    const chartData = res.data?.chart?.result?.[0];
    if (!chartData) {
      console.warn(`[Yahoo Finance] No chart data found for ${ticker}`);
      return null;
    }

    const meta = chartData.meta || {};
    const quotes = chartData.indicators?.quote?.[0]?.close || [];
    const validQuotes = quotes.filter(val => val !== null && val !== undefined);

    let fiftyDMA = null;
    if (validQuotes.length >= 50) {
      fiftyDMA = validQuotes.slice(-50).reduce((acc, val) => acc + val, 0) / 50;
    }

    let twoHundredDMA = null;
    if (validQuotes.length >= 200) {
      twoHundredDMA = validQuotes.slice(-200).reduce((acc, val) => acc + val, 0) / 200;
    }

    return {
      ticker,
      price: meta.regularMarketPrice,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      fiftyDMA: fiftyDMA ? Number(fiftyDMA.toFixed(2)) : null,
      twoHundredDMA: twoHundredDMA ? Number(twoHundredDMA.toFixed(2)) : null,
      currency: meta.currency || 'INR',
      exchangeName: meta.exchangeName || exchange
    };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [Yahoo Finance] Error fetching quote for ${symbol}:`, err.message);
    return null;
  }
}

// Endpoint 2: Individual Stock Research
app.get('/api/research', async (req, res) => {
  const startTime = Date.now();
  const symbol = (req.query.symbol || '').toString().trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: 'Stock symbol parameter is required.' });
  }

  const match = cachedEquities.find(e => e.symbol.toUpperCase() === symbol);
  const companyName = match ? match.name : '';

  console.log(`[${new Date().toISOString()}] GET /api/research: Starting research pipeline for ${symbol} (${companyName})...`);

  // Fetch real-time data from Yahoo Finance
  const realTimeData = await fetchRealTimeStockData(symbol, match ? match.exchange : 'NSE');
  let realTimeContext = '';
  if (realTimeData) {
    console.log(`[${new Date().toISOString()}] Real-time quote fetched successfully: CMP=${realTimeData.price}, 52W High=${realTimeData.high52}, 52W Low=${realTimeData.low52}, 50 DMA=${realTimeData.fiftyDMA}, 200 DMA=${realTimeData.twoHundredDMA}`);
    realTimeContext = `\n\nREAL-TIME STOCK MARKET DATA FOR PRECISE METRICS:
- Yahoo Finance Ticker: ${realTimeData.ticker}
- Current Market Price (CMP): ₹${realTimeData.price}
- 52-Week High: ₹${realTimeData.high52}
- 52-Week Low: ₹${realTimeData.low52}
- 50-day Moving Average (50 DMA): ${realTimeData.fiftyDMA ? '₹' + realTimeData.fiftyDMA : 'N/A'}
- 200-day Moving Average (200 DMA): ${realTimeData.twoHundredDMA ? '₹' + realTimeData.twoHundredDMA : 'N/A'}

You MUST use these exact real-time prices, ranges, and moving averages when generating the metrics in Section 2 (Key Financial & Market Data). Use these values to compute the P/E ratio or other valuation multiples based on the stock's latest earnings.`;
  } else {
    console.warn(`[${new Date().toISOString()}] Could not fetch real-time quote data. Falling back to default model intelligence.`);
  }

  const userPrompt = `Perform a comprehensive stock research and investment analysis on the Indian stock: "${symbol}" (Company Name: "${companyName || 'Unknown'}"). 
Follow the system instructions exactly and provide objective, analytical, concise, and scannable content. Current date: ${new Date().toISOString()}.${realTimeContext}`;

  let geminiResponseText = null;
  let successfulModel = null;
  const errorsList = [];

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const modelStartTime = Date.now();
    try {
      console.log(`[${new Date().toISOString()}] [Research Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
      const response = await ai.models.generateContent({
        model: model,
        contents: userPrompt,
        config: {
          systemInstruction: RESEARCH_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESEARCH_RESPONSE_SCHEMA
        }
      });

      if (response && response.text) {
        geminiResponseText = response.text;
        successfulModel = model;
        console.log(`[${new Date().toISOString()}] SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms.`);
        break;
      } else {
        errorsList.push({ model, error: 'Empty text response received' });
      }
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Model "${model}" FAILED:`, error.message);
      errorsList.push({ model, error: error.message });
    }
  }

  if (!geminiResponseText) {
    console.error(`[${new Date().toISOString()}] FATAL: Complete Gemini fallback exhaustion for research.`);
    return res.status(502).json({
      error: 'Complete Gemini fallback exhaustion. All attempted models failed to generate analysis.',
      details: errorsList
    });
  }

  try {
    const researchData = JSON.parse(geminiResponseText);
    researchData.processedByModel = successfulModel;

    // Calculate dynamic beginner-friendly indicators if realTimeData is available
    if (realTimeData) {
      const price = realTimeData.price;
      const fiftyDMA = realTimeData.fiftyDMA;
      const twoHundredDMA = realTimeData.twoHundredDMA;
      const high52 = realTimeData.high52;
      const low52 = realTimeData.low52;

      // 1. "Traffic Light" Trend Indicator
      let trendSignal = 'yellow';
      let trendText = 'Sideways. Stock price is moving flat and stabilizing.';
      
      if (fiftyDMA && twoHundredDMA && price) {
        if (price >= fiftyDMA && fiftyDMA >= twoHundredDMA) {
          trendSignal = 'green';
          trendText = 'Bullish. The stock is currently healthy and gaining momentum.';
        } else if (price <= fiftyDMA && fiftyDMA <= twoHundredDMA) {
          trendSignal = 'red';
          trendText = 'Bearish. The stock is in a downtrend. Caution is advised.';
        }
      }
      
      researchData.trendIndicator = {
        signal: trendSignal,
        text: trendText
      };

      // 2. "Is it On Sale?" Buying Position
      let saleText = 'N/A. Not enough historical range data.';
      if (high52 && low52 && price) {
        if (price >= high52) {
          saleText = 'Trading at its peak (52-Week High). No discount available.';
        } else {
          const discountPercent = ((high52 - price) / high52) * 100;
          if (discountPercent < 5) {
            saleText = `Trading near its peak. Sells at a premium (under 5% discount).`;
          } else if (discountPercent < 15) {
            saleText = `Trading at a minor discount of ${discountPercent.toFixed(1)}% off its yearly high.`;
          } else if (discountPercent < 30) {
            saleText = `Trading at a moderate discount of ${discountPercent.toFixed(1)}% off its yearly high.`;
          } else {
            saleText = `Trading at a significant discount of ${discountPercent.toFixed(1)}% off its yearly high. A clearance sale!`;
          }
        }
      }
      
      researchData.buyingPosition = {
        text: saleText
      };
    } else {
      researchData.trendIndicator = {
        signal: 'yellow',
        text: 'N/A. Real-time trend averages are currently unavailable.'
      };
      researchData.buyingPosition = {
        text: 'N/A. Real-time market range values are currently unavailable.'
      };
    }

    // Inject currentPrice inside priceTargetAnalysis
    if (researchData.priceTargetAnalysis) {
      if (realTimeData) {
        researchData.priceTargetAnalysis.currentPrice = realTimeData.price;
      } else {
        const cmpRow = researchData.financials?.find(f => f.metric.toLowerCase().includes('current market price') || f.metric.includes('CMP'));
        if (cmpRow) {
          const parsedPrice = parseFloat(cmpRow.value.replace(/[^\d.]/g, ''));
          researchData.priceTargetAnalysis.currentPrice = isNaN(parsedPrice) ? 0 : parsedPrice;
        } else {
          researchData.priceTargetAnalysis.currentPrice = 0;
        }
      }
    }

    console.log(`[${new Date().toISOString()}] Completed stock research for ${symbol} in ${Date.now() - startTime}ms.`);
    return res.json(researchData);
  } catch (parseError) {
    console.error(`[${new Date().toISOString()}] JSON Parse Error:`, parseError);
    return res.status(500).json({
      error: 'Invalid JSON structure returned by Gemini AI.',
      rawResponse: geminiResponseText
    });
  }
});

// Start the server
app.listen(PORT, () => {
  loadInstruments();
  console.log(`Server is running on port ${PORT}`);
  console.log(`Active environment port configuration: ${process.env.PORT || 'Default 3000'}`);
});

export default app;
