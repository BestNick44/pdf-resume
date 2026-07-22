// App-owned, best-effort declarations for only the PDF.js surface used by app code.
// This file grows or shrinks with app usage and is never generated from or
// reconciled against the vendored PDF.js files.

export interface PdfJsEventMap {
  documentinit: { source?: unknown };
  pagechanging: { source?: unknown };
  pagerendered: {
    error?: unknown;
    pageNumber?: number;
    source?: unknown;
  };
  pagesdestroy: { source?: unknown };
  pagesinit: { source?: unknown };
  updateviewarea: { source?: unknown };
}

export interface PdfJsEventBus {
  on<EventName extends keyof PdfJsEventMap>(
    eventName: EventName,
    listener: (event: PdfJsEventMap[EventName]) => void,
  ): void;
  off<EventName extends keyof PdfJsEventMap>(
    eventName: EventName,
    listener: (event: PdfJsEventMap[EventName]) => void,
  ): void;
}

export interface PdfJsPageView {
  renderingState: number;
}

export interface PdfJsPdfViewer {
  currentPageNumber: number;
  pagesCount: number;
  pagesPromise?: PromiseLike<unknown> | null;
  getPageView?(index: number): PdfJsPageView | null | undefined;
}

export interface PdfJsDocument {
  numPages: number;
  getMetadata(): Promise<unknown>;
}

export interface PdfJsOpenOptions {
  originalUrl: string;
  url: string;
}

export interface PdfJsApplicationBoundary {
  appConfig?: {
    mainContainer?: HTMLElement;
  };
  eventBus?: PdfJsEventBus;
  initializedPromise?: PromiseLike<unknown>;
  isInitialViewSet?: boolean;
  open?(options: PdfJsOpenOptions): PromiseLike<void>;
  pdfDocument?: PdfJsDocument | null;
  pdfViewer?: PdfJsPdfViewer;
}

export type PdfJsApplication = PdfJsApplicationBoundary & {
  eventBus: PdfJsEventBus;
  initializedPromise: PromiseLike<unknown>;
  pdfViewer: PdfJsPdfViewer;
};

export interface PdfJsWindow extends Window {
  PDFViewerApplication?: PdfJsApplicationBoundary;
}

export interface PdfJsFrame extends HTMLIFrameElement {
  readonly contentWindow: PdfJsWindow | null;
}
