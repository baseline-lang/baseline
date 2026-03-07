#!/usr/bin/env node

/**
 * Generates sitemap.xml from the prerendered build output.
 * Run after `npm run build`: node scripts/generate-sitemap.js
 */

import { readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const SITE_URL = 'https://baseline-lang.org';
const BUILD_DIR = new URL('../build', import.meta.url).pathname;

function collectHtmlFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectHtmlFiles(full, files);
    } else if (entry.endsWith('.html') && entry !== '404.html') {
      files.push(full);
    }
  }
  return files;
}

const htmlFiles = collectHtmlFiles(BUILD_DIR);
const urls = htmlFiles.map(f => {
  let path = '/' + relative(BUILD_DIR, f).replace(/index\.html$/, '').replace(/\.html$/, '');
  if (path.endsWith('/') && path !== '/') path = path.slice(0, -1);
  return path;
}).sort();

const today = new Date().toISOString().split('T')[0];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${SITE_URL}${url}</loc>
    <lastmod>${today}</lastmod>
  </url>`).join('\n')}
</urlset>
`;

writeFileSync(join(BUILD_DIR, 'sitemap.xml'), sitemap);
console.log(`Generated sitemap.xml with ${urls.length} URLs`);
