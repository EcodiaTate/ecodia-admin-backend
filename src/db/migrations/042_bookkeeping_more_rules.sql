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
  ('google one', 'Google One', 'DISCARD', true, false, 'gst_free'),
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

