import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RecommendationService, RecommendationsResponse, RecommendationItem } from './services/recommendation.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private recommenderService = inject(RecommendationService);

  // Core signals
  protected readonly data = signal<RecommendationsResponse | null>(null);
  protected readonly isLoading = signal<boolean>(false);
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

  // Computed signal for dynamically filtered items
  protected readonly filteredItems = computed(() => {
    const response = this.data();
    if (!response) return [];

    let items = response.items || [];
    const filter = this.activeFilter();
    const query = this.searchQuery().toLowerCase().trim();

    // Apply category filter
    if (filter !== 'ALL') {
      items = items.filter(item => {
        if (filter === 'GOOD') return item.classification === 'Good news';
        if (filter === 'BAD') return item.classification === 'Bad news';
        if (filter === 'NEUTRAL') return item.classification === 'No change';
        return true;
      });
    }

    // Apply search query
    if (query) {
      items = items.filter(
        item =>
          item.headline.toLowerCase().includes(query) ||
          item.summary.toLowerCase().includes(query) ||
          item.relatedStock.toLowerCase().includes(query) ||
          item.recommendationReason.toLowerCase().includes(query)
      );
    }

    return items;
  });

  fetchFeed(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.recommenderService.getRecommendations().subscribe({
      next: (response) => {
        this.data.set(response);
        this.isLoading.set(false);
      },
      error: (err) => {
        console.error('Error fetching market feed:', err);
        let msg = 'Failed to load recommendations. Please try again.';
        if (err.status === 502 && err.error?.error) {
          msg = err.error.error; // Displays fallback exhaustion error specifically
        } else if (err.error?.message) {
          msg = err.error.message;
        }
        this.errorMessage.set(msg);
        this.isLoading.set(false);
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
    const response = this.data();
    if (!response) return 0;
    return response.items.filter(item => item.classification === classification).length;
  }
}
