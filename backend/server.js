import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { put, del } from '@vercel/blob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend integration
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  },
  "latestNews": [
    {
      "headline": "A concise headline summarizing the event",
      "impact": "BULLISH" | "BEARISH" | "NEUTRAL",
      "summary": "1-2 sentences explaining what happened and its impact.",
      "date": "Estimated time or date of the event"
    }
  ]
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
    },
    latestNews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          impact: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
          date: { type: "string" }
        },
        required: ["headline", "summary", "impact", "date"]
      }
    }
  },
  required: [
    "symbol",
    "companyName",
    "signal",
    "signalReason",
    "overview",
    "financials",
    "thesis",
    "guidance",
    "priceTargetAnalysis",
    "latestNews"
  ]
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

// ==========================================
// PREMARKET REPORT FEATURE EXTENSIONS
// ==========================================

async function fetchIndexQuote(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    const chartData = res.data?.chart?.result?.[0];
    if (!chartData) return null;

    const meta = chartData.meta || {};
    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose;
    const change = price && prevClose ? price - prevClose : 0;
    const pctChange = prevClose ? (change / prevClose) * 100 : 0;

    return {
      price: price ? Number(price.toFixed(2)) : null,
      change: change ? Number(change.toFixed(2)) : null,
      pctChange: pctChange ? Number(pctChange.toFixed(2)) : null
    };
  } catch (err) {
    console.error(`[Yahoo Finance] Error fetching index ${ticker}:`, err.message);
    return null;
  }
}

async function fetchIndicesData() {
  const [nifty, sensex, sp500, nasdaq] = await Promise.all([
    fetchIndexQuote('^NSEI'),
    fetchIndexQuote('^BSESN'),
    fetchIndexQuote('^GSPC'),
    fetchIndexQuote('^IXIC')
  ]);
  return { nifty, sensex, sp500, nasdaq };
}

const PREMARKET_SYSTEM_INSTRUCTION = `You are an expert Indian stock market macro analyst specializing in the NSE and BSE. Your task is to process the latest global indices data and 25 live news headlines.

1. Filter the news headlines to identify which items have a direct or indirect impact on the Indian Stock Market (NSE/BSE), its sectors, or specific publicly listed Indian companies (e.g. RELIANCE, TCS, HDFCBANK, INFY, TATASTEEL, ICICIBANK, etc.).
2. Based on the indices (like Nifty 50, Sensex, S&P 500, and Nasdaq Composite) and news catalysts, generate a premium Premarket Report consisting of 2 to 5 slides structured as a JSON payload for Instagram story/post format (4:5 aspect ratio).
3. The slides must follow a unified structure where all fields are strictly required:
   - Slide 1 (Type: "market_overview"): Focuses on Nifty 50 expectations.
     - title: "NIFTY 50 EXPECTATION"
     - subtitle: "NSE Opening Outlook"
     - headline: "NIFTY 50"
     - badge: Expected opening direction (e.g. "GAP UP", "GAP DOWN", "FLAT", "BULLISH", "BEARISH", "SIDEWAYS")
     - cues: Concise 1-2 sentence summary of global cues (US markets, overnight changes).
     - details: Detailed 2-3 sentence macro explanation of why we expect this opening behavior.
     - levels: Key range support/resistance levels to watch today (e.g. "Support: 24,100, Resistance: 24,350").
   - Slides 2 to 5 (Type: "stock_impact"): Focuses on individual Indian stocks or sectors impacted by news.
     - title: e.g. "STOCK FOCUS: Ticker" (e.g., RELIANCE, TCS)
     - subtitle: Brief title of the news catalyst impact (e.g. "Geopolitical Supply Tailwinds")
     - headline: The company's valid NSE ticker (e.g. "RELIANCE")
     - badge: Sentiment outlook (strictly "BULLISH", "BEARISH", or "NEUTRAL")
     - cues: Summary of the catalyst trigger news.
     - details: Detailed 2-3 sentence explanation of the news impact on the stock and expected action.
     - levels: Key trading levels to watch (e.g. "Support: 2,520, Target: 2,570, SL: 2,500").
4. Output MUST be strictly valid JSON matching the provided schema. Do NOT include any markdown code blocks outside of the JSON representation (or return strictly the JSON). Do NOT recommend foreign stocks for stock impact slides; they must be listed on the NSE/BSE.

Return STRICTLY a JSON object matching this structural schema:
{
  "disclaimer": "This analysis is purely for informational and educational purposes. Market news has highly volatile short-term impacts that can reverse rapidly. We are NOT SEBI registered advisors. This output is an AI-generated text analysis and does NOT constitute formal financial advice. Use your own knowledge and due diligence before making any trade decisions. We hold zero liability for financial actions taken based on this tool.",
  "lastUpdated": "ISO Timestamp",
  "marketOverview": {
    "niftyCurrent": "Format Nifty price nicely",
    "niftyChange": "Format Nifty absolute change",
    "niftyChangePercent": "Format Nifty change percent with sign, e.g. -0.14%",
    "sensexCurrent": "Format Sensex price",
    "sensexChange": "Format Sensex absolute change",
    "sensexChangePercent": "Format Sensex change percent"
  },
  "slides": [
    {
      "slideNumber": 1,
      "type": "market_overview",
      "title": "NIFTY 50 EXPECTATION",
      "subtitle": "NSE Opening Outlook",
      "headline": "NIFTY 50",
      "badge": "GAP UP" | "GAP DOWN" | "FLAT" | "BULLISH" | "BEARISH" | "SIDEWAYS",
      "cues": "Global cues summary text",
      "details": "Opening rationale explanation text",
      "levels": "Support & Resistance levels text"
    },
    {
      "slideNumber": 2,
      "type": "stock_impact",
      "title": "STOCK FOCUS: Ticker",
      "subtitle": "Catalyst description",
      "headline": "Ticker symbol",
      "badge": "BULLISH" | "BEARISH" | "NEUTRAL",
      "cues": "News trigger text",
      "details": "Impact analysis text",
      "levels": "Trading levels text"
    }
  ]
}`;

