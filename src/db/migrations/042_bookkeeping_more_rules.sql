-- 042: Additional supplier rules + cleanup garbage auto-learned rules

-- First: purge auto-learned rules that are reference numbers or garbage patterns
DELETE FROM supplier_rules WHERE learning_source = 'ai_learned'
  AND (
    pattern ~ '^[a-z0-9\\.*]{10,}$'           -- long alphanumeric garbage
    OR supplier_name ~ '^[A-Z0-9]{5,}'         -- ref-number supplier names
    OR pattern ~ '7d1b'                         -- Centrelink refs
    OR pattern ~ 'dewr'                         -- DEWR salary refs
    OR account_code = 'DISCARD'                 -- never should have learned DISCARD rules
    OR account_code = '2100'                    -- Director Loan as account code is wrong
  );

-- 042: Additional supplier rules discovered from CSV analysis
--
-- These cover patterns found in months 2-12 of the bank statements
-- that weren't in the initial seed.

INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES
  ('hostinger', 'Hostinger', '5010', true, true, 'gst_free'),
  ('ANTHROPIC', 'Anthropic', '5010', true, true, 'gst_free'),
  ('RENDER\.COM', 'Render', '5010', true, true, 'gst_free'),
  ('USERSWP|AYECODE', 'UsersWP/AyeCode', '5010', true, true, 'gst_free'),
  ('BIZ\s*COVER|EZI\*BIZ', 'BizCover', '5025', true, true, 'gst_inclusive'),
  ('ECODIA PTY', 'Ecodia Pty Ltd (Stripe test)', 'DISCARD', true, false, 'gst_free'),
  ('translink|smartticket', 'Translink', 'DISCARD', true, false, 'gst_free'),
  ('google one', 'Google One (Personal)', 'DISCARD', true, false, 'gst_free'),
  ('suncorp transactional', 'Suncorp (Personal Transfer)', 'DISCARD', true, false, 'gst_free'),
  ('QUT SPORT', 'QUT Sport', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

-- Apple is ambiguous — default DISCARD but needs_review=true so it gets flagged
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, needs_review, gst_treatment)
VALUES
  ('APPLE\.COM/BILL', 'Apple', 'DISCARD', true, false, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;

-- Fix Canva: always Ecodia business, not ambiguous
UPDATE supplier_rules SET needs_review = false, is_business = true WHERE pattern = 'canva';

-- Fix: "round up" in savings rule was matching "Round Up (AUD)" column in long_description
UPDATE supplier_rules SET pattern = 'africa.*25|save up challenge|quick save transfer'
WHERE pattern = 'africa.*25|save up challenge|quick save|round up';

-- Fix Apple: always business (all Apple subs are Ecodia)
UPDATE supplier_rules SET account_code = '5010', is_business = true, needs_review = false
WHERE pattern = 'APPLE\.COM/BILL';

-- Marketing Broker = business advertising
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES ('MARKETING BROKER', 'Marketing Broker', '5005', true, true, 'gst_inclusive')
ON CONFLICT DO NOTHING;

-- Centrelink incoming = personal income, DISCARD
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES ('7D1B0', 'Centrelink (ref pattern)', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

-- "from Mum" transfers = personal
INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, is_business, gst_treatment)
VALUES ('from mum', 'Family Transfer', 'DISCARD', true, false, 'gst_free')
ON CONFLICT DO NOTHING;

