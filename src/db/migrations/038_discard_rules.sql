-- Add DISCARD supplier rules for known personal patterns
-- DISCARD = purely personal, auto-ignored, never enters the books

INSERT INTO supplier_rules (pattern, supplier_name, account_code, is_personal, gst_treatment, learning_source, tags) VALUES
  ('chempro|chemist|pharmacy', 'Personal (pharmacy)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('jericho|kings beach|moffat beach', 'Personal (food/drink)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('amrityu', 'Personal (food)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('woolworths|coles|aldi|iga', 'Personal (groceries)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('bp |shell |caltex|ampol|united petroleum|7-eleven fuel', 'Personal (fuel)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('mcdonald|hungry jack|kfc|subway|domino|pizza', 'Personal (fast food)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('dan murphy|bws|liquorland|bottlemart', 'Personal (alcohol)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('netflix|disney\+|spotify|stan |binge|youtube premium', 'Personal (streaming)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('uber(?!.*eats)|lyft|didi|taxi|cab charge', 'Personal (transport)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard"]'),
  ('invalid pin', 'Invalid PIN (discard)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["discard","zero"]'),
  ('changing.*bank|bank.*transfer|internal transfer|between accounts', 'Personal (bank transfer)', 'DISCARD', TRUE, 'no_gst', 'seeded', '["personal","discard","transfer"]')
ON CONFLICT DO NOTHING;

-- Update existing personal rules to DISCARD instead of director loan
-- These were personal-only patterns that should never be in the books
UPDATE supplier_rules SET account_code = 'DISCARD'
WHERE pattern IN ('casey donohoe', 'angelica choppin')
  AND account_code = '2100';

-- Keep 't j donohoe' as director loan since those are actual transfers between accounts
