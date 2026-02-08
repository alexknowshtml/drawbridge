#!/usr/bin/env tsx
/**
 * Convert Excalidraw JSON files to SVG or PNG
 *
 * Usage:
 *   tsx excalidraw-to-svg.ts <input.excalidraw> [output.svg|output.png]
 *
 * Output format is determined by file extension (defaults to .svg).
 * If no output path given, writes to same directory with .svg extension.
 *
 * Uses headless Chromium via Playwright to run Excalidraw's actual export
 * pipeline, producing faithful hand-drawn style output.
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { chromium } from 'playwright';

async function convert(inputPath: string, outputPath?: string): Promise<string> {
  const json = readFileSync(resolve(inputPath), 'utf-8');
  const diagram = JSON.parse(json);

  const elements = diagram.elements || [];
  const appState = diagram.appState || { viewBackgroundColor: '#ffffff' };

  const outFile = outputPath || join(
    dirname(resolve(inputPath)),
    basename(inputPath, '.excalidraw') + '.svg'
  );
  const format = extname(outFile).toLowerCase() === '.png' ? 'png' : 'svg';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Load Excalidraw from esm.sh CDN
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body>
      <script type="module">
        import { exportToSvg, convertToExcalidrawElements } from "https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle-deps";
        window.__exportToSvg = exportToSvg;
        window.__convertToExcalidrawElements = convertToExcalidrawElements;
        // Preload Excalidraw fonts for text measurement
        await Promise.all([
          document.fonts.load('20px Excalifont'),
          document.fonts.load('400 16px Assistant'),
          document.fonts.load('700 16px Assistant'),
        ]).catch(() => {});
        window.__ready = true;
      </script>
    </body>
    </html>
  `);

  await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 30000 });

  const svgString = await page.evaluate(async ({ elements, appState }) => {
    const exportToSvg = (window as any).__exportToSvg;
    const convert = (window as any).__convertToExcalidrawElements;

    // Detect skeleton format and convert if needed
    const needsConversion = elements.some((el: any) => el.label) ||
      elements.some((el: any) => !el.seed);
    let resolved = elements;
    if (needsConversion && convert) {
      const withDefaults = elements.map((el: any) =>
        el.label ? { ...el, label: { textAlign: 'center', verticalAlign: 'middle', ...el.label } } : el
      );
      resolved = convert(withDefaults, { regenerateIds: false });
    }

    const svg = await exportToSvg({
      elements: resolved,
      appState: {
        ...appState,
        exportBackground: true,
        exportWithDarkMode: false,
      },
      files: null,
      exportPadding: 20,
    });
    return svg.outerHTML;
  }, { elements, appState });

  if (format === 'png') {
    // Render SVG in browser and screenshot to PNG
    await page.setContent(svgString);
    // Extract viewBox dimensions for viewport
    const dims = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (!svg) return { width: 1200, height: 800 };
      return {
        width: parseInt(svg.getAttribute('width') || '1200'),
        height: parseInt(svg.getAttribute('height') || '800'),
      };
    });
    await page.setViewportSize({ width: dims.width, height: dims.height });
    await page.screenshot({ path: outFile, fullPage: true, type: 'png' });
  } else {
    writeFileSync(outFile, svgString);
  }

  await browser.close();
  return outFile;
}

const [,, inputPath, outputPath] = process.argv;

if (!inputPath) {
  console.error('Usage: tsx excalidraw-to-svg.ts <input.excalidraw> [output.svg|output.png]');
  process.exit(1);
}

convert(inputPath, outputPath)
  .then(outFile => console.log(`Written to: ${outFile}`))
  .catch(err => {
    console.error('Conversion failed:', err.message);
    process.exit(1);
  });
