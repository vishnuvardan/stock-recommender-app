import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { 
  RecommendationService, 
  RecommendationsResponse, 
  NewsItem,
  StockSuggestion,
  ResearchResponse,
  PremarketReportResponse,
  PremarketSlide
} from './services/recommendation.service';

declare var html2canvas: any;

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
  protected readonly activeTab = signal<'news' | 'research' | 'premarket'>('news');
  protected readonly researchQuerySymbol = signal<string>('');
  protected readonly suggestions = signal<StockSuggestion[]>([]);
  protected readonly isResearchLoading = signal<boolean>(false);
  protected readonly researchError = signal<string | null>(null);
  protected readonly researchData = signal<ResearchResponse | null>(null);
  protected readonly activeSlideIndex = signal<number>(0);

  // Premarket report signals
  protected readonly premarketData = signal<PremarketReportResponse | null>(null);
  protected readonly isPremarketLoading = signal<boolean>(false);
  protected readonly premarketError = signal<string | null>(null);
  protected readonly activePremarketSlideIndex = signal<number>(0);

  // Instagram Share signals
  protected readonly isInstagramModalOpen = signal<boolean>(false);
  protected readonly isInstagramSharing = signal<boolean>(false);
  protected readonly instagramShareStatus = signal<'idle' | 'capturing' | 'uploading' | 'success' | 'error'>('idle');
  protected readonly instagramError = signal<string | null>(null);
  protected readonly instagramCaption = signal<string>('');
  protected readonly instagramAdminSecret = signal<string>('');


  // Subscription signals
  protected readonly subscriberEmail = signal<string>('');
  protected readonly isSubscribing = signal<boolean>(false);
  protected readonly subscriptionSuccess = signal<boolean>(false);
  protected readonly subscriptionError = signal<string | null>(null);

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
      } else if (page === 'premarket') {
        this.activeTab.set('premarket');
        if (!this.premarketData()) {
          this.fetchPremarketReport();
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
  switchTab(tab: 'news' | 'research' | 'premarket'): void {
    this.activeTab.set(tab);
    if (tab === 'news') {
      this.router.navigate([], {
        queryParams: { page: 'news', stock: null },
        queryParamsHandling: 'merge'
      });
    } else if (tab === 'premarket') {
      this.router.navigate([], {
        queryParams: { page: 'premarket', stock: null },
        queryParamsHandling: 'merge'
      });
      if (!this.premarketData()) {
        this.fetchPremarketReport();
      }
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
        this.activeSlideIndex.set(0);
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

  nextSlide(): void {
    const current = this.activeSlideIndex();
    if (current < 4) {
      this.activeSlideIndex.set(current + 1);
    }
  }

  prevSlide(): void {
    const current = this.activeSlideIndex();
    if (current > 0) {
      this.activeSlideIndex.set(current - 1);
    }
  }

  setSlide(index: number): void {
    if (index >= 0 && index < 5) {
      this.activeSlideIndex.set(index);
    }
  }

  downloadSlide(slideIndex: number): void {
    const slideElement = document.getElementById(`instagram-slide-${slideIndex}`);
    if (!slideElement) {
      alert('Slide element not found.');
      return;
    }

    const symbol = this.researchData()?.symbol || 'STOCK';
    
    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    html2canvas(slideElement, {
      scale: 2.5, // 432px * 2.5 = 1080px width, 540px * 2.5 = 1350px height
      useCORS: true,
      logging: false,
      backgroundColor: null
    }).then((canvas: any) => {
      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `${symbol}_slide_${slideIndex + 1}.png`;
      link.click();
    }).catch((err: any) => {
      console.error('Error generating image:', err);
      alert('Failed to generate slide image.');
    });
  }

  async downloadAllSlides(): Promise<void> {
    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    const symbol = this.researchData()?.symbol || 'STOCK';

    for (let i = 0; i < 5; i++) {
      const slideElement = document.getElementById(`instagram-slide-${i}`);
      if (!slideElement) continue;

      try {
        const canvas = await html2canvas(slideElement, {
          scale: 2.5,
          useCORS: true,
          logging: false,
          backgroundColor: null
        });
        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = imgData;
        link.download = `${symbol}_slide_${i + 1}.png`;
        link.click();
        
        // Brief delay between downloads
        await new Promise(resolve => setTimeout(resolve, 350));
      } catch (err) {
        console.error(`Error generating slide ${i + 1} image:`, err);
      }
    }
  }

  fetchPremarketReport(): void {
    this.isPremarketLoading.set(true);
    this.premarketError.set(null);
    this.premarketData.set(null);

    this.recommenderService.getPremarketReport().subscribe({
      next: (response) => {
        this.premarketData.set(response);
        this.activePremarketSlideIndex.set(0);
        this.isPremarketLoading.set(false);
      },
      error: (err) => {
        console.error('Error fetching premarket report:', err);
        const msg = err.error?.error || err.error?.message || 'Failed to retrieve premarket report. Please try again.';
        this.premarketError.set(msg);
        this.isPremarketLoading.set(false);
      }
    });
  }

  prevPremarketSlide(): void {
    const current = this.activePremarketSlideIndex();
    if (current > 0) {
      this.activePremarketSlideIndex.set(current - 1);
    }
  }

  nextPremarketSlide(): void {
    const current = this.activePremarketSlideIndex();
    const slides = this.premarketData()?.slides || [];
    if (current < slides.length - 1) {
      this.activePremarketSlideIndex.set(current + 1);
    }
  }

  setPremarketSlide(index: number): void {
    const slides = this.premarketData()?.slides || [];
    if (index >= 0 && index < slides.length) {
      this.activePremarketSlideIndex.set(index);
    }
  }

  downloadPremarketSlide(slideIndex: number): void {
    const slideElement = document.getElementById(`premarket-slide-${slideIndex}`);
    if (!slideElement) {
      alert('Slide element not found.');
      return;
    }

    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    html2canvas(slideElement, {
      scale: 2.5, // 432px * 2.5 = 1080px width, 540px * 2.5 = 1350px height
      useCORS: true,
      logging: false,
      backgroundColor: null
    }).then((canvas: any) => {
      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `Premarket_Slide_${slideIndex + 1}.png`;
      link.click();
    }).catch((err: any) => {
      console.error('Error generating premarket slide image:', err);
      alert('Failed to generate slide image.');
    });
  }

  async downloadAllPremarketSlides(): Promise<void> {
    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    const slides = this.premarketData()?.slides || [];
    for (let i = 0; i < slides.length; i++) {
      const slideElement = document.getElementById(`premarket-slide-${i}`);
      if (!slideElement) continue;

      try {
        const canvas = await html2canvas(slideElement, {
          scale: 2.5,
          useCORS: true,
          logging: false,
          backgroundColor: null
        });
        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = imgData;
        link.download = `Premarket_Slide_${i + 1}.png`;
        link.click();
        
        // Brief delay between downloads
        await new Promise(resolve => setTimeout(resolve, 350));
      } catch (err) {
        console.error(`Error generating premarket slide ${i + 1} image:`, err);
      }
    }
  }

  openInstagramShareModal(): void {
    const data = this.premarketData();
    if (!data || !data.slides || data.slides.length === 0) {
      alert('No premarket data available to share.');
      return;
    }

    const dateStr = data.lastUpdated ? new Date(data.lastUpdated).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }) : new Date().toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    this.instagramCaption.set(
      `🇮🇳 Premarket Report - ${dateStr}\n\n` +
      `Here is the market outlook and key stock updates for today. Swipe left to see details for Nifty levels and stock setups.\n\n` +
      `#PremarketReport #IndianStockMarket #Nifty50 #Sensex #NSE #BSE #StockMarketIndia #Trading #Investing #MarketAnalysis #StockAnalysis`
    );

    this.instagramShareStatus.set('idle');
    this.instagramError.set(null);
    this.isInstagramModalOpen.set(true);
  }

  closeInstagramShareModal(): void {
    if (this.isInstagramSharing()) return;
    this.isInstagramModalOpen.set(false);
    this.instagramShareStatus.set('idle');
    this.instagramError.set(null);
    this.instagramAdminSecret.set('');
  }


  async shareToInstagram(): Promise<void> {
    if (this.isInstagramSharing()) return;

    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    const slides = this.premarketData()?.slides || [];
    if (slides.length === 0) {
      alert('No slides to share.');
      return;
    }

    this.isInstagramSharing.set(true);
    this.instagramError.set(null);
    this.instagramShareStatus.set('capturing');

    const base64Images: string[] = [];

    try {
      // 1. Capture slides as base64 images
      for (let i = 0; i < slides.length; i++) {
        const slideElement = document.getElementById(`premarket-slide-${i}`);
        if (!slideElement) {
          throw new Error(`Slide element for slide #${i + 1} not found.`);
        }

        const canvas = await html2canvas(slideElement, {
          scale: 2.5, // 1080x1350 Instagram resolution
          useCORS: true,
          logging: false,
          backgroundColor: null
        });

        const imgData = canvas.toDataURL('image/jpeg', 0.85);
        base64Images.push(imgData);
        // Brief delay between captures to prevent browser freezing
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      this.instagramShareStatus.set('uploading');

      // 2. Send images and caption to backend
      this.recommenderService.shareToInstagram(base64Images, this.instagramCaption(), this.instagramAdminSecret()).subscribe({
        next: (res) => {

          this.instagramShareStatus.set('success');
          this.isInstagramSharing.set(false);
        },
        error: (err) => {
          console.error('Error sharing to Instagram:', err);
          this.instagramShareStatus.set('error');
          this.instagramError.set(
            err.error?.details || err.error?.error || 'Failed to post carousel to Instagram. Please verify configuration.'
          );
          this.isInstagramSharing.set(false);
        }
      });

    } catch (err: any) {
      console.error('Error rendering slides for Instagram:', err);
      this.instagramShareStatus.set('error');
      this.instagramError.set(err.message || 'An error occurred while generating slides.');
      this.isInstagramSharing.set(false);
    }
  }


  downloadNewsCard(event: MouseEvent, index: number): void {
    event.stopPropagation(); // Prevent navigation click
    
    const cardElement = document.getElementById(`news-card-${index}`);
    if (!cardElement) {
      alert('Card element not found.');
      return;
    }

    const symbol = this.articles()[index]?.relatedStock || 'NEWS';
    
    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library is not loaded yet. Please try again.');
      return;
    }

    html2canvas(cardElement, {
      scale: 3, // High resolution export
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff'
    }).then((canvas: any) => {
      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `${symbol}_news_recommendation.png`;
      link.click();
    }).catch((err: any) => {
      console.error('Error generating card image:', err);
      alert('Failed to generate image.');
    });
  }

  subscribeEmail(event: Event): void {
    event.preventDefault();
    const email = this.subscriberEmail().trim().toLowerCase();
    
    if (!email || !email.includes('@')) {
      this.subscriptionError.set('Please enter a valid email address.');
      this.subscriptionSuccess.set(false);
      return;
    }

    this.isSubscribing.set(true);
    this.subscriptionError.set(null);
    this.subscriptionSuccess.set(false);

    this.recommenderService.subscribeEmail(email).subscribe({
      next: (res) => {
        this.isSubscribing.set(false);
        this.subscriptionSuccess.set(true);
        this.subscriberEmail.set(''); // Clear input
      },
      error: (err) => {
        this.isSubscribing.set(false);
        const errMsg = err.error?.error || 'Failed to subscribe. Please try again later.';
        this.subscriptionError.set(errMsg);
      }
    });
  }
}
