const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = '/tmp/coexist_screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

const EMAIL = 'code@ecodia.au';
const PASSWORD = '***REVOKED-CRED-SEE-INCIDENT-20260430***';

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Go to login
  await page.goto('https://app.coexistaus.org/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '1_login.png') });

  // Dump form HTML to understand structure
  const formHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
  console.log('Form HTML snippet:', formHtml);

})();
