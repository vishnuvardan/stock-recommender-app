import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { 
  RecommendationService, 
  RecommendationsResponse, 
  NewsItem,
  StockSuggestion,
  ResearchResponse
} from './services/recommendation.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private recommenderService = inject(RecommendationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

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

  // Stock Research signals
  protected readonly activeTab = signal<'news' | 'research'>('news');
  protected readonly researchQuerySymbol = signal<string>('');
  protected readonly suggestions = signal<StockSuggestion[]>([]);
  protected readonly isResearchLoading = signal<boolean>(false);
  protected readonly researchError = signal<string | null>(null);
  protected readonly researchData = signal<ResearchResponse | null>(null);

  // Default disclaimer text displayed prior to load
  protected readonly defaultDisclaimer = 
    'This analysis is purely for swing trading purposes. Market news has highly volatile short-term impacts that can reverse rapidly. ' +
    'We are NOT SEBI registered advisors. This output is an AI-generated text analysis and does NOT constitute formal financial advice. ' +
    'Use your own knowledge and due diligence before making any trade decisions. We hold zero liability for financial actions taken based on this tool.';

  private suggestionTimeout: any = null;

  ngOnInit(): void {
    // Listen to query parameters to drive view and search routing
    this.route.queryParams.subscribe(params => {
      const page = params['page'];
      const stock = params['stock'];

      if (page === 'research' || stock) {
        this.activeTab.set('research');
        if (stock) {
          const cleanStock = stock.trim().toUpperCase();
          this.researchQuerySymbol.set(cleanStock);
          this.runStockResearch(cleanStock);
        } else {
          this.researchData.set(null);
          this.researchError.set(null);
        }
      } else {
        this.activeTab.set('news');
        if (this.articles().length === 0) {
          this.fetchNews();
        }
      }
    });
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

  // Switch tabs programmatically updating query params
  switchTab(tab: 'news' | 'research'): void {
    this.activeTab.set(tab);
    if (tab === 'news') {
      this.router.navigate([], {
        queryParams: { page: 'news', stock: null },
        queryParamsHandling: 'merge'
      });
    } else {
      const stock = this.researchQuerySymbol();
      this.router.navigate([], {
        queryParams: { page: 'research', stock: stock ? stock : null },
        queryParamsHandling: 'merge'
      });
    }
  }

  // Handle autocomplete input text changes with a short debounce
  onSearchInput(query: string): void {
    this.researchQuerySymbol.set(query);
    if (this.suggestionTimeout) {
      clearTimeout(this.suggestionTimeout);
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      this.suggestions.set([]);
      return;
    }

    this.suggestionTimeout = setTimeout(() => {
      this.recommenderService.getSuggestions(trimmed).subscribe({
        next: (data) => {
          this.suggestions.set(data || []);
        },
        error: (err) => {
          console.error('Error fetching suggestions:', err);
        }
      });
    }, 150);
  }

  // Handle selection from autocomplete suggestions dropdown
  selectSuggestion(suggestion: StockSuggestion): void {
    this.researchQuerySymbol.set(suggestion.symbol);
    this.suggestions.set([]);
    this.triggerResearch(suggestion.symbol);
  }

  // Set URL parameter and navigate
  triggerResearch(symbol: string): void {
    if (!symbol) return;
    const cleanSymbol = symbol.trim().toUpperCase();
    this.router.navigate([], {
      queryParams: { page: 'research', stock: cleanSymbol },
      queryParamsHandling: 'merge'
    });
  }

  // Call backend to perform Gemini individual stock analysis
  runStockResearch(symbol: string): void {
    this.isResearchLoading.set(true);
    this.researchError.set(null);
    this.researchData.set(null);

    this.recommenderService.getResearch(symbol).subscribe({
      next: (data) => {
        this.researchData.set(data);
        this.isResearchLoading.set(false);
      },
      error: (err) => {
        console.error('Error performing stock research:', err);
        let msg = 'Failed to generate stock analysis. Please try again.';
        if (err.status === 502 && err.error?.error) {
          msg = err.error.error;
        } else if (err.error?.message) {
          msg = err.error.message;
        }
        this.researchError.set(msg);
        this.isResearchLoading.set(false);
      }
    });
  }

  // Helper to calculate percentage position on price track
  getPricePercent(price: number | undefined, min: number | undefined, max: number | undefined): number {
    if (price === undefined || min === undefined || max === undefined || min === max) return 0;
    const pct = ((price - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, pct)); // Clamp between 0% and 100%
  }

  // Helper to calculate upside percentage
  getUpsidePercent(price: number | undefined, target: number | undefined): number {
    if (!price || !target || target <= price) return 0;
    return ((target - price) / price) * 100;
  }

  // Helper to calculate downside risk percentage
  getDownsidePercent(price: number | undefined, stopLoss: number | undefined): number {
    if (!price || !stopLoss || stopLoss >= price) return 0;
    return ((price - stopLoss) / price) * 100;
  }

  // Helper method to compile analysis and copy it as raw Markdown to clipboard
  copyMarkdownAnalysis(): void {
    const data = this.researchData();
    if (!data) return;

    let markdown = `# Investment Research Report: ${data.companyName} (${data.symbol})\n\n`;
    markdown += `**Signal:** ${data.signal} (${data.signalReason})\n\n`;

    if (data.trendIndicator || data.buyingPosition) {
      markdown += `### Beginner-Friendly Insights\n`;
      if (data.trendIndicator) {
        markdown += `- **Trend Status:** ${data.trendIndicator.text} (${data.trendIndicator.signal.toUpperCase()})\n`;
      }
      if (data.buyingPosition) {
        markdown += `- **Buying Valuation:** ${data.buyingPosition.text}\n`;
      }
      markdown += `\n`;
    }

    markdown += `## 1. Stock Overview\n`;
    markdown += `- **Primary Listing/Exchange:** ${data.overview.primaryExchange}\n`;
    markdown += `- **Previous Names:** ${data.overview.previousNames}\n`;
    markdown += `- **Core Business Segments:** ${data.overview.coreSegments.join(', ')}\n`;
    markdown += `- **Revenue Drivers & Business Model:** ${data.overview.revenueDrivers}\n\n`;

    markdown += `## 2. Key Financial & Market Data\n\n`;
    markdown += `| Metric | Value | Insight |\n`;
    markdown += `| :--- | :--- | :--- |\n`;
    data.financials.forEach(f => {
      markdown += `| ${f.metric} | ${f.value} | ${f.insight} |\n`;
    });
    markdown += `\n`;

    markdown += `## 3. Fundamental Thesis: Pros vs. Cons\n\n`;
    markdown += `### Strengths & Growth Catalysts\n`;
    data.thesis.pros.forEach(pro => {
      markdown += `- ${pro}\n`;
    });
    markdown += `\n### Key Risks & Headwinds\n`;
    data.thesis.cons.forEach(con => {
      markdown += `- ${con}\n`;
    });
    markdown += `\n`;

    markdown += `## 4. Actionable Signal Breakdown\n`;
    markdown += `- **New Investors:** ${data.guidance.newInvestors}\n`;
    markdown += `- **Existing Holders:** ${data.guidance.existingHolders}\n`;
    markdown += `- **Short-Term / Swing Traders:** ${data.guidance.swingTraders}\n\n`;

    markdown += `---\n*Report generated by AI-Driven Stocks Analyser on ${new Date().toLocaleDateString()}. Disclaimer: SEBI registration pending. This is not formal financial advice.*`;

    navigator.clipboard.writeText(markdown).then(() => {
      alert('Markdown analysis copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy text: ', err);
      alert('Failed to copy to clipboard. Please copy manually.');
    });
  }
}
