if (typeof globalThis.DOMMatrix === 'undefined') {
  // Minimal DOMMatrix polyfill for pdfjs-dist under Node/Vitest
  globalThis.DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  } as unknown as typeof globalThis.DOMMatrix;
}
