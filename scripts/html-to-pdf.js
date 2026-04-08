#!/usr/bin/env node
const puppeteer = require('puppeteer');
const path = require('path');

async function convertHtmlToPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const htmlUrl = `file://${path.resolve(htmlPath)}`;

  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '0mm',
      right: '0mm',
      bottom: '0mm',
      left: '0mm'
    }
  });

  await browser.close();
  console.log(`PDF generated: ${pdfPath}`);
}

const htmlPath = process.argv[2];
const pdfPath = process.argv[3];

if (!htmlPath || !pdfPath) {
  console.error('Usage: node html-to-pdf.js <input.html> <output.pdf>');
  process.exit(1);
}

convertHtmlToPdf(htmlPath, pdfPath).catch(err => {
  console.error('Error generating PDF:', err);
  process.exit(1);
});
