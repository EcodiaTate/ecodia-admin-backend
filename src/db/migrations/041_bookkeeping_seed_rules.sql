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

-- Canva is ambiguous — could be personal or business. Flag for review.
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, needs_review, gst_treatment)
VALUES
  ('canva', 'Canva', '5010', true, true, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;
