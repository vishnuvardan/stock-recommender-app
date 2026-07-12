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
}