const PREMARKET_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    disclaimer: { type: "string" },
    lastUpdated: { type: "string" },
    marketOverview: {
      type: "object",
      properties: {
        niftyCurrent: { type: "string" },
        niftyChange: { type: "string" },
        niftyChangePercent: { type: "string" },
        sensexCurrent: { type: "string" },
        sensexChange: { type: "string" },
        sensexChangePercent: { type: "string" }
      },
      required: ["niftyCurrent", "niftyChange", "niftyChangePercent", "sensexCurrent", "sensexChange", "sensexChangePercent"]
    },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slideNumber: { type: "number" },
          type: { type: "string", enum: ["market_overview", "stock_impact"] },
          title: { type: "string" },
          subtitle: { type: "string" },
          headline: { type: "string" },
          badge: { type: "string" },
          cues: { type: "string" },
          details: { type: "string" },
          levels: { type: "string" }
        },
        required: ["slideNumber", "type", "title", "subtitle", "headline", "badge", "cues", "details", "levels"]
      }
    }
  },
  required: ["disclaimer", "lastUpdated", "marketOverview", "slides"]
};

app.get('/api/premarket', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] GET /api/premarket: Starting premarket report generation...`);

  try {
    // 1. Fetch indices
    const indices = await fetchIndicesData();

    // 2. Fetch live news (40 articles)
    const finnhubToken = process.env.FINNHUB_API_KEY || 'd99jf91r01qssj13hm60d99jf91r01qssj13hm6g';
    const finnhubUrl = `https://finnhub.io/api/v1/news?category=general&token=${finnhubToken}`;

    console.log(`[${new Date().toISOString()}] Premarket: Fetching news from Finnhub...`);
    const newsResponse = await axios.get(finnhubUrl);
    let rawArticles = [];
    if (Array.isArray(newsResponse.data)) {
      rawArticles = newsResponse.data.slice(0, 25);
    }
    console.log(`[${new Date().toISOString()}] Premarket: Mapped ${rawArticles.length} news articles.`);

    const cleanArticles = rawArticles.map(item => item.headline || 'No Headline');

    // 3. Construct prompt
    const userPrompt = `Here are the current global market index levels and recent 25 live news headlines.
Current Date: ${new Date().toISOString()}

MARKET INDICES DATA:
- Nifty 50 (^NSEI): Price ${indices.nifty?.price || 'N/A'}, Change: ${indices.nifty?.change || 'N/A'} (${indices.nifty?.pctChange || 'N/A'}%)
- BSE Sensex (^BSESN): Price ${indices.sensex?.price || 'N/A'}, Change: ${indices.sensex?.change || 'N/A'} (${indices.sensex?.pctChange || 'N/A'}%)
- S&P 500 (^GSPC): Price ${indices.sp500?.price || 'N/A'}, Change: ${indices.sp500?.change || 'N/A'} (${indices.sp500?.pctChange || 'N/A'}%)
- Nasdaq Composite (^IXIC): Price ${indices.nasdaq?.price || 'N/A'}, Change: ${indices.nasdaq?.change || 'N/A'} (${indices.nasdaq?.pctChange || 'N/A'}%)

LIVE NEWS HEADLINES:
${JSON.stringify(cleanArticles, null, 2)}

Filter this news for items impacting the Indian stock market (NSE/BSE) and generate the premarket report slides JSON according to the instructions.`;

    let geminiResponseText = null;
    let successfulModel = null;
    const errorsList = [];

    // Fallback loop over models
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const model = GEMINI_MODELS[i];
      const modelStartTime = Date.now();
      try {
        console.log(`[${new Date().toISOString()}] [Premarket Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
        const response = await ai.models.generateContent({
          model: model,
          contents: userPrompt,
          config: {
            systemInstruction: PREMARKET_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: PREMARKET_RESPONSE_SCHEMA
          }
        });

        if (response && response.text) {
          geminiResponseText = response.text;
          successfulModel = model;
          console.log(`[${new Date().toISOString()}] SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms.`);
          break;
        } else {
          errorsList.push({ model, error: 'Empty response text' });
        }
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Model "${model}" FAILED in premarket report:`, error.message);
        errorsList.push({ model, error: error.message });
      }
    }

    if (!geminiResponseText) {
      console.error(`[${new Date().toISOString()}] FATAL: Complete Gemini fallback exhaustion for premarket report.`);
      return res.status(502).json({
        error: 'Complete Gemini fallback exhaustion for premarket report.',
        details: errorsList
      });
    }

    const premarketReport = JSON.parse(geminiResponseText);
    premarketReport.processedByModel = successfulModel;

    console.log(`[${new Date().toISOString()}] Completed premarket report generation in ${Date.now() - startTime}ms.`);
    return res.json(premarketReport);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal error generating premarket report:`, error);
    return res.status(500).json({
      error: 'An internal server error occurred while generating premarket report.',
      message: error.message
    });
  }
});

// Endpoint: Subscribe to premarket reports
app.post('/api/subscribe', async (req, res) => {
  const email = (req.body.email || '').toString().trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!resendApiKey || !audienceId) {
    console.error(`[Resend] Missing API keys: API_KEY_SET=${!!resendApiKey}, AUDIENCE_ID_SET=${!!audienceId}`);
    return res.status(500).json({ error: 'Subscription service is not configured on the backend.' });
  }

  try {
    console.log(`[${new Date().toISOString()}] Subscribing email: "${email}" to Resend audience: "${audienceId}"...`);

    const url = `https://api.resend.com/audiences/${audienceId}/contacts`;
    const response = await axios.post(url, {
      email: email,
      unsubscribed: false
    }, {
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    console.log(`[${new Date().toISOString()}] Resend contact subscription success for ${email}. Status: ${response.status}`);
    return res.json({ success: true, message: 'Successfully subscribed to premarket briefs!' });

  } catch (error) {
    if (error.response) {
      console.error(`[Resend] Error response status: ${error.response.status}. Data:`, JSON.stringify(error.response.data));
      const message = error.response.data?.message || 'Failed to add subscription.';

      // Handle duplicates gracefully
      if (error.response.status === 409 || message.toLowerCase().includes('already exists')) {
        return res.status(409).json({ error: 'You are already subscribed to our premarket report!' });
      }
      return res.status(error.response.status).json({ error: message });
    }
    console.error(`[Resend] Fatal error subscribing email:`, error.message);
    return res.status(500).json({ error: 'Failed to complete subscription. Please try again later.' });
  }
});

