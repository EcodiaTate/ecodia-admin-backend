const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = '/tmp/coexist_screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

const EMAIL = 'code@ecodia.au';
const PASSWORD = '3C0d1a05!';
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
  await page.setViewport({ width: 1280, height: 900 });

  // Go directly to admin — see what it shows
  console.log('=== Navigating directly to /admin ===');
  await page.goto('https://app.coexistaus.org/admin', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'admin_direct.png') });
  console.log('Admin direct URL:', page.url());
  const adminText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log('Admin direct text:', adminText);

  // Check if there's a login form on the admin app
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, placeholder: i.placeholder, id: i.id }))
  );
  console.log('Inputs:', JSON.stringify(inputs));

  // If redirected to login, try logging in from the admin app's login page
  if (page.url().includes('login') || inputs.some(i => i.type === 'email' || i.type === 'password')) {
    console.log('Admin has its own login - attempting...');
    await clickButtonByText(page, 'Accept All');
    await sleep(500);
    
    const emailInput = await page.$('input[type="email"]');
    const passInput = await page.$('input[type="password"]');
    if (emailInput) { await emailInput.type(EMAIL); }
    if (passInput) { await passInput.type(PASSWORD); }
    
    await clickButtonByText(page, 'Log In');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    await sleep(3000);
    console.log('After admin login URL:', page.url());
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'admin_after_login.png') });
  }

  // Now try admin/impact directly (within the admin app context)
  console.log('\n=== Admin Impact page ===');
  await page.goto('https://app.coexistaus.org/admin/impact', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(4000);
  
  // Wait for any React loading to finish
  await page.waitForFunction(() => document.body.innerText.trim().length > 10, { timeout: 10000 }).catch(() => {});
  
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'admin_impact.png'), fullPage: true });
  const impactText = await page.evaluate(() => document.body.innerText);
  console.log('Impact URL:', page.url());
  console.log('Impact text:', impactText.substring(0, 3000));
  console.log('Has "Metrics":', impactText.includes('Metrics'));
  console.log('Has "Dashboard":', impactText.includes('Dashboard') || impactText.includes('dashboard'));

  // Admin surveys
  console.log('\n=== Admin Surveys page ===');
  await page.goto('https://app.coexistaus.org/admin/surveys', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(4000);
  await page.waitForFunction(() => document.body.innerText.trim().length > 10, { timeout: 10000 }).catch(() => {});
  
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'admin_surveys.png'), fullPage: true });
  const surveysText = await page.evaluate(() => document.body.innerText);
  console.log('Surveys URL:', page.url());
  console.log('Surveys text:', surveysText.substring(0, 3000));

  const expectedSurveys = ['Clean Up', 'Tree Planting', 'Ecosystem Restoration', 'Nature Hike', 'Camp Out', 'Spotlighting', 'Other'];
  for (const s of expectedSurveys) {
    console.log(`"${s}": ${surveysText.includes(s) ? 'FOUND' : 'MISSING'}`);
  }

  await browser.close();
  console.log('\nScreenshots in', SCREENSHOT_DIR);
})();
