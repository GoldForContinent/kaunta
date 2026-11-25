-- Kaunta migration #9
--  Non-drink products (groundnuts, cigarettes, matches, lighters, food) use the
--  same drink row, but with goods = 1 and human unit labels.
--    drinks.size      = units in one sellable pack (1 for a single item, 20 for a cigarette pack)
--    drinks.stockMl   = smallest units on hand (sticks for cigarettes)
--    drinks.full      = price per pack/piece
--    drinks.shot_ml   = units in one sub-unit portion (1 stick, 250 g, etc.)
--    drinks.shot_price= price per sub-unit (e.g. per stick / 250 g plate)
--    drinks.unit      = "pack" / "piece" / "plate" / "kg"
--    drinks.sub_unit  = "stick" / "slice" / "piece"

ALTER TABLE drinks ADD COLUMN goods INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drinks ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE drinks ADD COLUMN sub_unit TEXT NOT NULL DEFAULT '';