// Endpoint: Cron Job to broadcast premarket report via email
app.get('/api/cron/premarket-email', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] GET /api/cron/premarket-email: Triggered cron job...`);

  // Secure cron route: check for Vercel Cron header or local secret query param
  const isVercelCron = 
    req.headers['x-vercel-cron'] === '1' || 
    !!req.headers['x-vercel-cron-schedule'] || 
    (req.headers['user-agent'] && req.headers['user-agent'].includes('vercel-cron'));
  const isLocalSecret = req.query.secret === 'local';

  if (!isVercelCron && !isLocalSecret) {
    console.warn(`[${new Date().toISOString()}] Unauthorized cron call attempt. Headers:`, JSON.stringify(req.headers));
    return res.status(401).json({ error: 'Unauthorized access. Vercel cron headers missing.' });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!resendApiKey || !audienceId) {
    console.error(`[Resend] Missing API keys for cron: API_KEY_SET=${!!resendApiKey}, AUDIENCE_ID_SET=${!!audienceId}`);
    return res.status(500).json({ error: 'Mailer service is not configured on the backend.' });
  }

  try {
    // 1. Fetch indices
    const indices = await fetchIndicesData();

    // 2. Fetch live news (25 articles)
    const finnhubToken = process.env.FINNHUB_API_KEY || 'd99jf91r01qssj13hm60d99jf91r01qssj13hm6g';
    const finnhubUrl = `https://finnhub.io/api/v1/news?category=general&token=${finnhubToken}`;

    console.log(`[${new Date().toISOString()}] Cron: Fetching news from Finnhub...`);
    const newsResponse = await axios.get(finnhubUrl);
    let rawArticles = [];
    if (Array.isArray(newsResponse.data)) {
      rawArticles = newsResponse.data.slice(0, 25);
    }

    const cleanArticles = rawArticles.map(item => item.headline || 'No Headline');

    // 3. Construct prompt
    const userPrompt = `Here are the current global market index levels and recent 25 live news headlines.
Current Date: ${new Date().toISOString()}

MARKET INDICES DATA:
- Nifty 50 (^NSEI): Price ${indices.nifty?.price || 'N/A'}, Change: ${indices.nifty?.change || 'N/A'} (${indices.nifty?.pctChange || 'N/A'}%)
- BSE Sensex (^BSESN): Price ${indices.sensex?.price || 'N/A'}, Change: ${indices.sensex?.change || 'N/A'} (${indices.sensex?.pctChange || 'N/A'}%)
- S&P 500 (^GSPC): Price ${indices.sp500?.price || 'N/A'}, Change: ${indices.sp500?.change || 'N/A'} (${indices.sp500?.pctChange || 'N/A'}%)
- Nasdaq Composite (^IXIC): Price ${indices.nasdaq?.price || 'N/A'}, Change: ${indices.nasdaq?.change || 'N/A'} (${indices.nasdaq?.pctChange || 'N/A'}%)

LIVE NEWS HEADLINES:
${JSON.stringify(cleanArticles, null, 2)}

Filter this news for items impacting the Indian stock market (NSE/BSE) and generate the premarket report slides JSON according to the instructions.`;

    let geminiResponseText = null;
    let successfulModel = null;
    const errorsList = [];

    // Fallback loop over models
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const model = GEMINI_MODELS[i];
      const modelStartTime = Date.now();
      try {
        console.log(`[${new Date().toISOString()}] [Cron Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
        const response = await ai.models.generateContent({
          model: model,
          contents: userPrompt,
          config: {
            systemInstruction: PREMARKET_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: PREMARKET_RESPONSE_SCHEMA
          }
        });

        if (response && response.text) {
          geminiResponseText = response.text;
          successfulModel = model;
          console.log(`[${new Date().toISOString()}] Cron: SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms.`);
          break;
        } else {
          errorsList.push({ model, error: 'Empty response text' });
        }
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Cron: Model "${model}" FAILED:`, error.message);
        errorsList.push({ model, error: error.message });
      }
    }

    if (!geminiResponseText) {
      console.error(`[${new Date().toISOString()}] Cron: FATAL fallback exhaustion.`);
      throw new Error('All Gemini reasoning models failed to generate cron premarket analysis.');
    }

    const premarketReport = JSON.parse(geminiResponseText);
    const dateString = new Date().toLocaleDateString('en-IN', { dateStyle: 'medium' });

    // 4. Fetch all contacts from Resend Audience
    console.log(`[${new Date().toISOString()}] Cron: Fetching contacts from audience "${audienceId}"...`);
    const contactsResponse = await axios.get(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      headers: {
        'Authorization': `Bearer ${resendApiKey}`
      },
      timeout: 10000
    });

    const allContacts = contactsResponse.data?.data || [];
    const activeContacts = allContacts.filter(c => !c.unsubscribed).map(c => c.email);
    console.log(`[${new Date().toISOString()}] Cron: Found ${allContacts.length} contacts total (${activeContacts.length} active/subscribed).`);

    if (activeContacts.length === 0) {
      console.log(`[${new Date().toISOString()}] Cron: No active subscribers to email. Exiting successfully.`);
      return res.json({ success: true, message: 'No active subscribers found in the audience list. Mailer broadcast skipped.' });
    }

    // 5. Generate beautiful HTML Email content (tricolor financial modern template)
    const host = req.headers.host || 'stock-recommender-app.vercel.app';
    const readMoreLink = `http://${host}/?page=premarket`;

    const mOverview = premarketReport.marketOverview;
    const niftyColor = mOverview.niftyChange?.startsWith('-') ? '#ef4444' : '#22c55e';
    const sensexColor = mOverview.sensexChange?.startsWith('-') ? '#ef4444' : '#22c55e';

    let slidesHtml = '';
    premarketReport.slides.forEach(slide => {
      if (slide.type === 'market_overview') {
        slidesHtml += `
          <div style="background-color: #0f172a; border-left: 4px solid #fbbf24; border-radius: 8px; padding: 20px; margin-bottom: 25px; color: #f8fafc;">
            <div style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: #38bdf8; text-transform: uppercase; margin-bottom: 5px;">${slide.title}</div>
            <h3 style="font-size: 20px; margin: 0 0 15px 0; font-family: sans-serif; color: #ffffff;">${slide.subtitle}</h3>
            
            <div style="background-color: rgba(255,255,255,0.05); border-radius: 6px; padding: 12px; margin-bottom: 15px; font-size: 13px; font-weight: bold; color: #fbbf24; text-align: center; text-transform: uppercase;">
              Expected Open: ${slide.badge}
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">🌍 Global cues:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.cues}</p>
            </div>
            
            <div style="margin-bottom: 15px;">
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">💡 opening strategy:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.details}</p>
            </div>

            <div>
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">🎯 expected range:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.levels}</p>
            </div>
          </div>
        `;
      } else {
        const sentimentColor = slide.badge === 'BULLISH' ? '#22c55e' : slide.badge === 'BEARISH' ? '#ef4444' : '#cbd5e1';
        slidesHtml += `
          <div style="background-color: #0f172a; border-left: 4px solid ${sentimentColor}; border-radius: 8px; padding: 20px; margin-bottom: 25px; color: #f8fafc;">
            <div style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: ${sentimentColor}; text-transform: uppercase; margin-bottom: 5px;">${slide.title}</div>
            <h3 style="font-size: 18px; margin: 0 0 15px 0; font-family: sans-serif; color: #ffffff;">${slide.subtitle}</h3>

            <div style="background-color: rgba(255,255,255,0.03); border-radius: 6px; padding: 12px; margin-bottom: 15px;">
              <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase; display: block; margin-bottom: 4px;">expected sentiment:</span>
              <strong style="font-size: 16px; color: ${sentimentColor};">${slide.badge} (${slide.headline})</strong>
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">📰 news catalyst:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #f8fafc;">${slide.cues}</p>
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">🔍 impact analysis:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.details}</p>
            </div>

            <div>
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">⚡ levels to watch:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #60a5fa;">${slide.levels}</p>
            </div>
          </div>
        `;
      }
    });

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>India NSE/BSE Premarket Report</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 20px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
          <!-- Header Banner -->
          <div style="background: linear-gradient(135deg, #071115 0%, #0d1e26 100%); padding: 30px 25px; text-align: center; border-bottom: 3px solid #fbbf24;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; font-family: sans-serif; letter-spacing: -0.5px;">🇮🇳 NSE/BSE Premarket Report</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Daily market opening briefs and volatility analysis</p>
            <div style="display: inline-block; background-color: rgba(255,255,255,0.06); border-radius: 20px; padding: 4px 15px; margin-top: 15px; font-size: 12px; font-weight: 600; color: #38bdf8;">
              ${dateString} (Morning Brief)
            </div>
          </div>

          <!-- Content Body -->
          <div style="padding: 25px;">
            <!-- Index Prices overview -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
              <h4 style="margin: 0 0 10px 0; color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Current Market Levels</h4>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a;">Nifty 50:</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 14px; font-weight: 700; color: #0f172a;">₹${mOverview.niftyCurrent}</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 13px; font-weight: bold; color: ${niftyColor};">${mOverview.niftyChange} (${mOverview.niftyChangePercent})</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; border-top: 1px solid #f1f5f9;">Sensex:</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 14px; font-weight: 700; color: #0f172a; border-top: 1px solid #f1f5f9;">₹${mOverview.sensexCurrent}</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 13px; font-weight: bold; color: ${sensexColor}; border-top: 1px solid #f1f5f9;">${mOverview.sensexChange} (${mOverview.sensexChangePercent})</td>
                </tr>
              </table>
            </div>

            <!-- Report Slides -->
            <div>
              ${slidesHtml}
            </div>

            <!-- Call to Action -->
            <div style="text-align: center; margin: 35px 0 20px 0;">
              <a href="${readMoreLink}" style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 14px 30px; font-size: 14px; font-weight: bold; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 6px rgba(15,23,42,0.15);">
                📊 Read More Analysis & View Slides
              </a>
              <p style="font-size: 11px; color: #64748b; margin-top: 12px;">Click to view interactive charts, full fundamental research and download report slides as Instagram images.</p>
            </div>
          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 25px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; line-height: 1.6;">
            <strong style="color: #475569; display: block; margin-bottom: 5px;">LEGAL DISCLAIMER:</strong>
            ${premarketReport.disclaimer}
            <div style="margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 15px; text-align: center;">
              <p style="margin: 0;">&copy; 2026 Fundamental News Stocks Analyser. All rights reserved.</p>
              <p style="margin: 5px 0 0 0;">You received this email because you subscribed to daily premarket briefs on our application.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    // 6. Broadcast via Resend BCC in batches of 50
    console.log(`[${new Date().toISOString()}] Cron: Preparing Resend broadcast...`);

    const BATCH_SIZE = 50;
    const sendPromises = [];

    for (let i = 0; i < activeContacts.length; i += BATCH_SIZE) {
      const batch = activeContacts.slice(i, i + BATCH_SIZE);
      console.log(`[${new Date().toISOString()}] Cron: Dispatching batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batch.length} subscribers...`);

      const payload = {
        from: 'Premarket Report <onboarding@resend.dev>',
        to: 'onboarding@resend.dev',
        bcc: batch,
        subject: `🇮🇳 India NSE/BSE Premarket Report - ${dateString}`,
        html: emailHtml
      };

      sendPromises.push(
        axios.post('https://api.resend.com/emails', payload, {
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }).then(res => ({ success: true, size: batch.length, status: res.status }))
          .catch(err => {
            console.error(`[Resend] Batch send failed:`, err.response?.data || err.message);
            return { success: false, size: batch.length, error: err.response?.data?.message || err.message };
          })
      );
    }

    const results = await Promise.all(sendPromises);
    const successCount = results.filter(r => r.success).reduce((acc, r) => acc + r.size, 0);
    const failureCount = results.filter(r => !r.success).reduce((acc, r) => acc + r.size, 0);

    console.log(`[${new Date().toISOString()}] Cron: Broadcast completed. Dispatched: ${successCount} successfully, ${failureCount} failed.`);

    return res.json({
      success: true,
      message: 'Daily premarket report broadcast complete.',
      metrics: {
        totalSubscribers: activeContacts.length,
        dispatchedSuccess: successCount,
        dispatchedFailed: failureCount,
        batchesCount: results.length
      },
      modelUsed: successfulModel
    });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Cron Fatal Error:`, error);
    return res.status(500).json({
      error: 'An internal error occurred during cron premarket broadcast.',
      message: error.message
    });
  }
});

// Endpoint: Manual endpoint to trigger a single test email for debugging
app.get('/api/test/premarket-email', async (req, res) => {
  const startTime = Date.now();
  const testReceiver = (req.query.to || '').toString().trim().toLowerCase();
  console.log(`[${new Date().toISOString()}] GET /api/test/premarket-email: Sending report directly to: "${testReceiver}"`);

  if (!testReceiver || !testReceiver.includes('@')) {
    return res.status(400).json({ error: 'A valid query parameter "to" is required, e.g., /api/test/premarket-email?to=user@example.com' });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error('[Resend] Missing API key for manual test trigger.');
    return res.status(500).json({ error: 'Mailer API key is not configured in backend env.' });
  }

  try {
    // 1. Fetch indices
    const indices = await fetchIndicesData();

    // 2. Fetch live news (25 articles)
    const finnhubToken = process.env.FINNHUB_API_KEY || 'd99jf91r01qssj13hm60d99jf91r01qssj13hm6g';
    const finnhubUrl = `https://finnhub.io/api/v1/news?category=general&token=${finnhubToken}`;

    console.log(`[${new Date().toISOString()}] Test Mailer: Fetching news from Finnhub...`);
    const newsResponse = await axios.get(finnhubUrl);
    let rawArticles = [];
    if (Array.isArray(newsResponse.data)) {
      rawArticles = newsResponse.data.slice(0, 25);
    }

    const cleanArticles = rawArticles.map(item => item.headline || 'No Headline');

    // 3. Construct prompt
    const userPrompt = `Here are the current global market index levels and recent 25 live news headlines.
Current Date: ${new Date().toISOString()}

MARKET INDICES DATA:
- Nifty 50 (^NSEI): Price ${indices.nifty?.price || 'N/A'}, Change: ${indices.nifty?.change || 'N/A'} (${indices.nifty?.pctChange || 'N/A'}%)
- BSE Sensex (^BSESN): Price ${indices.sensex?.price || 'N/A'}, Change: ${indices.sensex?.change || 'N/A'} (${indices.sensex?.pctChange || 'N/A'}%)
- S&P 500 (^GSPC): Price ${indices.sp500?.price || 'N/A'}, Change: ${indices.sp500?.change || 'N/A'} (${indices.sp500?.pctChange || 'N/A'}%)
- Nasdaq Composite (^IXIC): Price ${indices.nasdaq?.price || 'N/A'}, Change: ${indices.nasdaq?.change || 'N/A'} (${indices.nasdaq?.pctChange || 'N/A'}%)

LIVE NEWS HEADLINES:
${JSON.stringify(cleanArticles, null, 2)}

Filter this news for items impacting the Indian stock market (NSE/BSE) and generate the premarket report slides JSON according to the instructions.`;

    let geminiResponseText = null;
    let successfulModel = null;
    const errorsList = [];

    // Fallback loop over models
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const model = GEMINI_MODELS[i];
      const modelStartTime = Date.now();
      try {
        console.log(`[${new Date().toISOString()}] [Test Mailer Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
        const response = await ai.models.generateContent({
          model: model,
          contents: userPrompt,
          config: {
            systemInstruction: PREMARKET_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: PREMARKET_RESPONSE_SCHEMA
          }
        });

        if (response && response.text) {
          geminiResponseText = response.text;
          successfulModel = model;
          console.log(`[${new Date().toISOString()}] Test Mailer: SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms.`);
          break;
        } else {
          errorsList.push({ model, error: 'Empty response text' });
        }
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Test Mailer: Model "${model}" FAILED:`, error.message);
        errorsList.push({ model, error: error.message });
      }
    }

    if (!geminiResponseText) {
      console.error(`[${new Date().toISOString()}] Test Mailer: FATAL fallback exhaustion.`);
      throw new Error('All Gemini reasoning models failed to generate test premarket analysis.');
    }

    const premarketReport = JSON.parse(geminiResponseText);
    const dateString = new Date().toLocaleDateString('en-IN', { dateStyle: 'medium' });

    // 4. Generate beautiful HTML Email content (tricolor financial modern template)
    const host = req.headers.host || 'whats-up-stocks.vercel.app';
    const readMoreLink = `http://${host}/?page=premarket`;

    const mOverview = premarketReport.marketOverview;
    const niftyColor = mOverview.niftyChange?.startsWith('-') ? '#ef4444' : '#22c55e';
    const sensexColor = mOverview.sensexChange?.startsWith('-') ? '#ef4444' : '#22c55e';

    let slidesHtml = '';
    premarketReport.slides.forEach(slide => {
      if (slide.type === 'market_overview') {
        slidesHtml += `
          <div style="background-color: #0f172a; border-left: 4px solid #fbbf24; border-radius: 8px; padding: 20px; margin-bottom: 25px; color: #f8fafc;">
            <div style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: #38bdf8; text-transform: uppercase; margin-bottom: 5px;">${slide.title}</div>
            <h3 style="font-size: 20px; margin: 0 0 15px 0; font-family: sans-serif; color: #ffffff;">${slide.subtitle}</h3>
            
            <div style="background-color: rgba(255,255,255,0.05); border-radius: 6px; padding: 12px; margin-bottom: 15px; font-size: 13px; font-weight: bold; color: #fbbf24; text-align: center; text-transform: uppercase;">
              Expected Open: ${slide.badge}
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">🌍 Global cues:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.cues}</p>
            </div>
            
            <div style="margin-bottom: 15px;">
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">💡 opening strategy:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.details}</p>
            </div>

            <div>
              <strong style="color: #fbbf24; font-size: 13px; display: block; margin-bottom: 4px; text-transform: uppercase;">🎯 expected range:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.levels}</p>
            </div>
          </div>
        `;
      } else {
        const sentimentColor = slide.badge === 'BULLISH' ? '#22c55e' : slide.badge === 'BEARISH' ? '#ef4444' : '#cbd5e1';
        slidesHtml += `
          <div style="background-color: #0f172a; border-left: 4px solid ${sentimentColor}; border-radius: 8px; padding: 20px; margin-bottom: 25px; color: #f8fafc;">
            <div style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: ${sentimentColor}; text-transform: uppercase; margin-bottom: 5px;">${slide.title}</div>
            <h3 style="font-size: 18px; margin: 0 0 15px 0; font-family: sans-serif; color: #ffffff;">${slide.subtitle}</h3>

            <div style="background-color: rgba(255,255,255,0.03); border-radius: 6px; padding: 12px; margin-bottom: 15px;">
              <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase; display: block; margin-bottom: 4px;">expected sentiment:</span>
              <strong style="font-size: 16px; color: ${sentimentColor};">${slide.badge} (${slide.headline})</strong>
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">📰 news catalyst:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #f8fafc;">${slide.cues}</p>
            </div>

            <div style="margin-bottom: 15px;">
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">🔍 impact analysis:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #cbd5e1;">${slide.details}</p>
            </div>

            <div>
              <strong style="color: #94a3b8; font-size: 12px; display: block; margin-bottom: 4px; text-transform: uppercase;">⚡ levels to watch:</strong>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #60a5fa;">${slide.levels}</p>
            </div>
          </div>
        `;
      }
    });

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>India NSE/BSE Premarket Report</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 20px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
          <!-- Header Banner -->
          <div style="background: linear-gradient(135deg, #071115 0%, #0d1e26 100%); padding: 30px 25px; text-align: center; border-bottom: 3px solid #fbbf24;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; font-family: sans-serif; letter-spacing: -0.5px;">🇮🇳 Test: NSE/BSE Premarket Brief</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Daily market opening briefs and volatility analysis</p>
            <div style="display: inline-block; background-color: rgba(255,255,255,0.06); border-radius: 20px; padding: 4px 15px; margin-top: 15px; font-size: 12px; font-weight: 600; color: #38bdf8;">
              ${dateString} (Manual Test Email)
            </div>
          </div>

          <!-- Content Body -->
          <div style="padding: 25px;">
            <!-- Index Prices overview -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
              <h4 style="margin: 0 0 10px 0; color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Current Market Levels</h4>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a;">Nifty 50:</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 14px; font-weight: 700; color: #0f172a;">₹${mOverview.niftyCurrent}</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 13px; font-weight: bold; color: ${niftyColor};">${mOverview.niftyChange} (${mOverview.niftyChangePercent})</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; border-top: 1px solid #f1f5f9;">Sensex:</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 14px; font-weight: 700; color: #0f172a; border-top: 1px solid #f1f5f9;">₹${mOverview.sensexCurrent}</td>
                  <td style="text-align: right; padding: 6px 0; font-size: 13px; font-weight: bold; color: ${sensexColor}; border-top: 1px solid #f1f5f9;">${mOverview.sensexChange} (${mOverview.sensexChangePercent})</td>
                </tr>
              </table>
            </div>

            <!-- Report Slides -->
            <div>
              ${slidesHtml}
            </div>

            <!-- Call to Action -->
            <div style="text-align: center; margin: 35px 0 20px 0;">
              <a href="${readMoreLink}" style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 14px 30px; font-size: 14px; font-weight: bold; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 6px rgba(15,23,42,0.15);">
                📊 Read More Analysis & View Slides
              </a>
              <p style="font-size: 11px; color: #64748b; margin-top: 12px;">Click to view interactive charts, full fundamental research and download report slides as Instagram images.</p>
            </div>
          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 25px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; line-height: 1.6;">
            <strong style="color: #475569; display: block; margin-bottom: 5px;">LEGAL DISCLAIMER:</strong>
            ${premarketReport.disclaimer}
            <div style="margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 15px; text-align: center;">
              <p style="margin: 0;">&copy; 2026 Fundamental News Stocks Analyser. All rights reserved.</p>
              <p style="margin: 5px 0 0 0;">This email is a manual test dispatch triggered for developers.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    // 5. Send to the specified recipient directly
    console.log(`[${new Date().toISOString()}] Test Mailer: Dispatching direct email to "${testReceiver}" via Resend...`);
    const payload = {
      from: 'Premarket Report <onboarding@resend.dev>',
      to: testReceiver,
      subject: `🇮🇳 Test: India NSE/BSE Premarket Brief - ${dateString}`,
      html: emailHtml
    };

    const sendRes = await axios.post('https://api.resend.com/emails', payload, {
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log(`[${new Date().toISOString()}] Test Mailer: Email successfully sent to ${testReceiver}. Status: ${sendRes.status}`);

    return res.json({
      success: true,
      message: `Manual test premarket email sent successfully to ${testReceiver}.`,
      resendEmailId: sendRes.data?.id,
      modelUsed: successfulModel,
      timeTakenMs: Date.now() - startTime
    });

  } catch (error) {
    if (error.response) {
      console.error(`[Resend] Direct send failed (Status: ${error.response.status}):`, JSON.stringify(error.response.data));
      return res.status(error.response.status).json({
        error: 'Failed to send test email through Resend API.',
        resendDetails: error.response.data
      });
    }
    console.error(`[${new Date().toISOString()}] Test Mailer Error:`, error.message);
    return res.status(500).json({
      error: 'An internal error occurred during direct premarket email send.',
      message: error.message
    });
  }
});


