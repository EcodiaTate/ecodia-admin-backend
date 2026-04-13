const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = '/tmp/coexist_screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

const EMAIL = 'code@ecodia.au';
const PASSWORD = '***REVOKED-CRED-SEE-INCIDENT-20260430***';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickButtonByText(page, text) {
  const btns = await page.$$('button');
  for (const btn of btns) {
    const t = await btn.evaluate(el => el.innerText.trim());
    if (t === text) { await btn.click(); return true; }
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  // Login
  await page.goto('https://app.coexistaus.org/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);
  await clickButtonByText(page, 'Accept All');
  await sleep(1000);
  await page.type('input[type="email"]', EMAIL);
  await page.type('input[type="password"]', PASSWORD);
  await clickButtonByText(page, 'Log In');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  await sleep(3000);
  console.log('Logged in, URL:', page.url());

  // --- ADMIN IMPACT PAGE ---
  console.log('\n--- Admin Impact Page ---');
  await page.goto('https://app.coexistaus.org/admin/impact', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(4000); // wait for React hydration
  
  // Get full HTML to see what's rendered
  const impactHtml = await page.evaluate(() => document.body.innerHTML);
  console.log('Impact HTML length:', impactHtml.length);
  console.log('Impact HTML (3000):', impactHtml.substring(0, 3000));
  
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '4_admin_impact.png'), fullPage: true });

  // Get all visible text
  const impactText = await page.evaluate(() => {
    // Get text from all elements including shadow DOM
    function getText(el) {
      return el.innerText || '';
    }
    return getText(document.body);
  });
  console.log('\nImpact visible text:', impactText.substring(0, 2000));

  // --- ADMIN SURVEYS PAGE ---
  console.log('\n--- Admin Surveys Page ---');
  await page.goto('https://app.coexistaus.org/admin/surveys', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(4000);
  
  const surveysHtml = await page.evaluate(() => document.body.innerHTML);
  console.log('Surveys HTML (3000):', surveysHtml.substring(0, 3000));
  
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '5_admin_surveys.png'), fullPage: true });

  const surveysText = await page.evaluate(() => document.body.innerText);
  console.log('\nSurveys visible text:', surveysText.substring(0, 2000));

  await browser.close();
})();
