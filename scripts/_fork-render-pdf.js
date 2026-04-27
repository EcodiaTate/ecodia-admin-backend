const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const [,, htmlPath, pdfPath, format] = process.argv;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const opts = format === 'landscape'
    ? { path: pdfPath, format: 'A4', landscape: true, margin: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true }
    : { path: pdfPath, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }, printBackground: true };
  await page.pdf(opts);
  await browser.close();
  console.log('Wrote', pdfPath);
})().catch(e => { console.error(e); process.exit(1); });