// -------------------------------------------------------------
// Instagram Carousel Sharing Endpoint
// -------------------------------------------------------------
app.post('/api/instagram/share', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Instagram Share: Starting sharing flow...`);
  
  try {
    const { images, caption } = req.body;
    
    if (!images || !Array.isArray(images) || images.length < 2 || images.length > 10) {
      return res.status(400).json({ error: 'Instagram carousel requires between 2 and 10 images.' });
    }
    
    const igUserId = process.env.IG_USER_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    
    if (!igUserId || !accessToken) {
      return res.status(500).json({ error: 'Instagram credentials (IG_USER_ID or META_ACCESS_TOKEN) are not configured on the server.' });
    }
    
    if (!blobToken) {
      return res.status(500).json({ error: 'Vercel Blob storage token (BLOB_READ_WRITE_TOKEN) is missing. Please connect Vercel Blob.' });
    }
    
    // 1. Upload base64 images to Vercel Blob in parallel
    console.log(`[${new Date().toISOString()}] Instagram Share: Uploading ${images.length} images to Vercel Blob...`);
    const uploadPromises = images.map(async (base64Str, index) => {
      const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        throw new Error(`Invalid base64 string format at index ${index}`);
      }
      
      const buffer = Buffer.from(matches[2], 'base64');
      const contentType = matches[1];
      const extension = contentType.split('/')[1] || 'png';
      const filename = `premarket-slide-${Date.now()}-${index}.${extension}`;
      
      const blob = await put(filename, buffer, {
        access: 'public',
        contentType: contentType,
        token: blobToken
      });

      
      return blob.url;
    });
    
    const imageUrls = await Promise.all(uploadPromises);
    console.log(`[${new Date().toISOString()}] Instagram Share: Successfully uploaded all images. URLs:`, imageUrls);
    
    // 2. Create Instagram media container for each image in parallel
    console.log(`[${new Date().toISOString()}] Instagram Share: Creating individual media containers...`);
    const containerPromises = imageUrls.map(async (url, index) => {
      const mediaContainerUrl = `https://graph.facebook.com/v20.0/${igUserId}/media`;
      const response = await axios.post(mediaContainerUrl, null, {
        params: {
          image_url: url,
          is_carousel_item: true,
          access_token: accessToken
        }
      });
      return response.data.id;
    });
    
    const containerIds = await Promise.all(containerPromises);
    console.log(`[${new Date().toISOString()}] Instagram Share: Container IDs created:`, containerIds);
    
    // 3. Poll each container status until they are all FINISHED in parallel
    console.log(`[${new Date().toISOString()}] Instagram Share: Waiting for containers to process...`);
    const checkContainerStatus = async (id) => {
      const checkUrl = `https://graph.facebook.com/v20.0/${id}`;
      let attempts = 0;
      const maxAttempts = 15;
      
      while (attempts < maxAttempts) {
        const response = await axios.get(checkUrl, {
          params: {
            fields: 'status_code',
            access_token: accessToken
          }
        });
        
        const status = response.data.status_code;
        if (status === 'FINISHED') {
          return true;
        }
        if (status === 'ERROR') {
          throw new Error(`Container ${id} failed processing with status ERROR`);
        }
        
        // Wait 1.5s before polling again
        await new Promise(r => setTimeout(r, 1500));
        attempts++;
      }
      throw new Error(`Container ${id} processing timed out`);
    };
    
    await Promise.all(containerIds.map(id => checkContainerStatus(id)));
    console.log(`[${new Date().toISOString()}] Instagram Share: All media containers are FINISHED.`);
    
    // 4. Create the carousel container
    console.log(`[${new Date().toISOString()}] Instagram Share: Creating parent CAROUSEL container...`);
    const carouselCreateUrl = `https://graph.facebook.com/v20.0/${igUserId}/media`;
    const carouselResponse = await axios.post(carouselCreateUrl, null, {
      params: {
        media_type: 'CAROUSEL',
        children: containerIds.join(','),
        caption: caption || '',
        access_token: accessToken
      }
    });
    
    const carouselContainerId = carouselResponse.data.id;
    console.log(`[${new Date().toISOString()}] Instagram Share: Parent carousel container ID: ${carouselContainerId}`);
    
    // Wait briefly to allow Facebook's DB to settle
    await new Promise(r => setTimeout(r, 2000));
    
    // 5. Publish the carousel container
    console.log(`[${new Date().toISOString()}] Instagram Share: Publishing post...`);
    const publishUrl = `https://graph.facebook.com/v20.0/${igUserId}/media_publish`;
    const publishResponse = await axios.post(publishUrl, null, {
      params: {
        creation_id: carouselContainerId,
        access_token: accessToken
      }
    });
    
    const mediaId = publishResponse.data.id;
    console.log(`[${new Date().toISOString()}] Instagram Share: Post published successfully! Media ID: ${mediaId}`);
    
    // 6. Clean up Vercel Blob in the background (non-blocking)
    imageUrls.forEach(url => {
      del(url, { token: blobToken }).catch(err => {
        console.error(`[${new Date().toISOString()}] Instagram Share: Cleanup failed for ${url}:`, err.message);
      });
    });
    
    return res.json({
      success: true,
      mediaId,
      timeTakenMs: Date.now() - startTime
    });
    
  } catch (error) {
    const errorData = error.response?.data?.error || {};
    console.error(`[${new Date().toISOString()}] Instagram Share Error:`, errorData.message || error.message);
    
    return res.status(500).json({
      error: 'Instagram sharing failed',
      details: errorData.message || error.message,
      fbError: errorData
    });
  }
});


// Load instruments into cache on module initialization
loadInstruments();


// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Active environment port configuration: ${process.env.PORT || 'Default 3000'}`);
});

export default app;
