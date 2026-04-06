-- 041: Seed supplier rules for personal vs business categorization
--
-- These rules pre-match common merchants before hitting the AI,
-- saving API calls and ensuring consistency.

-- Personal merchants → DISCARD (auto-ignore)
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('africa.*25|save up challenge|quick save|round up', 'Personal Savings', 'DISCARD', true, false, 'gst_free'),
  ('ecodia invest|ecodia savings', 'Ecodia Invest (Personal)', 'DISCARD', true, false, 'gst_free'),
  ('superhero', 'Superhero (Personal)', 'DISCARD', true, false, 'gst_free'),
  ('centrelink', 'Centrelink', 'DISCARD', true, false, 'gst_free'),
  ('dewr admin', 'DEWR Salary', 'DISCARD', true, false, 'gst_free'),
  ('felix mobile', 'Felix Mobile', 'DISCARD', true, false, 'gst_free'),
  ('chess\.com', 'Chess.com', 'DISCARD', true, false, 'gst_free'),
  ('audible', 'Audible', 'DISCARD', true, false, 'gst_free'),
  ('rollerdrome', 'Rollerdrome', 'DISCARD', true, false, 'gst_free'),
  ('helen donohoe', 'Helen Donohoe', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

-- Business merchants → real GL account codes
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('ASIC|australian securities', 'ASIC', '5025', true, true, 'gst_inclusive'),
  ('GOOGLE\*GSUITE|google workspace', 'Google Workspace', '5010', true, true, 'gst_inclusive'),
  ('GOOGLE\*CLOUD', 'Google Cloud', '5010', true, true, 'gst_inclusive'),
  ('VERCEL', 'Vercel', '5010', true, true, 'gst_free'),
  ('GODADDY|DNH\*GODADDY', 'GoDaddy', '5010', true, true, 'gst_inclusive'),
  ('WORDPRESS|WP\*WORDPRESS', 'WordPress.com', '5010', true, true, 'gst_inclusive'),
  ('LinkedInPreC|linkedin.*prem', 'LinkedIn Premium', '5005', true, true, 'gst_inclusive'),
  ('FACEBK|facebook.*ads', 'Facebook Ads', '5005', true, true, 'gst_free'),
  ('OPENAI|CHATGPT', 'OpenAI', '5010', true, true, 'gst_free'),
  ('MACINCLOUD', 'MacInCloud', '5010', true, true, 'gst_free'),
  ('AVERYPRODUCTS', 'Avery Products', '5030', true, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;

-- More business merchants
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('hostinger', 'Hostinger', '5010', true, true, 'gst_free'),
  ('ANTHROPIC', 'Anthropic', '5010', true, true, 'gst_free'),
  ('RENDER\.COM', 'Render', '5010', true, true, 'gst_free'),
  ('USERSWP|AYECODE', 'UsersWP/AyeCode', '5010', true, true, 'gst_free'),
  ('BIZ\s*COVER|EZI\*BIZ', 'BizCover', '5025', true, true, 'gst_inclusive'),
  ('ECODIA PTY', 'Ecodia Pty Ltd (Stripe test)', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

-- More personal merchants
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('translink|smartticket', 'Translink', 'DISCARD', true, false, 'gst_free'),
  ('google one', 'Google One', 'DISCARD', true, false, 'gst_free'),
  ('suncorp transactional', 'Suncorp (Personal Transfer)', 'DISCARD', true, false, 'gst_free'),
  ('QUT SPORT', 'QUT Sport', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

-- Ecodia inter-account transfers (NOT Invest/Savings) need special handling
-- These are capital contributions (money OUT to Ecodia) or reimbursements (money IN from Ecodia)
-- The AI prompt handles these via CAPITAL_CONTRIBUTION / REIMBURSEMENT special codes
-- No rule needed — let the AI decide direction based on +/- amount

-- Canva — always Ecodia business
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('canva', 'Canva', '5010', true, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;

-- Apple is ambiguous — multiple subscriptions, some personal (iCloud), some could be business
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, needs_review, gst_treatment)
VALUES
  ('APPLE\.COM/BILL', 'Apple', 'DISCARD', true, false, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;
