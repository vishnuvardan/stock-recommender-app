import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RecommendationService, RecommendationsResponse, NewsItem } from './services/recommendation.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private recommenderService = inject(RecommendationService);

  // Core signals for separate phases
  protected readonly articles = signal<NewsItem[]>([]);
  protected readonly data = signal<RecommendationsResponse | null>(null); // For global metadata (disclaimer, active model)
  protected readonly isNewsLoading = signal<boolean>(false);
  protected readonly isAnalyzing = signal<boolean>(false);
  protected readonly isAnalyzed = signal<boolean>(false);
  protected readonly errorMessage = signal<string | null>(null);

  // Search & filter signals
  protected readonly searchQuery = signal<string>('');
  protected readonly activeFilter = signal<string>('ALL');

  // Stats signals
  protected readonly goodCount = computed(() => this.countByClassification('Good news'));
  protected readonly badCount = computed(() => this.countByClassification('Bad news'));
  protected readonly neutralCount = computed(() => this.countByClassification('No change'));

  // Default disclaimer text displayed prior to load
  protected readonly defaultDisclaimer = 
    'This analysis is purely for swing trading purposes. Market news has highly volatile short-term impacts that can reverse rapidly. ' +
    'We are NOT SEBI registered advisors. This output is an AI-generated text analysis and does NOT constitute formal financial advice. ' +
    'Use your own knowledge and due diligence before making any trade decisions. We hold zero liability for financial actions taken based on this tool.';

  ngOnInit(): void {
    // Automatically load raw news feed on landing
    this.fetchNews();
  }

  // Phase 1: Retrieve raw news from Finnhub (very fast)
  fetchNews(): void {
    this.isNewsLoading.set(true);
    this.errorMessage.set(null);
    this.isAnalyzed.set(false);
    this.data.set(null);

    this.recommenderService.getNews().subscribe({
      next: (response) => {
        this.articles.set(response.items || []);
        this.isNewsLoading.set(false);
      },
      error: (err) => {
        console.error('Error fetching raw news:', err);
        const msg = err.error?.message || 'Failed to retrieve market news feed. Please try again.';
        this.errorMessage.set(msg);
        this.isNewsLoading.set(false);
      }
    });
  }

  // Phase 2: Run AI sentiment analysis on the current displayed news (takes 10-25s)
  runAnalysis(): void {
    const currentArticles = this.articles();
    if (currentArticles.length === 0) return;

    this.isAnalyzing.set(true);
    this.errorMessage.set(null);

    this.recommenderService.getRecommendations(currentArticles).subscribe({
      next: (response) => {
        this.data.set(response);
        const recommendations = response.items || [];

        // Merge AI recommendations back into the current articles signal items
        this.articles.update((items) =>
          items.map((item, index) => {
            // Match by index, fallback to matching by title/headline
            const rec = recommendations[index] || recommendations.find((r) => r.headline === item.title) || {};
            return {
              ...item,
              classification: rec.classification,
              relatedStock: rec.relatedStock,
              recommendationReason: rec.recommendationReason,
            };
          })
        );

        this.isAnalyzing.set(false);
        this.isAnalyzed.set(true);
      },
      error: (err) => {
        console.error('Error performing AI analysis:', err);
        let msg = 'Failed to generate AI recommendations. Please try again.';
        if (err.status === 502 && err.error?.error) {
          msg = err.error.error;
        } else if (err.error?.message) {
          msg = err.error.message;
        }
        this.errorMessage.set(msg);
        this.isAnalyzing.set(false);
      },
    });
  }

  setFilter(filter: string): void {
    this.activeFilter.set(filter);
  }

  openArticle(url: string | undefined): void {
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  private countByClassification(classification: 'Good news' | 'Bad news' | 'No change'): number {
    return this.articles().filter((item) => item.classification === classification).length;
  }

  // Computed signal for dynamically filtered items
  protected readonly filteredItems = computed(() => {
    let items = this.articles();
    const filter = this.activeFilter();
    const query = this.searchQuery().toLowerCase().trim();

    // Apply category filter
    if (filter !== 'ALL') {
      items = items.filter((item) => {
        if (filter === 'GOOD') return item.classification === 'Good news';
        if (filter === 'BAD') return item.classification === 'Bad news';
        if (filter === 'NEUTRAL') return item.classification === 'No change';
        return true;
      });
    }

    // Apply search query
    if (query) {
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          (item.relatedStock && item.relatedStock.toLowerCase().includes(query)) ||
          (item.recommendationReason && item.recommendationReason.toLowerCase().includes(query))
      );
    }

    return items;
  });
}
