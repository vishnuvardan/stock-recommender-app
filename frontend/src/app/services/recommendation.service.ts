import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface NewsItem {
  title: string;
  description: string;
  url: string;
  // Optional parameters merged during analysis
  classification?: 'Good news' | 'No change' | 'Bad news';
  relatedStock?: string;
  recommendationReason?: string;
}

export interface RecommendationItem {
  headline: string;
  summary: string;
  classification: 'Good news' | 'No change' | 'Bad news';
  relatedStock: string;
  recommendationReason: string;
  url?: string;
}

export interface RecommendationsResponse {
  disclaimer: string;
  lastUpdated: string;
  processedByModel?: string;
  items: RecommendationItem[];
}

export interface StockSuggestion {
  symbol: string;
  name: string;
  exchange: string;
}

export interface ResearchOverview {
  primaryExchange: string;
  previousNames: string;
  coreSegments: string[];
  revenueDrivers: string;
}

export interface ResearchFinancial {
  metric: string;
  value: string;
  insight: string;
}

export interface ResearchThesis {
  pros: string[];
  cons: string[];
}

export interface ResearchGuidance {
  newInvestors: string;
  existingHolders: string;
  swingTraders: string;
}

export interface ResearchPriceTarget {
  accumulationMin: number;
  accumulationMax: number;
  targetPrice: number;
  stopLoss: number;
  currentPrice?: number;
}

export interface ResearchResponse {
  symbol: string;
  companyName: string;
  signal: 'BUY' | 'HOLD' | 'SELL';
  signalReason: string;
  overview: ResearchOverview;
  financials: ResearchFinancial[];
  thesis: ResearchThesis;
  guidance: ResearchGuidance;
  processedByModel?: string;
  trendIndicator?: {
    signal: 'green' | 'yellow' | 'red';
    text: string;
  };
  buyingPosition?: {
    text: string;
  };
  priceTargetAnalysis: ResearchPriceTarget;
}

@Injectable({
  providedIn: 'root',
})
export class RecommendationService {
  private http = inject(HttpClient);

  getNews(): Observable<{ items: NewsItem[] }> {
    return this.http.get<{ items: NewsItem[] }>('/api/news');
  }

  getRecommendations(articles: NewsItem[]): Observable<RecommendationsResponse> {
    return this.http.post<RecommendationsResponse>('/api/recommendations', { articles });
  }

  getSuggestions(query: string): Observable<StockSuggestion[]> {
    return this.http.get<StockSuggestion[]>(`/api/suggestions?q=${encodeURIComponent(query)}`);
  }

  getResearch(symbol: string): Observable<ResearchResponse> {
    return this.http.get<ResearchResponse>(`/api/research?symbol=${encodeURIComponent(symbol)}`);
  }
}
