-- 041: Seed supplier rules for personal vs business categorization
--
-- These rules pre-match common merchants before hitting the AI,
-- saving API calls and ensuring consistency.

-- Personal merchants → DISCARD (auto-ignore)
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment, category)
VALUES
  ('africa.*25|save up challenge|quick save|round up', 'Personal Savings', 'DISCARD', true, false, 'gst_free', 'personal_transfer'),
  ('ecodia invest|ecodia savings', 'Ecodia Invest (Personal)', 'DISCARD', true, false, 'gst_free', 'personal_investment'),
  ('superhero', 'Superhero (Personal)', 'DISCARD', true, false, 'gst_free', 'personal_investment'),
  ('centrelink', 'Centrelink', 'DISCARD', true, false, 'gst_free', 'income_personal'),
  ('dewr admin', 'DEWR Salary', 'DISCARD', true, false, 'gst_free', 'income_personal'),
  ('felix mobile', 'Felix Mobile', 'DISCARD', true, false, 'gst_free', 'personal_phone'),
  ('chess\.com', 'Chess.com', 'DISCARD', true, false, 'gst_free', 'personal_entertainment'),
  ('audible', 'Audible', 'DISCARD', true, false, 'gst_free', 'personal_entertainment'),
  ('rollerdrome', 'Rollerdrome', 'DISCARD', true, false, 'gst_free', 'personal_entertainment'),
  ('helen donohoe', 'Helen Donohoe', 'DISCARD', true, false, 'gst_free', 'personal_transfer')
ON CONFLICT DO NOTHING;

-- Business merchants → real GL account codes
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment, category)
VALUES
  ('ASIC|australian securities', 'ASIC', '5025', true, true, 'gst_inclusive', 'legal_compliance'),
  ('GOOGLE\*GSUITE|google workspace', 'Google Workspace', '5010', true, true, 'gst_inclusive', 'software_saas'),
  ('GOOGLE\*CLOUD', 'Google Cloud', '5010', true, true, 'gst_inclusive', 'hosting'),
  ('VERCEL', 'Vercel', '5010', true, true, 'gst_free', 'hosting'),
  ('GODADDY|DNH\*GODADDY', 'GoDaddy', '5010', true, true, 'gst_inclusive', 'domains'),
  ('WORDPRESS|WP\*WORDPRESS', 'WordPress.com', '5010', true, true, 'gst_inclusive', 'website'),
  ('LinkedInPreC|linkedin.*prem', 'LinkedIn Premium', '5005', true, true, 'gst_inclusive', 'marketing'),
  ('FACEBK|facebook.*ads', 'Facebook Ads', '5005', true, true, 'gst_free', 'advertising'),
  ('OPENAI|CHATGPT', 'OpenAI', '5010', true, true, 'gst_free', 'ai_tools'),
  ('MACINCLOUD', 'MacInCloud', '5010', true, true, 'gst_free', 'hosting'),
  ('AVERYPRODUCTS', 'Avery Products', '5030', true, true, 'gst_inclusive', 'office_supplies')
ON CONFLICT DO NOTHING;

-- Canva is ambiguous — could be personal or business. Flag for review.
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, needs_review, gst_treatment, category)
VALUES
  ('canva', 'Canva', '5010', true, true, true, 'gst_inclusive', 'design_tool')
ON CONFLICT DO NOTHING;
