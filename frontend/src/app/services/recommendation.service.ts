import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

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
  private apiUrl = 'http://localhost:3000/api/recommendations';

  getRecommendations(): Observable<RecommendationsResponse> {
    return this.http.get<RecommendationsResponse>(this.apiUrl);
  }
}
